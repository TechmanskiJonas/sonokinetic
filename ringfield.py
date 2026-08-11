"""
ringfield.py — binaural renderer for rotating fields of decorrelated sources.

Research question this exists to probe:
    Can a listener perceive a field as ROTATING without localizing any
    individual source in it? The knobs that matter are (a) how many sources
    are in the ring, (b) how fast the ring circulates, and (c) how coherent
    the sources are with each other.

Design:
    HRTFProvider  -> gives you an HRIR pair for any azimuth. Two flavors:
                     AnalyticHRTF (spherical head, works with zero downloads)
                     SofaHRTF     (drop in measured HRTFs later)
    decorrelate() -> turns one mono signal into N variants of controllable
                     mutual coherence
    render()      -> block-based time-varying convolution, moving sources
    iacc()        -> objective coherence measure of the binaural output

The DSP core (marked CORE) is the part worth understanding line by line.
Everything else is plumbing.
"""

from dataclasses import dataclass, field, replace, asdict
from typing import Any, Dict, List, Optional
import numpy as np
from scipy.signal import lfilter, fftconvolve
from scipy.signal.windows import hann
import soundfile as sf

C_SOUND = 343.0      # m/s
HEAD_RADIUS = 0.0875  # m, standard anthropometric mean


# ----------------------------------------------------------------------
# CORE 1: HRTF models
# ----------------------------------------------------------------------

def woodworth_itd(azimuth_deg: float, a: float = HEAD_RADIUS,
                  c: float = C_SOUND) -> float:
    """Interaural time difference in seconds. Positive => left ear lags.

    Woodworth's ray-tracing approximation. Note this model is front-back
    symmetric, so it produces genuine front-back confusion. Real HRTFs
    resolve that with pinna spectral cues, which is one concrete reason to
    swap in measured data later.

    `a` is head radius and is the model's only anthropometric parameter: it
    scales the entire ITD curve and sets the shadow filter's corner frequency.
    """
    th = np.deg2rad(((azimuth_deg + 180.0) % 360.0) - 180.0)
    if th > np.pi / 2:
        th = np.pi - th
    elif th < -np.pi / 2:
        th = -np.pi - th
    return (a / c) * (th + np.sin(th))


def head_shadow_coeffs(theta_inc_deg: float, fs: int, a: float = HEAD_RADIUS,
                       c: float = C_SOUND):
    """Brown & Duda (1998) one-pole/one-zero head-shadow filter.

    theta_inc_deg is the angle between the source and that ear's outward
    normal: 0 deg = source pointing straight at the ear, 180 deg = fully
    shadowed. High-frequency gain of this filter equals alpha, which runs
    from 2.0 (ipsilateral, +6 dB) to 0.1 (contralateral, -20 dB). That
    frequency-dependent gain difference IS the ILD cue.
    """
    alpha_min, theta_min = 0.1, 150.0
    alpha = (1 + alpha_min / 2) + (1 - alpha_min / 2) * np.cos(
        np.deg2rad(theta_inc_deg / theta_min * 180.0)
    )
    w0 = c / a
    k_num, k_den = alpha * fs / w0, fs / w0
    b = np.array([1 + k_num, 1 - k_num])
    a_ = np.array([1 + k_den, 1 - k_den])
    return b / a_[0], a_ / a_[0]


def frac_delay_ir(delay_samples: float, n_taps: int) -> np.ndarray:
    """Windowed-sinc fractional delay. CORE: this is what carries the ITD."""
    m = np.arange(n_taps) - delay_samples
    half = n_taps / 2.0
    # Hann window centred ON the delay. Centring it on the array instead
    # truncates the sinc asymmetrically and destroys the high end.
    w = np.where(np.abs(m) < half, 0.5 * (1 + np.cos(np.pi * m / half)), 0.0)
    return np.sinc(m) * w


class AnalyticHRTF:
    """Spherical-head HRTF synthesized on demand. No dataset required.

    Gives you correct ITD and a plausible ILD. Missing: pinna cues,
    elevation, individualization. Good enough to hear rotation clearly.
    """

    def __init__(self, fs: int = 44100, n_taps: int = 128, grid_step: float = 1.0,
                 head_radius: float = HEAD_RADIUS, speed_of_sound: float = C_SOUND):
        self.fs, self.n_taps = fs, n_taps
        self.head_radius = head_radius
        self.speed_of_sound = speed_of_sound
        self.grid_step = grid_step
        self.grid = np.arange(0, 360, grid_step)
        self._table = np.stack([self._synth(az) for az in self.grid])  # (A, 2, taps)

    def _synth(self, azimuth_deg: float) -> np.ndarray:
        itd = woodworth_itd(azimuth_deg, self.head_radius, self.speed_of_sound)
        base = self.n_taps // 2
        d_l = base + 0.5 * itd * self.fs
        d_r = base - 0.5 * itd * self.fs

        # angle of incidence at each ear (left ear normal points to -90 deg)
        inc_l = abs(((azimuth_deg + 90.0 + 180.0) % 360.0) - 180.0)
        inc_r = abs(((azimuth_deg - 90.0 + 180.0) % 360.0) - 180.0)

        out = []
        for d, inc in ((d_l, inc_l), (d_r, inc_r)):
            ir = frac_delay_ir(d, self.n_taps)
            b, a = head_shadow_coeffs(inc, self.fs, self.head_radius,
                                      self.speed_of_sound)
            out.append(lfilter(b, a, ir))
        return np.stack(out)

    def hrir(self, azimuth_deg: float) -> np.ndarray:
        idx = int(round((azimuth_deg % 360.0) / (self.grid[1] - self.grid[0])))
        return self._table[idx % len(self.grid)]


class SofaHRTF:
    """Drop-in for measured HRTFs. Requires: pip install sofar

    Grab a SOFA file from SADIE II (KU100 or KEMAR) or SONICOM, point this
    at it, and everything downstream is unchanged. Uses nearest-neighbour
    on the horizontal plane; upgrade to ITD-aligned interpolation later.
    """

    def __init__(self, sofa_path: str, fs: int = 44100, elevation_tol: float = 5.0):
        import sofar
        s = sofar.read_sofa(sofa_path)
        self.fs = int(s.Data_SamplingRate)
        if self.fs != fs:
            raise ValueError(f"SOFA fs={self.fs}, renderer fs={fs}. Resample first.")
        pos, ir = s.SourcePosition, s.Data_IR
        horiz = np.abs(pos[:, 1]) < elevation_tol
        self.az = pos[horiz, 0] % 360.0
        self._table = ir[horiz]           # (A, 2, taps)
        self.n_taps = self._table.shape[-1]
        order = np.argsort(self.az)
        self.az, self._table = self.az[order], self._table[order]

    def hrir(self, azimuth_deg: float) -> np.ndarray:
        idx = int(np.argmin(np.abs(self.az - (azimuth_deg % 360.0))))
        return self._table[idx]


# ----------------------------------------------------------------------
# CORE 2: decorrelation
# ----------------------------------------------------------------------

def ir_envelope(n: int, envelope: str = "flat", decay_db: float = 60.0) -> np.ndarray:
    """Amplitude envelope over a decorrelation IR.

    Split out as its own control because the two prefabs differed in envelope
    as well as in density: velvet was flat and allpass was Hann-windowed. That
    made the two impossible to compare on density alone, since the window was
    quietly changing the effective IR length at the same time.

    flat  : full-length, maximum decorrelation for a given duration
    hann  : tapered both ends, shorter effective smear
    decay : exponential, what a real diffuse field's envelope looks like
    """
    if envelope == "hann":
        return np.hanning(n)
    if envelope == "decay":
        return 10 ** (-decay_db * np.arange(n) / max(n, 1) / 20.0)
    return np.ones(n)


def velvet_ir(fs: int, dur: float = 0.030, density: float = 1500.0,
              rng: Optional[np.random.Generator] = None,
              envelope: str = "flat", decay_db: float = 60.0) -> np.ndarray:
    """Velvet noise: sparse +/-1 impulses on a jittered grid.

    Current best practice for decorrelation because it is spectrally flat
    and perceptually near-colourless, unlike delay- or comb-based methods.
    Valimaki et al. are the reference here.

    density is the continuum: sparse impulses at one end, and as it approaches
    fs every sample carries an impulse and the IR becomes a random sign
    sequence, which is the allpass case.
    """
    rng = rng or np.random.default_rng()
    n = int(dur * fs)
    ir = np.zeros(n)
    td = max(fs / density, 1e-9)
    for m in range(int(n / td)):
        pos = int(round(m * td + rng.random() * max(td - 1, 0.0)))
        if pos < n:
            ir[pos] = 1.0 if rng.random() > 0.5 else -1.0
    ir[0] = 1.0
    ir = ir * ir_envelope(n, envelope, decay_db)
    return ir / np.sqrt(np.sum(ir ** 2) + 1e-20)


