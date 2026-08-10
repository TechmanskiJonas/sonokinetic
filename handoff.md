# ringfield — project handoff

Read this before changing anything. It carries the context, the findings that
constrain the design, and the spec for what to build next.

---

## 1. Who this is for and why it exists

I am a rising senior at UIUC (math + philosophy, CS minor) applying to audio
ML PhD programs this fall. This codebase is the research artifact behind that
application: a working prototype plus a real result, to be shown to faculty
(primarily Minje Kim, Siebel CS, audio ML) in September.

**It is a sandbox for experimentation, not a product.** Optimise for: fast
iteration, total parameter visibility, and the ability to try things I have
not thought of yet. Do not optimise for: polish, onboarding flows, hiding
complexity, or opinionated defaults that lock out exploration.

### The research question

> Can a listener perceive a field of sound as **rotating** without
> **localizing** any individual source in it?

Not "a sound moves from A to B." A pooled, global sense of the field turning,
with nothing pointable in it. The visual analogue is a random-dot
kinematogram: you see coherent rotation without tracking any single dot.
The auditory version is largely unmapped, because the dominant model of
auditory motion assumes motion is reconstructed from successive
*localizations* of single sources.

The hypothesis that follows: rotation should be carried by slow cyclic
modulation of the **aggregate interaural statistics** of an ensemble, not by
any source's position. Every design decision below serves testing that.

---

## 2. What already works (do not regress this)

```
ringfield.py     DSP core. Treat as load-bearing.
app.py           FastAPI backend for the web app
static/          the app: bench, arrangement builder, blind test
courses.json     the curriculum: six sequenced courses, 27 lessons
encyclopedia.json  cross-linked reference, every entry status-labelled
guide.json       theory, literature orientation, and how to get effects
glossary.json    short definitions, also read by the README
static/tour.js   guided tour of the interface, no dependencies
uploads/         your own audio, added through the app
tests/           pytest suite, 182 tests. Run it before and after any change.
make_track.py    one arrangement across a whole song
variations.py    several complete arrangements played back to back
compare.py       one passage repeated under different treatments
sweep.py         parameter grid + IACC log
```

Run the app: `python app.py`, then open http://127.0.0.1:8000.
Run the CLI tools as before: `python variations.py song.mp3`.
Run the tests: `pytest -q`.

Renders take roughly 1 s per second of audio per layer. A 12 s passage under 5
layers is about 11 s. MP3/WAV/FLAC/OGG all load via libsndfile.

### Architecture

- **HRTF providers** expose one method, `hrir(azimuth_deg) -> (2, taps)`.
  - `AnalyticHRTF`: spherical head, synthesized, zero downloads. Woodworth
    ITD + Brown & Duda (1998) one-pole/one-zero head shadow.
  - `SofaHRTF`: drop-in for measured HRTFs. Same interface, nothing
    downstream changes. Needs `sofar`.
- **`decorrelate(x, n, method, amount, fs, seed)`** turns one mono signal
  into N variants of controllable mutual coherence.
- **`render(x, hrtf, cfg, fs)`** overlap-add time-varying convolution.
  Periodic-Hann COLA blocks, 256 with 128 hop, one batched FFT convolution
  per block across all sources and both ears.
- **`render_timeline`** places treatments at absolute song positions.
  **`render_blocks`** renders several complete arrangements and concatenates
  them. **`render_sequence`** repeats one passage under different treatments.
- **`iacc`**, **`loudness_lufs`** (BS.1770 K-weighting), **`_match_level`**.

### Verified numbers — use these as regression tests

| Check | Expected |
|---|---|
| ITD at 90° azimuth | 0.656 ms predicted, 0.658 ms measured off the render |
| ILD by band at 90° | +1.3 dB (200–500 Hz), +7.8 dB (1–2 kHz), +15.2 dB (4–8 kHz) |
| IACC vs decorr amount, static 8-ring | 1.000 / 0.921 / 0.554 / 0.271 at 0 / 0.35 / 0.70 / 1.0 |
| Per-source level vs decorr amount | flat at 1.000 for all amounts |
| Mono dry vs original stereo | equal LUFS |
| `_match_level(mode="lufs")` | lands exactly on the reference LUFS |

The suite now exists: `tests/`, 114 tests, encoding the table above plus every
finding in §3 and §3b. Run it before and after any change. One correction to
the table: the IACC value at amount=1.0 was written down as 0.271, but that is
one draw from a distribution, not a constant. See finding 8.

---

## 3. Findings that constrain the design

These were measured, not assumed. Do not "simplify" them away.

