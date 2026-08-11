"""Multi-ring fields, distance, and kinematogram-style random motion.

The compatibility constraint matters most: rings=None must leave every legacy
code path bit-identical, and a single ring at the reference distance with no
wander must reproduce the legacy render exactly, or every number measured so
far silently stops applying.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ringfield as rf
from sweep import make_test_signal

FS = 44100
AZ5 = [-90, -18, 54, 126, 198]


@pytest.fixture(scope="module")
def signal():
    return make_test_signal(FS, 3.0)


@pytest.fixture(scope="module")
def hrtf():
    return rf.AnalyticHRTF(fs=FS)


# ----------------------------------------------------------------------
# Compatibility
# ----------------------------------------------------------------------

def test_single_reference_ring_reproduces_the_legacy_render(hrtf, signal):
    legacy = rf.FieldConfig(n_sources=5, rotation_deg_per_sec=60.0,
                            start_azimuths=AZ5, seed=3)
    ringed = rf.FieldConfig(seed=3, rings=[rf.RingConfig(
        n_sources=5, rotation_deg_per_sec=60.0, start_azimuths=AZ5)])
    a = rf.render(signal, hrtf, legacy, FS, normalize=False)
    b = rf.render(signal, hrtf, ringed, FS, normalize=False)
    assert np.array_equal(a, b)


def test_reference_distance_applies_no_ear_gains(signal):
    geom = rf.FieldGeometry(rf.FieldConfig(rings=[rf.RingConfig(n_sources=4)]))
    assert not geom.uses_distance


# ----------------------------------------------------------------------
# Distance
# ----------------------------------------------------------------------

def test_distant_ring_renders_quieter(hrtf, signal):
    near = rf.FieldConfig(rings=[rf.RingConfig(n_sources=3, distance_m=1.0)])
    far = rf.FieldConfig(rings=[rf.RingConfig(n_sources=3, distance_m=4.0)])
    yn = rf.render(signal, hrtf, near, FS, normalize=False)
    yf = rf.render(signal, hrtf, far, FS, normalize=False)
    ratio = np.sqrt(np.mean(yn ** 2) / np.mean(yf ** 2))
    # 1 m vs 4 m under a 1/d law is a factor of 4, before head geometry.
    assert ratio == pytest.approx(4.0, rel=0.15)


def test_near_field_boosts_ild(hrtf, signal):
    """A close lateral source should show a larger level difference between
    the ears than a far one, beyond what the shadow filter provides."""
    def lr_ratio(dist):
        cfg = rf.FieldConfig(rings=[rf.RingConfig(
            n_sources=1, rotation_deg_per_sec=0.0, start_azimuths=[90.0],
            distance_m=dist)])
        y = rf.render(signal, hrtf, cfg, FS, normalize=False)
        return np.sqrt(np.mean(y[:, 1] ** 2) / (np.mean(y[:, 0] ** 2) + 1e-20))

    assert lr_ratio(0.4) > lr_ratio(3.0) * 1.15


def test_ear_gain_geometry_is_symmetric():
    geom = rf.FieldGeometry(rf.FieldConfig(rings=[rf.RingConfig(
        n_sources=2, start_azimuths=[90.0, -90.0], distance_m=1.0)]))
    g = geom.ear_gains(np.array([90.0, -90.0]), np.array([1.0, 1.0]), 0.0875)
    assert g[0, 1] > g[0, 0]          # source right: right ear closer
    assert g[1, 0] > g[1, 1]          # source left: left ear closer
    assert g[0, 1] == pytest.approx(g[1, 0], rel=1e-9)


def test_median_plane_ear_gains_are_equal():
    geom = rf.FieldGeometry(rf.FieldConfig(rings=[rf.RingConfig(
        n_sources=1, start_azimuths=[0.0], distance_m=0.5)]))
    g = geom.ear_gains(np.array([0.0]), np.array([0.5]), 0.0875)
    assert g[0, 0] == pytest.approx(g[0, 1], rel=1e-9)


# ----------------------------------------------------------------------
# Random motion
# ----------------------------------------------------------------------

def test_random_fraction_splits_movers_and_wanderers():
    """Half the ring should advance with the rotation and half should not."""
    cfg = rf.FieldConfig(rings=[rf.RingConfig(
        n_sources=6, rotation_deg_per_sec=90.0, random_fraction=0.5)])
    geom = rf.FieldGeometry(cfg)
    advance = (geom.azimuths(2.0) - geom.azimuths(0.0)) % 360.0
    movers = int(np.sum(np.abs(advance - 180.0) < 1.0))
    assert movers == 3
    assert geom.n - movers == 3


def test_wander_is_deterministic_and_seed_dependent():
    mk = lambda s: rf.FieldGeometry(rf.FieldConfig(seed=s, rings=[rf.RingConfig(
        n_sources=4, random_fraction=1.0, wander_deg=60.0)]))
    a, b, c = mk(1), mk(1), mk(2)
    t = np.linspace(0, 5, 40)
    az_a = np.array([a.azimuths(x) for x in t])
    az_b = np.array([b.azimuths(x) for x in t])
    az_c = np.array([c.azimuths(x) for x in t])
    assert np.array_equal(az_a, az_b)
    assert not np.array_equal(az_a, az_c)


def test_wander_is_smooth_and_bounded():
    geom = rf.FieldGeometry(rf.FieldConfig(rings=[rf.RingConfig(
        n_sources=3, rotation_deg_per_sec=0.0,
        random_fraction=1.0, wander_deg=60.0, wander_hz=0.25)]))
    base = rf.RingConfig(n_sources=3).resolved_azimuths()
    t = np.arange(0, 10, 0.01)
    az = np.array([geom.azimuths(x) for x in t])
    excursion = np.abs(az - base)
    assert np.max(excursion) <= 60.0 * 1.01      # weights sum to the amplitude
    steps = np.abs(np.diff(az, axis=0))
    assert np.max(steps) < 3.0                    # no jumps at 100 Hz sampling


def test_wanderers_have_no_net_rotation():
    geom = rf.FieldGeometry(rf.FieldConfig(rings=[rf.RingConfig(
        n_sources=4, rotation_deg_per_sec=120.0, random_fraction=1.0)]))
    early = geom.azimuths(0.0)
    late = geom.azimuths(30.0)
    assert np.max(np.abs(late - early)) < 130.0   # bounded, not 3600 degrees on


def test_radial_wander_moves_distance_and_flags_it():
    cfg = rf.FieldConfig(rings=[rf.RingConfig(
        n_sources=2, radial_wander_m=0.8)])
    geom = rf.FieldGeometry(cfg)
    assert geom.uses_distance
    d = np.array([geom.distances(t) for t in np.linspace(0, 8, 60)])
    assert np.std(d) > 0.05
    assert np.min(d) >= 0.2


# ----------------------------------------------------------------------
# Composition
# ----------------------------------------------------------------------

def test_two_rings_compose(hrtf, signal):
    cfg = rf.FieldConfig(rings=[
        rf.RingConfig(n_sources=3, distance_m=1.2, rotation_deg_per_sec=40.0),
        rf.RingConfig(n_sources=5, distance_m=3.5, rotation_deg_per_sec=-90.0),
    ])
    geom = rf.FieldGeometry(cfg)
    assert geom.n == 8
    assert geom.comp_of == [0, 0, 0, 1, 1, 1, 1, 1]
    trace = []
    y = rf.render(signal, hrtf, cfg, FS, trace=trace)
    assert y.shape == (len(signal), 2)
    assert len(trace[0]["az"]) == 8
    assert len(trace[0]["dist"]) == 8
    # opposite rotation directions
    d_inner = trace[10]["az"][0] - trace[0]["az"][0]
    d_outer = trace[10]["az"][4] - trace[0]["az"][4]
    assert d_inner > 0 and d_outer < 0


def test_ring_level_decorr_override_reaches_the_bank(signal):
    cfg = rf.FieldConfig(rings=[
        rf.RingConfig(n_sources=2, decorr_amount=0.0),
        rf.RingConfig(n_sources=3),
    ], decorr=rf.DecorrConfig(amount=1.0))
    d = cfg.resolved_decorr()
    assert d.per_source_amount == [0.0, 0.0, 1.0, 1.0, 1.0]


def test_config_dict_reports_ring_structure():
    cfg = rf.FieldConfig(rings=[
        rf.RingConfig(n_sources=2, distance_m=1.0),
        rf.RingConfig(n_sources=3, distance_m=3.0),
    ])
    d = rf.config_dict(cfg)
    assert len(d["rings"]) == 2
    assert d["resolved_ring_of"] == [0, 0, 1, 1, 1]
    assert d["resolved_distances"] == [1.0, 1.0, 3.0, 3.0, 3.0]
    assert len(d["resolved_gains_db"]) == 5


def test_ring_gain_unbalances_the_field(hrtf, signal):
    quiet = rf.FieldConfig(rings=[rf.RingConfig(n_sources=3, gain_db=-12.0)])
    loud = rf.FieldConfig(rings=[rf.RingConfig(n_sources=3, gain_db=0.0)])
    yq = rf.render(signal, hrtf, quiet, FS, normalize=False)
    yl = rf.render(signal, hrtf, loud, FS, normalize=False)
    db = 20 * np.log10(np.sqrt(np.mean(yl ** 2) / np.mean(yq ** 2)))
    assert db == pytest.approx(12.0, abs=0.5)
