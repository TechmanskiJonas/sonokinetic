"""
variations.py — play several COMPLETE arrangements back to back.

    python variations.py wll.mp3

Each block below is a full pass over the same passage with one variable
changed. They play in sequence with a gap between them, not summed on top
of each other, and nothing outside the covered span is included.

Use this when you are isolating variables. Use make_track.py when you want
one arrangement across the whole song.
"""

import sys, os
import numpy as np
import ringfield as rf
from make_track import dry, spin, hotspot


# ----------------------------------------------------------------------
# One pass over the passage. Same skeleton every time, so any difference
# you hear between blocks comes from the arguments, not the structure.
# ----------------------------------------------------------------------

def block(n, decorr_pair, method, start_az):
    """decorr_pair: (low, high) used at 180 deg and again at 360 deg."""
    lo, hi = decorr_pair
    return [
        dry(31.5, 37.25, fade=0.25),
        spin(37.25, 38.35, degrees=180, n=n, decorr=lo, method=method,
             start_az=start_az, fade=0.25),
        dry(38.35, 39.8, fade=0.25),
        spin(39.8, 40.9, degrees=180, n=n, decorr=hi, method=method,
             start_az=start_az, fade=0.25),
        dry(40.9, 42.4, fade=0.25),
        spin(42.4, 43.5, degrees=360, n=n, decorr=lo, method=method,
             start_az=start_az, fade=0.25),
        dry(43.5, 44.9, fade=0.25),
        spin(44.9, 46.0, degrees=360, n=n, decorr=hi, method=method,
             start_az=start_az, fade=0.25),
        dry(46.0, 50.0, fade=0.25),
    ]


def theremin_block(n, start_az, method="allpass", decorr=1.0,
                   rate=360.0, span=(78.5, 143.0)):
    """The theremin section, spinning continuously for its whole length.

    No dry/spin alternation: one uninterrupted condition, so the percept has
    time to settle rather than being re-established every few seconds. The
    dry control block below is the reference instead.

    Sustained, nearly transient-free material with no onsets to anchor a
    position estimate on: the best stimulus in the track for this question.
    """
    return [spin(span[0], span[1], rate=rate, n=n, decorr=decorr,
                 method=method, start_az=start_az, fade=0.4)]


def theremin_control(span=(78.5, 143.0)):
    """Dry reference for the theremin section. Listen to this first: it is
    what the spun versions have to be different FROM."""
    return [dry(span[0], span[1], fade=0.4)]


EVEN3 = EVEN3 = EVEN3 = [-90, 30, 150]                      # evenly spaced, 120 deg apart
EVEN5 = [-90, -18, 54, 126, 198]            # evenly spaced, 72 deg apart.
                                            # Odd count on purpose: with an
                                            # even ring every source has one
                                            # directly opposite it, and that
                                            # antipodal pair is exactly the
                                            # symmetry that cancels.
UNEVEN3 = [-180, -90, 0]                    # gaps of 90/90/180: asymmetric

BLOCKS = [
    ("1. n=3 even, velvet",   block(3, (0.5, 1.0), "velvet",  EVEN3)),
    ("2. n=5 even, velvet",   block(5, (0.5, 1.0), "velvet",  EVEN5)),
    ("3. n=3 uneven, velvet", block(3, (0.5, 1.0), "velvet",  UNEVEN3)),
    ("4. n=3 even, allpass",  block(3, (0.5, 1.0), "allpass", EVEN3)),
    ("5. n=5 even, allpass",  block(5, (0.5, 1.0), "allpass", EVEN5)),
    ("6. n=3 uneven, allpass",block(3, (0.5, 1.0), "allpass", UNEVEN3)),

    # Theremin section, 78.5-143s. Continuous spin at 360 deg/s, allpass,
    # decorr=1.0. Block 7 is the dry control; ring geometry is the only
    # variable across 8-10.
    ("7.  theremin DRY control", theremin_control()),
    ("8.  theremin n=3 even",    theremin_block(3, EVEN3)),
    ("9.  theremin n=5 even",    theremin_block(5, EVEN5)),
    ("10. theremin n=3 uneven",  theremin_block(3, UNEVEN3)),
]

OUT = "variations.wav"
GAP = 1.5      # silence between blocks so you can reset your ears


# ----------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    stereo, mono, fs = rf.load_audio(sys.argv[1])
    print(f"loaded {os.path.basename(sys.argv[1])}: {len(mono)/fs:.1f}s")

    span = (min(s.start for _, b in BLOCKS for s in b),
            max(s.end for _, b in BLOCKS for s in b))
    if span[1] > len(mono) / fs:
        print(f"warning: blocks run to {span[1]:.1f}s but the track is only "
              f"{len(mono)/fs:.1f}s long.")
    print(f"{len(BLOCKS)} blocks over {span[0]}-{span[1]}s\n")

    hrtf = rf.AnalyticHRTF(fs=fs)
    y, timeline = rf.render_blocks(mono, stereo, hrtf, BLOCKS, fs, gap=GAP)
    rf.save(OUT, y, fs)
    rf.save_timeline(OUT.replace(".wav", ".json"), timeline, fs)

    # DRY is mono now, so its IACC is 1.0 by construction and would drag the
    # block average up. Report the spin segments separately: that is the
    # number that actually tracks what the field is doing.
    print(f"{'when':>16}   {'IACCspin':>8}   block")
    for label, entries in rf.group_timeline(timeline).items():
        spins = [e for e in entries
                 if e.kind == "spin" and (e.out_end - e.out_start) > 0.5]
        use = spins or entries                  # all-dry block (the control)
        vals = [rf.iacc(y[int(e.out_start * fs):int(e.out_end * fs)], fs)
                for e in use]
        a = min(e.out_start for e in entries)
        b = max(e.out_end for e in entries)
        print(f"{a:7.1f}-{b:7.1f}s   {np.mean(vals):8.3f}   {label}")

    print(f"\nwrote {OUT}  ({len(y)/fs:.1f}s, {len(BLOCKS)} blocks)")


if __name__ == "__main__":
    main()