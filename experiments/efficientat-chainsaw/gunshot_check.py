"""Trains the gunshot detector on the training set and measures it on the held-out set (gunshot.py), beside the model's
own "Gunshot, gunfire" label. Reports how many held-out gunshots each finds (clean, and with babble under them), how
many held-out clips that are not gunshots set it off, and whether the demo's own recordings (the player's samples, the
part of the hall recordings the training never hears) do. The babble and each hall recording are cut in two: the
training hears the first half, the test only the second.

usage: uv run python gunshot_check.py [--threshold 0.5]
"""
import argparse
import glob
import json
import os

import numpy as np

import gunshot
from classifier import Tagger, labels

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
STOCK = labels.index("Gunshot, gunfire")


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args()
    thr = args.threshold
    emb = gunshot.Embeddings(Tagger("mn10_as"))
    babble = gunshot.load(f"{HERE}/samples/babble.wav")
    halls = [(os.path.basename(p), gunshot.load(p)) for p in sorted(glob.glob(f"{HERE}/samples/noise/*.wav"))]
    train_noise = [("babble first half", babble[:len(babble) // 2])]
    train_noise += [(f"{name} first half", h[:len(h) // 2]) for name, h in halls]
    test_babble = babble[len(babble) // 2:]

    every = gunshot.items()
    train = [it for it in every if not it[4]]
    test = [it for it in every if it[4]]
    print(f"train: {sum(it[1] for it in train)} gunshots, {sum(1 - it[1] for it in train)} other clips; "
          f"test: {sum(it[1] for it in test)} gunshots, {sum(1 - it[1] for it in test)} other clips")
    X, Y = gunshot.training_set(emb, train, train_noise)
    w, b = gunshot.fit(X, Y)

    def score(key, make):
        e, s = emb.get(key, make), emb.scores(key, make)
        return sigmoid(e @ w + b), s[:, STOCK]

    # Held-out gunshots: clean, and under the babble the training never heard.
    pos = [(p, kind) for p, label, _, kind, _ in test if label == 1]
    print(f"\nheld-out gunshots ({len(pos)}), found at >= {thr}:  detector | stock label")
    for name, snr in [("clean", None), ("babble +10 dB", 10), ("babble +5 dB", 5), ("babble 0 dB", 0)]:
        det, stock = [], []
        for p, _ in pos:
            rel = os.path.relpath(p, gunshot.SAMPLES)
            rng = np.random.default_rng(gunshot._seed(rel, "test", snr))
            key = f"clean {rel}" if snr is None else f"test-babble {rel} {snr}"
            d, s = score(key, lambda: [x if snr is None else gunshot.mix(x, test_babble, snr, rng)
                                       for x in gunshot.windows(gunshot.load(p))])
            det.append(d.max()); stock.append(s.max())
        det, stock = np.array(det), np.array(stock)
        by = {}
        for (p, kind), d, s in zip(pos, det, stock):
            by.setdefault(kind, []).append((d >= thr, s >= thr))
        parts = ", ".join(f"{k}: {sum(a for a, _ in v)}/{len(v)}" for k, v in sorted(by.items()))
        print(f"  {name:14s} {int((det >= thr).sum()):3d}/{len(pos)} | {int((stock >= thr).sum()):3d}/{len(pos)}   ({parts})")
        if snr is None:
            clean_det = det

    # Held-out clips that are not gunshots, by kind.
    print(f"\nheld-out clips that are not gunshots, set off at >= {thr}:  detector | stock label")
    neg = {}
    for p, label, _, kind, _ in test:
        if label == 0:
            neg.setdefault(kind, []).append(p)
    forest_det = None
    for kind, paths in sorted(neg.items()):
        det, stock = [], []
        for p in paths:
            d, s = score(f"clean {os.path.relpath(p, gunshot.SAMPLES)}", lambda: gunshot.windows(gunshot.load(p)))
            det += list(d); stock += list(s)
        det, stock = np.array(det), np.array(stock)
        if kind == "vietnam noise":
            forest_det = det
        print(f"  {kind:26s} {int((det >= thr).sum()):4d}/{len(det)} | {int((stock >= thr).sum()):4d}/{len(det)}"
              f"   highest {det.max():.2f}")
    emb.save()

    # The demo's own recordings: the player's samples, and the half of each hall recording the training never heard,
    # in 5 s windows a second apart.
    print("\nthe demo's recordings, highest gunshot score over their windows (windows set off):")
    player = json.load(open(f"{ROOT}/web/bucket/player/samples.json"))["samples"]
    demo = [(s["name"], gunshot.load(f"{ROOT}/web/bucket/player/{s['file']}")) for s in player]
    demo += [(f"{name} (second half)", h[len(h) // 2:]) for name, h in halls]
    for name, wav in demo:
        wins = [wav[i:i + gunshot.WIN] for i in range(0, max(1, len(wav) - gunshot.WIN + 1), 32000)]
        d, s = score(f"demo {name} {len(wav)}", lambda: wins)
        print(f"  {name:36s} detector {d.max():.2f} ({int((d >= thr).sum())}/{len(wins)})  stock {s.max():.2f}")

    print(f"\nsensitivity: held-out gunshots found | held-out forest clips (3 s each, {len(forest_det) * 3 / 3600:.1f} h)"
          " set off")
    for t in (0.3, 0.5, 0.7, 0.8, 0.9):
        print(f"  {t:.1f}   {int((clean_det >= t).sum())}/{len(clean_det)} | {int((forest_det >= t).sum())}/{len(forest_det)}")
    emb.save()


if __name__ == "__main__":
    main()
