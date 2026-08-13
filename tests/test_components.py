"""Components as lattices with motion fields applied.

Two things matter most. Legacy and ring-shorthand configurations must render
exactly as before, since every measured number depends on it. And the lattice
must stay whole while it moves: sources wrap rather than accumulating at one
edge, so the count is constant and the flow is endless.
"""

import os
import sys

from dataclasses import replace

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


def xy(az, dist):
    th = np.deg2rad(az)
    return dist * np.sin(th), dist * np.cos(th)


# ----------------------------------------------------------------------
# Compatibility
# ----------------------------------------------------------------------

def test_single_polar_ring_matches_the_ring_shorthand(hrtf, signal):
    ringed = rf.FieldConfig(seed=2, rings=[rf.RingConfig(
        n_sources=5, rotation_deg_per_sec=60.0,
        start_azimuths=[-90, -18, 54, 126, 198])])
    comped = rf.FieldConfig(seed=2, components=[C(
        lattice="polar", rings=1, per_ring=5, rotation_deg_per_sec=60.0,
        start_azimuths=[-90, -18, 54, 126, 198],
        r_near_m=rf.REF_DISTANCE, r_far_m=rf.REF_DISTANCE)])
    a = rf.render(signal, hrtf, ringed, FS, normalize=False)
    b = rf.render(signal, hrtf, comped, FS, normalize=False)
    assert np.array_equal(a, b)


def test_legacy_scalar_config_still_renders_identically(hrtf, signal):
    legacy = rf.FieldConfig(n_sources=4, rotation_deg_per_sec=45.0, seed=1)
    comped = rf.FieldConfig(seed=1, components=[C(
        lattice="polar", rings=1, per_ring=4, rotation_deg_per_sec=45.0,
        r_near_m=rf.REF_DISTANCE, r_far_m=rf.REF_DISTANCE)])
    a = rf.render(signal, hrtf, legacy, FS, normalize=False)
    b = rf.render(signal, hrtf, comped, FS, normalize=False)
    assert np.array_equal(a, b)


# ----------------------------------------------------------------------
# Lattices
# ----------------------------------------------------------------------

def test_polar_lattice_builds_concentric_rings():
    """Rings sit at half-steps across the band so that the outer one does not
    land where the inner one wraps to."""
    c = C(lattice="polar", rings=3, per_ring=6, r_near_m=1.0, r_far_m=4.0)
    assert c.n_sources == 18
    g = geom(c)
    _, dist, _ = g.state(0.0)
    assert sorted(set(np.round(dist, 3))) == [1.5, 2.5, 3.5]
    for r in (1.5, 2.5, 3.5):
        assert int(np.sum(np.abs(dist - r) < 1e-6)) == 6


def test_cartesian_lattice_builds_a_grid():
    c = C(lattice="cartesian", cols=4, rows=3, extent_x_m=6.0, extent_y_m=6.0)
    assert c.n_sources == 12
    g = geom(c)
    az, dist, _ = g.state(0.0)
    xs, ys = xy(az, dist)
    assert len(set(np.round(xs, 3))) == 4
    assert len(set(np.round(ys, 3))) == 3


def test_ring_stagger_offsets_each_successive_ring():
    c = C(lattice="polar", rings=2, per_ring=4, ring_stagger_deg=45.0,
          r_near_m=1.0, r_far_m=2.0)
    az = c.resolved_azimuths()
    assert az[0] == pytest.approx(0.0)
    assert az[4] == pytest.approx(45.0)


# ----------------------------------------------------------------------
# Translation: a grid drifting past the listener
# ----------------------------------------------------------------------

def test_a_drifting_grid_keeps_every_source():
    """The lattice wraps, so nothing drains away and the count never changes."""
    g = geom(C(lattice="cartesian", cols=4, rows=4, drift_y_mps=-1.5))
    for t in (0.0, 3.0, 11.0, 40.0):
        az, dist, _ = g.state(t)
        assert len(az) == 16
        assert np.all(np.isfinite(dist))


def test_a_grid_drifting_back_moves_every_source_backward():
    g = geom(C(lattice="cartesian", cols=3, rows=3, extent_y_m=9.0,
               drift_y_mps=-1.0))
    _, y0 = xy(*g.state(0.0)[:2])
    _, y1 = xy(*g.state(1.0)[:2])
    # each source is a metre further back, before any wrap
    moved = [(b - a) for a, b in zip(sorted(y0), sorted(y1))]
    assert np.mean(moved) < 0


