"""Runs ESC-50 chainsaw + negative clips through EfficientAT and reports chainsaw detection stats.

usage: uv run python evaluate.py [model_name ...]   (default: mn04_as mn10_as)
"""
import glob
import sys
import time

import librosa
import numpy as np

from classifier import CHAINSAW, SAMPLE_RATE, Tagger, labels

THRESH = 0.2


def main(models):
    pos = sorted(glob.glob("samples/chainsaw/*.wav"))
    neg = sorted(glob.glob("samples/negative/*.wav"))
    clips = {p: librosa.load(p, sr=SAMPLE_RATE, mono=True)[0] for p in pos + neg}
    cats = dict((f[0], f[3]) for f in (l.strip().split(",") for l in open("samples/esc50.csv").readlines()[1:]))

    for name in models:
        t = Tagger(name)
        t(np.zeros(SAMPLE_RATE * 5, np.float32))  # warm up
        rows, times = [], []
        for p, wav in clips.items():
            t0 = time.perf_counter()
            s = t(wav)
            times.append(time.perf_counter() - t0)
            rank = int((s > s[CHAINSAW]).sum()) + 1
            rows.append((p, s[CHAINSAW], rank, labels[int(np.argmax(s))]))
        P = [r for r in rows if "/chainsaw/" in r[0]]
        N = [r for r in rows if "/negative/" in r[0]]
        print(f"\n=== {name}  ({np.mean(times) * 1000:.0f} ms per 5 s clip on this Mac CPU) ===")
        print(f"chainsaw clips: top-1 {sum(r[2] == 1 for r in P)}/{len(P)}, top-5 {sum(r[2] <= 5 for r in P)}/{len(P)}, "
              f"score>={THRESH} {sum(r[1] >= THRESH for r in P)}/{len(P)}, median score {np.median([r[1] for r in P]):.2f}")
        print(f"negative clips: score>={THRESH} {sum(r[1] >= THRESH for r in N)}/{len(N)}, "
              f"max score {max(r[1] for r in N):.2f}")
        for p, sc, rank, top1 in sorted(P, key=lambda r: r[1])[:5]:
            print(f"  weakest chainsaw  {p.split('/')[-1]:22s} score {sc:.2f} rank {rank:3d} top1 {top1}")
        for p, sc, rank, top1 in sorted(N, key=lambda r: -r[1])[:5]:
            print(f"  highest negative  {p.split('/')[-1]:22s} ({cats[p.split('/')[-1]]:14s}) score {sc:.2f} top1 {top1}")


if __name__ == "__main__":
    main(sys.argv[1:] or ["mn04_as", "mn10_as"])
