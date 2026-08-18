# Sonokinetic

Can motion in a field of sound be perceived without localizing anything in it?

The instrument builds a field of virtual sources from a piece of audio, gives
the field a motion, and makes each source individually too diffuse to locate.
Whether a listener still hears the field move is the experiment.

Jonas Techmanski · jonas030405@gmail.com

Eight variants are playable on headphones at
[techmanskijonas.github.io/sonokinetic](https://techmanskijonas.github.io/sonokinetic/).

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

Open http://127.0.0.1:8000 on headphones. Switch off operating-system spatial
audio first, because it applies a second head model to signals that already
carry one.

### Audio

Recordings stay out of the repository, so the first run writes
`demo-drone.wav`, 45 seconds of synthetic sustained material, and selects it.
The signal is built to what the treatment needs. It has no transients, because
onsets restore the localization the treatment removes. It carries energy up to
8 kHz, because the level difference between the ears is a high-frequency cue.
Running `make_demo_audio.py` writes that file and `demo-strings.wav` beside it.

Any track can be dropped onto the waveform or put in the project folder.
Sustained material with few transients works best. Pads, drones, bowed strings,
organ, held voice and cymbal wash all qualify. The reason is measured and sits
under *Sustained material decorrelates far more readily* in the Research
chapter.

The `?` beside the title runs a guided tour. There are three, covering an
overview, a hands-on build, and blind testing.

### Measured HRTFs

The head model is a rigid sphere by default. A sphere renders mirrored azimuths
identically and so carries no front-back information. A measured set supplies
it, and the files are free to download:

```bash
pip install sofar
mkdir hrtf
curl -o hrtf/mit_kemar_normal_pinna.sofa https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa
```

That is the Gardner and Martin KEMAR measurement, 1.2 MB, 72 positions on the
horizontal plane. Set `hrtf_file` on a variant to use it and leave it unset for
the sphere. Direction comes from the measured set while distance stays with the
geometry, so near-field behaviour is unaffected.

Interpolation is nearest-neighbour on a 5 degree grid, which suits static
sources and is still too coarse for moving ones.

## How it works

Audio is summed to mono and rendered as a **field** of virtual sources. Work is
organised in three levels:

- A **passage** is a time region of the track.
- A **variant** is one treatment of that passage, or the untreated signal.
- A **component** is a lattice of sources with a motion field applied.

There are two lattices. A **polar** one is concentric rings. A **grid** is a
rectangle of sources spanning an extent in metres. Rotation, radial flow and
translational drift combine freely on either, so a whirlpool is a polar lattice
turning while it flows inward, and driving through a field of sources is a grid
with a backward drift. Sources wrap within the lattice, which holds the count
constant.

Each component carries its own decorrelation or inherits the variant's. Any
share of its sources can be given over to random wandering in place of the
coherent motion, following the coherence manipulation in random-dot
kinematograms.

Distance is set per component in metres and may reach zero. At the head centre
both ears are equidistant, the interaural differences vanish, and the source is
heard as a centred, in-head image.

Every variant of a passage is rendered over the same span, aligned to the
sample and matched in loudness. During playback the track runs untreated while
the variants run alongside it in step, and holding a number key brings one
forward.

## Reading the results

Two findings constrain how the instrument is used. Both were measured here.

**A single render carries no evidence that a field is moving.** IACC responds
to diffuseness as well as to motion, and modulation at the motion rate is
confounded with the material's own periodicity. Over a 20 s passage a
completely static field scored 2.04 at 0.5 Hz where moving fields scored 2.65
to 3.14. Every motion claim needs a matched control that is identical except
for having its motion stopped. Stop it by setting `time_scale` to zero, which
holds each source where it was at the level it had. Zeroing the rates instead
changes the level distribution, because the edge fade keys off whether the
lattice wraps. The instrument detects those pairs and reports the difference.

**The measures have a noise floor larger than several effects under study.**
IACC at full decorrelation varies with a standard deviation of 0.038 across
seeds. Ring geometry moves it by 0.04 to 0.05, which falls inside that. Hold
the seed fixed when comparing, or average across several.

## Learning it

**Courses** run from two ears and two differences through to conducting a
listening test that counts as evidence. **Research** covers the question, where
it sits in the literature, the results measured here, and what blind listening
has shown. **Glossary** defines every term the interface uses, split into
established material and this project's own vocabulary, each entry labelled by
status:

| Status | Meaning |
|---|---|
| Established | Standard material with a citation |
| Implementation | A design choice in this codebase |
| This project's term | Vocabulary coined here, not a term of art |
| Measured here | A result reproducible from the test suite |
| Conjecture | A hypothesis under test |

The labels matter when writing for other people, because *motion in unison*,
*motion coherence share* and *component* come from this project and not from
the literature.

## Files

| File | Role |
|---|---|
| `ringfield.py` | the DSP, and the file to read first |
| `app.py` | web backend, wrapping the renderers and holding no DSP of its own |
| `static/` | the interface |
| `courses.json`, `purpose.json`, `encyclopedia.json` | all written content |
| `tests/` | 311 tests, to run before and after any change |
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

The first writes the two beds. The second renders every variant of each and
writes the audio, the monitor traces and the measured numbers into
`docs/data/`. Both beds are synthesised, which keeps the published page clear
of material that cannot be redistributed.

The page renders the ring at the geometry the blind sessions used, which is
nine sources at two metres with allpass decorrelation and every source
wandering 60 degrees at a quarter hertz. A plainer ring with fewer sources and
no wander is a much weaker stimulus, so the demonstration would understate what
the sessions found.

Each variant is rendered unnormalised, loudness-matched to the untreated
reference, then scaled together with every other variant by one common factor.
A listener moving between two of them hears a difference of treatment and
nothing else.

## Known limits

The head model is a rigid sphere by default, with no pinna, so it carries
neither elevation nor front-back discrimination. Azimuth 0° and 180° produce
identical signals and the direction of motion cannot be recovered from them. A
measured HRTF in SOFA format supplies both and is selectable per variant,
though interpolation between measured directions is still nearest-neighbour and
suits static sources better than moving ones. Distance is carried by level and
near-field level difference, with no propagation delay, Doppler, air absorption
or reverberation.

Blind listening found the sensation of movement surviving a sum to mono, which
removes every interaural difference. The effect is therefore substantially
spectral, and calling it interaural would overstate what has been shown.

Everything measured so far comes from one listener who holds the hypothesis.
The blind test logs to CSV with full parameter provenance, so adding listeners
needs no further work.
