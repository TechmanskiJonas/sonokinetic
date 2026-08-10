"""
make_track.py — THIS is the file you edit.

    python make_track.py "Whole Lotta Love.mp3"

Define regions of the song and what happens in each. Change the ARRANGEMENT
list below, re-run, listen. That is the whole loop.

Times are in seconds. Any part of the track you do not cover stays silent,
so cover the whole thing (or use dry() as a base layer).
"""

import sys, os
import numpy as np
import ringfield as rf


# ----------------------------------------------------------------------
# Shorthand builders so the arrangement reads like an arrangement
# ----------------------------------------------------------------------

def dry(start, end, fade=0.08):
    """Original stereo, untouched."""
    return rf.Segment(start, end, None, fade)


def spin(start, end, degrees=360, n=6, decorr=1.0, method="velvet",
         start_az=None, fade=0.35, gain_db=0.0, rate=None):
    """A rotating decorrelated field.

    degrees : TOTAL rotation across this segment. 360 = exactly one full lap
              between start and end, 180 = half a lap, -360 = one lap the
              other way. Lengthen the segment and it turns more slowly on
              its own.
    n       : how many sources in the ring
    decorr  : 0.0 = fully coherent (collapses to dead centre, no rotation
              cue at all), 1.0 = maximally decorrelated
    rate    : optional override in deg/sec, ignoring `degrees`
    """
    dur = max(end - start, 1e-6)
    dps = rate if rate is not None else degrees / dur
    cfg = rf.FieldConfig(n_sources=n, rotation_deg_per_sec=dps,
                         decorr_amount=decorr, decorr_method=method,
                         start_azimuths=start_az)
    return rf.Segment(start, end, cfg, fade, gain_db)


def hotspot(start, end, degrees=360, n=6, bed=1.0, fade=0.35,
            gain_db=0.0, rate=None):
    """The hypothesis case: a coherent source circulating inside a diffuse bed.

    Source 0 stays coherent, the rest are decorrelated to `bed`. This is the
    configuration meant to produce rotation you can feel without being able
    to point at anything.

    degrees : TOTAL rotation across this segment, same as spin().
    """
    dur = max(end - start, 1e-6)
    dps = rate if rate is not None else degrees / dur
    amounts = [0.0] + [bed] * (n - 1)
    cfg = rf.FieldConfig(n_sources=n, rotation_deg_per_sec=dps,
                         per_source_amount=amounts, decorr_method="velvet")
    return rf.Segment(start, end, cfg, fade, gain_db)


# ----------------------------------------------------------------------
# EDIT THIS
# ----------------------------------------------------------------------

ARRANGEMENT = [
    # Lead-in so you hear the song arrive at the section. Delete if you only
    # want the treated part.
    dry(0, 31.5, fade=0.25),

    dry(31.5, 37.25, fade=0.25),
    spin(37.25, 38.35, degrees=180, n=3, decorr=0.5, method="velvet",
         start_az=[-90, 30, 150], fade=0.25),
    dry(38.35, 39.8, fade=0.25),
    spin(39.8, 40.9, degrees=180, n=3, decorr=1.0, method="velvet",
         start_az=[-90, 30, 150], fade=0.25),
    dry(40.9, 42.4, fade=0.25),
    spin(42.4, 43.5, degrees=360, n=3, decorr=0.5, method="velvet",
         start_az=[-90, 30, 150], fade=0.25),
    dry(43.5, 44.9, fade=0.25),
    spin(44.9, 46.0, degrees=360, n=3, decorr=1.0, method="velvet",
         start_az=[-90, 30, 150], fade=0.25),

    dry(46.0, 50.0, fade=0.25),
]

OUT = "arrangement.wav"


# ----------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("error: give me an audio file (mp3, wav, flac, ogg...)")
        sys.exit(1)

    path = sys.argv[1]
    stereo, mono, fs = rf.load_audio(path)
    dur = len(mono) / fs
    print(f"loaded {os.path.basename(path)}: {dur:.1f}s @ {fs} Hz")

    covered = max((s.end for s in ARRANGEMENT), default=0)
    if covered > dur:
        print(f"note: arrangement runs to {covered:.0f}s but the track is "
              f"{dur:.0f}s. Trailing segments will be clipped.")

    hrtf = rf.AnalyticHRTF(fs=fs)
    print(f"rendering {len(ARRANGEMENT)} segments...")
    for s in ARRANGEMENT:
        kind = "DRY " if s.config is None else (
            f"spin {s.config.rotation_deg_per_sec*(s.end-s.start):>7.0f} deg "
            f"({s.config.rotation_deg_per_sec:>5.1f} d/s)")
        print(f"  {s.start:6.1f}-{s.end:6.1f}s  {kind}")

    y, timeline = rf.render_timeline(mono, stereo, hrtf, ARRANGEMENT, fs)
    rf.save(OUT, y, fs)
    rf.save_timeline(OUT.replace(".wav", ".json"), timeline, fs)
    print(f"\nwrote {OUT}  ({len(y)/fs:.1f}s)")

    print("\nIACC per segment (1.0 = centred/coherent, ~0 = diffuse):")
    for e in timeline:
        i0, i1 = int(e.out_start * fs), min(int(e.out_end * fs), len(y))
        if i1 - i0 > fs:
            print(f"  {e.out_start:6.1f}-{e.out_end:6.1f}s  {e.kind:4s}  "
                  f"IACC={rf.iacc(y[i0:i1], fs):.3f}")


if __name__ == "__main__":
    main()