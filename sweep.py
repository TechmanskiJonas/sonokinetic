"""
sweep.py — render the parameter space, then go listen to it.

    python sweep.py yourguitar.wav

Writes renders/ with one file per cell plus an iacc.csv log. The point is
not any single render: it is hearing where in the space the percept flips
from "sources over there" to "the field is turning."
"""

import sys, os, csv
import numpy as np
import ringfield as rf


def make_test_signal(fs=44100, dur=6.0):
    """Fallback if you have no audio yet: plucky broadband bursts.

    Broadband transients are the right stimulus class here. Pure tones
    give you almost no localization cue to work with.
    """
    n = int(dur * fs)
    t = np.arange(n) / fs
    rng = np.random.default_rng(1)
    x = np.zeros(n)
    for onset in np.arange(0, dur, 0.25):
        i = int(onset * fs)
        L = int(0.22 * fs)
        env = np.exp(-np.linspace(0, 9, L))
        noise = rng.normal(0, 1, L)
        tone = np.sin(2 * np.pi * 220 * np.arange(L) / fs)
        x[i:i + L] += env * (0.6 * noise + 0.4 * tone)
    return x / np.max(np.abs(x))


def main():
    fs = 44100
    outdir = "renders"
    os.makedirs(outdir, exist_ok=True)

    if len(sys.argv) > 1:
        x = rf.load_mono(sys.argv[1], fs)
        print(f"loaded {sys.argv[1]}: {len(x)/fs:.1f}s")
    else:
        x = make_test_signal(fs)
        print("no input given, using synthetic pluck train")
    x = x[: int(8 * fs)]

    hrtf = rf.AnalyticHRTF(fs=fs)
    print(f"HRTF table built: {len(hrtf.grid)} azimuths\n")

    # The three axes of the question.
    n_sources_list = [1, 2, 4, 8]
    rates = [0, 30, 90, 270, 720]        # deg/s; 720 is well past the limit
    amounts = [0.0, 0.35, 0.7, 1.0]      # 0 = coherent ring

    rows = []
    for ns in n_sources_list:
        for rate in rates:
            for amt in amounts:
                if ns == 1 and amt > 0:
                    continue             # decorrelating one source is a no-op
                cfg = rf.FieldConfig(n_sources=ns, rotation_deg_per_sec=rate,
                                     decorr_amount=amt, decorr_method="velvet")
                y = rf.render(x, hrtf, cfg, fs)
                name = f"n{ns}_rate{rate}_dec{int(amt*100):03d}.wav"
                rf.save(os.path.join(outdir, name), y, fs)
                score = rf.iacc(y, fs)
                rows.append({"file": name, "n_sources": ns,
                             "rate_dps": rate, "decorr": amt,
                             "iacc": round(score, 3)})
                print(f"  {name:32s} IACC={score:.3f}")

    with open(os.path.join(outdir, "iacc.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # The hypothesis render: diffuse bed with one coherent source circulating.
    cfg = rf.FieldConfig(n_sources=6, rotation_deg_per_sec=60,
                         per_source_amount=[0.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    y = rf.render(x, hrtf, cfg, fs)
    rf.save(os.path.join(outdir, "hotspot_coherent1_of6.wav"), y, fs)
    print(f"\n  hotspot_coherent1_of6.wav          IACC={rf.iacc(y, fs):.3f}")
    print(f"\n{len(rows)+1} renders in {outdir}/")


if __name__ == "__main__":
    main()
