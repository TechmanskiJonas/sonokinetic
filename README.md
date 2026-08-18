# Sonokinetic

Can motion in a field of sound be perceived without localizing anything in it?

A binaural renderer and experiment bench for testing that question. It builds a
field of virtual sources from a piece of audio, gives the field a motion, and
makes each source individually too diffuse to locate. Whether the field is still
heard to move is the experiment.

Jonas Techmanski · jonas030405@gmail.com

**[Hear it without installing anything →](https://techmanskijonas.github.io/sonokinetic/)**
Eight variants of the same twenty seconds, sample-aligned and loudness-matched,
with the field drawn as it plays. Headphones required.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate
pip install numpy scipy soundfile matplotlib sounddevice fastapi uvicorn python-multipart pytest
```

`sofar` is optional and only needed for measured HRTFs.

## Run

```bash
python app.py
```

Open http://127.0.0.1:8000, on headphones, with any operating-system spatial
audio switched off: it applies a second head model on top of this one.

### Audio

Recordings are not in the repository, so the first run writes `demo-drone.wav`,
45 seconds of synthetic sustained material, and selects it. It is built to suit
the treatment: no transients, since onsets restore the localization the
treatment exists to remove, and energy up to 8 kHz, since the level difference
between the ears is a high-frequency cue.

### Measured HRTFs

The head model is a rigid sphere by default, which renders mirrored azimuths
identically and so carries no front-back information at all. A measured set
supplies that. Nothing is vendored here, since the files are freely available:

```bash
pip install sofar
mkdir hrtf
curl -o hrtf/mit_kemar_normal_pinna.sofa https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa
```

That is the Gardner and Martin KEMAR measurement, 1.2 MB, 72 positions on the
horizontal plane. Set `hrtf_file` on a variant to use it; leave it unset for
the sphere. Direction comes from the measured set and distance stays with the
geometry, so near-field behaviour is unaffected.

Interpolation is nearest-neighbour on a 5 degree grid, which is fine for
static sources and not yet fine for moving ones.

Any track can be dropped onto the waveform, or placed in the project folder.
Sustained, nearly transient-free material works best — pads, drones, bowed
strings, organ, held voice, cymbal wash — and the reason is measured rather
than aesthetic: see *Sustained material decorrelates far more readily* under
Research.

The `?` beside the title runs a guided tour. Three are available: an overview, a
hands-on build, and blind testing.

## How it works

Audio is summed to mono and rendered as a **field** of virtual sources. Work is
organised in three levels:

- A **passage** is a time region of the track.
- A **variant** is one treatment of that passage, or the untreated signal.
- A **component** is a lattice of sources with a motion field applied.

Two lattices are available. A **polar** one is concentric rings; a **grid** is a
rectangle of sources spanning an extent in metres. Rotation, radial flow and
translational drift combine freely on either, so a whirlpool is a polar lattice
turning while flowing inward, and driving through a field of sources is a grid
with a backward drift. Sources wrap within the lattice, so the count is constant.

Each component carries its own decorrelation or inherits the variant's, and any
share of its sources can be given over to random wandering instead of the
coherent motion, after the coherence manipulation in random-dot kinematograms.

Distance is set per component in metres and may reach zero. At the head centre
both ears are equidistant, so the interaural differences vanish and the source
is heard as a centred, in-head image.

Every variant of a passage is rendered over the same span, sample aligned and
loudness matched. During playback the track runs untreated while the variants
run alongside it in step; holding a number key brings one forward.

## Reading the results

Two findings constrain how the instrument is used, and both are measured here
rather than assumed.

**No single render can show that a field is moving.** IACC does not separate
motion from diffuseness, and modulation at the motion rate is confounded with
the material's own periodicity: over a 20 s passage a completely static field
scored 2.04 at 0.5 Hz where moving fields scored 2.65 to 3.14. Every motion
claim needs a matched control, identical in every respect except that time is
stopped. The instrument detects those pairs and reports the difference.

**The measures have a noise floor larger than several effects under study.**
IACC at full decorrelation varies with standard deviation 0.038 across seeds.
Ring geometry moves it by 0.04 to 0.05, which is inside that. Hold the seed
fixed when comparing, or average across several.

## Learning it

**Courses** are a sequenced curriculum from two ears and two differences through
to running a listening test that counts as evidence. **Research** covers the
question, its standing in the literature, the results measured here, and what
blind listening has shown. **Glossary** defines every term the interface uses, split into established
material and this project's own vocabulary, with each entry labelled by status:

| Status | Meaning |
|---|---|
| Established | Standard material with a citation |
| Implementation | A design choice in this codebase |
| This project's term | Vocabulary coined here, not a term of art |
| Measured here | A result reproducible from the test suite |
| Conjecture | A hypothesis under test |

That distinction matters when writing for others: *motion in unison*, *motion
coherence share* and *component* are names from this project rather than from
the literature.

## Files

| File | Role |
|---|---|
| `ringfield.py` | the DSP. Read this one first. |
| `app.py` | web backend. Wraps the renderers, contains no DSP. |
| `static/` | the interface |
| `courses.json`, `purpose.json`, `encyclopedia.json` | all written content |
| `tests/` | 311 tests. Run before and after any change. |
| `make_track.py`, `compare.py`, `variations.py`, `sweep.py` | command line renderers |
| `make_demo_audio.py` | synthesises the two demo beds, drone and strings |
| `build_demo.py` | renders everything the public page serves |
| `docs/` | the public page. `docs/data/` is generated, never hand-edited. |

```bash
pytest -q
```

### Rebuilding the public page

```bash
python make_demo_audio.py
python build_demo.py
```

The first writes the two beds, the second renders every variant of each and
writes the audio, the monitor traces and the measured numbers into
`docs/data/`. Both beds are synthesised rather than sampled, so the page
carries no recording that could not be distributed. Each variant is rendered
unnormalised, loudness-matched to the untreated reference, and then all of
them are scaled by one common factor: normalising each file on its own would
hand a listener a loudness difference to mistake for a treatment difference.

## Known limits

The head model is a rigid sphere by default, with no pinna, so it has no
elevation and no front-back discrimination: azimuth 0° and 180° produce
identical signals, and motion direction is not recoverable. A measured HRTF in
SOFA format removes that and is selectable per variant, though interpolation
between measured directions is still nearest-neighbour, which suits static
sources rather than moving ones. Distance is carried by level and
near-field level difference only, with no propagation delay, Doppler, air
absorption or reverberation.

Everything measured so far comes from one listener who holds the hypothesis.
The blind test logs to CSV with full parameter provenance so that adding
listeners needs no new work.
