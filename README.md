# ringfield

Binaural renderer for rotating fields of decorrelated sources. Built to test
one question: **can a listener perceive a field as rotating without localizing
any source in it?**

By Jonas (jonas030405@gmail.com).

## Setup

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install numpy scipy soundfile matplotlib sounddevice fastapi uvicorn pytest
```

`sofar` is optional, and only needed when you move to measured HRTFs:
```bash
pip install sofar
```

## Run

```bash
python app.py
```

Then open http://127.0.0.1:8000. Listen on headphones, with Windows Sonic and
Dolby Atmos for Headphones **off** or a second HRTF gets applied on top of ours.

Upload a track or pick one, drag a region on the waveform to make a **passage**,
give it **variants**, and render. The track then plays dry while every variant
runs alongside it in sync: hold <kbd>1</kbd>..<kbd>9</kbd> to punch one in
mid-playback and release to return to dry. Everything shares one amplitude
scale, so switching changes the spatial treatment and nothing else.

The `?` beside the title runs a guided tour of the whole interface.

**Learn** opens a curriculum: six short courses in order, from how two ears
produce a sense of direction through to running a listening test that counts as
evidence. Terms inside a lesson open a definition without leaving the lesson.

Every reference entry is labelled with its status: established literature with a
citation, an implementation choice in this codebase, vocabulary invented for
this project, a result measured here, or an open conjecture. That distinction is
enforced by the test suite. **Unison rotation** and **circulating coherence
hotspot** are this project's own coinages, not terms of art; describe the
configuration rather than naming it when writing for anyone else.

The command line tools still work and are the faster path for batch renders:

```bash
python compare.py wll.mp3        # one passage, several treatments
python variations.py wll.mp3     # whole arrangements back to back
python make_track.py wll.mp3     # one arrangement across a song
python sweep.py                  # parameter grid, no input needed
pytest -q                        # 114 tests, run before and after changes
```

## What is in here

| File | Role |
|---|---|
| `ringfield.py` | the DSP. Read this one. |
| `app.py` | web app backend. Wraps the renderers, contains no DSP. |
| `static/` | the app itself: bench, arrangement builder, blind test, tour |
| `courses.json` | the curriculum: six sequenced courses, 27 lessons |
| `encyclopedia.json` | cross-linked reference, every entry status-labelled |
| `guide.json` | theory, literature orientation, and how to get effects |
| `glossary.json` | short definitions, shared with this README |
| `tests/` | the regression suite. The numbers below live here. |
| `make_track.py` | **edit this one.** Per-region treatment of a real song. |
| `sweep.py` | renders the parameter grid and logs IACC |

## Working on a real song

```bash
python make_track.py "Whole Lotta Love.mp3"
```

MP3, WAV, FLAC and OGG all load directly. No pre-segmenting, no chopping the
file up: you declare time regions and the renderer stitches them with
equal-power crossfades. Edit the `ARRANGEMENT` list in `make_track.py`:

```python
ARRANGEMENT = [
    dry(0, 20),                                # original stereo, untouched
    spin(20, 44, rate=30, n=6, decorr=1.0),    # slow drift
    spin(44, 68, rate=120, n=6, decorr=1.0),   # obvious rotation
    hotspot(68, 92, rate=60, n=6, bed=1.0),    # the hypothesis case
    spin(92, 110, rate=540, n=8, decorr=0.7),  # past the speed limit
    dry(110, 140),
]
```

Rendered regions are RMS-matched to the dry material, so switching treatments
does not change the loudness. Rotation phase restarts at each segment's
`start_azimuths`, so segments are independent and predictable.

Four blocks in `ringfield.py`, in the order worth reading them:

1. **HRTF models.** `woodworth_itd` (interaural time difference),
   `head_shadow_coeffs` (Brown & Duda 1998 one-pole/one-zero shadow filter),
   `frac_delay_ir` (windowed-sinc fractional delay). Together these synthesize
   a spherical-head HRTF with no dataset download. `SofaHRTF` is the drop-in
   for measured data later: identical interface, so nothing downstream changes.
2. **Decorrelation.** `DecorrConfig` is the control set: family (velvet or
   allpass), IR length, impulse density, IR envelope, phase depth,
   per-band amounts over exposed crossovers, micro-delay and micro-pitch
   spread, and an LFO on the amount. `SourceBank` realises it, writing each
   source as `x + a*d_i` so band shaping folds in once and a time-varying
   amount costs nothing at render time. Every control preserves per-source
   level through a closed-form correction.
3. **Render.** `render()` does overlap-add time-varying convolution with
   periodic-Hann COLA blocks. This is what makes moving sources smooth
   instead of clicky. Decorrelation amount is evaluated per block, which is
   what lets a hotspot sweep independently of the sources. Pass a list as
   `trace` to get per-frame azimuths and amounts back for display.
4. **Analysis.** `iacc()` is the interaural cross-correlation coefficient:
   ~1.0 means coherent and centred, near 0 means diffuse and enveloping.
   `iacc_bands()` splits it by octave, `metrics()` bundles everything, and
   `paired_modulation()` is the only one of them that can speak to rotation.

## Verified behaviour

All of this is asserted in `tests/`. Run `pytest -q` before and after changing
anything: several of these numbers were wrong at some point and the audio still
*played*, it was just physically incorrect.

- ITD peaks at 0.656 ms at 90 deg azimuth, sign flips across the median plane.
  Measured back off the rendered output: 0.658 ms.
- ILD grows with frequency as it should: +1.3 dB at 200-500 Hz, +7.8 dB at
  1-2 kHz, +15.2 dB at 4-8 kHz. Low frequencies diffract around the head,
  high frequencies are shadowed.
- IACC falls monotonically with the decorrelation knob: 1.000 / 0.921 / 0.554
  on a static 8-source ring at amount = 0 / 0.35 / 0.70.
- Per-source level is flat to within 0.2 dB across the whole amount sweep, and
  across every decorrelation control separately.

### The metrics have a noise floor, and it is large

At amount = 1.0 the fourth IACC value is **not** reproducible. It varies with
the random draw: over twelve seeds, sd 0.038 and range 0.166 to 0.283. An
earlier version of this README reported 0.271 as if it were a constant; it was
one sample. Inter-source coherence carries about 0.05 per draw.

This matters more than it sounds. Ring geometry moves IACC by 0.039 to 0.051,
which is *inside* that floor, so those differences cannot be resolved from one
render per condition. Fix the seed when comparing, or average over several.

Two decorrelation controls also do less than they look like they do: velvet
density is a large effect while the IR is sparse and then saturates completely
past roughly 400 impulses/sec, and IR envelope dominates when sparse and is
inert when dense. IR length is the axis with real headroom.

## The result that matters

A fully coherent, evenly spaced ring renders with **L and R identical to
machine precision**. It is a dead-centre mono image with no interaural
information at all, and rotating it does not change that. The rotation
produces only slow timbral shimmer from shifting comb filtering.

This is a symmetry property, not a bug: summing identical copies over a
symmetric ring cancels the interaural differences that would carry rotation.

So the symmetry has to be broken for rotation to be perceptible at all.
Four ways to break it, all supported:

- `decorr_amount > 0` (the main knob)
- uneven `start_azimuths`
- `per_source_gain_db`
- `per_source_amount`: one coherent source inside an otherwise diffuse bed

## The main case: unison rotation

A ring of mutually decorrelated sources, **all turning together**. Every source
travels, keeping its position relative to the others; each one is individually
diffuse because of the decorrelation.

```python
cfg = rf.FieldConfig(
    n_sources=5, rotation_deg_per_sec=60,
    start_azimuths=[-90, -18, 54, 126, 198],
    decorr=rf.DecorrConfig(amount=1.0, family="allpass"))