1. **A fully coherent, evenly spaced ring is degenerate.** It renders with
   L and R identical to machine precision: a dead-centre mono image with no
   interaural information. Rotating it changes nothing. Summing identical
   copies over a symmetric ring cancels exactly the differences that would
   carry rotation. **Symmetry-breaking is mandatory**, via decorrelation,
   uneven spacing, per-source gain, or per-source coherence.

2. **Odd source counts avoid antipodal cancellation.** With an even ring
   every source has one directly opposite it, and those pairs are what
   cancel. Rings are currently 3 or 5 for this reason.

3. **The analytic HRTF has zero front–back discrimination.** az=0 and az=180
   produce bit-identical HRIRs (also 45/135, 225/315). Woodworth is
   front-back symmetric by construction and a sphere has no pinna. A full
   360° rotation therefore reads as left-right oscillation at twice the
   rate. Measured HRTFs improve this; only head tracking really solves it.
   **Consequence: "is it turning, and which way" is confounded right now.
   "Can I point at anything" is not.** Design the app so the second question
   is answerable today and the first becomes answerable when SOFA support
   and head tracking land.

4. **The dry/wet blend was not power preserving.** `(1-a)x + a*wet` dipped
   ~5.4 dB at a=0.5. Fixed by renormalising the mix. Any new decorrelation
   control must preserve per-source level, or the knob changes loudness as
   well as coherence and the comparison is worthless.

5. **Level matching must be local and K-weighted.** Matching to the whole
   track's average flattens the song's dynamics. Raw RMS misses the
   spectral differences between decorrelation methods.

6. **Sustained material decorrelates far more readily than transient
   material.** Theremin passages hit IACC 0.04–0.05 where guitar sits at
   0.38–0.62. Transients give the auditory system discrete localization
   snapshots, which is exactly the percept we are trying to avoid.

7. **IACC does not capture everything I hear.** Velvet measures slightly
   *louder* than allpass in LUFS but is perceived as quieter, and its IACC
   is much lower (0.12 vs 0.33). Ring geometry barely moves IACC
   (0.039/0.040/0.051) even where it may be clearly audible. **Where the
   metric and the percept come apart is the interesting part, not an error
   to correct.** Show both, never let the metric overwrite the listener.

---

## 3b. Findings from building the app

These came out of writing the test suite and are all measured. Several of them
change how the experiment has to be run, not just how the code is written.

8. **The coherence metrics have a noise floor, and it is large.** At
   amount=1.0 the IACC of a static 8-ring varies with the random draw. Over
   twelve seeds: sd 0.038, range 0.166 to 0.283 with the current per-source
   seeding, and sd 0.064, range 0.118 to 0.356 when all the IRs come from one
   stream. Inter-source coherence carries about 0.05 per draw. The documented
   0.271 was one sample from that distribution, not a constant, which is why
   the test asserts a band and the trend rather than the point value.
   **Finding 7's ring-geometry differences of 0.039/0.040/0.051 are inside
   this floor**, so they are not resolvable from one render per condition.
   Fix the seed when comparing, or average over several.

9. **Two of the decorrelation controls do far less than they appear to.**
   Velvet density is a large effect while the IR is sparse (coherence 0.50 at
   60 impulses/sec down to 0.07 at 400) and then saturates completely: 1500,
   20000 and 44100 impulses/sec are indistinguishable. IR length is the axis
   with real headroom, running 0.19 down to 0.04 across 5 to 120 ms. Sweep
   that one.

10. **The prefabs differed in envelope, not just density.** Velvet was flat
    and allpass was Hann-windowed, so comparing them on density was really
    measuring the window. Envelope is now its own control. It dominates when
    the IR is sparse (at 60 impulses/sec, flat gives 0.50 against Hann's 0.08,
    because a flat envelope leaves velvet's forced direct tap at full
    amplitude) and is inert once dense. Held equal, velvet does converge on
    allpass, which is what makes them one axis.

11. **No single render can show that a field is rotating.** This is the
    important one. Broadband IACC does not separate rotation from
    diffuseness: a static diffuse field and a rotating one land in the same
    place. The obvious alternative, looking for modulation of the interaural
    statistics at the rotation rate, is confounded on real music, because the
    song's own periodicity sits in the same part of the series. Measured over
    20 s of the theremin section, a **completely static** field scored 2.04 at
    0.5 Hz where genuinely rotating fields scored 2.65 to 3.14.

    Every rotation claim therefore needs a **matched static control**:
    identical configuration, identical seed, every rate set to zero. The app
    detects these automatically and reports the paired difference, and the
    default layer set ships with one control per moving condition.

    Caveat on top of the caveat: the paired delta is itself noisy at short
    passage lengths. The same comparison gave +0.61 for ring rotation over a
    20 s passage and −0.91 over a 12 s one. Use 20 s or more and repeat across
    seeds before concluding anything from it.