def allpass_noise_ir(fs: int, dur: float = 0.030,
                     rng: Optional[np.random.Generator] = None,
                     depth: float = 1.0, envelope: str = "hann",
                     decay_db: float = 60.0) -> np.ndarray:
    """Random-phase allpass IR: flat magnitude, scrambled phase.

    Preserves the source's magnitude spectrum exactly while destroying
    inter-source phase coherence. Smears transients more than velvet does.

    depth scales the phase scramble from 0 (identity, no decorrelation at all)
    to 1 (full +/-pi). Partial scrambling is a continuous axis rather than the
    on/off the prefab implied.
    """
    rng = rng or np.random.default_rng()
    n = int(dur * fs)
    spec = np.exp(1j * depth * rng.uniform(-np.pi, np.pi, n // 2 + 1))
    spec[0] = 1.0
    if n % 2 == 0:
        spec[-1] = 1.0
    ir = np.fft.irfft(spec, n) * ir_envelope(n, envelope, decay_db)
    return ir / np.sqrt(np.sum(ir ** 2) + 1e-20)


# ----------------------------------------------------------------------
# CORE 2b: decorrelation as orthogonal controls
#
# `method="velvet"` and `method="allpass"` were a black box with two values.
# What actually matters is the resulting inter-source coherence structure; the
# filter design is only how it gets realised. These controls are the axes of
# that realisation, kept separable so each can be moved on its own.
#
# Velvet at very high density approaches the allpass case, so the two prefabs
# are two points on one continuum rather than two categories.
# ----------------------------------------------------------------------

@dataclass
class DecorrConfig:
    """How one mono signal becomes N mutually incoherent variants.

    amount is the master dry/wet knob. Everything else shapes what "wet" means.
    Every control preserves per-source level: see SourceBank._gain.
    """
    amount: float = 1.0
    per_source_amount: Optional[List[float]] = None

    family: str = "velvet"      # velvet | allpass | none
    ir_ms: float = 30.0         # temporal smearing
    density: float = 1500.0     # impulses/sec, velvet only. High -> noise-like
    phase_depth: float = 1.0    # allpass only, 0..1 scale on the phase scramble

    # IR envelope, orthogonal to family. "auto" keeps each prefab's historical
    # shape (velvet flat, allpass Hann) so existing renders reproduce; set it
    # explicitly to compare families on density alone.
    envelope: str = "auto"      # auto | flat | hann | decay
    decay_db: float = 60.0      # envelope="decay" only, fall across the IR

    # Frequency-dependent decorrelation. Decorrelating low frequencies gives a
    # vague, weak low end because the head does not shadow them, so standard
    # practice keeps bass coherent. The crossover is exposed rather than baked
    # in: whether that practice holds for a rotating field is an open question.
    crossovers: Optional[List[float]] = None      # Hz, ascending; C entries
    band_amounts: Optional[List[float]] = None    # C+1 entries, multiply amount

    # Cruder families, kept for comparison because they colour differently.
    micro_delay_ms: float = 0.0     # per-source delay spread
    micro_pitch_cents: float = 0.0  # per-source detune spread

    # Time-varying amount: coherence that breathes.
    lfo_hz: float = 0.0
    lfo_depth: float = 0.0
    lfo_source_spread: float = 0.0  # 0 = all sources in phase, 1 = spread over 2pi

    seed: int = 0

    def resolved_band_amounts(self) -> Optional[List[float]]:
        if not self.crossovers:
            return None
        n = len(self.crossovers) + 1
        if self.band_amounts and len(self.band_amounts) == n:
            return list(self.band_amounts)
        # Default: hold the lowest band coherent, decorrelate everything above.
        return [0.0] + [1.0] * (n - 1)


@dataclass
class HotspotConfig:
    """Coherence as a property of a DIRECTION, not of a source.

    The existing per_source_amount pins coherence to a source, so the coherent
    thing travels with the ring. Here the hotspot sweeps at its own rate and a
    source is coherent only while it is near it.

    Set rotation_deg_per_sec=0 on the field and deg_per_sec nonzero here and
    the sources do not move at all while the coherence structure rotates. That
    is the sharpest form of the hypothesis: rotation carried purely by the
    aggregate interaural statistics, with no source trajectory to track.
    """
    enabled: bool = False
    deg_per_sec: float = 60.0
    start_deg: float = 0.0
    width_deg: float = 60.0     # angular width of the coherent region
    hot_amount: float = 0.0     # decorrelation amount at the centre
    bed_amount: float = 1.0     # decorrelation amount far away
    shape: str = "gaussian"     # gaussian | cosine

    def weight(self, delta_deg: np.ndarray) -> np.ndarray:
        """Coherence weight vs angular distance from the hotspot centre."""
        w = np.maximum(self.width_deg, 1e-6)
        if self.shape == "cosine":
            d = np.clip(np.abs(delta_deg) / w, 0.0, 1.0)
            return 0.5 * (1.0 + np.cos(np.pi * d))
        return np.exp(-0.5 * (delta_deg / (w / 2.0)) ** 2)

    def amounts_at(self, azimuths_deg: np.ndarray, t: float) -> np.ndarray:
        centre = self.start_deg + self.deg_per_sec * t
        delta = (azimuths_deg - centre + 180.0) % 360.0 - 180.0
        w = self.weight(delta)
        return self.bed_amount + (self.hot_amount - self.bed_amount) * w


REF_DISTANCE = 2.0   # m. A source at this distance renders at unity gain.


@dataclass
class ComponentConfig:
    """One group of sources sharing a motion pattern. A variant is a list.

    Every kind is a trajectory in polar coordinates around the head, giving each
    source an azimuth, a distance, and a gain at every instant. Writing them as
    one mechanism rather than four means a component can combine motions:
    `spiral` is rotation and radial drift at once, and any kind can hand a share
    of its sources over to wandering.

        ring    sources on a circle, rotating at rotation_deg_per_sec
        stream  straight-line travel across the space along heading_deg,
                fading in and out at the ends of the path and recycling
        radial  travel along radii, inward or outward, fading at both ends
        spiral  rotation and radial travel together

    A stationary component is any kind with its rates at zero.

    Note what the head model can and cannot carry. Left-right motion moves both
    interaural cues strongly. Front-back motion moves neither: the model is
    front-back symmetric, and a source crossing the median plane keeps both ears
    equidistant throughout, so such a stream is heard through distance alone.
    See the reference entry on translation for what that implies for design.
    """
    kind: str = "ring"
    n_sources: int = 5
    label: str = ""

    # placement
    start_azimuths: Optional[List[float]] = None
    spacing_deg: Optional[float] = None
    offset_deg: float = 0.0
    distance_m: float = 2.0

    # rotation, used by ring and spiral
    rotation_deg_per_sec: float = 60.0

    # translation, used by stream
    heading_deg: float = 180.0       # direction of travel, 0 ahead, 90 right
    speed_mps: float = 1.5
    path_m: float = 9.0              # length of the run before recycling
    spread_m: float = 3.0            # lateral width of the flow

    # radial travel, used by radial and spiral
    radial_speed_mps: float = 0.0    # positive outward, negative inward
    r_near_m: float = 0.7
    r_far_m: float = 6.0

    # random motion, available to every kind
    random_fraction: float = 0.0
    wander_deg: float = 60.0
    wander_hz: float = 0.25
    radial_wander_m: float = 0.0

    # level
    gain_db: float = 0.0
    fade_frac: float = 0.3           # share of the path spent fading
    min_distance_m: float = 0.4      # keeps a passing source out of the head

    # Decorrelation for this component's sources. None inherits the variant's,
    # so two components can carry different coherence in one field.
    decorr: Optional["DecorrConfig"] = None

    def resolved_azimuths(self) -> np.ndarray:
        n = max(int(self.n_sources), 1)
        if self.start_azimuths:
            az = np.array(self.start_azimuths, dtype=float)
            if len(az) < n:
                az = np.tile(az, int(np.ceil(n / len(az))))
            return az[:n]
        if self.spacing_deg is not None:
            return self.offset_deg + np.arange(n) * self.spacing_deg
        return self.offset_deg + np.linspace(0, 360, n, endpoint=False)

    def is_static(self) -> bool:
        moving = abs(self.rotation_deg_per_sec) > 1e-9
        if self.kind in ("stream",):
            moving = moving or abs(self.speed_mps) > 1e-9
        if self.kind in ("radial", "spiral"):
            moving = moving or abs(self.radial_speed_mps) > 1e-9
        wandering = self.random_fraction > 0 and self.wander_hz > 0
        radial_wandering = self.radial_wander_m > 0 and self.wander_hz > 0
        return not (moving or wandering or radial_wandering)

    def frozen(self) -> "ComponentConfig":
        """The same component with every motion removed.

        A matched control has to hold the spatial and level distribution while
        removing movement, so rates go to zero and the oscillators stop rather
        than the component being deleted. Sources stay wherever their offsets
        place them, including partway through a fade.
        """
        return replace(self, rotation_deg_per_sec=0.0, speed_mps=0.0,
                       radial_speed_mps=0.0, wander_hz=0.0)


@dataclass
class RingConfig:
    """One ring of sources. Retained as the shorthand for a rotating component.

    distance_m sets the ring's radius from the head. Distance is carried by
    per-ear gains computed from the source-to-ear geometry, so nearby sources
    are louder and their ILD grows, including at low frequency, which is the
    near-field effect. Propagation delay, air absorption and reverberation are
    not modelled, so this is a deliberately thin distance cue: see the
    reference entry for what real distance hearing uses.

    random_fraction assigns that share of the ring's sources to smooth, seeded
    wandering instead of rotation, after the coherence manipulation in
    random-dot kinematograms. Wander is bounded around each source's base
    azimuth and reproducible from the seed.
    """
    n_sources: int = 5
    rotation_deg_per_sec: float = 60.0
    start_azimuths: Optional[List[float]] = None
    spacing_deg: Optional[float] = None
    offset_deg: float = 0.0
    distance_m: float = REF_DISTANCE
    gain_db: float = 0.0
    random_fraction: float = 0.0
    wander_deg: float = 60.0
    wander_hz: float = 0.25
    radial_wander_m: float = 0.0
    decorr_amount: Optional[float] = None   # override the master amount

    def resolved_azimuths(self) -> np.ndarray:
        if self.start_azimuths is not None:
            az = np.array(self.start_azimuths, dtype=float)
            if len(az) < self.n_sources:
                az = np.tile(az, int(np.ceil(self.n_sources / max(len(az), 1))))
            return az[: self.n_sources]
        if self.spacing_deg is not None:
            return self.offset_deg + np.arange(self.n_sources) * self.spacing_deg
        return self.offset_deg + np.linspace(0, 360, self.n_sources, endpoint=False)


def _smoothstep(u: np.ndarray) -> np.ndarray:
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3.0 - 2.0 * u)


class FieldGeometry:
    """Per-source trajectories for a whole variant, resolved once per render.

    Every component contributes a block of sources; this concatenates them and
    answers azimuth, distance and gain for all of them at any instant.

    Wander is a sum of three incommensurate sinusoids with seeded frequencies
    and phases rather than filtered noise: smooth, since binaural sluggishness
    makes fast jitter useless, bounded, and reproducible from the seed.
    """

    def __init__(self, cfg: "FieldConfig"):
        comps = cfg.resolved_components()
        rng = np.random.default_rng(cfg.seed + 7919)
        self.comps = comps
        self.comp_of: List[int] = []
        self._src: List[Dict[str, Any]] = []
        gains = []

        for ci, c in enumerate(comps):
            n = max(int(c.n_sources), 1)
            az = c.resolved_azimuths()
            n_rand = int(round(np.clip(c.random_fraction, 0.0, 1.0) * n))
            idx_rand = set(rng.choice(n, size=n_rand, replace=False).tolist()) \
                if n_rand else set()
            for i in range(n):
                s: Dict[str, Any] = {
                    "c": c, "ci": ci, "i": i, "n": n,
                    "az0": float(az[i % len(az)]),
                    "random": i in idx_rand,
                    "wander": None, "radial_wander": None,
                    # even stagger along a path so a flow is continuous rather
                    # than every source arriving at once
                    "phase": (i + 0.5) / n,
                }
                if s["random"]:
                    s["wander"] = self._osc(rng, c.wander_deg, c.wander_hz)
                if c.radial_wander_m > 0:
                    s["radial_wander"] = self._osc(rng, c.radial_wander_m, c.wander_hz)
                # lateral placement across a stream's width
                s["lateral"] = (((i + 0.5) / n) - 0.5) * c.spread_m
                self._src.append(s)
                self.comp_of.append(ci)
                gains.append(10 ** (c.gain_db / 20.0))

        self.gain = np.array(gains) if gains else np.zeros(0)
        self.n = len(self._src)
        self.uses_distance = any(
            c.kind in ("stream", "radial", "spiral")
            or abs(c.distance_m - REF_DISTANCE) > 1e-9
            or c.radial_wander_m > 0
            for c in comps)
        self.uses_envelope = any(c.kind in ("stream", "radial", "spiral")
                                 for c in comps)

    @staticmethod
    def _osc(rng, amp: float, hz: float):
        f = hz * rng.uniform([0.6, 1.1, 1.7], [0.9, 1.6, 2.3])
        ph = rng.uniform(0, 2 * np.pi, 3)
        w = np.array([0.62, 0.27, 0.11]) * amp
        return (f, ph, w)

    @staticmethod
    def _eval(osc, t: float) -> float:
        if osc is None:
            return 0.0
        f, ph, w = osc
        return float(np.sum(w * np.sin(2 * np.pi * f * t + ph)))

    def _state(self, s, t: float):
        """(azimuth, distance, envelope) for one source at time t."""
        c: ComponentConfig = s["c"]
        env = 1.0
        az = s["az0"]
        dist = max(c.distance_m, 0.2)

        if c.kind == "stream":
            # Travel along heading, staggered along the path, spread across it.
            h = np.deg2rad(c.heading_deg)
            fwd = np.array([np.sin(h), np.cos(h)])       # x right, y forward
            side = np.array([np.cos(h), -np.sin(h)])
            path = max(c.path_m, 0.1)
            u = (s["phase"] + (c.speed_mps * t) / path) % 1.0
            along = (u - 0.5) * path
            p = fwd * along + side * s["lateral"]
            dist = float(np.hypot(p[0], p[1]))
            az = float(np.degrees(np.arctan2(p[0], p[1])))
            env = self._fade(u, c.fade_frac)

        elif c.kind in ("radial", "spiral"):
            near, far = min(c.r_near_m, c.r_far_m), max(c.r_near_m, c.r_far_m)
            span = max(far - near, 0.05)
            if abs(c.radial_speed_mps) > 1e-9:
                u = (s["phase"] + (c.radial_speed_mps * t) / span) % 1.0
                dist = near + u * span
                env = self._fade(u, c.fade_frac)
            else:
                dist = near + s["phase"] * span
            if c.kind == "spiral":
                az = s["az0"] + c.rotation_deg_per_sec * t
            else:
                az = s["az0"]

        else:                                            # ring
            if not s["random"]:
                az = s["az0"] + c.rotation_deg_per_sec * t

        if s["wander"] is not None:
            az += self._eval(s["wander"], t)
        if s["radial_wander"] is not None:
            dist += self._eval(s["radial_wander"], t)

        return az, max(dist, c.min_distance_m), env

    @staticmethod
    def _fade(u: float, frac: float) -> float:
        """Fade in at the start of a run and out at the end.

        Without it a recycling source would appear and vanish abruptly, which
        is heard as a click and read as an event rather than as flow.
        """
        f = float(np.clip(frac, 0.001, 0.5))
        return float(_smoothstep(np.array(u / f)) * _smoothstep(np.array((1.0 - u) / f)))

    def azimuths(self, t: float) -> np.ndarray:
        return np.array([self._state(s, t)[0] for s in self._src])

    def distances(self, t: float) -> np.ndarray:
        return np.array([self._state(s, t)[1] for s in self._src])

    def state(self, t: float):
        """(azimuths, distances, gains) for every source."""
        if not self.n:
            return np.zeros(0), np.zeros(0), np.zeros(0)
        out = [self._state(s, t) for s in self._src]
        az = np.array([o[0] for o in out])
        dist = np.array([o[1] for o in out])
        env = np.array([o[2] for o in out]) * self.gain
        return az, dist, env

    def ear_gains(self, az_deg: np.ndarray, dist: np.ndarray,
                  head_radius: float) -> np.ndarray:
        """(S, 2) gains, left then right, from source-to-ear path lengths.

        The 1/d law applied per ear rather than per source is what produces the
        near-field ILD growth: for a close source the two path lengths differ
        proportionally more, so the level difference rises beyond its far-field
        value even at frequencies the head does not shadow.
        """
        th = np.deg2rad(az_deg)
        r, a = dist, head_radius
        dl = np.sqrt(r * r + a * a + 2 * a * r * np.sin(th))
        dr = np.sqrt(r * r + a * a - 2 * a * r * np.sin(th))
        return np.stack([REF_DISTANCE / np.maximum(dl, 1e-3),
                         REF_DISTANCE / np.maximum(dr, 1e-3)], axis=1)


def _lowpass(x: np.ndarray, cutoff: float, fs: int, order: int = 4) -> np.ndarray:
    """Zero-phase lowpass used to split bands."""
    from scipy.signal import butter, sosfiltfilt
    ny = fs / 2.0
    f = np.clip(cutoff / ny, 1e-6, 0.999)
    return sosfiltfilt(butter(order, f, btype="low", output="sos"), x)


def band_shape(d: np.ndarray, crossovers, band_amounts, fs: int) -> np.ndarray:
    """Apply per-band gains to a signal.

    Bands are built as successive differences of lowpasses, so they telescope
    back to the input exactly. Uniform gains therefore reproduce d bit-for-bit
    and the frequency control is inert until it is actually used, whatever the
    filter's phase response does.
    """
    if not crossovers:
        return d
    lows = [_lowpass(d, f, fs) for f in crossovers]
    out = band_amounts[0] * lows[0]
    for k in range(1, len(lows)):
        out += band_amounts[k] * (lows[k] - lows[k - 1])
    out += band_amounts[-1] * (d - lows[-1])
    return out


def _micro_delay(x: np.ndarray, ms: float, fs: int) -> np.ndarray:
    d = ms * fs / 1000.0
    if d <= 0:
        return x
    n = int(np.floor(d))
    frac = d - n
    y = np.zeros_like(x)
    if n < len(x):
        y[n:] = x[: len(x) - n]
    if frac > 0:                      # linear interpolation between taps
        y2 = np.zeros_like(x)
        if n + 1 < len(x):
            y2[n + 1:] = x[: len(x) - n - 1]
        y = (1 - frac) * y + frac * y2
    return y


def _micro_pitch(x: np.ndarray, cents: float, fs: int) -> np.ndarray:
    """Resample by a small ratio, then trim or pad back to length.

    This changes duration as well as pitch, which is exactly why it is a crude
    method: over a long segment the sources drift out of time with each other.
    """
    if abs(cents) < 1e-6:
        return x
    from scipy.signal import resample_poly
    from fractions import Fraction
    ratio = Fraction(2.0 ** (cents / 1200.0)).limit_denominator(2000)
    y = resample_poly(x, ratio.denominator, ratio.numerator)
    if len(y) >= len(x):
        return y[: len(x)]
    return np.pad(y, (0, len(x) - len(y)))


class SourceBank:
    """Per-source difference signals plus the level correction.

    The blend for source i is written as

        blend_i(t) = x + a_i(t) * d_i

    where d_i is a fixed per-source difference signal. That form is worth the
    algebra: band shaping folds into d_i once (band gains are linear and scale
    with a, so a common factor comes out), which leaves a single array per
    source and makes a time-varying amount free at render time. The equivalent
    (1-a)x + a*wet is recovered exactly when the band gains are uniform.
    """

    def __init__(self, x: np.ndarray, n_sources: int, dcfg, fs: int = 44100):
        """dcfg is one DecorrConfig for every source, or a list of one per
        source so components can carry different coherence in one field.

        The random draws come from a single stream in source order regardless,
        so a uniform list reproduces the single-config render exactly.
        """
        self.x = x
        self.fs = fs
        self.n_sources = n_sources
        cfgs = list(dcfg) if isinstance(dcfg, (list, tuple)) else [dcfg] * n_sources
        if len(cfgs) < n_sources:
            cfgs = cfgs + [cfgs[-1]] * (n_sources - len(cfgs))
        self.cfgs = cfgs[:n_sources]
        self.cfg = self.cfgs[0] if self.cfgs else DecorrConfig()
        self.Pd = float(np.mean(x ** 2)) + 1e-20

        rng = np.random.default_rng(self.cfg.seed)

        diffs, stats = [], []
        for i in range(n_sources):
            c = self.cfgs[i]
            wet = self._wet(x, c, rng, i, n_sources, fs)
            # RMS-match wet to dry BEFORE differencing, so `amount` is a
            # coherence control and not a level control.
            wet = wet * np.sqrt(self.Pd / (np.mean(wet ** 2) + 1e-20))
            d = band_shape(wet - x, c.crossovers, c.resolved_band_amounts(), fs)
            diffs.append(d)
            stats.append((float(np.mean(x * d)), float(np.mean(d ** 2))))

        self.d = np.stack(diffs) if n_sources else np.zeros((0, len(x)))
        self.cross = np.array([s[0] for s in stats])   # <x, d_i>
        self.dpow = np.array([s[1] for s in stats])    # <d_i, d_i>

    @staticmethod
    def _wet(x, dcfg, rng, i, n_sources, fs):
        env = dcfg.envelope
        if dcfg.family == "velvet":
            h = velvet_ir(fs, dcfg.ir_ms / 1000.0, dcfg.density, rng,
                          "flat" if env == "auto" else env, dcfg.decay_db)
            wet = fftconvolve(x, h)[: len(x)]
        elif dcfg.family == "allpass":
            h = allpass_noise_ir(fs, dcfg.ir_ms / 1000.0, rng, dcfg.phase_depth,
                                 "hann" if env == "auto" else env, dcfg.decay_db)
            wet = fftconvolve(x, h)[: len(x)]
        elif dcfg.family == "none":
            wet = x.copy()
        else:
            raise ValueError(f"unknown decorrelation family {dcfg.family!r}")

        # Spread deterministically across the ring rather than randomly, so
        # neighbouring sources differ by a predictable step.
        # Delay runs 0..1 because it cannot go negative: a symmetric -1..1
        # spread folded, handing the two end sources the same delay.
        frac = i / max(n_sources - 1, 1) if n_sources > 1 else 0.0
        if dcfg.micro_delay_ms:
            wet = _micro_delay(wet, frac * dcfg.micro_delay_ms, fs)
        if dcfg.micro_pitch_cents:
            wet = _micro_pitch(wet, (frac * 2.0 - 1.0) * dcfg.micro_pitch_cents, fs)
        return wet

    def _gain(self, i: int, a: np.ndarray) -> np.ndarray:
        """Level correction for blend = x + a*d_i, in closed form.

        P(a) = Pd + 2a<x,d> + a^2<d,d>, so the gain that holds the blend at the
        dry signal's power is sqrt(Pd/P(a)). Closed form rather than measured
        because a may vary within the segment, and a per-block RMS measurement
        would modulate the level it is supposed to be holding still.
        """
        p = self.Pd + 2.0 * a * self.cross[i] + (a ** 2) * self.dpow[i]
        return np.sqrt(self.Pd / np.maximum(p, 1e-20))

    def base_amounts(self) -> np.ndarray:
        c = self.cfg
        if c.per_source_amount is not None:
            a = np.array(c.per_source_amount, dtype=float)
            if len(a) < self.n_sources:
                a = np.pad(a, (0, self.n_sources - len(a)), constant_values=c.amount)
            return a[: self.n_sources]
        return np.array([self.cfgs[i].amount for i in range(self.n_sources)],
                        dtype=float)

    def amounts_at(self, t: float, azimuths: np.ndarray,
                   hotspot: Optional[HotspotConfig]) -> np.ndarray:
        """Instantaneous decorrelation amount per source."""
        if hotspot is not None and hotspot.enabled:
            a = hotspot.amounts_at(azimuths, t)
        else:
            a = self.base_amounts()
        n = max(self.n_sources, 1)
        for i in range(self.n_sources):
            c = self.cfgs[i]
            if c.lfo_hz and c.lfo_depth:
                phase = 2 * np.pi * c.lfo_hz * t
                if c.lfo_source_spread:
                    phase += c.lfo_source_spread * 2 * np.pi * (i / n)
                a[i] = a[i] + c.lfo_depth * np.sin(phase)
        return np.clip(a, 0.0, 1.0)

    def blocks(self, start: int, stop: int, a: np.ndarray) -> np.ndarray:
        """Blended block for every source. Returns (S, stop-start)."""
        seg = self.x[start:stop]
        g = np.array([self._gain(i, a[i]) for i in range(self.n_sources)])
        return (seg[None, :] + a[:, None] * self.d[:, start:stop]) * g[:, None]


def decorrelate(x: np.ndarray, n_sources: int, method: str = "velvet",
                amount: float = 1.0, fs: int = 44100, seed: int = 0) -> np.ndarray:
    """Produce n_sources variants of x with controllable mutual coherence.

    amount = 0.0 -> identical copies (fully coherent ring)
    amount = 1.0 -> maximally decorrelated

    Convenience wrapper over SourceBank with the prefab defaults. Reach for
    DecorrConfig directly when you want any of the other axes.

    Returns (n_sources, len(x)).
    """
    if method == "none" or amount <= 0:
        return np.tile(x, (n_sources, 1))
    bank = SourceBank(x, n_sources,
                      DecorrConfig(amount=amount, family=method, seed=seed), fs)
    return bank.blocks(0, len(x), bank.base_amounts())


def coherence_matrix(sigs: np.ndarray) -> np.ndarray:
    """Measured pairwise correlation between source signals.

    The controls say what was asked for; this says what was got. Those come
    apart often enough that the app shows both.
    """
    s = sigs - sigs.mean(axis=1, keepdims=True)
    norm = np.sqrt(np.sum(s ** 2, axis=1))
    norm = np.maximum(norm, 1e-20)
    return (s @ s.T) / np.outer(norm, norm)


# ----------------------------------------------------------------------
# CORE 3: time-varying binaural render
# ----------------------------------------------------------------------

@dataclass
class FieldConfig:
    """One rotating field.

    The scalar decorr_* fields are the short path and stay supported. Set
    `decorr` to a DecorrConfig for the full control set; it wins where both
    are given.
    """
    n_sources: int = 4
    rotation_deg_per_sec: float = 60.0

    # Ring geometry: an explicit azimuth list, or count + spacing + offset.
    start_azimuths: Optional[List[float]] = None
    spacing_deg: Optional[float] = None      # None -> evenly spaced over 360
    offset_deg: float = 0.0

    decorr_method: str = "velvet"
    decorr_amount: float = 1.0
    per_source_amount: Optional[List[float]] = None

    decorr: Optional[DecorrConfig] = None
    hotspot: Optional[HotspotConfig] = None

    # Multi-ring geometry. When set, this replaces the scalar ring fields above
    # entirely; when None, the scalar fields behave exactly as before.
    rings: Optional[List[RingConfig]] = None

    # The general form: any mix of motion patterns, each with its own
    # decorrelation. Takes precedence over both of the above.
    components: Optional[List[ComponentConfig]] = None

    # Per-source gain is the third documented way to break the ring's symmetry,
    # alongside decorrelation and uneven spacing.
    per_source_gain_db: Optional[List[float]] = None

    # Physical model. These are the constants behind every ITD and ILD the
    # renderer produces, exposed because head size in particular is the model's
    # only anthropometric parameter and the closest it comes to being fitted to
    # a listener. render() takes the HRTF as an argument, so a caller wanting
    # these honoured has to build the HRTF from them: see hrtf_for().
    head_radius: float = HEAD_RADIUS
    speed_of_sound: float = C_SOUND
    hrtf_taps: int = 128
    hrtf_grid_step: float = 1.0

    block: int = 256
    seed: int = 0

    def resolved_components(self) -> List[ComponentConfig]:
        """The variant as a flat list of components.

        Three ways in, one way out: an explicit component list, the ring
        shorthand, or the scalar single-ring fields.
        """
        if self.components:
            return list(self.components)
        if self.rings:
            return [ComponentConfig(
                kind="ring", n_sources=r.n_sources,
                rotation_deg_per_sec=r.rotation_deg_per_sec,
                start_azimuths=r.start_azimuths, spacing_deg=r.spacing_deg,
                offset_deg=r.offset_deg, distance_m=r.distance_m,
                gain_db=r.gain_db, random_fraction=r.random_fraction,
                wander_deg=r.wander_deg, wander_hz=r.wander_hz,
                radial_wander_m=r.radial_wander_m,
                decorr=(replace(self.resolved_decorr_base(),
                                amount=r.decorr_amount)
                        if r.decorr_amount is not None else None))
                for r in self.rings]
        return [ComponentConfig(
            kind="ring", n_sources=self.n_sources,
            rotation_deg_per_sec=self.rotation_deg_per_sec,
            start_azimuths=self.start_azimuths, spacing_deg=self.spacing_deg,
            offset_deg=self.offset_deg)]

    def resolved_rings(self) -> List[ComponentConfig]:
        return self.resolved_components()

    def total_sources(self) -> int:
        return sum(max(int(c.n_sources), 1) for c in self.resolved_components())

    def per_source_decorr(self) -> List[DecorrConfig]:
        """One DecorrConfig per source, taking each component's override."""
        base = self.resolved_decorr()
        out: List[DecorrConfig] = []
        for c in self.resolved_components():
            d = c.decorr if c.decorr is not None else base
            out.extend([d] * max(int(c.n_sources), 1))
        return out

    def resolved_azimuths(self) -> np.ndarray:
        if self.components or self.rings:
            return np.concatenate([c.resolved_azimuths()
                                   for c in self.resolved_components()])
        if self.start_azimuths is not None:
            return np.array(self.start_azimuths, dtype=float)
        if self.spacing_deg is not None:
            return self.offset_deg + np.arange(self.n_sources) * self.spacing_deg
        return self.offset_deg + np.linspace(0, 360, self.n_sources, endpoint=False)

    def resolved_decorr_base(self) -> DecorrConfig:
        if self.decorr is not None:
            d = replace(self.decorr)
            if d.per_source_amount is None and self.per_source_amount is not None:
                d.per_source_amount = list(self.per_source_amount)
            return d
        return DecorrConfig(amount=self.decorr_amount, family=self.decorr_method,
                            per_source_amount=(list(self.per_source_amount)
                                               if self.per_source_amount else None),
                            seed=self.seed)

    def resolved_decorr(self) -> DecorrConfig:
        d = self.resolved_decorr_base()
        # Ring-level amount overrides expand into a per-source list.
        if (self.rings and not self.components and d.per_source_amount is None
                and any(r.decorr_amount is not None for r in self.rings)):
            d.per_source_amount = [
                (r.decorr_amount if r.decorr_amount is not None else d.amount)
                for r in self.rings for _ in range(max(int(r.n_sources), 1))]
        return d

    def resolved_gains(self) -> np.ndarray:
        if not self.per_source_gain_db:
            return np.ones(self.n_sources)
        g = np.array(self.per_source_gain_db, dtype=float)
        if len(g) < self.n_sources:
            g = np.pad(g, (0, self.n_sources - len(g)))
        return 10 ** (g[: self.n_sources] / 20.0)


_HRTF_CACHE: Dict[tuple, Any] = {}


def hrtf_for(cfg: FieldConfig, fs: int = 44100):
    """HRTF matching a field's physical model, cached.

    Building one costs a few hundred milliseconds, and most variants share the
    same head, so the cache matters when a passage has several of them.
    """
    key = (fs, round(cfg.head_radius, 6), round(cfg.speed_of_sound, 4),
           int(cfg.hrtf_taps), round(cfg.hrtf_grid_step, 4))
    hit = _HRTF_CACHE.get(key)
    if hit is None:
        if len(_HRTF_CACHE) > 24:
            _HRTF_CACHE.clear()
        hit = AnalyticHRTF(fs=fs, n_taps=int(cfg.hrtf_taps),
                           grid_step=cfg.hrtf_grid_step,
                           head_radius=cfg.head_radius,
                           speed_of_sound=cfg.speed_of_sound)
        _HRTF_CACHE[key] = hit
    return hit


def render(x: np.ndarray, hrtf, cfg: FieldConfig, fs: int = 44100,
           normalize: bool = True, trace: Optional[list] = None) -> np.ndarray:
    """Overlap-add time-varying convolution. Returns (len, 2).

    CORE: each 50%-overlapped Hann block is convolved with the HRIR for the
    azimuth at that block's centre, then summed. The Hann windows satisfy
    COLA so the crossfade is transparent; without it, moving sources click.

    Decorrelation amount is evaluated per block rather than once up front, so a
    hotspot can sweep the ring independently of the sources and coherence can
    be modulated over time.

    Pass a list as `trace` to have it filled with per-frame azimuths and
    amounts for display. The renderer already knows these; recomputing them in
    the UI would be a second implementation of the same geometry, free to drift.
    """
    n = len(x)
    hop = cfg.block // 2
    win = hann(cfg.block, sym=False)   # periodic Hann: exact COLA at 50% overlap

    use_geom = bool(cfg.rings or cfg.components)
    geom = FieldGeometry(cfg) if use_geom else None
    if geom is not None:
        n_src = geom.n
        gains = geom.gain
        decorr = cfg.per_source_decorr()
    else:
        n_src = cfg.n_sources
        az0 = cfg.resolved_azimuths()
        gains = cfg.resolved_gains()
        decorr = cfg.resolved_decorr()
    bank = SourceBank(x, n_src, decorr, fs)

    trace_every = max(1, int(round(fs / (hop * 60.0))))   # about 60 frames/sec
    hot = cfg.hotspot

    out = np.zeros((n + hrtf.n_taps + cfg.block, 2))
    for k, start in enumerate(range(0, n - cfg.block, hop)):
        t_c = (start + cfg.block / 2) / fs
        if geom is not None:
            az, dist, lvl = geom.state(t_c)
        else:
            az = az0 + cfg.rotation_deg_per_sec * t_c
            dist, lvl = None, gains
        amt = bank.amounts_at(t_c, az, hot)

        blocks = bank.blocks(start, start + cfg.block, amt)      # (S, block)
        blocks = blocks * win * lvl[:, None]
        h = np.stack([hrtf.hrir(a) for a in az])                 # (S, 2, taps)
        # one batched convolution for all sources and both ears
        seg = fftconvolve(blocks[:, None, :], h, mode="full", axes=-1)
        if geom is not None and geom.uses_distance:
            seg = seg * geom.ear_gains(az, dist, cfg.head_radius)[:, :, None]
        seg = seg.sum(axis=0).T                                  # (block+taps-1, 2)
        out[start:start + len(seg)] += seg

        if trace is not None and k % trace_every == 0:
            frame = {
                "t": round(t_c, 4),
                "az": [round(float(v) % 360.0, 2) for v in az],
                "amt": [round(float(v), 4) for v in amt],
                "hot": (round((hot.start_deg + hot.deg_per_sec * t_c) % 360.0, 2)
                        if hot is not None and hot.enabled else None),
            }
            if dist is not None:
                frame["dist"] = [round(float(v), 2) for v in dist]
                frame["lvl"] = [round(float(v), 3) for v in lvl]
            trace.append(frame)

    out = out[:n]
    if not normalize:
        return out
    peak = np.max(np.abs(out))
    return out / peak * 0.89 if peak > 0 else out


def k_weight(x: np.ndarray, fs: int) -> np.ndarray:
    """ITU-R BS.1770 K-weighting: high-shelf then high-pass."""
    f0, G, Q = 1681.97, 3.999, 0.7071
    K = np.tan(np.pi * f0 / fs)
    Vh, Vb = 10 ** (G / 20), (10 ** (G / 20)) ** 0.499
    a0 = 1 + K / Q + K * K
    b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0,
          (Vh - Vb * K / Q + K * K) / a0]
    a1 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    y = lfilter(b1, a1, x, axis=0)
    f0, Q = 38.13, 0.5003
    K = np.tan(np.pi * f0 / fs)
    a0 = 1 + K / Q + K * K
    return lfilter([1, -2, 1], [1, 2 * (K * K - 1) / a0,
                                (1 - K / Q + K * K) / a0], y, axis=0)


