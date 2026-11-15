"""Trains the custom sound detectors the live page uses, on all available data, and saves them to heads/.

Each head is one weight per embedding dimension plus a bias (~4 KB as float32): the over-the-air "teach a new
sound" update. Background noise for augmentation and as negatives: samples/babble.wav plus any
samples/noise/*.wav (put a recording of the demo room there and re-run).

The chainsaw detector never trains on an ESC-50 source recording the demo player plays (the credits list in
web/bucket/player/samples.json), and records the source recordings it did train on, so the player's samples are
provably new to it (demo-kit/player_samples.py check).

The gunshot detector trains on the forest gunshots and everything else in gunshot.py's training set, never on its
held-out set, which stays new to it for testing (gunshot_check.py) and for any gunshot the demo plays.

usage: uv run python train_heads.py [chainsaw|owl|gunshot ...] [--model mn10_as]
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
import gunshot
from probe import HERE, WIN, load_task, mix, windows

HEADS = {"chainsaw": "Chainsaw", "owl": "Boreal owl", "gunshot": "Gunshot"}
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


PLAYER_SAMPLES = os.path.join(HERE, "..", "..", "web", "bucket", "player", "samples.json")


def player_sources():
    """ESC-50 source recordings the demo player plays; every clip cut from them is kept out of training."""
    if not os.path.exists(PLAYER_SAMPLES):
        return set()
    return {s["source"]["recording"] for s in json.load(open(PLAYER_SAMPLES))["samples"]
            if s["source"]["dataset"] == "ESC-50"}


rng = np.random.default_rng(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks", nargs="*", default=list(HEADS), choices=list(HEADS))
    ap.add_argument("--model", default="mn10_as")
    args = ap.parse_args()
    tagger = Tagger(args.model)
    noise = [librosa.load(p, sr=SAMPLE_RATE)[0] for p in [f"{HERE}/samples/babble.wav"] + sorted(glob.glob(f"{HERE}/samples/noise/*.wav"))]
    noise_w = [n[i:i + WIN] for n in noise for i in range(0, len(n) - WIN, WIN // 2)]
    _, E_noise = tagger.analyse_batch(noise_w)
    os.makedirs(f"{HERE}/heads", exist_ok=True)

    for task in args.tasks:
        name = HEADS[task]
        if task == "gunshot":
            train = [it for it in gunshot.items() if not it[4]]
            held = sorted({it[2] for it in gunshot.items() if it[4] and it[1] == 1})
            # The whole of the babble and of every hall recording: gunshot_check.py measures on the halves left out.
            named = [("babble", noise[0])] + [(os.path.basename(p), n) for p, n in
                                              zip(sorted(glob.glob(f"{HERE}/samples/noise/*.wav")), noise[1:])]
            X, Y = gunshot.training_set(gunshot.Embeddings(tagger), train, named)
            w, b = gunshot.fit(X, Y)
            save(task, name, args.model, w, b, {
                "positive_clips": sum(it[1] for it in train), "negative_clips": sum(1 - it[1] for it in train),
                "occasions": sorted({it[2] for it in train if it[1] == 1}), "held_out_occasions": held,
            })
            continue
        items = load_task(task)
        trained_on = {}
        if task == "chainsaw":
            excluded = player_sources()
            items = [it for it in items if not (it[1] == 1 and it[2] in excluded)]
            trained_on["sources"] = sorted({it[2] for it in items if it[1] == 1})
            print(f"kept {len(excluded)} player source recording(s) out of training: {', '.join(sorted(excluded))}")
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
        save(task, name, args.model, w, b, {"positive_windows": int(y.sum()),
                                            "negative_windows": int((1 - y).sum() + len(E_noise)), **trained_on})


def save(task, name, model, w, b, trained_on):
    out = {"name": name, "model": model, "weights": np.asarray(w, dtype=np.float32).tolist(), "bias": float(b),
           "trained_on": trained_on}
    path = f"{HERE}/heads/{task}.json"
    json.dump(out, open(path, "w"))
    print(f"{name}: {len(w)} weights, {len(w) * 4 + 4} bytes as float32 -> {os.path.relpath(path, HERE)}")


if __name__ == "__main__":
    main()