12. **The micro-delay spread was folding.** Delay cannot go negative, so a
    symmetric −1..1 spread handed the first and last source the same delay,
    leaving them perfectly correlated. Now runs 0..1. Caught by a test, not by
    listening, which is the failure mode §2 warns about.

---

## 4. The app, as built

Local web app: FastAPI wrapping the existing renderers, plain HTML/JS
frontend, no build step. `ringfield.py` remains the only DSP; `app.py` turns
JSON into dataclasses, caches renders and serves files. No real-time DSP.

Three tabs plus two reference sheets.

**Bench.** The main surface. Upload or select a track, drag a region on the
waveform to define a **passage**, give the passage **variants** (the untreated
original, plus any number of spin functions), and render.

Playback runs a dry spine of the whole track while every variant sits alongside
it, silent and in sync. Holding <kbd>1</kbd>..<kbd>9</kbd> **punches a variant
in** mid-playback and releasing returns to dry, which is the closest thing to
real-time control without any real-time DSP. Loop a passage to work on it, or
play the whole track and punch in as each passage arrives. Spine and variants
share a single amplitude scale, so the punch-in never jumps in level.

Alongside: a top-down ring showing each source's live azimuth and coherence
and the hotspot's position, the full parameter readout, and the metrics panel.

**Learn sheet.** The front door is now a **curriculum**: six sequenced courses
in `courses.json`, 27 lessons, from two ears and two differences through to
running a listening test that counts. Each course states what it assumes; each
lesson carries an optional exercise and a self-check question. Progress is kept
in localStorage.

Terms inside a lesson open a **definition card in place**, anchored to the
word, so the reader never loses their position. The card offers the full entry,
and the back button returns to the exact lesson.

Behind that: `encyclopedia.json` (126 entries) and `guide.json` (theory,
literature orientation, recipes, and how not to fool yourself).

**Every reference entry declares its epistemic status**, and this matters more
than it sounds:

| Status | Meaning |
|---|---|
| `established` | Standard material with a literature behind it, and a citation |
| `implementation` | A design choice in this codebase, not a fact about hearing |
| `project` | Vocabulary invented here. Not a term of art |
| `measured` | A result from this codebase, reproducible from the test suite |
| `open` | A hypothesis under test, stated as such |

An earlier pass presented **unison rotation** and **circulating coherence
hotspot** alongside ITD and IACC with no distinction. Both are coinages from
this work; nobody else will recognise them. The random-dot kinematogram is
genuinely established vision science, but *using it as an auditory analogy* is
this project's own move, and the two were blurred. `tests/test_reference.py`
now asserts the labelling, so a coinage cannot quietly acquire the appearance
of a citation.

**Guided tour.** A 16-step walkthrough of the interface, reachable from the `?`
beside the title. Dependency-free, in `static/tour.js`; steps can prepare the
interface and gate progress on a render completing.

**Arrangement.** All three renderer modes (`timeline`, `blocks`, `sequence`),
segment editing with per-segment parameters, JSON import/export, and export to
WAV + timeline JSON + SRT subtitles. Timeline renders are cropped to their
covered span by default, since otherwise a 10 s experiment on a 6 min track
returns 6 min of mostly silence.

**Blind test.** Conditions come from the bench layers, presented in randomised
order with labels hidden. Forced-choice on: can you point at anything, is it
turning, which way (flagged as confounded), plus an envelopment scale.
Responses append to `sessions/*.jsonl` as they are made, so an abandoned
session keeps everything already answered, and flatten to CSV with full
parameter provenance at `/api/session/<name>.csv`.

Every parameter and metric label has a hover definition sourced from
`glossary.json`.

### Rings, distance, and random motion

A field is now a list of **rings**. Each ring carries its own source count,
rotation rate, azimuths, gain, and **distance in metres** (2 m renders at unity;
per-ear gains follow the source-to-ear geometry, so near sources gain the
near-field ILD growth; no delay, Doppler, air absorption, or reverb, and the
reference says so). Each ring can also give a **share of its sources to smooth
seeded wandering** instead of rotation, the kinematogram coherence
manipulation, plus radial wander. The matched control zeroes ring rates AND
freezes wander, and the server pairs such controls automatically. Legacy scalar
configs (rings=None) render bit-identically; `tests/test_rings.py` asserts it.

The variant editor is modular: ring cards with duplicate/copy/paste across
variants. Blind test: 0–6 scales, localization of individual sources separated
from centred-in-head (a mono image is centred yet pointable), motion-kind
conditional on a nonzero motion rating, notes box, and **no direction question**
(front-back symmetry makes direction unrecoverable; the page says so).