def loudness_lufs(stereo: np.ndarray, fs: int) -> float:
    """Integrated loudness, BS.1770. Use this instead of raw RMS: it is
    frequency weighted, so it tracks what you actually hear when the
    decorrelation method changes the spectral balance."""
    y = k_weight(np.atleast_2d(stereo.T).T, fs)
    return -0.691 + 10 * np.log10(np.sum(np.mean(y ** 2, axis=0)) + 1e-12)


def _dry_reference(mono: np.ndarray, stereo: np.ndarray, fs: int,
                   dry_mono: bool) -> np.ndarray:
    """DRY playback material: either the original stereo, or the mono sum
    duplicated to both ears and loudness-matched to that original."""
    if not dry_mono:
        return stereo
    d = np.stack([mono, mono], axis=-1)
    return d * 10 ** ((loudness_lufs(stereo, fs) - loudness_lufs(d, fs)) / 20.0)


def _match_level(chunk: np.ndarray, ref: np.ndarray, fs: int,
                 mode: str = "lufs") -> np.ndarray:
    """Scale chunk to sit at the same level as ref.

    mode="lufs" : K-weighted loudness match (default, closest to perception)
    mode="rms"  : plain RMS match
    mode="none" : leave it alone
    """
    if mode == "none" or len(ref) < 128 or len(chunk) < 128:
        return chunk
    if mode == "rms":
        r = np.sqrt(np.mean(ref ** 2)) / (np.sqrt(np.mean(chunk ** 2)) + 1e-12)
    else:
        r = 10 ** ((loudness_lufs(ref, fs) - loudness_lufs(chunk, fs)) / 20.0)
    return chunk * r


