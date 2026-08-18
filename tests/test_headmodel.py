"""The physical model's constants, exposed as parameters.

Head radius is the model's only anthropometric quantity: it scales every ITD
and sets the shadow filter's corner. Fixing it in code meant the one thing a
listener actually differs by could not be varied.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ringfield as rf

FS = 44100


def test_itd_scales_with_head_radius():
    """Woodworth's formula is linear in radius, so a 10% larger head gives a
    10% larger delay at every azimuth."""
    small = rf.woodworth_itd(90.0, a=0.080)
    large = rf.woodworth_itd(90.0, a=0.096)
    assert large / small == pytest.approx(0.096 / 0.080, rel=1e-9)


def test_itd_scales_inversely_with_speed_of_sound():
    slow = rf.woodworth_itd(90.0, c=300.0)
    fast = rf.woodworth_itd(90.0, c=400.0)
    assert slow / fast == pytest.approx(400.0 / 300.0, rel=1e-9)


def test_default_head_radius_reproduces_the_documented_itd():
    assert rf.woodworth_itd(90.0) * 1000 == pytest.approx(0.656, abs=0.002)


@pytest.mark.parametrize("radius,expected_ms", [
    (0.075, 0.562), (0.0875, 0.656), (0.100, 0.750),
])
def test_head_radius_reaches_the_rendered_hrir(radius, expected_ms):
    """The parameter has to survive all the way into the synthesized impulse
    response, not merely into the formula."""
    h = rf.AnalyticHRTF(fs=FS, head_radius=radius)
    ir = h.hrir(90.0)
    cc = np.correlate(ir[0], ir[1], mode="full")
    lag_ms = (np.argmax(np.abs(cc)) - (len(ir[1]) - 1)) / FS * 1000
    assert lag_ms == pytest.approx(expected_ms, abs=0.03)


def test_head_radius_moves_the_shadow_corner():
    """The Brown and Duda corner sits at c/a, so a larger head shadows from a
    lower frequency."""
    def corner_gain(radius, freq):
        b, a = rf.head_shadow_coeffs(0.0, FS, a=radius)
        w = 2 * np.pi * freq / FS
        z = np.exp(-1j * w)
        return abs((b[0] + b[1] * z) / (a[0] + a[1] * z))

    small = corner_gain(0.075, 400.0)
    large = corner_gain(0.105, 400.0)
    # bigger head, corner lower, so more of the boost has arrived by 400 Hz
    assert large > small


def test_hrtf_for_honours_the_config():
    cfg = rf.FieldConfig(head_radius=0.095, hrtf_taps=64)
    h = rf.hrtf_for(cfg, FS)
    assert h.head_radius == 0.095
    assert h.n_taps == 64


def test_hrtf_for_caches_identical_models():
    a = rf.hrtf_for(rf.FieldConfig(head_radius=0.0875), FS)
    b = rf.hrtf_for(rf.FieldConfig(head_radius=0.0875), FS)
    c = rf.hrtf_for(rf.FieldConfig(head_radius=0.0900), FS)
    assert a is b
    assert a is not c


def test_hrtf_grid_step_controls_table_size():
    assert len(rf.AnalyticHRTF(fs=FS, grid_step=1.0).grid) == 360
    assert len(rf.AnalyticHRTF(fs=FS, grid_step=5.0).grid) == 72


def test_tap_count_changes_the_hrir_length():
    assert rf.AnalyticHRTF(fs=FS, n_taps=64).hrir(45.0).shape == (2, 64)
    assert rf.AnalyticHRTF(fs=FS, n_taps=256).hrir(45.0).shape == (2, 256)


def test_head_radius_changes_the_rendered_output(hrtf_signal):
    """Two heads should not produce the same render."""
    small = rf.FieldConfig(n_sources=3, rotation_deg_per_sec=60, head_radius=0.075)
    large = rf.FieldConfig(n_sources=3, rotation_deg_per_sec=60, head_radius=0.105)
    ys = rf.render(hrtf_signal, rf.hrtf_for(small, FS), small, FS)
    yl = rf.render(hrtf_signal, rf.hrtf_for(large, FS), large, FS)
    assert np.max(np.abs(ys - yl)) > 1e-3


def test_timeline_resolves_a_head_model_per_segment(hrtf_signal):
    """Passing no HRTF means each segment supplies its own, which is what lets
    two variants in one render use different heads."""
    stereo = np.stack([hrtf_signal, hrtf_signal], axis=-1)
    segs = [
        rf.Segment(0, 1, rf.FieldConfig(n_sources=3, head_radius=0.075)),
        rf.Segment(1, 2, rf.FieldConfig(n_sources=3, head_radius=0.105)),
    ]
    y, tl = rf.render_timeline(hrtf_signal, stereo, None, segs, FS)
    assert len(tl) == 2
    assert tl[0].params["head_radius"] == 0.075
    assert tl[1].params["head_radius"] == 0.105


def test_config_dict_reports_the_physical_model(hrtf_signal):
    cfg = rf.FieldConfig(head_radius=0.09, speed_of_sound=347.0, hrtf_taps=64)
    d = rf.config_dict(cfg)
    assert d["head_radius"] == 0.09
    assert d["speed_of_sound"] == 347.0
    assert d["hrtf_taps"] == 64


@pytest.fixture(scope="module")
def hrtf_signal():
    from sweep import make_test_signal
    return make_test_signal(FS, 2.0)


# ----------------------------------------------------------------------
# Measured HRTFs
# ----------------------------------------------------------------------

SOFA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "hrtf", "mit_kemar_normal_pinna.sofa")


@pytest.mark.skipif(not os.path.isfile(SOFA), reason="no SOFA file present")
def test_a_measured_set_breaks_the_front_back_symmetry():
    """The sphere renders mirrored azimuths bit-identically, which is why
    rotation reaches the ears as a doubled-rate oscillation and why direction
    cannot be recovered. A measured set carries pinna cues, and the whole
    reason to fit one is that those differ front from back.
    """
    fs = 44100
    sphere = rf.AnalyticHRTF(fs=fs)
    kemar = rf.SofaHRTF(SOFA, fs=fs)

    freqs = np.fft.rfftfreq(512, 1.0 / fs)
    pinna = (freqs > 3000) & (freqs < 12000)

    def spread(hrtf, a, b):
        fa = 20 * np.log10(np.abs(np.fft.rfft(hrtf.hrir(a)[0], 512)) + 1e-9)
        fb = 20 * np.log10(np.abs(np.fft.rfft(hrtf.hrir(b)[0], 512)) + 1e-9)
        return float(np.mean(np.abs(fa - fb)[pinna]))

    for a, b in ((0.0, 180.0), (30.0, 150.0), (45.0, 135.0), (60.0, 120.0)):
        assert spread(sphere, a, b) < 1e-9, "the sphere must stay symmetric"
        assert spread(kemar, a, b) > 3.0, f"KEMAR gives no front-back at {a}/{b}"


@pytest.mark.skipif(not os.path.isfile(SOFA), reason="no SOFA file present")
def test_choosing_a_measured_set_changes_what_renders():
    """hrtf_file has to reach the renderer, and distance has to survive it:
    the measured set supplies direction only, while level and the near-field
    growth stay with the geometry, which applies them after the convolution.
    """
    fs = 44100
    x = np.random.default_rng(0).normal(0, 0.2, fs)

    def one(path, az):
        cfg = rf.FieldConfig(
            hrtf_file=path, decorr=rf.DecorrConfig(amount=0.0),
            components=[rf.ComponentConfig(
                lattice="polar", rings=1, per_ring=1, r_near_m=2.0,
                r_far_m=2.0, start_azimuths=[az])])
        return rf.render(x, rf.hrtf_for(cfg, fs), cfg, fs, normalize=False)

    assert np.array_equal(one(None, 0.0), one(None, 180.0))
    assert not np.array_equal(one(SOFA, 0.0), one(SOFA, 180.0))
    assert isinstance(rf.hrtf_for(rf.FieldConfig(hrtf_file=SOFA), fs), rf.SofaHRTF)
