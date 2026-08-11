"""A source passing through the listener must not click.

The stored HRIRs are far-field, so without correction a source crossing the
centre keeps a full interaural delay while its azimuth swings almost instantly,
and the delay flips sign between blocks. That is audible.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ringfield as rf
from sweep import make_test_signal

FS = 44100
G = rf.FieldGeometry
C = rf.ComponentConfig


def test_cues_collapse_to_centre_at_the_head():
    """At the centre both ears are equidistant, so the source must read as
    straight ahead rather than hard to one side."""
    eff = G.effective_azimuths(np.array([90.0]), np.array([0.0]), 0.0875)
    assert eff[0] == pytest.approx(0.0, abs=1e-9)


def test_cues_are_untouched_beyond_the_collapse_radius():
    az = np.array([90.0, -45.0, 200.0])
    dist = np.array([2.0, 3.0, 5.0])
    eff = G.effective_azimuths(az, dist, 0.0875)
    assert eff[0] == pytest.approx(90.0, abs=1e-6)
    assert eff[1] == pytest.approx(-45.0, abs=1e-6)
    # 200 deg is behind; the model is front-back symmetric, so its mirror is used
    assert abs(np.sin(np.deg2rad(eff[2])) - np.sin(np.deg2rad(200.0))) < 1e-6


def test_the_collapse_is_monotonic_in_distance():
    d = np.linspace(0.0, 0.5, 40)
    eff = G.effective_azimuths(np.full_like(d, 90.0), d, 0.0875)
    assert np.all(np.diff(eff) >= -1e-9)
    assert eff[0] < eff[-1]


def test_side_is_preserved_while_collapsing():
    for a in (30.0, -30.0, 120.0, -120.0):
        eff = G.effective_azimuths(np.array([a]), np.array([0.15]), 0.0875)
        assert np.sign(np.sin(np.deg2rad(eff[0]))) == np.sign(np.sin(np.deg2rad(a)))


def test_a_source_crossing_the_centre_does_not_flip_abruptly():
    """The failure this guards against: azimuth swinging 180 degrees between
    adjacent blocks with full cues attached."""
    g = G(rf.FieldConfig(components=[C(
        lattice="cartesian", cols=1, rows=1, extent_x_m=0.001, extent_y_m=8.0,
        drift_y_mps=-2.0, min_distance_m=0.0)]))
    ts = np.linspace(1.9, 2.1, 400)           # straight through the centre
    eff = []
    for t in ts:
        az, dist, _ = g.state(t)
        eff.append(G.effective_azimuths(az, dist, 0.0875)[0])
    eff = np.array(eff)
    lateral = np.sin(np.deg2rad(eff))         # what the interaural cue follows
    assert np.max(np.abs(np.diff(lateral))) < 0.25


def test_the_raw_azimuth_really_does_swing_without_the_correction():
    """Confirms the correction is doing work rather than the trajectory being
    gentle on its own."""
    g = G(rf.FieldConfig(components=[C(
        lattice="cartesian", cols=1, rows=1, extent_x_m=0.001, extent_y_m=8.0,
        drift_y_mps=-2.0, min_distance_m=0.0)]))
    raw = np.array([g.state(t)[0][0] for t in np.linspace(1.9, 2.1, 400)])
    assert np.max(np.abs(np.diff(np.unwrap(np.deg2rad(raw))))) > 0.5


def test_a_grid_passing_through_renders_without_a_step(hrtf, signal):
    """Sample-to-sample jumps in the output are what a click is."""
    cfg = rf.FieldConfig(components=[C(
        lattice="cartesian", cols=2, rows=2, extent_x_m=0.5, extent_y_m=6.0,
        drift_y_mps=-3.0, min_distance_m=0.0)],
        decorr=rf.DecorrConfig(amount=0.0))
    y = rf.render(signal, hrtf, cfg, FS, normalize=False)
    still = rf.FieldConfig(components=[C(
        lattice="cartesian", cols=2, rows=2, extent_x_m=0.5, extent_y_m=6.0,
        drift_y_mps=0.0, min_distance_m=0.0)],
        decorr=rf.DecorrConfig(amount=0.0))
    ref = rf.render(signal, hrtf, still, FS, normalize=False)
    # the moving version must not introduce jumps far beyond the static one
    assert np.max(np.abs(np.diff(y, axis=0))) < 4 * np.max(np.abs(np.diff(ref, axis=0)))


def test_distant_rendering_is_unaffected(hrtf, signal):
    """The correction must not touch anything at ordinary listening distance."""
    cfg = rf.FieldConfig(components=[C(
        lattice="polar", rings=1, per_ring=4, r_near_m=2.0, r_far_m=2.0,
        rotation_deg_per_sec=60.0)])
    az = np.array([0.0, 90.0, 180.0, 270.0])
    dist = np.full(4, 2.0)
    eff = G.effective_azimuths(az, dist, 0.0875)
    assert np.allclose(np.sin(np.deg2rad(eff)), np.sin(np.deg2rad(az)), atol=1e-9)


@pytest.fixture(scope="module")
def hrtf():
    return rf.AnalyticHRTF(fs=FS)


@pytest.fixture(scope="module")
def signal():
    return make_test_signal(FS, 3.0)