# ----------------------------------------------------------------------
# CORE 4: timeline — different treatment per region of a track
# ----------------------------------------------------------------------

@dataclass
class Segment:
    """One region of the track.

    config = None  -> DRY: the original stereo passes through untouched.
    config = a FieldConfig -> that region gets rendered as a rotating field.

    Times are in seconds. Regions are crossfaded so treatments swap without
    clicking. Rotation phase is measured from each segment's own start, so
    a segment always begins at its configured start_azimuths.
    """
    start: float
    end: float
    config: Optional["FieldConfig"] = None
    fade: float = 0.08
    gain_db: float = 0.0
    label: str = ""


# ----------------------------------------------------------------------
# Timeline: what is playing, when, and under exactly which parameters
#
# Every renderer emits one of these per SEGMENT rather than per block. The UI
# reads playback position against it, so the readout and the audio cannot
# disagree. Anything that re-derives segment geometry downstream is a second
# implementation free to drift from this one.
# ----------------------------------------------------------------------

def _jsonable(v):
    if isinstance(v, np.ndarray):
        return [_jsonable(x) for x in v.tolist()]
    if isinstance(v, (np.floating, np.integer)):
        return v.item()
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


def config_dict(cfg: Optional["FieldConfig"]) -> Optional[Dict[str, Any]]:
    """Full parameter set of a field, JSON-safe.

    Resolved values are included alongside the raw ones: the ring geometry can
    be given three different ways and the readout should show the azimuths
    actually used, not just which shorthand produced them.
    """
    if cfg is None:
        return None
    d = _jsonable(asdict(cfg))
    d["resolved_azimuths"] = [round(float(a), 2) for a in cfg.resolved_azimuths()]
    d["resolved_decorr"] = _jsonable(asdict(cfg.resolved_decorr()))
    if cfg.rings or cfg.components:
        geom = FieldGeometry(cfg)
        az0, dist0, lvl0 = geom.state(0.0)
        d["resolved_gains_db"] = [round(float(20 * np.log10(max(g, 1e-9))), 2)
                                  for g in geom.gain]
        d["resolved_ring_of"] = list(geom.comp_of)
        d["resolved_component_of"] = list(geom.comp_of)
        d["resolved_distances"] = [round(float(v), 2) for v in dist0]
        d["resolved_components"] = [_jsonable(asdict(c))
                                    for c in geom.comps]
        d["component_labels"] = [c.label or f"{c.kind} {i + 1}"
                                 for i, c in enumerate(geom.comps)]
    else:
        d["resolved_gains_db"] = [round(float(20 * np.log10(max(g, 1e-9))), 2)
                                  for g in cfg.resolved_gains()]
    return d


