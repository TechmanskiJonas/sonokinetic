"""Tests for the decomposed decorrelation controls.

The binding constraint from the handoff: every control must preserve per-source
level. A knob that changes loudness as well as coherence makes every comparison
made with it worthless, so that property is asserted for each axis separately
rather than once for the default.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ringfield as rf
from sweep import make_test_signal

FS = 44100


@pytest.fixture(scope="module")
def signal():
    return make_test_signal(FS, 4.0)


@pytest.fixture(scope="module")
def hrtf():
    return rf.AnalyticHRTF(fs=FS)


# ----------------------------------------------------------------------
# Level preservation, one case per control axis
# ----------------------------------------------------------------------

CONFIGS = {
    "velvet default":     rf.DecorrConfig(),
    "allpass":            rf.DecorrConfig(family="allpass"),
    "short ir":           rf.DecorrConfig(ir_ms=5.0),
    "long ir":            rf.DecorrConfig(ir_ms=120.0),
    "sparse velvet":      rf.DecorrConfig(density=200.0),
    "dense velvet":       rf.DecorrConfig(density=20000.0),
    "partial phase":      rf.DecorrConfig(family="allpass", phase_depth=0.4),
    "bass coherent":      rf.DecorrConfig(crossovers=[200.0], band_amounts=[0.0, 1.0]),
    "three bands":        rf.DecorrConfig(crossovers=[150.0, 2000.0],
                                          band_amounts=[0.0, 0.6, 1.0]),
    "micro delay":        rf.DecorrConfig(family="none", micro_delay_ms=12.0),
    "micro pitch":        rf.DecorrConfig(family="none", micro_pitch_cents=14.0),
    "half amount":        rf.DecorrConfig(amount=0.5),
    "per source":         rf.DecorrConfig(per_source_amount=[0.0, 0.3, 0.7, 1.0]),
}


@pytest.mark.parametrize("name", list(CONFIGS))
def test_every_control_preserves_per_source_level(signal, name):
    cfg = CONFIGS[name]
    bank = rf.SourceBank(signal, 4, cfg, FS)
    out = bank.blocks(0, len(signal), bank.base_amounts())
    ref = np.sqrt(np.mean(signal ** 2))
    for i in range(4):
        got = np.sqrt(np.mean(out[i] ** 2))
        assert got == pytest.approx(ref, rel=0.02), f"{name}: source {i}"


@pytest.mark.parametrize("amount", np.linspace(0, 1, 11))
def test_level_is_flat_across_the_whole_amount_sweep(signal, amount):
    """The failure this guards against dipped 5.4 dB mid-sweep while sitting at
    full level at both ends, so it is only visible if the middle is sampled."""
    bank = rf.SourceBank(signal, 2, rf.DecorrConfig(amount=float(amount)), FS)
    out = bank.blocks(0, len(signal), bank.base_amounts())
    ratio = np.sqrt(np.mean(out[0] ** 2) / np.mean(signal ** 2))
    assert 20 * np.log10(ratio) == pytest.approx(0.0, abs=0.2)


# ----------------------------------------------------------------------
# Band shaping
# ----------------------------------------------------------------------

def test_uniform_band_gains_are_exactly_identity(signal):
    """Bands telescope back to the input, so the frequency control is inert
    until it is used. Without this the crossover would colour every render
    that merely has the control switched on."""
    out = rf.band_shape(signal, [200.0, 3000.0], [1.0, 1.0, 1.0], FS)
    assert np.allclose(out, signal, atol=1e-10)


def test_zero_band_gains_return_silence(signal):
    out = rf.band_shape(signal, [200.0], [0.0, 0.0], FS)
    assert np.max(np.abs(out)) < 1e-10


def test_bass_stays_coherent_when_the_low_band_is_held_at_zero(signal):
    """Standard practice keeps bass coherent because the head does not shadow
    it. Check the low band really is untouched across sources."""
    cfg = rf.DecorrConfig(crossovers=[200.0], band_amounts=[0.0, 1.0])
    bank = rf.SourceBank(signal, 3, cfg, FS)
    out = bank.blocks(0, len(signal), bank.base_amounts())

    low = np.stack([rf._lowpass(o, 150.0, FS) for o in out])
    high = np.stack([rf._lowpass(o, 150.0, FS) - o for o in out])

    low_corr = np.corrcoef(low[0], low[1])[0, 1]
    high_corr = np.corrcoef(high[0], high[1])[0, 1]
    assert low_corr > 0.9, "low band should stay coherent between sources"
    assert high_corr < low_corr, "high band should be less coherent than low"


# ----------------------------------------------------------------------
# The prefabs are two points on one continuum
# ----------------------------------------------------------------------

def test_phase_depth_zero_does_not_decorrelate(signal):
    bank = rf.SourceBank(signal, 2, rf.DecorrConfig(
        family="allpass", phase_depth=0.0), FS)
    out = bank.blocks(0, len(signal), bank.base_amounts())
    assert np.corrcoef(out[0], out[1])[0, 1] > 0.95


def test_phase_depth_is_a_continuous_axis(signal):
    """Coherence between sources should fall as the scramble deepens."""
    got = []
    for depth in (0.0, 0.25, 0.5, 1.0):
        bank = rf.SourceBank(signal, 2, rf.DecorrConfig(
            family="allpass", phase_depth=depth, seed=3), FS)
        out = bank.blocks(0, len(signal), bank.base_amounts())
        got.append(abs(np.corrcoef(out[0], out[1])[0, 1]))
    assert got[0] > got[-1]
    assert got == sorted(got, reverse=True), got


def inter_source_corr(signal, cfg, n=2):
    bank = rf.SourceBank(signal, n, cfg, FS)
    o = bank.blocks(0, len(signal), bank.base_amounts())
    return abs(np.corrcoef(o[0], o[1])[0, 1])


def mean_corr(signal, seeds=8, **kw):
    """Inter-source coherence averaged over draws.

    Single-draw estimates carry sd near 0.05 on a quantity whose useful range
    is about 0.04 to 0.5, so any single-seed comparison between two settings is
    reading noise. Every claim about these controls averages first.
    """
    vals = [inter_source_corr(signal, rf.DecorrConfig(seed=s * 37, **kw))
            for s in range(seeds)]
    return float(np.mean(vals))


def test_velvet_density_is_monotonic_where_it_has_headroom(signal):
    """Density only does work while the IR is sparse enough to be audible as
    sparse. Below roughly 400 impulses/sec each step matters; above it the IR
    is already noise-like and further density is inert (see the saturation test
    below). Asserting monotonicity over the whole range would be asserting noise.
    """
    got = [mean_corr(signal, density=d, envelope="flat")
           for d in (60.0, 150.0, 400.0)]
    assert got == sorted(got, reverse=True), got
    assert got[0] - got[-1] > 0.15, "sparse regime should be a large effect"


def test_velvet_density_saturates_once_the_ir_is_noise_like(signal):
    """Past saturation the knob is decorative. Worth asserting so that time is
    not spent sweeping a control that cannot move the result."""
    got = [mean_corr(signal, density=d, envelope="flat")
           for d in (1500.0, 20000.0, 44100.0)]
    assert max(got) - min(got) < 0.06, got


def test_dense_velvet_converges_on_allpass(signal):
    """Velvet at high density approaches allpass, which is what makes the two
    prefabs one axis rather than two categories. Convergence is reached by
    density near 400, not only at the extreme.
    """
    dense = mean_corr(signal, density=20000.0, envelope="flat")
    allpass = mean_corr(signal, family="allpass", envelope="flat")
    assert abs(dense - allpass) < 0.06


def test_ir_length_is_the_axis_with_the_most_headroom(signal):
    """Of the filter-shape controls this is the one that moves the result
    furthest relative to the noise floor, so it is the one worth sweeping."""
    got = [mean_corr(signal, ir_ms=ms, envelope="flat")
           for ms in (5.0, 30.0, 120.0)]
    assert got[0] > got[-1]
    assert got[0] - got[-1] > 0.1


def test_envelope_dominates_in_the_sparse_regime(signal):
    """With only a couple of impulses in the IR, a flat envelope leaves the
    forced direct tap at full amplitude and the source stays coherent with its
    own dry signal, while a Hann window tapers that tap away. This is the
    hidden variable that made the two prefabs look incomparable on density.
    """
    flat = mean_corr(signal, density=60.0, envelope="flat")
    hann = mean_corr(signal, density=60.0, envelope="hann")
    assert flat - hann > 0.2


def test_envelope_is_inert_once_the_ir_is_dense(signal):
    """The same control that dominates when sparse does almost nothing when
    dense, which is why it has to be a separate axis rather than folded into
    the family."""
    flat = mean_corr(signal, density=20000.0, envelope="flat")
    hann = mean_corr(signal, density=20000.0, envelope="hann")
    assert abs(flat - hann) < 0.06


def test_auto_envelope_reproduces_each_prefab(signal):
    """Existing renders have to stay reproducible, so "auto" must be exactly
    the historical shape: velvet flat, allpass Hann."""
    assert inter_source_corr(signal, rf.DecorrConfig(seed=5)) == pytest.approx(
        inter_source_corr(signal, rf.DecorrConfig(seed=5, envelope="flat")))
    assert inter_source_corr(signal, rf.DecorrConfig(
        family="allpass", seed=5)) == pytest.approx(inter_source_corr(
            signal, rf.DecorrConfig(family="allpass", seed=5, envelope="hann")))


def test_micro_delay_spread_gives_every_source_a_distinct_delay(signal):
    """Delay cannot go negative, so a symmetric spread folds and hands the two
    end sources the same delay. Each source must differ from each other one."""
    bank = rf.SourceBank(signal, 4, rf.DecorrConfig(
        family="none", micro_delay_ms=15.0), FS)
    out = bank.blocks(0, len(signal), bank.base_amounts())
    for i in range(4):
        for j in range(i + 1, 4):
            c = abs(np.corrcoef(out[i], out[j])[0, 1])
            assert c < 0.99, f"sources {i} and {j} are the same signal"


@pytest.mark.parametrize("cfg,label", [
    (rf.DecorrConfig(family="none", micro_delay_ms=15.0), "micro delay"),
    (rf.DecorrConfig(family="none", micro_pitch_cents=20.0), "micro pitch"),
])
def test_crude_families_do_decorrelate(signal, cfg, label):
    bank = rf.SourceBank(signal, 4, cfg, FS)
    out = bank.blocks(0, len(signal), bank.base_amounts())
    assert abs(np.corrcoef(out[0], out[-1])[0, 1]) < 0.9, label


# ----------------------------------------------------------------------
# The circulating coherence hotspot
# ----------------------------------------------------------------------





def test_lfo_modulates_coherence_over_time(hrtf, signal):
    cfg = rf.FieldConfig(n_sources=4, rotation_deg_per_sec=0.0,
                         decorr=rf.DecorrConfig(amount=0.5, lfo_hz=1.0,
                                                lfo_depth=0.5))
    trace = []
    rf.render(signal, hrtf, cfg, FS, trace=trace)
    amts = np.array([t["amt"][0] for t in trace])
    assert amts.std() > 0.05


# ----------------------------------------------------------------------
# Geometry and trace plumbing
# ----------------------------------------------------------------------

def test_ring_geometry_paths_agree_where_they_should():
    explicit = rf.FieldConfig(n_sources=3, start_azimuths=[0, 120, 240])
    spaced = rf.FieldConfig(n_sources=3, spacing_deg=120.0)
    default = rf.FieldConfig(n_sources=3)
    assert np.allclose(explicit.resolved_azimuths(), [0, 120, 240])
    assert np.allclose(spaced.resolved_azimuths(), [0, 120, 240])
    assert np.allclose(default.resolved_azimuths(), [0, 120, 240])


def test_offset_rotates_the_whole_ring():
    cfg = rf.FieldConfig(n_sources=4, offset_deg=45.0)
    assert np.allclose(cfg.resolved_azimuths(), [45, 135, 225, 315])


def test_per_source_gain_breaks_symmetry(hrtf, signal):
    """The third documented symmetry break, with decorrelation switched off so
    it is the only thing acting."""
    x = signal[: 2 * FS]
    cfg = rf.FieldConfig(n_sources=8, rotation_deg_per_sec=60.0,
                         decorr_amount=0.0,
                         per_source_gain_db=[0, -6, 0, -3, 0, -9, 0, -2])
    y = rf.render(x, hrtf, cfg, FS)
    assert np.max(np.abs(y[:, 0] - y[:, 1])) > 1e-4


def test_trace_frames_are_serializable_and_sane(hrtf, signal):
    cfg = rf.FieldConfig(n_sources=3, rotation_deg_per_sec=90.0)
    trace = []
    rf.render(signal[: 2 * FS], hrtf, cfg, FS, trace=trace)
    import json
    json.dumps(trace)
    assert len(trace) > 10
    for fr in trace:
        assert len(fr["az"]) == 3 and len(fr["amt"]) == 3
        assert all(0.0 <= a <= 1.0 for a in fr["amt"])
        assert all(0.0 <= a < 360.0 for a in fr["az"])
    assert trace[0]["t"] < trace[-1]["t"]


def test_coherence_matrix_reports_what_was_got(signal):
    bank = rf.SourceBank(signal, 4, rf.DecorrConfig(amount=1.0), FS)
    sigs = bank.blocks(0, len(signal), bank.base_amounts())
    m = rf.coherence_matrix(sigs)
    assert m.shape == (4, 4)
    assert np.allclose(np.diag(m), 1.0)
    assert np.allclose(m, m.T)
    off = m[~np.eye(4, dtype=bool)]
    assert np.max(np.abs(off)) < 0.6


def test_coherence_matrix_is_all_ones_for_a_coherent_ring(signal):
    bank = rf.SourceBank(signal, 3, rf.DecorrConfig(amount=0.0), FS)
    sigs = bank.blocks(0, len(signal), bank.base_amounts())
    assert np.allclose(rf.coherence_matrix(sigs), 1.0, atol=1e-9)


def test_legacy_scalar_fields_still_drive_the_render(hrtf, signal):
    """make_track.py, variations.py and compare.py all use the scalar path."""
    cfg = rf.FieldConfig(n_sources=3, rotation_deg_per_sec=90.0,
                         decorr_amount=0.7, decorr_method="allpass")
    d = cfg.resolved_decorr()
    assert d.amount == 0.7 and d.family == "allpass"
    y = rf.render(signal[: FS], hrtf, cfg, FS)
    assert y.shape == (FS, 2)


def test_distinctiveness_finds_the_source_that_stands_out():
    """Correlation and distinctiveness are different quantities.

    Decorrelation is carried by phase; a spectral signature is carried by
    magnitude. So the coherence matrix can read near zero while one source
    still has a resonance its neighbours lack, and that source is the one the
    ear holds on to. No correlation measure reports it, which is why this one
    exists.

    Asserted by planting a resonance: one source is filtered through a narrow
    peak, which barely moves the coherence and should move this measure a lot.
    """
    import app as A

    fs = 44100
    rng = np.random.default_rng(0)
    n = fs
    sigs = [rng.normal(0, 1, n) for _ in range(6)]

    flat = A._source_distinctiveness(sigs, fs)
    assert flat["spread_db"] < 3.0, "independent noise should look uniform"

    # a two-pole resonance at 3 kHz on source 4 only
    w = 2 * np.pi * 3000 / fs
    r = 0.995
    a1, a2 = -2 * r * np.cos(w), r * r
    y = np.zeros(n)
    for i in range(2, n):
        y[i] = sigs[4][i] - a1 * y[i - 1] - a2 * y[i - 2]
    sigs[4] = 0.5 * y / (np.std(y) + 1e-12)

    marked = A._source_distinctiveness(sigs, fs)
    assert marked["outlier"] == 4
    assert marked["spread_db"] > flat["spread_db"] + 3.0
    assert 2000 < marked["outlier_hz"] < 4500
