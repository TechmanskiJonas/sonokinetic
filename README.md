# Sonokinetic

Can motion in a field of sound be perceived without localizing anything in it?

A binaural renderer and experiment bench for testing that question. It builds a
field of virtual sources from a piece of audio, gives the field a motion, and
makes each source individually too diffuse to locate. Whether the field is still
heard to move is the experiment.

Jonas Techmanski · jonas030405@gmail.com

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

The `?` beside the title runs a guided tour. Four are available: an overview, a
hands-on build, arrangements, and blind testing.

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
to running a listening test that counts as evidence. **Purpose** covers the
research question, its standing in the literature, and the results measured
here. **Glossary** defines every term the interface uses, split into established
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
| `tests/` | 254 tests. Run before and after any change. |
| `make_track.py`, `compare.py`, `variations.py`, `sweep.py` | command line renderers |

```bash
pytest -q
```

## Known limits

The head model is a rigid sphere with no pinna, so it has no elevation and no
front-back discrimination: azimuth 0° and 180° produce identical signals, and
motion direction is not recoverable. Measured HRTFs in SOFA format would change
this and the class is already in place. Distance is carried by level and
near-field level difference only, with no propagation delay, Doppler, air
absorption or reverberation.

Everything measured so far comes from one listener who holds the hypothesis.
The blind test logs to CSV with full parameter provenance so that adding
listeners needs no new work.