@dataclass
class TimelineEntry:
    """One segment as it appears in the rendered output.

    out_* is where it sits in the rendered file; src_* is where it came from in
    the source track. The two differ whenever segments are cropped and
    concatenated, which is exactly when a readout is most likely to go wrong.
    """
    out_start: float
    out_end: float
    src_start: float
    src_end: float
    kind: str                     # "dry" | "spin"
    label: str = ""
    group: str = ""               # block or take grouping, when there is one
    params: Optional[Dict[str, Any]] = None
    trace: Optional[List[Dict[str, Any]]] = None

    def as_dict(self) -> Dict[str, Any]:
        return _jsonable(asdict(self))


def _seg_label(seg: "Segment", index: int) -> str:
    if seg.label:
        return seg.label
    if seg.config is None:
        return f"dry {seg.start:.1f}-{seg.end:.1f}s"
    c = seg.config
    dur = seg.end - seg.start
    bits = [f"n={c.n_sources}"]
    if c.rotation_deg_per_sec:
        bits.append(f"ring {c.rotation_deg_per_sec * dur:.0f}deg")
    # A stationary ring under a moving hotspot would otherwise read as "0deg",
    # which is the opposite of what that configuration is doing.
    if c.hotspot is not None and c.hotspot.enabled:
        bits.append(f"hotspot {c.hotspot.deg_per_sec * dur:.0f}deg")
    if len(bits) == 1:
        bits.append("still")
    return "spin " + " ".join(bits)


