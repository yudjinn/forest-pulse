"""Trains the custom sound detectors the live page uses, on all available data, and saves them to heads/.

Each head is one weight per embedding dimension plus a bias (~4 KB as float32): the over-the-air "teach a new
sound" update. Background noise for augmentation and as negatives: samples/babble.wav plus any
samples/noise/*.wav (put a recording of the demo room there and re-run).

usage: uv run python train_heads.py [--model mn10_as]
"""
import argparse
import glob
import json
import os

import librosa
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from classifier import SAMPLE_RATE, Tagger
from probe import HERE, WIN, load_task, mix, windows

HEADS = {"chainsaw": "Chainsaw", "owl": "Boreal owl"}
HOLDOUT_PER_KIND = {"Aegolius_funereus": 5}  # owl recordings kept out of training for live testing; others get 2


def holdout(items):
    """Recordings whose recordist has nothing else in the set, so no training clip shares their microphone or site."""
    from collections import Counter
    n = Counter(it[2] for it in items)
    out, taken = set(), Counter()
    for p, _, rec, kind in items:
        if n[rec] == 1 and taken[kind] < HOLDOUT_PER_KIND.get(kind, 2):
            out.add(p); taken[kind] += 1
    return out


rng = np.random.default_rng(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="mn10_as")
    args = ap.parse_args()
    tagger = Tagger(args.model)
    noise = [librosa.load(p, sr=SAMPLE_RATE)[0] for p in [f"{HERE}/samples/babble.wav"] + sorted(glob.glob(f"{HERE}/samples/noise/*.wav"))]
    noise_w = [n[i:i + WIN] for n in noise for i in range(0, len(n) - WIN, WIN // 2)]
    _, E_noise = tagger.analyse_batch(noise_w)
    os.makedirs(f"{HERE}/heads", exist_ok=True)

    for task, name in HEADS.items():
        items = load_task(task)
        if task == "owl":
            held = holdout(items)
            items = [it for it in items if it[0] not in held]
            json.dump([{"url": "/samples/" + os.path.relpath(p, f"{HERE}/samples"), "kind": p.split("/")[-2]}
                       for p in sorted(held)], open(f"{HERE}/heads/owl_holdout.json", "w"), indent=1)
            print(f"held out {len(held)} owl recordings -> heads/owl_holdout.json")
        rec_win = [windows(librosa.load(p, sr=SAMPLE_RATE, mono=True)[0]) for p, *_ in items]
        y = np.concatenate([[it[1]] * len(w) for it, w in zip(items, rec_win)])
        flat = [w for ws in rec_win for w in ws]
        _, E_clean = tagger.analyse_batch(flat)
        _, E_aug = tagger.analyse_batch([mix(w, noise[rng.integers(len(noise))], rng.uniform(-3, 15)) for w in flat])
        X = np.concatenate([E_clean, E_aug, E_noise])
        Y = np.concatenate([y, y, np.zeros(len(E_noise), int)])
        sc = StandardScaler().fit(X)
        clf = LogisticRegression(C=0.1, max_iter=3000, class_weight="balanced").fit(sc.transform(X), Y)
        # fold the scaler into the weights so the device needs only w . emb + b
        w = clf.coef_[0] / sc.scale_
        b = float(clf.intercept_[0] - np.sum(clf.coef_[0] * sc.mean_ / sc.scale_))
        out = {"name": name, "model": args.model, "weights": w.astype(np.float32).tolist(), "bias": b,
               "trained_on": {"positive_windows": int(y.sum()), "negative_windows": int((1 - y).sum() + len(E_noise))}}
        path = f"{HERE}/heads/{task}.json"
        json.dump(out, open(path, "w"))
        print(f"{name}: {len(w)} weights, {len(w) * 4 + 4} bytes as float32 -> {os.path.relpath(path, HERE)}")


if __name__ == "__main__":
    main()
