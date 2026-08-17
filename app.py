"""app.py: local web app for running the experiment.

    python app.py            then open http://127.0.0.1:8000

Thin wrapper over ringfield.py, the DSP core. All DSP lives there; this module only turns
JSON into dataclasses, caches renders, and serves files. If you find yourself
writing signal processing in here, it belongs in ringfield.py instead.

Renders take tens of seconds, so nothing here pretends to be real time. The
flow is configure, render, then play back fixed buffers. Applying a treatment
during playback works by rendering the variants in advance and crossfading
between already-rendered buffers in the browser, which is sample accurate and
cannot glitch under load.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import threading
import time
from dataclasses import asdict
from typing import Any, Dict, List, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import ringfield as rf

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, ".cache")
SESSIONS = os.path.join(ROOT, "sessions")
PRESETS = os.path.join(ROOT, "presets")
UPLOADS = os.path.join(ROOT, "uploads")
AUDIO_EXT = (".wav", ".mp3", ".flac", ".ogg", ".aif", ".aiff", ".m4a")

for d in (CACHE, SESSIONS, PRESETS, UPLOADS):
    os.makedirs(d, exist_ok=True)

app = FastAPI(title="ringfield")

# ----------------------------------------------------------------------
# Track cache: decoding an mp3 takes seconds, so hold the last few in memory.
# ----------------------------------------------------------------------

_tracks: Dict[str, Any] = {}
_track_lock = threading.Lock()
_hrtf_cache: Dict[int, Any] = {}


def resolve_track(name: str) -> str:
    """Absolute path for a track name, confined to the project folder.

    Names may include the uploads/ prefix, so a plain basename is not enough,
    but the result still has to sit inside ROOT: the name arrives from a
    request and would otherwise be a path traversal.
    """
    path = os.path.abspath(os.path.join(ROOT, name.replace("\\", "/")))
    if os.path.commonpath([path, ROOT]) != ROOT or not os.path.isfile(path):
        raise HTTPException(404, f"no such track: {name}")
    return path


def get_track(name: str):
    """(stereo, mono, fs) for a track. Decoding an mp3 is slow, so cache it."""
    path = resolve_track(name)
    with _track_lock:
        hit = _tracks.get(path)
        if hit is None:
            hit = rf.load_audio(path)
            if len(_tracks) > 3:
                _tracks.clear()
            _tracks[path] = hit
        return hit


def get_hrtf(fs: int):
    if fs not in _hrtf_cache:
        _hrtf_cache[fs] = rf.AnalyticHRTF(fs=fs)
    return _hrtf_cache[fs]


# ----------------------------------------------------------------------
# Request models. These mirror the dataclasses in ringfield.py; keeping them
# separate means a malformed request cannot reach the DSP.
# ----------------------------------------------------------------------

class DecorrIn(BaseModel):
    amount: float = 1.0
    per_source_amount: Optional[List[float]] = None
    family: str = "velvet"
    ir_ms: float = 30.0
    density: float = 1500.0
    phase_depth: float = 1.0
    envelope: str = "auto"
    decay_db: float = 60.0
    crossovers: Optional[List[float]] = None
    band_amounts: Optional[List[float]] = None
    micro_delay_ms: float = 0.0
    micro_pitch_cents: float = 0.0
    lfo_hz: float = 0.0
    lfo_depth: float = 0.0
    lfo_source_spread: float = 0.0
    seed: int = 0

    def to_cfg(self) -> rf.DecorrConfig:
        return rf.DecorrConfig(**self.model_dump())


class RingIn(BaseModel):
    n_sources: int = 5
    rotation_deg_per_sec: float = 60.0
    start_azimuths: Optional[List[float]] = None
    spacing_deg: Optional[float] = None
    offset_deg: float = 0.0
    distance_m: float = rf.REF_DISTANCE
    gain_db: float = 0.0
    random_fraction: float = 0.0
    wander_deg: float = 60.0
    wander_hz: float = 0.25
    radial_wander_m: float = 0.0
    decorr_amount: Optional[float] = None

    def to_cfg(self) -> rf.RingConfig:
        return rf.RingConfig(**self.model_dump())


class ComponentIn(BaseModel):
    lattice: str = "polar"
    label: str = ""
    rings: int = 1
    per_ring: int = 5
    r_near_m: float = 1.5
    r_far_m: float = 4.0
    offset_deg: float = 0.0
    ring_stagger_deg: float = 0.0
    start_azimuths: Optional[List[float]] = None
    cols: int = 5
    rows: int = 5
    extent_x_m: float = 8.0
    extent_y_m: float = 8.0
    rotation_deg_per_sec: float = 0.0
    rotation_outer_deg_per_sec: Optional[float] = None
    radial_speed_mps: float = 0.0
    drift_x_mps: float = 0.0
    drift_y_mps: float = 0.0
    random_fraction: float = 0.0
    wander_deg: float = 60.0
    wander_hz: float = 0.25
    radial_wander_m: float = 0.0
    gain_db: float = 0.0
    edge_fade: float = 0.3
    min_distance_m: float = 0.0
    max_gain_db: float = 12.0
    time_scale: float = 1.0
    decorr: Optional[DecorrIn] = None

    def to_cfg(self) -> rf.ComponentConfig:
        d = self.model_dump()
        d["decorr"] = self.decorr.to_cfg() if self.decorr else None
        return rf.ComponentConfig(**d)


class FieldIn(BaseModel):
    n_sources: int = 3
    rotation_deg_per_sec: float = 60.0
    total_degrees: Optional[float] = None      # alternative to a rate
    start_azimuths: Optional[List[float]] = None
    spacing_deg: Optional[float] = None
    offset_deg: float = 0.0
    per_source_gain_db: Optional[List[float]] = None
    rings: Optional[List[RingIn]] = None
    components: Optional[List[ComponentIn]] = None
    decorr: DecorrIn = Field(default_factory=DecorrIn)
    head_radius: float = rf.HEAD_RADIUS
    speed_of_sound: float = rf.C_SOUND
    hrtf_taps: int = 128
    hrtf_grid_step: float = 1.0
    block: int = 256
    seed: int = 0

    def to_cfg(self, duration: Optional[float] = None) -> rf.FieldConfig:
        rate = self.rotation_deg_per_sec
        if self.total_degrees is not None and duration:
            rate = self.total_degrees / max(duration, 1e-6)
        return rf.FieldConfig(
            n_sources=self.n_sources, rotation_deg_per_sec=rate,
            start_azimuths=self.start_azimuths, spacing_deg=self.spacing_deg,
            offset_deg=self.offset_deg,
            per_source_gain_db=self.per_source_gain_db,
            rings=[r.to_cfg() for r in self.rings] if self.rings else None,
            components=([c.to_cfg() for c in self.components]
                        if self.components else None),
            decorr=self.decorr.to_cfg(),
            head_radius=self.head_radius, speed_of_sound=self.speed_of_sound,
            hrtf_taps=self.hrtf_taps, hrtf_grid_step=self.hrtf_grid_step,
            block=self.block, seed=self.seed)


class SegmentIn(BaseModel):
    start: float
    end: float
    config: Optional[FieldIn] = None      # None => dry
    fade: float = 0.25
    gain_db: float = 0.0
    label: str = ""

    def to_seg(self) -> rf.Segment:
        dur = self.end - self.start
        return rf.Segment(self.start, self.end,
                          self.config.to_cfg(dur) if self.config else None,
                          self.fade, self.gain_db, self.label)


class BlockIn(BaseModel):
    label: str
    segments: List[SegmentIn]


class TakeIn(BaseModel):
    src_start: float
    src_end: float
    config: Optional[FieldIn] = None
    gain_db: float = 0.0
    label: str = ""

    def to_take(self) -> rf.Take:
        dur = self.src_end - self.src_start
        return rf.Take(self.src_start, self.src_end,
                       self.config.to_cfg(dur) if self.config else None,
                       self.gain_db, self.label)


class VariantIn(BaseModel):
    label: str = ""
    config: Optional[FieldIn] = None      # None => the untreated reference
    gain_db: float = 0.0


class PassageIn(BaseModel):
    name: str = ""
    start: float
    end: float
    variants: List[VariantIn] = []


class RenderIn(BaseModel):
    """One render request.

    mode="session"   untreated spine plus every passage variant, aligned
    mode="timeline"  one arrangement across the song
    mode="blocks"    several complete arrangements, back to back
    mode="sequence"  one passage repeated under different treatments
    mode="layers"    the same span rendered N times, aligned, for crossfading
    """
    track: str
    mode: str = "session"
    passages: List[PassageIn] = []
    segments: List[SegmentIn] = []
    blocks: List[BlockIn] = []
    takes: List[TakeIn] = []
    layers: List[TakeIn] = []
    gap: float = 0.8
    match: str = "lufs"
    dry_mono: bool = True
    with_trace: bool = True
    with_metrics: bool = True
    crop: bool = True          # timeline mode: trim to the covered span


# ----------------------------------------------------------------------
# Render cache, keyed on the request. Re-asking for the same settings is
# common (tweak one layer, keep five) and re-rendering them is the slow path.
# ----------------------------------------------------------------------

def _key(payload: Dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha1(blob).hexdigest()[:16]


def _write_wav(key: str, y: np.ndarray, fs: int) -> str:
    path = os.path.join(CACHE, f"{key}.wav")
    if not os.path.exists(path):
        sf.write(path, y, fs, subtype="PCM_16")   # 16-bit: browser decodes it fine
    return path


def _prune_cache(keep_mb: int = 1500):
    files = [(os.path.getmtime(os.path.join(CACHE, f)), os.path.join(CACHE, f))
             for f in os.listdir(CACHE) if f.endswith(".wav")]
    total = sum(os.path.getsize(p) for _, p in files)
    for _, p in sorted(files):
        if total <= keep_mb * 1024 * 1024:
            break
        total -= os.path.getsize(p)
        try:
            os.remove(p)
        except OSError:
            pass


# ----------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------

def _load_json(name: str):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return json.load(f)


@app.get("/api/encyclopedia")
def encyclopedia():
    """Cross-linked reference behind every info button in the interface."""
    return _load_json("encyclopedia.json")


@app.get("/api/purpose")
def purpose():
    """The research programme: question, literature, findings, method.

    Sections carry ids, so a [[link]] from a lesson or a glossary entry can
    resolve here as well as to a term.
    """
    return _load_json("purpose.json")


@app.get("/api/courses")
def courses():
    """Sequenced lessons. The intended route in for a reader starting cold."""
    return _load_json("courses.json")


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    """Accept a user's own audio.

    Kept to the formats libsndfile handles. The file is decoded once here so a
    bad upload fails immediately with a clear message rather than at render
    time, and the name is sanitised because it reaches the filesystem.
    """
    name = os.path.basename(file.filename or "upload")
    stem, ext = os.path.splitext(name)
    if ext.lower() not in AUDIO_EXT:
        raise HTTPException(400, f"unsupported format {ext!r}. "
                                 f"Use one of: {', '.join(sorted(AUDIO_EXT))}")
    stem = "".join(c for c in stem if c.isalnum() or c in "-_ .").strip() or "upload"
    os.makedirs(UPLOADS, exist_ok=True)

    dest = os.path.join(UPLOADS, stem + ext)
    n = 1
    while os.path.exists(dest):
        dest = os.path.join(UPLOADS, f"{stem} ({n}){ext}")
        n += 1

    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    with open(dest, "wb") as f:
        f.write(data)

    try:
        sf.info(dest)
    except Exception as exc:
        os.remove(dest)
        raise HTTPException(400, f"could not decode that file: {exc}")

    return {"name": os.path.relpath(dest, ROOT).replace("\\", "/"),
            "size_mb": round(len(data) / 1e6, 1)}


GENERATED = {"variations.wav", "compare.wav", "arrangement.wav"}


@app.get("/api/tracks")
def tracks():
    """Audio available to work on: uploads first, then the project folder.

    Renders written by the command line tools sort alphabetically ahead of the
    songs and would otherwise become the default selection, which means
    spatializing an already spatialized file. They are pushed to the end and
    labelled instead.
    """
    out = []
    for folder, prefix in ((UPLOADS, "uploads/"), (ROOT, "")):
        if not os.path.isdir(folder):
            continue
        for f in sorted(os.listdir(folder)):
            if not f.lower().endswith(AUDIO_EXT) or f.startswith("."):
                continue
            p = os.path.join(folder, f)
            out.append({"name": prefix + f,
                        "size_mb": round(os.path.getsize(p) / 1e6, 1),
                        "uploaded": prefix != "",
                        "generated": f in GENERATED})
    out.sort(key=lambda t: (t["generated"], not t["uploaded"], t["name"]))
    return {"tracks": out}


@app.get("/api/track/{name:path}")
def track_info(name: str, peaks: int = 1400):
    """Duration plus a downsampled peak envelope for drawing the waveform."""
    stereo, mono, fs = get_track(name)
    n = len(mono)
    step = max(n // max(peaks, 1), 1)
    trimmed = mono[: (n // step) * step].reshape(-1, step)
    env = np.abs(trimmed).max(axis=1)
    env = env / (env.max() + 1e-12)
    return {"name": name, "duration": n / fs, "fs": fs,
            "peaks": [round(float(v), 3) for v in env]}


@app.post("/api/render")
def render(req: RenderIn):
    stereo, mono, fs = get_track(req.track)
    hrtf = get_hrtf(fs)
    payload = req.model_dump()
    t0 = time.time()

    if req.mode == "timeline":
        segs = [s.to_seg() for s in req.segments]
        if not segs:
            raise HTTPException(400, "timeline mode needs segments")
        y, tl = rf.render_timeline(mono, stereo, None, segs, fs, req.match,
                                   req.dry_mono, with_trace=req.with_trace)
        if req.crop:
            # render_timeline works on the song's own clock and leaves anything
            # uncovered as silence, so a ten second experiment on a six minute
            # track otherwise returns six minutes of mostly nothing.
            y, tl = _crop_to_coverage(y, tl, fs)
        result = _one_render(payload, y, tl, fs, req)

    elif req.mode == "blocks":
        blocks = [(b.label, [s.to_seg() for s in b.segments]) for b in req.blocks]
        if not blocks:
            raise HTTPException(400, "blocks mode needs blocks")
        y, tl = rf.render_blocks(mono, stereo, None, blocks, fs, req.gap,
                                 match=req.match, dry_mono=req.dry_mono,
                                 with_trace=req.with_trace)
        result = _one_render(payload, y, tl, fs, req)

    elif req.mode == "sequence":
        takes = [t.to_take() for t in req.takes]
        if not takes:
            raise HTTPException(400, "sequence mode needs takes")
        y, tl = rf.render_sequence(mono, stereo, None, takes, fs, req.gap,
                                   match=req.match, dry_mono=req.dry_mono,
                                   with_trace=req.with_trace)
        result = _one_render(payload, y, tl, fs, req)

    elif req.mode == "layers":
        result = _render_layers(req, mono, stereo, hrtf, fs, payload)

    elif req.mode == "session":
        result = _render_session(req, mono, stereo, hrtf, fs)

    else:
        raise HTTPException(400, f"unknown mode {req.mode!r}")

    result["render_seconds"] = round(time.time() - t0, 2)
    _prune_cache()
    return result


def _crop_to_coverage(y, tl, fs):
    """Trim a timeline render to the span its segments actually cover."""
    if not tl:
        return y, tl
    t0 = min(e.out_start for e in tl)
    t1 = max(e.out_end for e in tl)
    a, b = max(0, int(t0 * fs)), min(len(y), int(t1 * fs))
    if b <= a:
        return y, tl
    shifted = [rf.TimelineEntry(
        out_start=e.out_start - t0, out_end=e.out_end - t0,
        src_start=e.src_start, src_end=e.src_end, kind=e.kind,
        label=e.label, group=e.group, params=e.params, trace=e.trace)
        for e in tl]
    return y[a:b], shifted


def _one_render(payload, y, tl, fs, req) -> Dict[str, Any]:
    key = _key(payload)
    _write_wav(key, y, fs)
    out = {"id": key, "url": f"/api/audio/{key}.wav", "duration": len(y) / fs,
           "fs": fs, "timeline": [e.as_dict() for e in tl]}
    if req.with_metrics:
        out["metrics"] = rf.metrics(y, fs)
        out["segment_metrics"] = _segment_metrics(y, tl, fs)
    return out


def _segment_metrics(y, tl, fs) -> List[Dict[str, Any]]:
    """Per-segment IACC and loudness.

    Whole-render numbers average across treatments and dry material, which is
    the one thing you never want to compare. Segment-level is the unit the
    experiment actually varies.
    """
    out = []
    for e in tl:
        a, b = int(e.out_start * fs), min(int(e.out_end * fs), len(y))
        if b - a < fs // 4:
            out.append({"label": e.label, "iacc": None, "lufs": None})
            continue
        seg = y[a:b]
        out.append({"label": e.label, "group": e.group, "kind": e.kind,
                    "iacc": round(float(rf.iacc(seg, fs)), 4),
                    "lufs": round(float(rf.loudness_lufs(seg, fs)), 2)})
    return out


def _effective_rate(cfg_in: FieldIn) -> float:
    """Whichever rate is actually driving the interaural pattern.

    With several components at different rates the dominant one is used, since
    the paired measure can only examine one frequency.
    """
    if cfg_in.components:
        # Only rotation has a well-defined cyclic rate. Translation and radial
        # flow recycle, but their period depends on extent and speed, and
        # mixing those into one figure would misreport what is measured.
        rates = [r for c in cfg_in.components
                 for r in (c.rotation_deg_per_sec,
                           c.rotation_outer_deg_per_sec or c.rotation_deg_per_sec)]
        rates = [r for r in rates if r]
        return max(rates, key=abs) if rates else 0.0
    if cfg_in.rings:
        rates = [r.rotation_deg_per_sec for r in cfg_in.rings]
        return max(rates, key=abs) if rates else 0.0
    return cfg_in.rotation_deg_per_sec


def _control_key(cfg_in: FieldIn) -> str:
    """Identity of a configuration with all motion removed.

    Wander counts as motion, so the matched control freezes it too: wander_hz
    of zero holds every wanderer at a fixed offset drawn from the same seed,
    preserving the geometry while removing the movement.

    time_scale is normalised for the same reason the other rates are. Freezing
    a component stops its clock rather than zeroing its rates, which is the
    preferred way to build a control because it keeps the level distribution
    identical. Leaving time_scale in the key would give the frozen copy a
    different identity from the component it controls for, and the pair the
    listener deliberately constructed would never be recognised as one.
    """
    d = cfg_in.model_dump()
    d["rotation_deg_per_sec"] = 0.0
    d["total_degrees"] = None
    if d.get("rings"):
        d["rings"] = [{**r, "rotation_deg_per_sec": 0.0, "wander_hz": 0.0}
                      for r in d["rings"]]
    if d.get("components"):
        d["components"] = [{**c, "rotation_deg_per_sec": 0.0,
                            "rotation_outer_deg_per_sec": None,
                            "radial_speed_mps": 0.0, "drift_x_mps": 0.0,
                            "drift_y_mps": 0.0, "wander_hz": 0.0,
                            "time_scale": 1.0}
                           for c in d["components"]]
    return json.dumps(d, sort_keys=True, default=str)


def _has_motion(cfg_in: FieldIn) -> bool:
    """Whether anything in the variant moves, across every motion kind."""
    for c in (cfg_in.components or []):
        if not c.to_cfg().is_static():
            return True
    for r in (cfg_in.rings or []):
        if r.rotation_deg_per_sec or (r.random_fraction > 0 and r.wander_hz > 0):
            return True
    if not cfg_in.components and not cfg_in.rings:
        return bool(cfg_in.rotation_deg_per_sec)
    return False


def _render_layers(req: RenderIn, mono, stereo, hrtf, fs, payload) -> Dict[str, Any]:
    """Render the same span N times, sample aligned, for live crossfading.

    Every layer covers the identical source span and comes back the same
    length, so the browser can start them together and switch between them
    mid-note. Levels are matched per layer against the dry reference and the
    whole set is normalised by one shared peak, so crossfading does not also
    change loudness: otherwise the louder layer wins every comparison
    regardless of what it is doing spatially.
    """
    if not req.layers:
        raise HTTPException(400, "layers mode needs layers")
    src_start = req.layers[0].src_start
    src_end = req.layers[0].src_end
    if src_end - src_start <= 0:
        raise HTTPException(400, "layer span is empty")

    n = len(mono)
    a, b = max(0, int(src_start * fs)), min(n, int(src_end * fs))
    dry_ref = rf._dry_reference(mono, stereo, fs, req.dry_mono)[a:b]

    rendered, traces, out_layers = [], [], []
    for lay in req.layers:
        tr: Optional[list] = [] if (req.with_trace and lay.config) else None
        if lay.config is None:
            chunk = dry_ref.copy()
        else:
            cfg = lay.config.to_cfg(src_end - src_start)
            chunk = rf.render(mono[a:b], rf.hrtf_for(cfg, fs), cfg, fs,
                              normalize=False, trace=tr)
            chunk = rf._match_level(chunk, dry_ref, fs, req.match)
        chunk = chunk * 10 ** (lay.gain_db / 20.0)
        rendered.append(chunk)
        traces.append(tr)

    peak = max(float(np.max(np.abs(c))) for c in rendered) or 1.0
    scale = 0.89 / peak

    # A layer's matched control is the identical configuration with every rate
    # set to zero: same sources, same coherence structure, nothing moving. Any
    # modulation the music itself contributes at the rotation frequency shows
    # up in both and cancels, which is the only way that measure means
    # anything on real material.
    controls: Dict[str, int] = {}
    for i, lay in enumerate(req.layers):
        if lay.config is not None and _effective_rate(lay.config) == 0:
            controls[_control_key(lay.config)] = i

    for idx, (lay, chunk, tr) in enumerate(zip(req.layers, rendered, traces)):
        y = chunk * scale
        key = _key({"layer": lay.model_dump(), "span": [src_start, src_end],
                    "track": req.track, "match": req.match,
                    "dry_mono": req.dry_mono, "scale": round(scale, 9)})
        _write_wav(key, y, fs)
        entry = {
            "id": key, "url": f"/api/audio/{key}.wav",
            "label": lay.label or ("dry" if lay.config is None else "spin"),
            "kind": "dry" if lay.config is None else "spin",
            "params": rf.config_dict(lay.config.to_cfg(src_end - src_start))
                      if lay.config else None,
            "trace": tr,
        }
        if req.with_metrics:
            cfg = lay.config.to_cfg(src_end - src_start) if lay.config else None
            rate = 0.0
            if cfg is not None:
                # Whichever is actually driving the interaural pattern. With a
                rate = _effective_rate(v.config)
            entry["metrics"] = rf.metrics(y, fs, rotation_deg_per_sec=rate)
            entry["effective_rate"] = rate
            if cfg is not None:
                entry["coherence"] = _measured_coherence(
                    mono[a:b], cfg, fs, src_end - src_start)
            if rate and lay.config is not None:
                ci = controls.get(_control_key(lay.config))
                if ci is not None and ci != idx:
                    entry["paired_modulation"] = rf.paired_modulation(
                        y, rendered[ci] * scale, fs, rate)
                    entry["control_layer"] = ci
                else:
                    entry["control_missing"] = True
        out_layers.append(entry)

    return {"mode": "layers", "fs": fs, "duration": (b - a) / fs,
            "src_start": src_start, "src_end": src_end, "layers": out_layers}


def _render_session(req: RenderIn, mono, stereo, hrtf, fs) -> Dict[str, Any]:
    """Dry spine for the whole track, plus every passage variant aligned to it.

    Playback runs the dry spine end to end while every variant sits alongside
    it, silent and in sync, so punching one in is a gain change rather than a
    restart. That requires the spine and the variants to share a single
    amplitude scale: normalising each separately would make the punch-in jump
    in level, and the louder thing wins any comparison regardless of what it is
    doing spatially.
    """
    if not req.passages:
        raise HTTPException(400, "session mode needs passages")

    dry_full = rf._dry_reference(mono, stereo, fs, req.dry_mono)

    # Render everything first, then pick one scale for the whole set.
    rendered: List[List[Optional[np.ndarray]]] = []
    traces: List[List[Optional[list]]] = []
    for p in req.passages:
        a = max(0, int(p.start * fs))
        b = min(len(mono), int(p.end * fs))
        chunks, trs = [], []
        for v in p.variants:
            if v.config is None or b <= a:
                chunks.append(None)
                trs.append(None)
                continue
            tr: Optional[list] = [] if req.with_trace else None
            cfg = v.config.to_cfg(p.end - p.start)
            # Each variant may specify its own head model, so the HRTF is
            # resolved per variant rather than once for the request.
            y = rf.render(mono[a:b], rf.hrtf_for(cfg, fs), cfg, fs,
                          normalize=False, trace=tr)
            y = rf._match_level(y, dry_full[a:b], fs, req.match)
            chunks.append(y * 10 ** (v.gain_db / 20.0))
            trs.append(tr)
        rendered.append(chunks)
        traces.append(trs)

    peak = float(np.max(np.abs(dry_full))) if len(dry_full) else 1.0
    for chunks in rendered:
        for c in chunks:
            if c is not None:
                peak = max(peak, float(np.max(np.abs(c))))
    scale = 0.89 / (peak or 1.0)

    dry_key = _key({"dry": req.track, "match": req.match,
                    "dry_mono": req.dry_mono, "scale": round(scale, 9)})
    _write_wav(dry_key, dry_full * scale, fs)

    out_passages = []
    for pi, p in enumerate(req.passages):
        a = max(0, int(p.start * fs))
        b = min(len(mono), int(p.end * fs))

        controls: Dict[str, int] = {}
        for i, v in enumerate(p.variants):
            if v.config is not None and not _has_motion(v.config):
                controls[_control_key(v.config)] = i

        vs = []
        for vi, v in enumerate(p.variants):
            chunk = rendered[pi][vi]
            entry: Dict[str, Any] = {
                "label": v.label or ("dry" if v.config is None else f"variant {vi}"),
                "kind": "dry" if v.config is None else "spin",
                "params": None, "url": None, "trace": traces[pi][vi],
            }
            if chunk is None:
                # The untreated reference is just the spine over this span, so
                # there is nothing extra to render or transfer. It still gets
                # measured, so the comparison table has a baseline row.
                if req.with_metrics and b > a:
                    entry["metrics"] = rf.metrics(dry_full[a:b] * scale, fs)
                vs.append(entry)
                continue

            y = chunk * scale
            cfg = v.config.to_cfg(p.end - p.start)
            key = _key({"track": req.track, "span": [p.start, p.end],
                        "variant": v.model_dump(), "match": req.match,
                        "dry_mono": req.dry_mono, "scale": round(scale, 9)})
            _write_wav(key, y, fs)
            entry["url"] = f"/api/audio/{key}.wav"
            entry["params"] = rf.config_dict(cfg)

            if req.with_metrics:
                rate = _effective_rate(v.config)
                moves = _has_motion(v.config)
                entry["metrics"] = rf.metrics(y, fs, rotation_deg_per_sec=rate)
                entry["effective_rate"] = rate
                entry["moves"] = moves
                entry["coherence"] = _measured_coherence(
                    mono[a:b], cfg, fs, p.end - p.start)
                entry["component_coherence"] = _component_coherence(
                    mono[a:b], cfg, fs)
                if rate:
                    ci = controls.get(_control_key(v.config))
                    if ci is not None and ci != vi and rendered[pi][ci] is not None:
                        entry["paired_modulation"] = rf.paired_modulation(
                            y, rendered[pi][ci] * scale, fs, rate)
                        entry["control_variant"] = ci
                    else:
                        entry["control_missing"] = True
                elif moves:
                    # Translation and radial flow recycle rather than cycling at
                    # a fixed rate, so there is no single frequency to test.
                    entry["no_rotation_rate"] = True
            vs.append(entry)

        out_passages.append({"name": p.name, "start": p.start, "end": p.end,
                             "variants": vs})

    if req.with_metrics:
        dry_slice = dry_full[:min(len(dry_full), 30 * fs)] * scale
        dry_metrics = rf.metrics(dry_slice, fs)
    else:
        dry_metrics = None

    return {"mode": "session", "fs": fs,
            "dry": {"url": f"/api/audio/{dry_key}.wav",
                    "duration": len(dry_full) / fs, "metrics": dry_metrics},
            "passages": out_passages}


def _source_distinctiveness(sigs, fs: int, lo: float = 200.0, hi: float = 12000.0):
    """How far each source's spectrum sits from the ensemble average, in dB.

    Decorrelation is carried by phase and distinctiveness by magnitude, so the
    coherence matrix can read near zero while one source still has a spectral
    signature: a resonance or a notch its neighbours do not share. The ear
    holds on to that source, it stops being part of the ground and becomes a
    figure, and the field is heard as a thing that circles rather than as a
    field in motion. No correlation measure reports this, because correlation
    does not look at magnitude.

    Measured on the rendered per-source signals rather than on the filters, so
    the blend amount and any band shaping are included.
    """
    n = len(sigs)
    if n < 2:
        return None
    nfft = 4096
    take = min(len(sigs[0]), nfft * 8)
    win = np.hanning(nfft)
    mags = []
    for s in sigs:
        acc = np.zeros(nfft // 2 + 1)
        hops = max(1, (take - nfft) // (nfft // 2))
        for k in range(hops):
            seg = s[k * nfft // 2: k * nfft // 2 + nfft]
            if len(seg) < nfft:
                break
            acc += np.abs(np.fft.rfft(seg * win))
        mags.append(20 * np.log10(acc / max(hops, 1) + 1e-9))
    M = np.array(mags)
    f = np.fft.rfftfreq(nfft, 1 / fs)

    # Third-octave bands, not raw bins. A source is grabbed by a resonance
    # wide enough to hear, and bin-by-bin deviation is dominated by the ripple
    # every filter has, which averages out to much the same number for all of
    # them and hides the one that stands out.
    edges, fc = [], lo
    while fc < hi:
        edges.append((fc, fc * 2 ** (1 / 3)))
        fc *= 2 ** (1 / 3)
    B = np.array([[M[i, (f >= a) & (f < b)].mean() for a, b in edges]
                  for i in range(n)])
    B = np.nan_to_num(B)
    mean = B.mean(axis=0)
    dev = B - mean

    colour = np.sqrt((dev ** 2).mean(axis=1))    # how coloured each source is
    handle = np.abs(dev).max(axis=1)             # its worst single band
    worst = int(np.argmax(handle))
    # Where it sticks out, meaning energy this source has and its neighbours do
    # not. Reporting the largest deviation of either sign points at the region
    # a resonant source is missing rather than at the resonance itself.
    at = float(edges[int(np.argmax(dev[worst]))][0])
    return {"per_source_db": [round(float(v), 2) for v in handle],
            "colour_db": [round(float(v), 2) for v in colour],
            "mean_db": round(float(handle.mean()), 2),
            "spread_db": round(float(handle.max() - handle.min()), 2),
            "outlier": worst, "outlier_hz": round(at)}


def _component_coherence(x: np.ndarray, cfg: rf.FieldConfig, fs: int):
    """Measured inter-source coherence within each component separately.

    A whole-variant matrix mixes components that may be carrying deliberately
    different coherence, so the average across it describes nothing in
    particular. Reported per component alongside it.
    """
    comps = cfg.resolved_components()
    if len(comps) < 2:
        return None
    take = x[: min(len(x), 6 * fs)]
    per = cfg.per_source_decorr()
    out, at = [], 0
    for ci, c in enumerate(comps):
        n = max(int(c.n_sources), 1)
        cfgs = per[at:at + n]
        at += n
        if n < 2:
            out.append({"label": c.label or f"{c.lattice} {ci + 1}",
                        "kind": c.lattice, "n": n, "mean_offdiagonal": None})
            continue
        bank = rf.SourceBank(take, n, cfgs, fs)
        sigs = bank.blocks(0, len(take), bank.base_amounts())
        m = rf.coherence_matrix(sigs)
        off = m[~np.eye(n, dtype=bool)]
        out.append({"label": c.label or f"{c.lattice} {ci + 1}",
                    "kind": c.lattice, "n": n,
                    "mean_offdiagonal": round(float(np.mean(np.abs(off))), 4)})
    return out


def _measured_coherence(x: np.ndarray, cfg: rf.FieldConfig, fs: int,
                        duration: float = 0.0):
    """What the sources actually ended up looking like to each other.

    Measured on a slice rather than the whole span: the matrix is only used as
    a readout and the full-length correlation costs more than it reports.

    Sampled once, since the decorrelation amounts do not vary within a render.
    """
    take = x[: min(len(x), 6 * fs)]
    n_src = cfg.total_sources() if (cfg.components or cfg.rings) else cfg.n_sources
    decorr = (cfg.per_source_decorr() if (cfg.components or cfg.rings)
              else cfg.resolved_decorr())
    bank = rf.SourceBank(take, n_src, decorr, fs)
    az = cfg.resolved_azimuths()
    moving = False

    times = [0.0]
    if moving and duration > 0:
        times = [duration * f for f in (0.0, 0.25, 0.5, 0.75)]

    mats, means, distinct = [], [], None
    for t in times:
        amts = bank.amounts_at(t, az + cfg.rotation_deg_per_sec * t)
        sigs = bank.blocks(0, len(take), amts)
        m = rf.coherence_matrix(sigs)
        off = m[~np.eye(len(m), dtype=bool)]
        mats.append(m)
        means.append(float(np.mean(np.abs(off))) if len(off) else 0.0)
        if distinct is None:
            distinct = _source_distinctiveness(sigs, fs)

    out = {"matrix": [[round(float(v), 3) for v in row] for row in mats[0]],
           "mean_offdiagonal": round(means[0], 4),
           "distinctiveness": distinct,
           "time_varying": moving}
    if moving:
        out["mean_offdiagonal_range"] = [round(min(means), 4), round(max(means), 4)]
        out["sampled_at"] = [round(t, 2) for t in times]
    return out


@app.get("/api/source/{name:path}")
def source_audio(name: str):
    """The original file, for auditioning a selection before rendering it.

    Choosing which stretch of a track is worth studying is a listening job, and
    waiting on a render to do it would discourage looking around.
    """
    path = resolve_track(name)
    return FileResponse(path)


@app.get("/api/audio/{name}")
def audio(name: str):
    path = os.path.join(CACHE, os.path.basename(name))
    if not os.path.isfile(path):
        raise HTTPException(404, "render not in cache, render again")
    return FileResponse(path, media_type="audio/wav")


class ExportIn(BaseModel):
    id: str
    name: str = "ringfield"
    timeline: List[Dict[str, Any]] = []
    srt_verbose: bool = True


@app.post("/api/export")
def export(req: ExportIn):
    """Copy a cached render out to exports/ with its timeline and subtitles."""
    src = os.path.join(CACHE, f"{os.path.basename(req.id)}.wav")
    if not os.path.isfile(src):
        raise HTTPException(404, "render not in cache, render again")
    outdir = os.path.join(ROOT, "exports")
    os.makedirs(outdir, exist_ok=True)
    stem = "".join(c for c in req.name if c.isalnum() or c in "-_ ").strip() or "ringfield"
    base = os.path.join(outdir, stem)

    shutil.copyfile(src, base + ".wav")
    entries = [rf.TimelineEntry(**{k: v for k, v in e.items()
                                   if k in rf.TimelineEntry.__dataclass_fields__})
               for e in req.timeline]
    with open(base + ".json", "w", encoding="utf-8") as f:
        json.dump({"segments": req.timeline}, f, indent=2)
    if entries:
        rf.save_srt(base + ".srt", entries, req.srt_verbose)
    return {"wrote": [base + ".wav", base + ".json",
                      base + ".srt" if entries else None]}


# ----------------------------------------------------------------------
# Presets: named spin functions and arrangements. These are the user's
# instruments, so they persist as plain JSON files that can be edited by hand.
# ----------------------------------------------------------------------

class PresetIn(BaseModel):
    kind: str            # "spin" | "arrangement" | "layers"
    name: str
    data: Dict[str, Any]


def _preset_path(kind: str, name: str) -> str:
    safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip()
    if not safe:
        raise HTTPException(400, "preset needs a name")
    return os.path.join(PRESETS, f"{kind}__{safe}.json")


@app.get("/api/presets")
def list_presets():
    out = []
    for f in sorted(os.listdir(PRESETS)):
        if not f.endswith(".json"):
            continue
        kind, _, rest = f[:-5].partition("__")
        try:
            with open(os.path.join(PRESETS, f), encoding="utf-8") as fh:
                out.append({"kind": kind, "name": rest, "data": json.load(fh)})
        except (OSError, json.JSONDecodeError):
            continue
    return {"presets": out}


@app.post("/api/presets")
def save_preset(req: PresetIn):
    with open(_preset_path(req.kind, req.name), "w", encoding="utf-8") as f:
        json.dump(req.data, f, indent=2)
    return {"ok": True}


@app.delete("/api/presets/{kind}/{name}")
def delete_preset(kind: str, name: str):
    p = _preset_path(kind, name)
    if os.path.isfile(p):
        os.remove(p)
    return {"ok": True}


# ----------------------------------------------------------------------
# Feedback: files a GitHub issue when the gh CLI is available, and always
# keeps a local copy so nothing is lost when it is not.
# ----------------------------------------------------------------------

class FeedbackIn(BaseModel):
    kind: str = "note"          # bug | idea | question | note
    area: str = ""              # bench | learn | blind | measurement | other
    title: str = ""
    body: str
    contact: str = ""


@app.post("/api/feedback")
def feedback(req: FeedbackIn):
    import subprocess
    body = req.body.strip()
    if not body:
        raise HTTPException(400, "feedback needs some text")
    title = req.title.strip() or (body.splitlines()[0][:70])
    prefix = f"[{req.kind}]" + (f"[{req.area}]" if req.area else "")
    full_title = f"{prefix} {title}"
    issue_body = body + "\n\n---\n" + "\n".join(filter(None, [
        f"kind: {req.kind}", f"area: {req.area}" if req.area else "",
        f"contact: {req.contact}" if req.contact else "",
        "filed from the in-app feedback form"]))

    os.makedirs(os.path.join(ROOT, "feedback"), exist_ok=True)
    local = os.path.join(ROOT, "feedback", "feedback.jsonl")
    with open(local, "a", encoding="utf-8") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                            "title": full_title, "body": body,
                            "kind": req.kind, "area": req.area,
                            "contact": req.contact}) + "\n")

    try:
        r = subprocess.run(
            ["gh", "issue", "create", "--title", full_title, "--body", issue_body],
            cwd=ROOT, capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            url = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
            return {"ok": True, "issue": url, "local": False}
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"ok": True, "issue": None, "local": True,
            "note": "saved to feedback/feedback.jsonl; GitHub was not reachable"}


# ----------------------------------------------------------------------
# Listening test logging
# ----------------------------------------------------------------------

class TrialIn(BaseModel):
    """One trial.

    A trial is a pair, so condition/params describe side A and condition_b /
    params_b describe side B. Both are optional so that a session file written
    by an older single-stimulus run still parses.
    """
    session: str
    trial: int
    condition: str
    params: Optional[Dict[str, Any]] = None
    condition_b: Optional[str] = None
    params_b: Optional[Dict[str, Any]] = None
    identity: Optional[bool] = None      # both sides the same render: a catch trial
    switches: Optional[int] = None       # how many times the listener crossed over
    responses: Dict[str, Any]
    blind: bool = True
    seconds: Optional[float] = None
    presentation_index: Optional[int] = None


@app.post("/api/trial")
def log_trial(req: TrialIn):
    """Append one trial to its session file.

    Written as newline-delimited JSON so a crashed or abandoned session still
    leaves every completed trial on disk. Responses are never overwritten.
    """
    safe = "".join(c for c in req.session if c.isalnum() or c in "-_") or "session"
    path = os.path.join(SESSIONS, f"{safe}.jsonl")
    row = req.model_dump()
    row["logged_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    return {"ok": True, "path": os.path.relpath(path, ROOT)}


@app.get("/api/sessions")
def list_sessions():
    out = []
    for f in sorted(os.listdir(SESSIONS)):
        if f.endswith(".jsonl"):
            p = os.path.join(SESSIONS, f)
            with open(p, encoding="utf-8") as fh:
                n = sum(1 for _ in fh)
            out.append({"name": f[:-6], "trials": n})
    return {"sessions": out}


@app.get("/api/session/{name}.csv")
def session_csv(name: str):
    """Flatten a session to CSV for analysis elsewhere."""
    import csv
    safe = "".join(c for c in name if c.isalnum() or c in "-_")
    path = os.path.join(SESSIONS, f"{safe}.jsonl")
    if not os.path.isfile(path):
        raise HTTPException(404, "no such session")

    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            flat = {k: v for k, v in r.items()
                    if k not in ("responses", "params", "params_b")}
            for k, v in (r.get("responses") or {}).items():
                flat[f"response.{k}"] = v
            # Side A keeps the unprefixed column names so a file mixing paired
            # trials with older single-stimulus ones still lines up.
            for prefix, p in (("", r.get("params") or {}),
                              ("b.", r.get("params_b") or {})):
                if not p:
                    continue
                d = p.get("resolved_decorr") or {}
                flat.update({
                    f"{prefix}n_sources": p.get("n_sources"),
                    f"{prefix}rotation_deg_per_sec": p.get("rotation_deg_per_sec"),
                    f"{prefix}azimuths": json.dumps(p.get("resolved_azimuths")),
                    f"{prefix}decorr_family": d.get("family"),
                    f"{prefix}decorr_amount": d.get("amount"),
                    f"{prefix}ir_ms": d.get("ir_ms"),
                    f"{prefix}density": d.get("density"),
                    f"{prefix}envelope": d.get("envelope"),
                    f"{prefix}seed": d.get("seed"),
                })
            rows.append(flat)

    if not rows:
        return Response("", media_type="text/csv")
    cols: List[str] = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition":
                             f'attachment; filename="{safe}.csv"'})


# ----------------------------------------------------------------------

class NoCacheStatic(StaticFiles):
    """Serve the front end without caching.

    The default sends validators, so a browser holds on to app.js and app.css
    across edits and keeps running the previous version. On a local instrument
    that is edited constantly, a stale asset looks exactly like a bug in the
    code you just changed.
    """

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        return resp


app.mount("/", NoCacheStatic(directory=os.path.join(ROOT, "static"), html=True),
          name="static")


DEMO_TRACK = "demo-drone.wav"


def ensure_demo_audio() -> None:
    """Write a synthetic passage if the folder has no audio in it.

    Audio is excluded from the repository, so a fresh clone starts with an
    empty track list and nothing to listen to. That makes the instrument look
    broken to anyone who did not build it.

    sweep.make_test_signal exists but is the wrong stimulus: it is a string of
    plucks, and transients are exactly what restores the localization this is
    trying to remove, so a first listen on it would show the treatment failing.
    This is sustained and nearly transient-free instead, which is the material
    the method calls for: a harmonic drone with slowly beating partials over a
    band-limited wash, broadband enough to carry a level difference between
    the ears.
    """
    for folder in (ROOT, UPLOADS):
        for f in os.listdir(folder) if os.path.isdir(folder) else []:
            if f.lower().endswith(AUDIO_EXT) and not f.startswith("."):
                return

    fs, dur = 44100, 45.0
    n = int(fs * dur)
    t = np.arange(n) / fs
    rng = np.random.default_rng(7)
    x = np.zeros(n)

    # Partials over a 110 Hz fundamental, up to 8 kHz. Each is detuned a little
    # and breathes at its own sub-hertz rate, so the sound evolves without any
    # event in it sharp enough to time. The stack has to reach the top of the
    # range: the level difference between the ears is a high-frequency cue, so
    # a drone with nothing above 2 kHz would be spatially inert.
    # The 1/k**0.45 tilt is set by measurement, not by taste. A steeper tilt
    # sounds more like an organ and decorrelates far worse, because the energy
    # collects in the bass where there is no level difference to work with: at
    # 1/k**0.9 a fully decorrelated ring of nine still measures IACC 0.65,
    # against 0.25 here. A demo on the darker version would show the treatment
    # failing and look like a bug in the instrument.
    # The breathing is shallow on purpose. At +/-0.45 per partial the finished
    # drone swung 3.3 dB over a few seconds, and a listener judging motion
    # reported static fields as fading away and returning, correctly suspecting
    # the material rather than the treatment. A stimulus for motion judgements
    # has to hold still in every respect except the one under test.
    for k in range(1, 73):
        detune = 1.0 + rng.uniform(-0.004, 0.004)
        breathe = 0.93 + 0.07 * np.sin(2 * np.pi * rng.uniform(0.03, 0.11) * t
                                       + rng.uniform(0, 6.28))
        x += (breathe / k ** 0.45) * np.sin(2 * np.pi * 110.0 * k * detune * t
                                            + rng.uniform(0, 6.28))

    # A wash between the partials, so the spectrum is continuous rather than a
    # comb. Lightly smoothed to take the edge off while keeping the top octaves.
    wash = rng.normal(0, 1, n)
    kern = np.hanning(7)
    wash = np.convolve(wash, kern / kern.sum(), mode="same")
    x = x + 0.30 * wash / (np.max(np.abs(wash)) or 1.0)

    fade = int(fs * 2.0)
    ramp = np.sin(np.linspace(0, np.pi / 2, fade)) ** 2
    x[:fade] *= ramp
    x[-fade:] *= ramp[::-1]

    # Levelled by RMS, not by peak. A drone is flat, so a peak-normalised one
    # is far louder than music normalised the same way: this at 0.7 peak
    # measured 4.9 dB hotter than the song it sits next to in the list, and
    # arrives on headphones with no warning. Target is a quiet -26 dBFS with a
    # peak ceiling well below full scale, since the first thing anyone hears
    # should never be the loudest.
    rms = float(np.sqrt(np.mean(x ** 2))) or 1.0
    x = x * (10 ** (-26.0 / 20.0) / rms)
    peak = float(np.max(np.abs(x))) or 1.0
    if peak > 0.5:
        x *= 0.5 / peak

    sf.write(os.path.join(ROOT, DEMO_TRACK), x.astype(np.float32), fs)
    print(f"wrote {DEMO_TRACK}: 45s of sustained material to start from")


if __name__ == "__main__":
    import uvicorn
    ensure_demo_audio()
    print("ringfield: http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")