def test_the_grid_wraps_after_one_extent():
    g = geom(C(lattice="cartesian", cols=2, rows=2, extent_y_m=6.0,
               drift_y_mps=-2.0, edge_fade=0.001))
    a0 = g.state(0.0)
    a1 = g.state(3.0)          # 6 m of travel at 2 m/s: exactly one extent
    assert np.allclose(a0[0], a1[0], atol=1e-6)
    assert np.allclose(a0[1], a1[1], atol=1e-6)


def test_sources_fade_near_the_wrap_so_the_jump_is_not_a_click():
    g = geom(C(lattice="cartesian", cols=1, rows=1, extent_y_m=8.0,
               drift_y_mps=-1.0, edge_fade=0.2))
    lv = [g.state(t)[2][0] for t in np.linspace(0, 8, 81)]
    assert min(lv) < 0.05
    assert max(lv) > 0.95


def test_drift_direction_is_independent_on_each_axis():
    g = geom(C(lattice="cartesian", cols=1, rows=1, drift_x_mps=1.0))
    x0, y0 = xy(*g.state(0.0)[:2])
    x1, y1 = xy(*g.state(0.5)[:2])
    assert x1[0] > x0[0]
    assert y1[0] == pytest.approx(y0[0], abs=1e-6)


# ----------------------------------------------------------------------
# Radial flow: concentric rings closing in or opening out
# ----------------------------------------------------------------------

def test_concentric_rings_flow_inward_together():
    g = geom(C(lattice="polar", rings=3, per_ring=4, r_near_m=1.0, r_far_m=5.0,
               radial_speed_mps=-1.0))
    d0 = g.state(0.0)[1]
    d1 = g.state(0.5)[1]
    assert np.all(d1 < d0)


def test_radial_flow_recycles_at_the_limit():
    """A ring reaching the inner limit reappears at the outer one, so an
    inward flow is endless rather than emptying out."""
    g = geom(C(lattice="polar", rings=2, per_ring=3, r_near_m=1.0, r_far_m=5.0,
               radial_speed_mps=-1.0, edge_fade=0.001))
    span = 4.0
    assert np.allclose(g.state(0.0)[1], g.state(span / 1.0)[1], atol=1e-6)


def test_radial_flow_holds_azimuth_when_not_rotating():
    g = geom(C(lattice="polar", rings=2, per_ring=5, radial_speed_mps=0.8))
    assert np.allclose(g.state(0.0)[0], g.state(2.0)[0])


# ----------------------------------------------------------------------
# Whirlpool: rotation and radial flow combined, rates varying with radius
# ----------------------------------------------------------------------

def test_inner_rings_can_turn_faster_than_outer_ones():
    c = C(lattice="polar", rings=2, per_ring=1, r_near_m=1.0, r_far_m=4.0,
          rotation_deg_per_sec=120.0, rotation_outer_deg_per_sec=30.0)
    assert c.rate_at(1.0) == pytest.approx(120.0)
    assert c.rate_at(4.0) == pytest.approx(30.0)
    assert c.rate_at(2.5) == pytest.approx(75.0)


def test_a_whirlpool_turns_and_closes_in_at_once():
    g = geom(C(lattice="polar", rings=3, per_ring=4, r_near_m=0.8, r_far_m=5.0,
               rotation_deg_per_sec=140.0, rotation_outer_deg_per_sec=40.0,
               radial_speed_mps=-0.6))
    a0, d0, _ = g.state(0.0)
    a1, d1, _ = g.state(1.0)
    assert np.all(d1 < d0)                       # everything closing in
    advance = (a1 - a0) % 360.0
    assert advance.max() - advance.min() > 50    # inner outruns outer


def test_a_single_rate_rotates_the_lattice_rigidly():
    g = geom(C(lattice="polar", rings=3, per_ring=4, rotation_deg_per_sec=90.0))
    advance = (g.state(1.0)[0] - g.state(0.0)[0]) % 360.0
    assert np.allclose(advance, 90.0)


# ----------------------------------------------------------------------
# Distance reaching the head
# ----------------------------------------------------------------------

def test_a_source_at_the_centre_produces_no_interaural_difference():
    """Both ears are equidistant from the head centre, so the image collapses
    to mono. This is why nothing swings wildly as a source passes close."""
    g = geom(C(lattice="polar", rings=1, per_ring=1, r_near_m=0.0, r_far_m=0.0))
    gains = g.ear_gains(np.array([37.0]), np.array([0.0]), 0.0875)
    assert gains[0, 0] == pytest.approx(gains[0, 1], rel=1e-9)


