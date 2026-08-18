"""
make_demo_audio.py — synthesise the beds the public demo is built on.

    python make_demo_audio.py

Writes demo-drone.wav and demo-strings.wav. Both are generated here rather
than sampled from a recording, for two reasons. Recordings are not
distributable, and the demo page is public. And the material has to meet
conditions the treatment imposes, which most music does not: no transients,
since onsets restore the localization the treatment exists to remove, and real
energy up to 8 kHz, since the level difference between the ears is a
high-frequency cue.

demo-drone.wav is the stationary bed. It is the same signal app.py writes on
first run, kept here so both beds come from one file. Its constants are set by
measurement and the reasoning behind each is recorded at ensure_demo_audio()
in app.py: the 1/k**0.45 tilt, the shallow breathing, the RMS levelling.

demo-strings.wav is the musical bed, added because the drone is a hard listen
for anyone meeting the instrument for the first time. It is a slow modal
progression, i-VI-III-VII in D aeolian, voiced as a bowed string section and
crossfaded so no chord ever starts: the changes arrive without an attack.

    A CAVEAT THAT BELONGS WITH IT. The drone is deliberately stationary in
    every respect except the treatment under test, because a listener judging
    a static field reported it "fading away and returning" when the drone
    breathed too deeply. The progression breaks that rule on purpose: its
    spectrum moves. The direction of the resulting bias is the reason it is
    still safe to publish. Spectral change makes the *static control* more
    likely to be heard as moving, not less, so a listener who still hears more
    motion in the rotating variant has reported a conservative result. Use the
    strings to be convinced there is something here; use the drone to measure.
"""

import os
import numpy as np
import soundfile as sf

FS = 44100
OUT_DRONE = "demo-drone.wav"
OUT_STRINGS = "demo-strings.wav"


def _level(x: np.ndarray, target_dbfs: float = -26.0, ceiling: float = 0.5):
    """RMS levelling with a peak ceiling.

    Sustained material is flat, so peak-normalising it lands far louder than
    music treated the same way. The first thing anyone hears on headphones
    should never be the loudest thing they hear.
    """
    rms = float(np.sqrt(np.mean(x ** 2))) or 1.0
    x = x * (10 ** (target_dbfs / 20.0) / rms)
    peak = float(np.max(np.abs(x))) or 1.0
    if peak > ceiling:
        x *= ceiling / peak
    return x


def _fade(x: np.ndarray, secs: float = 2.0):
    n = int(FS * secs)
    ramp = np.sin(np.linspace(0, np.pi / 2, n)) ** 2
    x[:n] *= ramp
    x[-n:] *= ramp[::-1]
    return x


def drone(dur: float = 45.0) -> np.ndarray:
    """Harmonic drone over a band-limited wash. See app.ensure_demo_audio."""
    n = int(FS * dur)
    t = np.arange(n) / FS
    rng = np.random.default_rng(7)
    x = np.zeros(n)

    for k in range(1, 73):
        detune = 1.0 + rng.uniform(-0.004, 0.004)
        breathe = 0.93 + 0.07 * np.sin(2 * np.pi * rng.uniform(0.03, 0.11) * t
                                       + rng.uniform(0, 6.28))
        x += (breathe / k ** 0.45) * np.sin(2 * np.pi * 110.0 * k * detune * t
                                            + rng.uniform(0, 6.28))

    wash = rng.normal(0, 1, n)
    kern = np.hanning(7)
    wash = np.convolve(wash, kern / kern.sum(), mode="same")
    x = x + 0.30 * wash / (np.max(np.abs(wash)) or 1.0)
    return _level(_fade(x))


# ----------------------------------------------------------------------
# the musical bed
# ----------------------------------------------------------------------

# i - VI - III - VII in D aeolian. Minor, unresolved, and it loops without
# ever wanting to cadence, which is what a bed for a 20 second passage needs.
PROGRESSION = [
    ("Dm",  [146.83, 174.61, 220.00, 293.66]),   # D4 F4 A4 D5
    ("Bb",  [116.54, 174.61, 233.08, 293.66]),   # Bb3 F4 Bb4 D5
    ("F",   [130.81, 174.61, 220.00, 261.63]),   # C4 F4 A4 C5
    ("C",   [130.81, 164.81, 196.00, 261.63]),   # C4 E4 G4 C5
]