def _equal_power_fades(n: int, nf: int):
    """Equal-power (sin/cos) fade curves. Constant power through a crossfade,
    unlike linear fades which dip in the middle for decorrelated material."""
    fi = np.ones(n)
    if nf > 0:
        t = np.linspace(0, np.pi / 2, min(nf, n // 2))
        fi[: len(t)] = np.sin(t)
        fi[-len(t):] = np.cos(t)
    return fi


def render_timeline(mono: np.ndarray, stereo: np.ndarray, hrtf,
                    segments: List[Segment], fs: int = 44100,
                    match: str = "lufs", dry_mono: bool = True,
                    normalize: bool = True, with_trace: bool = False):
    """Render a full track with per-region treatments.

    mono   : the summed signal fed to the spatializer
    stereo : the original file

    dry_mono=True plays DRY regions as the same mono sum the spatializer
    receives, duplicated to both ears. Without it you are comparing the
    record's own stereo image against a field built from its mono sum, which
    is two variables at once. The mono version is loudness-matched to the
    original so toggling this does not change overall level.

    Returns (audio, timeline).
    """
    n = len(mono)
    out = np.zeros((n, 2))
    dry_ref = _dry_reference(mono, stereo, fs, dry_mono)
    timeline: List[TimelineEntry] = []

    for idx, seg in enumerate(segments):
        i0 = max(0, int(seg.start * fs))
        i1 = min(n, int(seg.end * fs))
        if i1 <= i0:
            continue
        nf = int(seg.fade * fs)
        pad0, pad1 = min(i0, nf), min(n - i1, nf)
        a, b = i0 - pad0, i1 + pad1

        tr: Optional[list] = [] if (with_trace and seg.config is not None) else None
        if seg.config is None:
            chunk = dry_ref[a:b].copy()
        else:
            # hrtf=None means each segment supplies its own head model.
            h = hrtf if hrtf is not None else hrtf_for(seg.config, fs)
            chunk = render(mono[a:b], h, seg.config, fs, normalize=False,
                           trace=tr)
            # Reference is the SAME passage played dry, so the song keeps its
            # own dynamics instead of every region being flattened to the
            # whole-track average.
            chunk = _match_level(chunk, dry_ref[a:b], fs, match)

        chunk *= 10 ** (seg.gain_db / 20.0)
        out[a:b] += chunk * _equal_power_fades(len(chunk), nf)[:, None]

        timeline.append(TimelineEntry(
            out_start=seg.start, out_end=seg.end,
            src_start=seg.start, src_end=seg.end,
            kind="dry" if seg.config is None else "spin",
            label=_seg_label(seg, idx), params=config_dict(seg.config),
            trace=tr))

    if normalize:
        peak = np.max(np.abs(out))
        out = out / peak * 0.89 if peak > 0 else out
    return out, timeline


def render_blocks(mono: np.ndarray, stereo: np.ndarray, hrtf,
                  blocks, fs: int = 44100, gap: float = 1.0,
                  edge_fade: float = 0.05, match: str = "lufs",
                  dry_mono: bool = True, with_trace: bool = False):
    """Render several complete arrangements and play them BACK TO BACK.

    blocks: list of (label, [Segment, ...]).

    Each block is rendered on the song's own timeline, then cropped to just
    the span its segments cover and concatenated. So six blocks that all
    treat 31.5-50s become six consecutive passes over that passage instead
    of six passes summed on top of each other.

    Nothing outside the covered span is included, so there is no trailing
    remainder of the song. Levels are normalised once across the whole
    output, so blocks stay comparable to each other.

    Returns (audio, timeline) where timeline is [(start, end, label), ...].
    """
    pieces, timeline, cursor = [], [], 0.0
    nf = int(edge_fade * fs)

    for label, segs in blocks:
        if not segs:
            continue
        src0 = min(s.start for s in segs)
        a = int(src0 * fs)
        b = int(max(s.end for s in segs) * fs)
        full, inner = render_timeline(mono, stereo, hrtf, segs, fs,
                                      match, dry_mono, normalize=False,
                                      with_trace=with_trace)
        chunk = full[a:min(b, len(full))].copy()
        if len(chunk) == 0:
            continue
        if nf > 0 and len(chunk) > 2 * nf:
            ramp = np.linspace(0, 1, nf)[:, None]
            chunk[:nf] *= ramp
            chunk[-nf:] *= ramp[::-1]

        dur = len(chunk) / fs
        # Segments keep their own entries, shifted onto the concatenated
        # timeline. Reporting one entry per block would hide the parameter
        # changes inside it, which are the thing being compared.
        for e in inner:
            timeline.append(TimelineEntry(
                out_start=cursor + (e.src_start - src0),
                out_end=cursor + (e.src_end - src0),
                src_start=e.src_start, src_end=e.src_end,
                kind=e.kind, label=e.label, group=label,
                params=e.params, trace=e.trace))
        pieces.append(chunk)
        cursor += dur
        if gap > 0:
            pieces.append(np.zeros((int(gap * fs), 2)))
            cursor += gap

    out = np.concatenate(pieces) if pieces else np.zeros((0, 2))
    peak = np.max(np.abs(out))
    return (out / peak * 0.89 if peak > 0 else out), timeline


@dataclass
class Take:
    """Pull a passage OUT of the song and place it in a new running order.

    Unlike Segment, which treats a region in place, Take lets you repeat the
    same passage as many times as you like with different treatments. That
    is the A/B comparison: identical material, one variable changed.
    """
    src_start: float
    src_end: float
    config: Optional["FieldConfig"] = None
    gain_db: float = 0.0
    label: str = ""


def render_sequence(mono: np.ndarray, stereo: np.ndarray, hrtf,
                    takes: List[Take], fs: int = 44100, gap: float = 0.6,
                    edge_fade: float = 0.05, match: str = "lufs",
                    dry_mono: bool = True, with_trace: bool = False):
    """Concatenate takes into one file. Returns (audio, timeline).

    timeline is a list of (start_sec, end_sec, label) so you know what you
    are hearing and can score each take separately.

    gap: silence between takes. Keep it non-zero for comparison listening;
    a hard cut between two treatments lets the contrast do the work, whereas
    a crossfade blends them into each other.
    """
    n = len(mono)
    dry_ref = _dry_reference(mono, stereo, fs, dry_mono)
    pieces, timeline, cursor = [], [], 0.0
    nf = int(edge_fade * fs)

    for tk in takes:
        a, b = max(0, int(tk.src_start * fs)), min(n, int(tk.src_end * fs))
        if b <= a:
            continue
        tr: Optional[list] = [] if (with_trace and tk.config is not None) else None
        if tk.config is None:
            chunk = dry_ref[a:b].copy()
        else:
            h = hrtf if hrtf is not None else hrtf_for(tk.config, fs)
            chunk = render(mono[a:b], h, tk.config, fs, normalize=False,
                           trace=tr)
            chunk = _match_level(chunk, dry_ref[a:b], fs, match)
        chunk = chunk * 10 ** (tk.gain_db / 20.0)

        if nf > 0 and len(chunk) > 2 * nf:      # de-click the edges only
            ramp = np.linspace(0, 1, nf)[:, None]
            chunk[:nf] *= ramp
            chunk[-nf:] *= ramp[::-1]

        dur = len(chunk) / fs
        timeline.append(TimelineEntry(
            out_start=cursor, out_end=cursor + dur,
            src_start=tk.src_start, src_end=tk.src_end,
            kind="dry" if tk.config is None else "spin",
            label=tk.label or f"{tk.src_start:.0f}-{tk.src_end:.0f}s",
            params=config_dict(tk.config), trace=tr))
        pieces.append(chunk)
        cursor += dur
        if gap > 0:
            pieces.append(np.zeros((int(gap * fs), 2)))
            cursor += gap

    out = np.concatenate(pieces) if pieces else np.zeros((0, 2))
    peak = np.max(np.abs(out))
    return (out / peak * 0.89 if peak > 0 else out), timeline


# ----------------------------------------------------------------------
# Analysis
# ----------------------------------------------------------------------

def iacc(stereo: np.ndarray, fs: int = 44100, max_lag_ms: float = 1.0) -> float:
    """Interaural cross-correlation coefficient, max over +/-1 ms.

    ~1.0 => coherent, tightly localized image. Near 0 => diffuse and
    enveloping. This is the objective counterpart to what you are trying
    to hear, so log it for every render.
    """
    l, r = stereo[:, 0], stereo[:, 1]
    l, r = l - l.mean(), r - r.mean()
    m = int(max_lag_ms * fs / 1000)
    denom = np.sqrt(np.sum(l ** 2) * np.sum(r ** 2)) + 1e-12
    # Only the +/- m lags are needed. np.correlate(mode='full') would compute
    # all 2N-1 lags by direct summation: O(N^2), which is unusable here.
    lp = np.pad(l, (m, m))
    cc = np.array([np.dot(lp[m + k: m + k + len(r)], r) for k in range(-m, m + 1)])
    return float(np.max(np.abs(cc)) / denom)


def iacc_over_time(stereo, fs=44100, win_s=0.25):
    n = int(win_s * fs)
    if n <= 0 or len(stereo) <= n:
        return np.array([])
    return np.array([iacc(stereo[i:i + n], fs)
                     for i in range(0, len(stereo) - n, n)])


# Octave bands, 125 Hz through 8 kHz.
OCTAVE_BANDS = [(88, 177), (177, 354), (354, 707), (707, 1414),
                (1414, 2828), (2828, 5657), (5657, 11314)]


def iacc_bands(stereo: np.ndarray, fs: int = 44100, bands=None):
    """IACC per octave band.

    Broadband IACC hides where the coherence went. It matters here because
    decorrelating low frequencies gives a vague, weak low end (the head does
    not shadow them, so there is no ILD to carry a position), and a single
    number cannot show that happening.
    """
    from scipy.signal import butter, sosfiltfilt
    out = []
    for lo, hi in (bands or OCTAVE_BANDS):
        if lo >= fs / 2:
            continue
        wn = [lo / (fs / 2), min(hi / (fs / 2), 0.999)]
        y = sosfiltfilt(butter(4, wn, btype="band", output="sos"), stereo, axis=0)
        centre = int(round(np.sqrt(lo * hi)))
        out.append({"lo": lo, "hi": hi, "centre": centre,
                    "iacc": round(float(iacc(y, fs)), 4)})
    return out


def iacc_modulation(stereo: np.ndarray, fs: int = 44100,
                    freq_hz: float = 0.5, win_s: float = 0.1) -> Optional[Dict[str, Any]]:
    """Strength of cyclic modulation in the IACC-over-time series at one rate.

    Broadband IACC says how diffuse a field is. It cannot say whether the field
    is turning: a static decorrelated field and a rotating one routinely land
    on the same value. Rotation should instead show up as the interaural
    statistics varying cyclically, so this looks for a line in that series.

    READ THE WARNING. On real music this number is confounded and a single
    render's value is not evidence of anything. Measured on a 20 s passage of
    Whole Lotta Love, a completely static diffuse field scored ratio 2.04 at
    0.5 Hz, against 2.65 to 3.14 for genuinely rotating fields: the song's own
    periodicity sits in the same part of the series as the rotation signature.
    It only becomes interpretable as a difference against a matched static
    control, which is what paired_modulation does.
    """
    series = iacc_over_time(stereo, fs, win_s)
    if len(series) < 8:
        return None
    f_series = 1.0 / win_s
    if freq_hz <= 0 or freq_hz >= f_series / 2:
        return None
    s = series - series.mean()
    n = len(s)
    comp = abs(np.sum(s * np.exp(-2j * np.pi * freq_hz * np.arange(n) / f_series))) / n
    spec = np.abs(np.fft.rfft(s)) / n
    return {"freq_hz": round(float(freq_hz), 4),
            "magnitude": round(float(comp), 5),
            "ratio": round(float(comp / (spec.mean() + 1e-12)), 3),
            "resolution_hz": round(float(f_series / n), 4)}


def interaural_pattern_hz(deg_per_sec: float, front_back_symmetric: bool = True) -> float:
    """Rate at which the interaural pattern repeats, given a rotation rate.

    Twice the lap rate under the analytic HRTF: it is front-back symmetric, so
    a source at 30 deg and one at 150 deg produce identical cues and the
    pattern completes twice per revolution. With measured HRTFs this becomes
    the lap rate itself.
    """
    laps = abs(deg_per_sec) / 360.0
    return 2.0 * laps if front_back_symmetric else laps


def paired_modulation(rotating: np.ndarray, control: np.ndarray, fs: int,
                      deg_per_sec: float, win_s: float = 0.1,
                      front_back_symmetric: bool = True) -> Optional[Dict[str, Any]]:
    """Modulation at the rotation rate, minus the same measure on a control.

    The control must be the same material under the same decorrelation and the
    same seed, differing only in that nothing is rotating. Then whatever the
    music itself contributes at that frequency appears in both and subtracts
    out, and a positive delta is attributable to the rotation.

    A delta near zero means the render carries no measurable rotation
    signature. That is a real answer, and given finding 7 it is not the same
    as the rotation being inaudible.
    """
    f0 = interaural_pattern_hz(deg_per_sec, front_back_symmetric)
    a = iacc_modulation(rotating, fs, f0, win_s)
    b = iacc_modulation(control, fs, f0, win_s)
    if a is None or b is None:
        return None
    return {"freq_hz": a["freq_hz"], "rotating_ratio": a["ratio"],
            "control_ratio": b["ratio"],
            "delta": round(a["ratio"] - b["ratio"], 3),
            "resolution_hz": a["resolution_hz"]}


def metrics(stereo: np.ndarray, fs: int = 44100, win_s: float = 0.25,
            bands: bool = True, rotation_deg_per_sec: float = 0.0) -> Dict[str, Any]:
    """Everything measurable about one render, in one dict.

    Reported alongside the listener's response, never in place of it. Finding 7
    is that the metric and the percept come apart: velvet measures louder than
    allpass in LUFS but is heard as quieter, and ring geometry barely moves
    IACC even where it may be clearly audible. Where they diverge is the
    interesting part, so the app shows both and resolves neither.

    iacc_sd is the within-render spread of the windowed series. It is the floor
    below which a difference in the broadband number means nothing, which
    matters because several of the controls move IACC by less than that.
    """
    series = iacc_over_time(stereo, fs, win_s)
    out = {
        "iacc": round(float(iacc(stereo, fs)), 4),
        "lufs": round(float(loudness_lufs(stereo, fs)), 2),
        "peak_db": round(float(20 * np.log10(np.max(np.abs(stereo)) + 1e-12)), 2),
        "iacc_sd": round(float(np.std(series)), 4) if len(series) else None,
        "iacc_series": [round(float(v), 4) for v in series],
        "iacc_series_hz": round(1.0 / win_s, 3),
    }
    if bands:
        out["iacc_bands"] = iacc_bands(stereo, fs)
    if rotation_deg_per_sec:
        f0 = interaural_pattern_hz(rotation_deg_per_sec)
        out["modulation"] = iacc_modulation(stereo, fs, f0)
        out["modulation_note"] = ("confounded on its own: compare against a "
                                  "matched static control, not against zero")
    return out


# ----------------------------------------------------------------------
# I/O
# ----------------------------------------------------------------------

def group_timeline(timeline: List[TimelineEntry]) -> Dict[str, List[TimelineEntry]]:
    """Bucket entries by their block or take grouping, insertion ordered."""
    out: Dict[str, List[TimelineEntry]] = {}
    for e in timeline:
        out.setdefault(e.group or e.label, []).append(e)
    return out


def timeline_dict(timeline: List[TimelineEntry], fs: int = 44100,
                  duration: Optional[float] = None) -> Dict[str, Any]:
    return {"fs": fs, "duration": duration,
            "segments": [e.as_dict() for e in timeline]}


def save_timeline(path: str, timeline: List[TimelineEntry], fs: int = 44100,
                  duration: Optional[float] = None):
    import json
    with open(path, "w", encoding="utf-8") as f:
        json.dump(timeline_dict(timeline, fs, duration), f, indent=2)


def _srt_time(t: float) -> str:
    if t < 0:
        t = 0.0
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s % 1) * 1000)):03d}"