def test_the_level_difference_grows_as_a_source_approaches():
    """Near-field growth: the ratio between the ears rises steeply close in,
    then collapses to unity exactly at the centre where both are equidistant.

    Read as a ratio rather than a difference, since the loudness ceiling scales
    the pair together and would otherwise confound the comparison.
    """
    g = geom(C(lattice="polar", rings=1, per_ring=1))
    def ratio(r):
        gg = g.ear_gains(np.array([90.0]), np.array([r]), 0.0875)
        return gg[0, 1] / gg[0, 0]
    assert ratio(0.0) == pytest.approx(1.0, abs=1e-9)   # centred: no difference
    assert ratio(0.3) > ratio(1.0) > ratio(4.0)         # grows on approach
    assert ratio(4.0) > 1.0


def test_ear_gain_is_capped_so_the_centre_is_not_deafening():
    g = geom(C(lattice="polar", rings=1, per_ring=1))
    gains = g.ear_gains(np.array([0.0]), np.array([0.0]), 0.0875, max_gain=4.0)
    assert np.all(gains <= 4.0 + 1e-9)


def test_distance_zero_renders_without_blowing_up(hrtf, signal):
    cfg = rf.FieldConfig(components=[C(
        lattice="polar", rings=1, per_ring=3, r_near_m=0.0, r_far_m=0.0,
        min_distance_m=0.0)])
    y = rf.render(signal, hrtf, cfg, FS)
    assert np.all(np.isfinite(y))
    assert np.max(np.abs(y)) <= 1.0


def test_a_grid_may_pass_through_the_listener(hrtf, signal):
    """Driving forward through a field of sources is the motivating image, and
    it requires sources to pass arbitrarily close without artefacts."""
    cfg = rf.FieldConfig(components=[C(
        lattice="cartesian", cols=3, rows=3, extent_x_m=4.0, extent_y_m=8.0,
        drift_y_mps=-2.0, min_distance_m=0.0)])
    y = rf.render(signal, hrtf, cfg, FS)
    assert np.all(np.isfinite(y))


# ----------------------------------------------------------------------
# Freezing
# ----------------------------------------------------------------------

@pytest.mark.parametrize("comp", [
    C(lattice="polar", rings=2, per_ring=4, rotation_deg_per_sec=90.0),
    C(lattice="polar", rings=3, per_ring=4, radial_speed_mps=-1.0),
    C(lattice="polar", rings=3, per_ring=4, rotation_deg_per_sec=120.0,
      rotation_outer_deg_per_sec=30.0, radial_speed_mps=-0.5),
    C(lattice="cartesian", cols=3, rows=3, drift_y_mps=-1.5),
    C(lattice="cartesian", cols=3, rows=3, drift_x_mps=1.0, drift_y_mps=-1.0),
    C(lattice="polar", rings=1, per_ring=4, random_fraction=1.0),
])
def test_frozen_components_do_not_move(comp):
    g = rf.FieldGeometry(rf.FieldConfig(components=[comp.frozen()]))
    a0, d0, l0 = g.state(0.0)
    a1, d1, l1 = g.state(5.0)
    assert np.allclose(a0, a1) and np.allclose(d0, d1) and np.allclose(l0, l1)


@pytest.mark.parametrize("moving", [
    C(lattice="cartesian", cols=4, rows=4, drift_y_mps=-2.0),
    C(lattice="polar", rings=4, per_ring=5, r_near_m=0.5, r_far_m=6.0,
      radial_speed_mps=-0.8),
    C(lattice="polar", rings=3, per_ring=4, rotation_deg_per_sec=90.0),
])
def test_freezing_preserves_the_spatial_and_level_distribution(moving):
    """A control that differed in level distribution would not be a control.

    This is why freezing stops the clock instead of the rates: zeroing the
    drift would also remove the edge fade that a wrapping lattice carries, and
    the control would come out louder at the edges than the thing it controls
    for.
    """
    a = rf.FieldGeometry(rf.FieldConfig(components=[moving])).state(0.0)
    b = rf.FieldGeometry(rf.FieldConfig(components=[moving.frozen()])).state(0.0)
    for x, y in zip(a, b):
        assert np.allclose(x, y)


def test_freezing_leaves_the_configured_motion_readable():
    """The rates stay on the config so the interface can still show what the
    control is a control for."""
    moving = C(lattice="cartesian", cols=2, rows=2, drift_y_mps=-2.0)
    frozen = moving.frozen()
    assert frozen.drift_y_mps == -2.0
    assert frozen.time_scale == 0.0
    assert frozen.is_static()