CHORD_SECS = 5.0        # each chord's steady state
CROSSFADE_SECS = 2.2    # long enough that no chord has an onset


def _bowed(freq: float, n: int, rng, bright: float = 1.0) -> np.ndarray:
    """One sustained bowed note.

    A sawtooth-ish partial stack is the bowed-string starting point, but the
    drone's measured tilt is the constraint that matters here: at a steeper
    tilt than 1/k**0.45 the energy collects in the bass, where there is no
    interaural level difference to work with, and the whole field decorrelates
    badly. So the stack keeps that tilt and simply runs out at 8 kHz.

    Three detuned voices per note stand in for a section rather than a soloist.
    Vibrato is deliberately absent: it is periodic modulation at 5 Hz or so,
    and this instrument's own measurements show periodic modulation in the
    material is confounded with modulation from the motion under test.
    """
    t = np.arange(n) / FS
    out = np.zeros(n)
    n_voices = 3
    for v in range(n_voices):
        # Section detune, static per voice. A fixed offset, not an LFO.
        f = freq * (1.0 + rng.uniform(-0.0035, 0.0035))
        phase0 = rng.uniform(0, 6.28)
        k = 1
        while f * k < 8000.0:
            amp = bright / k ** 0.45
            # A slow, shallow breath per partial so the tone is not dead still,
            # at the same depth the drone settled on for the same reason.
            breathe = 0.94 + 0.06 * np.sin(2 * np.pi * rng.uniform(0.04, 0.10) * t
                                           + rng.uniform(0, 6.28))
            out += (amp * breathe / n_voices) * np.sin(
                2 * np.pi * f * k * t + phase0 + rng.uniform(0, 6.28))
            k += 1
    return out


def _bow_noise(n: int, rng) -> np.ndarray:
    """The rosin, as a continuous wash. Keeps the spectrum from being a comb."""
    w = rng.normal(0, 1, n)
    kern = np.hanning(9)
    w = np.convolve(w, kern / kern.sum(), mode="same")
    return w / (np.max(np.abs(w)) or 1.0)


def strings(loops: int = 3) -> np.ndarray:
    """The progression, crossfaded so that nothing in it ever starts."""
    rng = np.random.default_rng(19)
    step = int(FS * CHORD_SECS)
    xf = int(FS * CROSSFADE_SECS)
    chords = PROGRESSION * loops
    n = step * len(chords) + xf
    x = np.zeros(n)

    # Equal-power crossfade, so the sum holds a constant level through a change
    # rather than dipping in the middle of it. A dip reads as an event, and an
    # event is exactly what this material must not contain.
    up = np.sin(np.linspace(0, np.pi / 2, xf)) ** 2
    down = up[::-1]

    for i, (_name, freqs) in enumerate(chords):
        seg_n = step + xf
        seg = np.zeros(seg_n)
        for f in freqs:
            seg += _bowed(f, seg_n, rng)
        seg += 0.22 * _bow_noise(seg_n, rng) * float(np.sqrt(np.mean(seg ** 2)))

        env = np.ones(seg_n)
        env[:xf] *= up            # every chord fades in over the previous one
        env[-xf:] *= down
        start = i * step
        x[start:start + seg_n] += seg * env

    return _level(_fade(x, 2.5))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for name, sig in ((OUT_DRONE, drone()), (OUT_STRINGS, strings())):
        path = os.path.join(here, name)
        sf.write(path, sig.astype(np.float32), FS)
        rms_db = 20 * np.log10(float(np.sqrt(np.mean(sig ** 2))))
        print(f"wrote {name}: {len(sig)/FS:.1f}s, "
              f"RMS {rms_db:.1f} dBFS, peak {np.max(np.abs(sig)):.2f}")


if __name__ == "__main__":
    main()
