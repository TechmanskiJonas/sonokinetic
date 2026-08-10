"""
compare.py — play ONE passage several times, changing one thing each time.

    python compare.py wll.mp3

This is the experiment. Pick a passage, list the treatments, listen, and
write down for each one: can I point at anything? Is it turning?

Output is compare.wav plus a printed running order.
"""

import sys, os
import numpy as np
import ringfield as rf


# ----------------------------------------------------------------------
# EDIT THIS: the passage you want to test, in seconds
# ----------------------------------------------------------------------

PASSAGE = (84, 108)      # start, end. Keep it 15-30s: long enough to settle
                         # into, short enough to compare without forgetting.

def take(config, label, gain_db=0.0):
    return rf.Take(PASSAGE[0], PASSAGE[1], config, gain_db, label)


def spin_cfg(degrees=360, n=6, decorr=1.0, method="velvet", start_az=None):
    dur = PASSAGE[1] - PASSAGE[0]
    return rf.FieldConfig(n_sources=n, rotation_deg_per_sec=degrees / dur,
                          decorr_amount=decorr, decorr_method=method,
                          start_azimuths=start_az)


def hotspot_cfg(degrees=360, n=6, bed=1.0):
    dur = PASSAGE[1] - PASSAGE[0]
    return rf.FieldConfig(n_sources=n, rotation_deg_per_sec=degrees / dur,
                          per_source_amount=[0.0] + [bed] * (n - 1),
                          decorr_method="velvet")


TAKES = [
    take(None,                                   "1. dry (reference)"),
    take(spin_cfg(degrees=360, decorr=0.0),      "2. coherent ring (degenerate)"),
    take(spin_cfg(degrees=360, decorr=1.0),      "3. decorrelated, 1 lap"),
    take(hotspot_cfg(degrees=360, bed=1.0),      "4. coherence hotspot, 1 lap"),
    take(spin_cfg(degrees=0,   decorr=1.0),      "5. decorrelated, NOT moving"),
]

OUT = "compare.wav"


# ----------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    stereo, mono, fs = rf.load_audio(sys.argv[1])
    print(f"loaded {os.path.basename(sys.argv[1])}: {len(mono)/fs:.1f}s")
    print(f"passage: {PASSAGE[0]}-{PASSAGE[1]}s "
          f"({PASSAGE[1]-PASSAGE[0]}s), {len(TAKES)} takes\n")

    hrtf = rf.AnalyticHRTF(fs=fs)
    y, timeline = rf.render_sequence(mono, stereo, hrtf, TAKES, fs, gap=0.8)
    rf.save(OUT, y, fs)
    rf.save_timeline(OUT.replace(".wav", ".json"), timeline, fs)

    print(f"{'when':>14}   {'IACC':>5}   what")
    for e in timeline:
        seg = y[int(e.out_start * fs):int(e.out_end * fs)]
        score = rf.iacc(seg, fs) if len(seg) > fs else float("nan")
        print(f"{e.out_start:6.1f}-{e.out_end:6.1f}s   {score:5.3f}   {e.label}")

    print(f"\nwrote {OUT}  ({len(y)/fs:.1f}s total)")
    print("\nFor each take, note: (a) can you point at anything? "
          "(b) is it turning? Those two answers are the experiment.")


if __name__ == "__main__":
    main()