Four tours under the `?` menu (overview, hands-on build, arrangement, blind
test); interactive steps gate Next on the actual action with a hint, clicks
pass through the spotlight, and clicking outside never dismisses. Experiments
(track + passages + variants) save/load by name. **Participant mode**:
`/?mode=test&experiment=NAME&session=ID` hides everything but the blind test,
renders the experiment, and logs under the given session. The Feedback tab
files GitHub issues via `gh` when signed in, and always appends to
`feedback/feedback.jsonl` locally.

### What is still open

1. SOFA/measured HRTF support wired into the UI. The class already exists and
   the interface is unchanged, so this is mostly a file picker plus resampling.
   It is what unblocks the rotation-direction question (finding 3).
2. Head tracking.
3. Target coherence matrix as a first-class control (§5). The circulating
   hotspot is the case that mattered most and it is built, but specifying an
   arbitrary coherence structure is not yet expressible.
4. A second listener. Everything above still has n=1 with the hypothesis in
   the room.

---

## 5. Decorrelation: break apart the prefabs

Currently `method` is a black box with two values, `"velvet"` and
`"allpass"`. Decompose it into orthogonal controls.

**The principled framing:** decorrelation means applying filters `h_i` to
each source such that the `h_i` are mutually incoherent while each stays
approximately allpass. What actually matters is the resulting
**inter-source coherence structure**; the filter design is just how you
realise it. Build toward specifying a *target coherence matrix* and treating
the decorrelators as the means. That framing generalises the coherence
hotspot into "any coherence structure, including one that rotates," which is
the core hypothesis.

Controls, all now built as `DecorrConfig` and exposed in the UI:

- **IR length** (ms). Temporal smearing. The axis with the most headroom.
- **Impulse density** (impulses/sec). Sparse velvet through to dense noise.
  Saturates by roughly 400: see finding 9.
- **IR envelope** (flat/hann/decay). Was a hidden variable in the prefabs and
  is now separable: finding 10.
- **Phase randomization depth** (0 to 1). Partial scrambling, not just on/off.
- **Frequency-dependent decorrelation.** Crossover plus per-band amount. Bands
  are built as differences of lowpasses so they telescope back to the input,
  which makes uniform gains exactly inert: the crossover colours nothing until
  it is actually used.
- **Per-source amount.** Surfaced.
- **Time-varying amount.** LFO on decorrelation, with optional phase spread
  across sources.
- **Micro-delay spread** and **micro-pitch shift.** Built; see finding 12 for
  the bug that was in the first version.
- **Circulating coherence hotspot.** `HotspotConfig`. Coherence becomes a
  property of a direction rather than of a source: the hotspot sweeps at its
  own rate, independent of the ring's, and a source is coherent only while it
  is near it. Set the ring rate to 0 and the hotspot rate to nonzero and no
  source moves at all while the coherence structure rotates.

  **Scope note.** An earlier pass through this document promoted the hotspot to
  "the hypothesis" and made it the default. That was wrong. The main case is
  **unison rotation**: a ring of decorrelated sources all turning together,
  which is the direct counterpart of the random-dot kinematogram, where the
  dots themselves move. Rotation comes from the ring rate, unlocalizability
  from the decorrelation amount, and separating those two is the point. The
  hotspot is a narrower follow-up asking whether rotation survives when even
  the source motion is removed; a null result there says much less than a null
  result for unison rotation. The app now opens on unison rotation with its
  matched static control, and offers the hotspot as a variant preset.
- **Pairwise/target coherence matrix.** Still not expressible. The hotspot
  covers the case that mattered; arbitrary structures do not.

**Constraint on all of the above:** every control preserves per-source level,
enforced by a closed-form correction rather than a measured one (so it holds
when the amount varies within a segment) and asserted per axis in
`tests/test_decorr.py`. Measured coherence is reported next to the requested
value throughout.

---

## 6. Working notes

- Windows, PowerShell, venv at `.venv` managed by `uv`.
  `uv pip install ...`, activate with `.venv\Scripts\activate`.
- Deps: numpy, scipy, soundfile, matplotlib, sounddevice. `sofar` optional.
- Listening is on open-back headphones. **Windows Sonic / Dolby Atmos for
  Headphones must stay off** or a second HRTF is applied on top of ours.
- Watch performance: an early version used `np.correlate(mode="full")`,
  which is naive O(N²) and hung on 350k samples. Restricting to the lags
  actually needed fixed it. Profile before assuming numpy is fast.
- Style: prefer colons to em-dashes, no gerund openers, no hedging filler.
  Comments should explain *why*, especially where a choice encodes one of
  the findings in §3.