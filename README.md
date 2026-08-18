# Sonokinetic

Can motion in a field of sound be perceived without localizing anything in it?

A binaural renderer and experiment bench built around that question. The
instrument constructs a field of virtual sources from a piece of audio, gives
the field a motion, and makes each source individually too diffuse to locate.
The experiment asks whether the field is heard to move under those conditions.

Jonas Techmanski · jonas030405@gmail.com

A public demonstration runs at
[techmanskijonas.github.io/sonokinetic](https://techmanskijonas.github.io/sonokinetic/).
It holds eight variants of the same twenty seconds, rendered in advance and
playable on headphones with nothing installed.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate
pip install numpy scipy soundfile matplotlib sounddevice fastapi uvicorn python-multipart pytest
```

`sofar` is an optional dependency, required only for measured HRTFs.

## Run

```bash
python app.py
```

Open http://127.0.0.1:8000 on headphones. Operating-system spatial audio should
be switched off for the session, since it applies a second head model to signals
that already carry one.

### Audio

Recordings are kept out of the repository, so the first run writes
`demo-drone.wav`, 45 seconds of synthetic sustained material, and selects it.
The signal is built to the conditions the treatment imposes. It contains no
transients, since onsets restore the localization the treatment removes, and it
carries energy up to 8 kHz, since the level difference between the ears is a
high-frequency cue. Running `make_demo_audio.py` writes that file alongside
`demo-strings.wav`, a slower harmonic bed built to the same conditions.

Any track can be dropped onto the waveform or placed in the project folder.
Sustained material with few transients suits the method best, covering pads,
drones, bowed strings, organ, held voice and cymbal wash. The reason is
measured rather than aesthetic and is recorded under *Sustained material
decorrelates far more readily* in the Research chapter.

The `?` beside the title runs a guided tour. Three are available, covering an
overview, a hands-on build, and blind testing.

### Measured HRTFs

The head model is a rigid sphere by default. A sphere renders mirrored azimuths
identically and therefore carries no front-back information, which a measured
set supplies. The files are freely available and are downloaded rather than
vendored here:

```bash
pip install sofar
mkdir hrtf
curl -o hrtf/mit_kemar_normal_pinna.sofa https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa
```

That is the Gardner and Martin KEMAR measurement, 1.2 MB, covering 72 positions
on the horizontal plane. Setting `hrtf_file` on a variant selects it, and
leaving the field unset selects the sphere. Direction is taken from the
measured set while distance stays with the geometry, so near-field behaviour is
unaffected.

Interpolation is nearest-neighbour on a 5 degree grid, which suits static
sources and remains too coarse for moving ones.

## How it works

Audio is summed to mono and rendered as a **field** of virtual sources. Work is
organised in three levels:

- A **passage** is a time region of the track.
- A **variant** is one treatment of that passage, or the untreated signal.
- A **component** is a lattice of sources with a motion field applied.

Two lattices are available. A **polar** lattice is a set of concentric rings,
and a **grid** is a rectangle of sources spanning an extent in metres. Rotation,
radial flow and translational drift combine freely on either, so a whirlpool is
a polar lattice turning while it flows inward, and driving through a field of
sources is a grid with a backward drift. Sources wrap within the lattice, which
holds the source count constant.

Each component carries its own decorrelation or inherits the variant's, and any
share of its sources can be given over to random wandering in place of the
coherent motion, following the coherence manipulation used in random-dot
kinematograms.

Distance is set per component in metres and may reach zero. At the head centre
both ears are equidistant, so the interaural differences vanish and the source
is heard as a centred, in-head image.

Every variant of a passage is rendered over the same span, aligned to the
sample and matched in loudness. During playback the track runs untreated while
the variants run alongside it in step, and holding a number key brings one
forward.

## Reading the results

Two findings constrain how the instrument is used, and both were measured here.

**A single render carries no evidence that a field is moving.** IACC responds
to diffuseness as well as to motion, and modulation at the motion rate is
confounded with the material's own periodicity. Over a 20 s passage a
completely static field scored 2.04 at 0.5 Hz where moving fields scored 2.65
to 3.14. Every motion claim therefore requires a matched control, identical in
every respect except that its motion is stopped. The instrument detects those
pairs and reports the difference between them.

**The measures have a noise floor larger than several effects under study.**
IACC at full decorrelation varies with a standard deviation of 0.038 across
seeds, while ring geometry moves it by 0.04 to 0.05, which falls inside that
range. Hold the seed fixed when comparing, or average across several.

## Learning it

**Courses** are a sequenced curriculum running from two ears and two
differences through to conducting a listening test that counts as evidence.
**Research** covers the question, its standing in the literature, the results
measured here, and what blind listening has shown. **Glossary** defines every
term the interface uses, separated into established material and this project's
own vocabulary, with each entry labelled by status:

| Status | Meaning |
|---|---|
| Established | Standard material with a citation |
| Implementation | A design choice in this codebase |
| This project's term | Vocabulary coined here, not a term of art |
| Measured here | A result reproducible from the test suite |
| Conjecture | A hypothesis under test |

The distinction matters when writing for others, since *motion in unison*,
*motion coherence share* and *component* are names taken from this project
rather than from the literature.

## Files

| File | Role |
|---|---|
| `ringfield.py` | the DSP, and the file to read first |
| `app.py` | web backend, wrapping the renderers and holding no DSP of its own |
| `static/` | the interface |
| `courses.json`, `purpose.json`, `encyclopedia.json` | all written content |
| `tests/` | 311 tests, to be run before and after any change |
| `make_track.py`, `compare.py`, `variations.py`, `sweep.py` | command line renderers |
| `make_demo_audio.py` | synthesises the two demonstration beds |
| `build_demo.py` | renders everything the public page serves |
| `docs/` | the public page, whose `data/` directory is generated |

```bash
pytest -q
```

### Rebuilding the public page

```bash
python make_demo_audio.py
python build_demo.py
```

The first command writes the two beds. The second renders every variant of each
and writes the audio, the monitor traces and the measured numbers into
`docs/data/`. Both beds are synthesised, which keeps the published page free of
material whose distribution would be restricted. Each variant is rendered
unnormalised, loudness-matched to the untreated reference, and then scaled with
every other variant by one common factor, so that a listener moving between two
of them hears a difference of treatment alone.

## Known limits

The head model is a rigid sphere by default, without a pinna, so it carries
neither elevation nor front-back discrimination. Azimuth 0° and 180° produce
identical signals and the direction of motion is unrecoverable from them. A
measured HRTF in SOFA format supplies both and is selectable per variant,
though interpolation between measured directions remains nearest-neighbour and
suits static sources better than moving ones. Distance is carried by level and
near-field level difference alone, without propagation delay, Doppler shift,
air absorption or reverberation.

Blind listening found the sensation of movement surviving a sum to mono, which
removes every interaural difference and indicates that the effect is
substantially spectral. Interpreting it as an interaural phenomenon would
overstate what has been shown.

Everything measured so far comes from one listener who holds the hypothesis.
The blind test logs to CSV with full parameter provenance, so that adding
listeners requires no further work.