def test_a_frozen_variant_is_recognised_as_the_control_for_its_original():
    """Freezing is the documented way to build a control, so the pairing has
    to survive it.

    The two routes to a static field produce different configurations: zeroing
    the rates leaves time_scale at 1, while freezing leaves the rates alone and
    stops the clock. Both have to land on the same control identity, or the
    comparison the listener set up is never reported as a paired one.
    """
    from app import ComponentIn, FieldIn, _control_key, _has_motion

    moving = C(lattice="polar", rings=3, per_ring=6, rotation_deg_per_sec=60.0,
               radial_speed_mps=-0.5)
    as_in = lambda c: FieldIn(components=[ComponentIn(**_component_fields(c))])

    m = as_in(moving)
    f = as_in(moving.frozen())
    z = as_in(replace(moving, rotation_deg_per_sec=0.0, radial_speed_mps=0.0))

    assert _has_motion(m)
    assert not _has_motion(f) and not _has_motion(z)
    assert _control_key(m) == _control_key(f), "frozen control lost its pairing"
    assert _control_key(m) == _control_key(z)


def _component_fields(c):
    """The ComponentIn fields present on a ComponentConfig."""
    from app import ComponentIn
    return {k: getattr(c, k) for k in ComponentIn.model_fields if hasattr(c, k)}


@pytest.mark.parametrize("comp,static", [
    (C(rotation_deg_per_sec=0.0), True),
    (C(rotation_deg_per_sec=30.0), False),
    (C(rotation_outer_deg_per_sec=20.0), False),
    (C(radial_speed_mps=0.5), False),
    (C(lattice="cartesian", drift_y_mps=-1.0), False),
    (C(random_fraction=0.5, wander_hz=0.3), False),
    (C(random_fraction=0.5, wander_hz=0.0), True),
])
def test_static_detection(comp, static):
    assert comp.is_static() is static


# ----------------------------------------------------------------------
# Randomness on any lattice
# ----------------------------------------------------------------------

def test_random_share_applies_to_a_grid_as_well_as_a_ring():
    g = geom(C(lattice="cartesian", cols=3, rows=2, drift_y_mps=-1.0,
               random_fraction=0.5, wander_deg=40.0))
    assert sum(1 for s in g._src if s["random"]) == 3


def test_wander_is_deterministic_under_seed():
    mk = lambda s: rf.FieldGeometry(rf.FieldConfig(seed=s, components=[
        C(lattice="polar", rings=1, per_ring=4, random_fraction=1.0)]))
    t = np.linspace(0, 4, 30)
    a = np.array([mk(1).state(x)[0] for x in t])
    b = np.array([mk(1).state(x)[0] for x in t])
    c = np.array([mk(2).state(x)[0] for x in t])
    assert np.array_equal(a, b) and not np.array_equal(a, c)


# ----------------------------------------------------------------------
# Per-component decorrelation and reporting
# ----------------------------------------------------------------------

def test_each_component_can_carry_its_own_decorrelation():
    cfg = rf.FieldConfig(components=[
        C(lattice="polar", rings=1, per_ring=2, decorr=rf.DecorrConfig(amount=0.0)),
        C(lattice="polar", rings=1, per_ring=3,
          decorr=rf.DecorrConfig(amount=1.0, family="allpass")),
    ], decorr=rf.DecorrConfig(amount=0.5))
    per = cfg.per_source_decorr()
    assert [d.amount for d in per] == [0.0, 0.0, 1.0, 1.0, 1.0]
    assert [d.family for d in per] == ["velvet"] * 2 + ["allpass"] * 3


def test_mixed_components_render_and_report(hrtf, signal):
    cfg = rf.FieldConfig(components=[
        C(lattice="polar", rings=2, per_ring=3, rotation_deg_per_sec=50.0,
          label="whirl"),
        C(lattice="cartesian", cols=3, rows=2, drift_y_mps=-1.2, label="drift"),
    ])
    trace = []
    y = rf.render(signal, hrtf, cfg, FS, trace=trace)
    assert y.shape == (len(signal), 2)
    assert len(trace[0]["az"]) == 12
    d = rf.config_dict(cfg)
    assert d["component_labels"] == ["whirl", "drift"]
    assert d["component_sources"] == [6, 6]
    assert d["resolved_component_of"] == [0] * 6 + [1] * 6
    assert d["resolved_shade_of"][:6] == [0, 0, 0, 1, 1, 1]   # ring index
    assert d["component_shades"] == [2, 2]


def test_component_gain_scales_that_component_only(hrtf, signal):
    loud = rf.FieldConfig(components=[C(lattice="polar", rings=1, per_ring=2)])
    quiet = rf.FieldConfig(components=[
        C(lattice="polar", rings=1, per_ring=2, gain_db=-12.0)])
    yl = rf.render(signal, hrtf, loud, FS, normalize=False)
    yq = rf.render(signal, hrtf, quiet, FS, normalize=False)
    db = 20 * np.log10(np.sqrt(np.mean(yl ** 2) / np.mean(yq ** 2)))
    assert db == pytest.approx(12.0, abs=0.5)
