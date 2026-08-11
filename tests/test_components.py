"""Components: the general motion patterns a variant is built from.

Two properties matter most. Legacy and ring-shorthand configurations must keep
rendering exactly as before, since every measured number depends on it. And a
frozen component must hold its spatial and level distribution while removing
motion, since that is what a matched control is.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ringfield as rf
from sweep import make_test_signal

FS = 44100
C = rf.ComponentConfig


@pytest.fixture(scope="module")
def signal():
    return make_test_signal(FS, 3.0)


@pytest.fixture(scope="module")
def hrtf():
    return rf.AnalyticHRTF(fs=FS)


def geom(*comps, seed=0):
    return rf.FieldGeometry(rf.FieldConfig(seed=seed, components=list(comps)))


# ----------------------------------------------------------------------
# Compatibility
# ----------------------------------------------------------------------

def test_ring_component_matches_the_ring_shorthand(hrtf, signal):
    ringed = rf.FieldConfig(seed=2, rings=[rf.RingConfig(
        n_sources=5, rotation_deg_per_sec=60.0, start_azimuths=[-90, -18, 54, 126, 198])])
    comped = rf.FieldConfig(seed=2, components=[C(
        kind="ring", n_sources=5, rotation_deg_per_sec=60.0,
        start_azimuths=[-90, -18, 54, 126, 198])])
    a = rf.render(signal, hrtf, ringed, FS, normalize=False)
    b = rf.render(signal, hrtf, comped, FS, normalize=False)
    assert np.array_equal(a, b)


def test_legacy_scalar_config_still_matches_a_ring_component(hrtf, signal):
    legacy = rf.FieldConfig(n_sources=4, rotation_deg_per_sec=45.0, seed=1)
    comped = rf.FieldConfig(seed=1, components=[
        C(kind="ring", n_sources=4, rotation_deg_per_sec=45.0)])
    a = rf.render(signal, hrtf, legacy, FS, normalize=False)
    b = rf.render(signal, hrtf, comped, FS, normalize=False)
    assert np.array_equal(a, b)


# ----------------------------------------------------------------------
# Stream: straight-line translation
# ----------------------------------------------------------------------

def test_stream_crosses_from_one_side_to_the_other():
    """Heading 90 travels rightward, so a source's x coordinate should rise
    monotonically through the crossing."""
    g = geom(C(kind="stream", n_sources=1, heading_deg=90.0, speed_mps=2.0,
               path_m=8.0, spread_m=0.0))
    xs = []
    for t in np.linspace(0, 3.5, 40):
        az, dist, _ = g.state(t)
        xs.append(dist[0] * np.sin(np.deg2rad(az[0])))
    diffs = np.diff(xs)
    assert np.sum(diffs > 0) > len(diffs) * 0.85


def test_stream_fades_in_and_out_at_the_ends_of_its_path():
    g = geom(C(kind="stream", n_sources=1, speed_mps=1.0, path_m=6.0,
               spread_m=0.0, fade_frac=0.3))
    lv = [g.state(t)[2][0] for t in np.linspace(0, 6.0, 61)]
    assert min(lv) < 0.05           # silent at the ends of the run
    assert max(lv) > 0.9            # full level partway through


def test_stream_recycles_so_the_flow_is_continuous():
    g = geom(C(kind="stream", n_sources=1, speed_mps=1.0, path_m=4.0, spread_m=0.0))
    early = g.state(0.0)[0][0]
    after_one_lap = g.state(4.0)[0][0]
    assert after_one_lap == pytest.approx(early, abs=1e-6)


def test_stream_sources_are_staggered_along_the_path():
    """Otherwise every source arrives at once and the flow pulses.

    Checked on position rather than level: the fade envelope is symmetric about
    the midpoint, so two sources at opposite ends share a level while sitting in
    quite different places.
    """
    g = geom(C(kind="stream", n_sources=6, speed_mps=1.0, path_m=8.0, spread_m=0.0))
    az, dist, _ = g.state(0.0)
    signed = dist * np.cos(np.deg2rad(az))       # position along the path
    assert len(set(np.round(signed, 3))) == 6


def test_front_back_stream_produces_no_interaural_difference(hrtf, signal):
    """A stream along the median plane keeps both ears equidistant, and the
    model is front-back symmetric, so nothing interaural moves. It is audible
    only as a level change. This constrains what translation can be tested."""
    cfg = rf.FieldConfig(components=[C(
        kind="stream", n_sources=1, heading_deg=180.0, speed_mps=1.5,
        path_m=8.0, spread_m=0.0)], decorr=rf.DecorrConfig(amount=0.0))
    y = rf.render(signal, hrtf, cfg, FS, normalize=False)
    assert np.max(np.abs(y[:, 0] - y[:, 1])) < 1e-9


def test_side_to_side_stream_does_move_the_interaural_cues(hrtf, signal):
    cfg = rf.FieldConfig(components=[C(
        kind="stream", n_sources=1, heading_deg=90.0, speed_mps=1.5,
        path_m=8.0, spread_m=0.0)], decorr=rf.DecorrConfig(amount=0.0))
    y = rf.render(signal, hrtf, cfg, FS, normalize=False)
    assert np.max(np.abs(y[:, 0] - y[:, 1])) > 1e-3


def test_a_source_never_passes_through_the_head():
    g = geom(C(kind="stream", n_sources=1, heading_deg=180.0, speed_mps=1.0,
               path_m=6.0, spread_m=0.0, min_distance_m=0.4))
    d = [g.state(t)[1][0] for t in np.linspace(0, 6, 121)]
    assert min(d) >= 0.4 - 1e-9


# ----------------------------------------------------------------------
# Radial and spiral
# ----------------------------------------------------------------------

def test_radial_outward_increases_distance():
    """Sampled over a window short enough not to reach the far edge, since a
    source that arrives there recycles to the near edge and starts again."""
    g = geom(C(kind="radial", n_sources=1, radial_speed_mps=1.0,
               r_near_m=0.8, r_far_m=5.0))
    d = [g.state(t)[1][0] for t in np.linspace(0, 1.5, 30)]
    assert d[-1] > d[0]
    assert all(np.diff(d) > 0)


def test_radial_inward_decreases_distance():
    g = geom(C(kind="radial", n_sources=1, radial_speed_mps=-1.0,
               r_near_m=0.8, r_far_m=5.0))
    d = [g.state(t)[1][0] for t in np.linspace(0, 1.5, 30)]
    assert d[-1] < d[0]
    assert all(np.diff(d) < 0)


def test_radial_recycles_at_the_far_edge():
    """A source reaching the outer limit reappears at the inner one, so an
    outward flow is continuous rather than emptying out."""
    g = geom(C(kind="radial", n_sources=1, radial_speed_mps=1.0,
               r_near_m=0.8, r_far_m=5.0))
    span = 5.0 - 0.8
    d0 = g.state(0.0)[1][0]
    d_after_lap = g.state(span / 1.0)[1][0]
    assert d_after_lap == pytest.approx(d0, abs=1e-6)


def test_radial_holds_its_azimuth():
    g = geom(C(kind="radial", n_sources=3, radial_speed_mps=1.0))
    assert np.allclose(g.azimuths(0.0), g.azimuths(2.7))


def test_spiral_moves_in_both_angle_and_distance():
    g = geom(C(kind="spiral", n_sources=1, rotation_deg_per_sec=60.0,
               radial_speed_mps=0.8, r_near_m=1.0, r_far_m=5.0))
    az0, d0, _ = g.state(0.0)
    az1, d1, _ = g.state(2.0)
    assert abs(az1[0] - az0[0]) == pytest.approx(120.0, abs=1.0)
    assert d1[0] != pytest.approx(d0[0], abs=0.05)


def test_radial_and_spiral_use_the_distance_path(hrtf, signal):
    for kind in ("radial", "spiral"):
        g = geom(C(kind=kind, n_sources=2, radial_speed_mps=0.5))
        assert g.uses_distance and g.uses_envelope


# ----------------------------------------------------------------------
# Freezing: what a matched control does
# ----------------------------------------------------------------------

@pytest.mark.parametrize("comp", [
    C(kind="ring", n_sources=4, rotation_deg_per_sec=90.0),
    C(kind="stream", n_sources=4, speed_mps=2.0),
    C(kind="radial", n_sources=4, radial_speed_mps=1.0),
    C(kind="spiral", n_sources=4, rotation_deg_per_sec=60.0, radial_speed_mps=0.5),
    C(kind="ring", n_sources=4, rotation_deg_per_sec=0.0, random_fraction=1.0),
])
def test_frozen_components_do_not_move(comp):
    g = rf.FieldGeometry(rf.FieldConfig(components=[comp.frozen()]))
    a0, d0, l0 = g.state(0.0)
    a1, d1, l1 = g.state(5.0)
    assert np.allclose(a0, a1) and np.allclose(d0, d1) and np.allclose(l0, l1)


def test_freezing_preserves_the_spatial_and_level_distribution():
    """A control must remove motion only. Deleting the component or resetting
    positions would change the ensemble as well."""
    moving = C(kind="stream", n_sources=6, speed_mps=2.0, path_m=8.0)
    g_move = rf.FieldGeometry(rf.FieldConfig(components=[moving]))
    g_still = rf.FieldGeometry(rf.FieldConfig(components=[moving.frozen()]))
    a0, d0, l0 = g_move.state(0.0)
    a1, d1, l1 = g_still.state(0.0)
    assert np.allclose(a0, a1) and np.allclose(d0, d1) and np.allclose(l0, l1)


@pytest.mark.parametrize("comp,expect_static", [
    (C(kind="ring", rotation_deg_per_sec=0.0), True),
    (C(kind="ring", rotation_deg_per_sec=30.0), False),
    (C(kind="ring", rotation_deg_per_sec=0.0, random_fraction=0.5, wander_hz=0.3), False),
    (C(kind="ring", rotation_deg_per_sec=0.0, random_fraction=0.5, wander_hz=0.0), True),
    (C(kind="stream", rotation_deg_per_sec=0.0, speed_mps=1.0), False),
    (C(kind="radial", rotation_deg_per_sec=0.0, radial_speed_mps=0.4), False),
])
def test_static_detection(comp, expect_static):
    assert comp.is_static() is expect_static


# ----------------------------------------------------------------------
# Per-component decorrelation
# ----------------------------------------------------------------------

def test_each_component_can_carry_its_own_decorrelation():
    cfg = rf.FieldConfig(components=[
        C(kind="ring", n_sources=2, decorr=rf.DecorrConfig(amount=0.0)),
        C(kind="ring", n_sources=3, decorr=rf.DecorrConfig(amount=1.0, family="allpass")),
    ], decorr=rf.DecorrConfig(amount=0.5))
    per = cfg.per_source_decorr()
    assert [d.amount for d in per] == [0.0, 0.0, 1.0, 1.0, 1.0]
    assert [d.family for d in per] == ["velvet"] * 2 + ["allpass"] * 3


def test_components_without_an_override_inherit_the_variant(signal):
    cfg = rf.FieldConfig(components=[C(kind="ring", n_sources=3)],
                         decorr=rf.DecorrConfig(amount=0.7, family="allpass"))
    per = cfg.per_source_decorr()
    assert all(d.amount == 0.7 and d.family == "allpass" for d in per)


def test_per_component_decorrelation_reaches_the_bank(signal):
    cfg = rf.FieldConfig(components=[
        C(kind="ring", n_sources=2, decorr=rf.DecorrConfig(amount=0.0)),
        C(kind="ring", n_sources=2, decorr=rf.DecorrConfig(amount=1.0)),
    ])
    bank = rf.SourceBank(signal, 4, cfg.per_source_decorr(), FS)
    out = bank.blocks(0, len(signal), bank.base_amounts())
    # the coherent pair stays identical; the decorrelated pair does not
    assert np.corrcoef(out[0], out[1])[0, 1] > 0.999
    assert abs(np.corrcoef(out[2], out[3])[0, 1]) < 0.6


def test_uniform_per_source_configs_match_a_single_config(signal):
    d = rf.DecorrConfig(amount=0.6, seed=4)
    a = rf.SourceBank(signal, 3, d, FS)
    b = rf.SourceBank(signal, 3, [d, d, d], FS)
    assert np.allclose(a.blocks(0, len(signal), a.base_amounts()),
                       b.blocks(0, len(signal), b.base_amounts()))


# ----------------------------------------------------------------------
# Composition and reporting
# ----------------------------------------------------------------------

def test_mixed_components_render_and_trace(hrtf, signal):
    cfg = rf.FieldConfig(components=[
        C(kind="ring", n_sources=3, rotation_deg_per_sec=50.0, distance_m=1.5,
          label="inner"),
        C(kind="stream", n_sources=4, heading_deg=90.0, speed_mps=1.5,
          label="crossing"),
        C(kind="radial", n_sources=2, radial_speed_mps=-0.6, label="closing in"),
    ])
    trace = []
    y = rf.render(signal, hrtf, cfg, FS, trace=trace)
    assert y.shape == (len(signal), 2)
    assert len(trace[0]["az"]) == 9
    assert len(trace[0]["lvl"]) == 9
    d = rf.config_dict(cfg)
    assert d["resolved_component_of"] == [0, 0, 0, 1, 1, 1, 1, 2, 2]
    assert d["component_labels"] == ["inner", "crossing", "closing in"]


def test_component_gain_scales_that_component_only(hrtf, signal):
    loud = rf.FieldConfig(components=[C(kind="ring", n_sources=2, gain_db=0.0)])
    quiet = rf.FieldConfig(components=[C(kind="ring", n_sources=2, gain_db=-12.0)])
    yl = rf.render(signal, hrtf, loud, FS, normalize=False)
    yq = rf.render(signal, hrtf, quiet, FS, normalize=False)
    db = 20 * np.log10(np.sqrt(np.mean(yl ** 2) / np.mean(yq ** 2)))
    assert db == pytest.approx(12.0, abs=0.5)


def test_an_empty_component_list_falls_back_to_the_scalar_ring():
    cfg = rf.FieldConfig(n_sources=3, components=[])
    assert len(cfg.resolved_components()) == 1
    assert cfg.resolved_components()[0].n_sources == 3