def timeline_srt(timeline: List[TimelineEntry], verbose: bool = True) -> str:
    """Subtitle track carrying the parameter readout.

    Point VLC at the WAV with this alongside and the parameters display over
    the audio, with no video encoding and nothing to keep in sync by hand.
    """
    lines = []
    for i, e in enumerate(timeline, 1):
        parts = [e.label]
        if e.group:
            parts.insert(0, f"[{e.group}]")
        p = e.params
        if verbose and p:
            d = p.get("resolved_decorr", {})
            parts.append(
                f"n={p['n_sources']}  rot={p['rotation_deg_per_sec']:.0f} deg/s  "
                f"az={p['resolved_azimuths']}")
            parts.append(
                f"{d.get('family')} amount={d.get('amount'):.2f} "
                f"ir={d.get('ir_ms'):.0f}ms density={d.get('density'):.0f}")
            hot = p.get("hotspot")
            if hot and hot.get("enabled"):
                parts.append(f"hotspot {hot['deg_per_sec']:.0f} deg/s "
                             f"width={hot['width_deg']:.0f} "
                             f"hot={hot['hot_amount']:.2f} bed={hot['bed_amount']:.2f}")
        lines.append(f"{i}\n{_srt_time(e.out_start)} --> {_srt_time(e.out_end)}\n"
                     + "\n".join(parts) + "\n")
    return "\n".join(lines)