```

The two properties come from two different controls, and keeping them separate
is the design. **Rotation** is the ring rate. **Unlocalizability** is the
decorrelation amount. Turn decorrelation down and you get trackable objects
circling you, which nobody disputes is possible. Turn it up and the sources
dissolve into a diffuse field. Does that field still turn?

This is the direct counterpart of the random-dot kinematogram, where the dots
themselves move and the coherence is in their common motion.

### A narrower probe

`HotspotConfig` removes even the source motion: coherence becomes a property of
a **direction** and sweeps at its own rate while every source stands still.

```python
cfg = rf.FieldConfig(
    n_sources=5, rotation_deg_per_sec=0,          # nothing moves
    start_azimuths=[-90, -18, 54, 126, 198],
    decorr=rf.DecorrConfig(amount=1.0, family="allpass"),
    hotspot=rf.HotspotConfig(enabled=True, deg_per_sec=90, width_deg=80))
```

This asks whether rotation can ride on coherence structure alone. It is a
follow-up to the main case, not a replacement for it: a null result here says
much less, because it has removed the very motion the ordinary account of
auditory motion would work with.

## Proving it is another matter

**No single render can show that a field is rotating.** Broadband IACC does not
separate rotation from diffuseness, and the obvious alternative, looking for
modulation of the interaural statistics at the rotation rate, is confounded on
real music: the song's own periodicity sits in the same part of the series.
Over 20 s of the theremin section, a **completely static** field scored 2.04 at
0.5 Hz where genuinely rotating fields scored 2.65 to 3.14.

So every rotation claim needs a matched static control: identical
configuration, identical seed, every rate set to zero. The app detects these
automatically and reports the paired difference. Its default layer set ships
one control per moving condition, and `rf.paired_modulation` is the same thing
from Python.

## Known limits of the analytic HRTF

- No pinna cues, so no elevation and genuine front-back confusion. Woodworth
  is front-back symmetric by construction.
- Not individualized. Swap in `SofaHRTF` with a measured set to fix both.
- `SofaHRTF` uses nearest-neighbour azimuth lookup. Naive interpolation of
  HRIRs causes comb filtering from time-of-arrival misalignment, so the real
  upgrade is: separate the ITD, interpolate magnitude, reapply the delay.

## HRTF datasets to move to

- **SADIE II** (York): KU100 and KEMAR, dense grids, free, SOFA.
- **SONICOM**: large recent database, 200 subjects, built for personalization
  research.
- **CIPIC**: the classic 45-subject set with anthropometric measurements.

## Next steps in the code

- **SOFA/measured HRTFs wired into the app.** The class exists and the
  interface is unchanged, so this is a file picker plus resampling. It is what
  unblocks the rotation-direction question, which is currently unanswerable:
  under the analytic HRTF a full lap reads as left-right oscillation at twice
  the rate, so "is it turning, and which way" is confounded while "can I point
  at anything" is not.
- ITD-aligned HRIR interpolation: separate the ITD, interpolate magnitude,
  reapply the delay. Naive HRIR interpolation comb filters.
- headphone compensation filter
- head tracking
- a target coherence matrix as a first-class control, generalising the hotspot
  to arbitrary structures
- **a second listener.** The blind-test harness is built and logs to CSV with
  full parameter provenance, but everything measured so far is still n=1 with
  the hypothesis in the room.