def save_srt(path: str, timeline: List[TimelineEntry], verbose: bool = True):
    with open(path, "w", encoding="utf-8") as f:
        f.write(timeline_srt(timeline, verbose))


def load_audio(path: str, target_fs: int = 44100):
    """Load any format libsndfile handles, including MP3 and WAV.

    Returns (stereo, mono, fs). stereo is the untouched original (duplicated
    if the file was mono) and is what DRY timeline regions play. mono is the
    channel sum that gets spatialized.
    """
    x, fs = sf.read(path, always_2d=True)
    if fs != target_fs:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(int(fs), int(target_fs))
        x = resample_poly(x, target_fs // g, fs // g, axis=0)
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    elif x.shape[1] > 2:
        x = x[:, :2]
    peak = np.max(np.abs(x)) + 1e-12
    x = x / peak
    return x, x.mean(axis=1), target_fs


def load_mono(path: str, target_fs: int = 44100) -> np.ndarray:
    x, fs = sf.read(path, always_2d=True)
    x = x.mean(axis=1)
    if fs != target_fs:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(int(fs), int(target_fs))
        x = resample_poly(x, target_fs // g, fs // g)
    return x / (np.max(np.abs(x)) + 1e-12)


def save(path: str, stereo: np.ndarray, fs: int = 44100):
    sf.write(path, stereo, fs, subtype="PCM_24")