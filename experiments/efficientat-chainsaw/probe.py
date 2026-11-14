"""Can a tiny classifier on EfficientAT embeddings beat the stock labels, and survive a noisy room?

Two tasks, same method (the "teach the sensor a new sound" feature):
  chainsaw : ESC-50 chainsaw vs forest sounds and machinery confusers
  owl      : boreal owl vs other Nordic owls and the cuckoo (xeno-canto)

For each, a logistic regression is trained on frozen EfficientAT embeddings and tested on recordings it never saw
(grouped by source recording / recordist), clean and mixed with crowd babble at several loudness ratios.
Training babble and test babble come from different halves of samples/babble.wav.

usage: uv run python probe.py [chainsaw|owl ...] [--model mn10_as]
"""
import argparse
import glob
import json
import os

import librosa
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from classifier import CHAINSAW, SAMPLE_RATE, Tagger, labels

HERE = os.path.dirname(os.path.abspath(__file__))
WIN = 5 * SAMPLE_RATE
MAX_LEN = 40 * SAMPLE_RATE
TEST_SNRS = [None, 10, 5, 0]  # None = clean
OWL = labels.index("Owl")
rng = np.random.default_rng(0)


def load_task(task):
    """Returns list of (path, label 0/1, group, kind)."""
    items = []
    if task == "chainsaw":
        meta = {l.split(",")[0]: l.strip().split(",") for l in open(f"{HERE}/samples/esc50.csv").readlines()[1:]}
        for p in sorted(glob.glob(f"{HERE}/samples/chainsaw/*.wav")) + sorted(glob.glob(f"{HERE}/samples/negative/*.wav")):
            m = meta[os.path.basename(p)]
            items.append((p, int(m[3] == "chainsaw"), m[5], m[3]))
    else:
        meta = json.load(open(f"{HERE}/samples/owls/meta.json"))
        for p in sorted(glob.glob(f"{HERE}/samples/owls/*/*.mp3")):
            key = os.path.relpath(p, f"{HERE}/samples/owls")
            sp = key.split("/")[0]
            items.append((p, int(sp == "Aegolius_funereus"), meta[key]["rec"], sp))
    return items


def windows(wav):
    wav = wav[:MAX_LEN]
    if len(wav) < WIN:
        return [np.pad(wav, (0, WIN - len(wav)))]
    return [wav[i:i + WIN] for i in range(0, len(wav) - WIN + 1, WIN)]


def mix(w, babble, snr):
    off = rng.integers(0, len(babble) - WIN)
    b = babble[off:off + WIN]
    g = np.sqrt(np.mean(w ** 2) / (np.mean(b ** 2) + 1e-12)) / 10 ** (snr / 20)
    return (w + g * b).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks", nargs="*", default=["chainsaw", "owl"])
    ap.add_argument("--model", default="mn10_as")
    args = ap.parse_args()
    tagger = Tagger(args.model)
    babble = librosa.load(f"{HERE}/samples/babble.wav", sr=SAMPLE_RATE)[0]
    half = len(babble) // 2
    bab_train, bab_test = babble[:half], babble[half:]

    for task in args.tasks:
        items = load_task(task)
        rec_win = [windows(librosa.load(p, sr=SAMPLE_RATE, mono=True)[0]) for p, *_ in items]
        y = np.array([it[1] for it in items])
        groups = np.array([it[2] for it in items])
        kinds = np.array([it[3] for it in items])
        idx = np.concatenate([[i] * len(w) for i, w in enumerate(rec_win)])
        flat = [w for ws in rec_win for w in ws]
        print(f"\n##### {task}: {y.sum()} positive / {(1 - y).sum()} negative recordings, {len(flat)} windows, {args.model}")

        # embeddings: clean, test-babble mixes, and one training-babble augmentation per window
        S, E = {}, {}
        for snr in TEST_SNRS:
            ws = flat if snr is None else [mix(w, bab_test, snr) for w in flat]
            S[snr], E[snr] = tagger.analyse_batch(ws)
        _, E_aug = tagger.analyse_batch([mix(w, bab_train, rng.uniform(-3, 15)) for w in flat])
        bab_tr_w = [bab_train[i:i + WIN] for i in range(0, len(bab_train) - WIN, WIN // 2)]
        bab_te_w = [bab_test[i:i + WIN] for i in range(0, len(bab_test) - WIN, WIN // 2)]
        _, E_btr = tagger.analyse_batch(bab_tr_w)
        S_bte, E_bte = tagger.analyse_batch(bab_te_w)

        # stock model, recording level = max over windows
        def stock(snr):
            target = CHAINSAW if task == "chainsaw" else OWL
            return np.array([S[snr][idx == i, target].max() for i in range(len(items))])

        # probe, cross-validated by group
        probs = {(aug, snr): np.zeros(len(items)) for aug in (False, True) for snr in TEST_SNRS}
        babble_fp = {False: [], True: []}
        for tr, te in GroupKFold(5).split(np.zeros(len(items)), y, groups):
            trw = np.isin(idx, tr)
            for aug in (False, True):
                X, Y = E[None][trw], y[idx[trw]]
                if aug:
                    X = np.concatenate([X, E_aug[trw], E_btr])
                    Y = np.concatenate([Y, y[idx[trw]], np.zeros(len(E_btr), int)])
                clf = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=3000, class_weight="balanced"))
                clf.fit(X, Y)
                for snr in TEST_SNRS:
                    p = clf.predict_proba(E[snr])[:, 1]
                    for i in te:
                        probs[(aug, snr)][i] = p[idx == i].max()
                babble_fp[aug].append(clf.predict_proba(E_bte)[:, 1].max())

        # report
        stock_thr = 0.2 if task == "chainsaw" else 0.1
        stock_name = "Chainsaw" if task == "chainsaw" else "Owl"
        print(f"stock '{stock_name}' label (>= {stock_thr}) vs probe (>= 0.5); detections on positives, false alarms on negatives")
        print(f"{'condition':12s} {'stock hit':>10s} {'stock FA':>9s} {'probe hit':>10s} {'probe FA':>9s} {'AUC':>5s} "
              f"{'probe+aug hit':>14s} {'FA':>4s} {'AUC':>5s}")
        P, N = y == 1, y == 0
        for snr in TEST_SNRS:
            st = stock(snr)
            row = f"{'clean' if snr is None else f'babble {snr:+d}dB':12s} {f'{(st[P] >= stock_thr).sum()}/{P.sum()}':>10s} {f'{(st[N] >= stock_thr).sum()}/{N.sum()}':>9s}"
            for aug in (False, True):
                pr = probs[(aug, snr)]
                hit, fa = f"{(pr[P] >= .5).sum()}/{P.sum()}", f"{(pr[N] >= .5).sum()}"
                row += f" {hit:>{14 if aug else 10}s} {fa:>{4 if aug else 9}s} {roc_auc_score(y, pr):5.2f}"
            print(row)
        print(f"babble alone, max probe score over {len(E_bte)} windows: plain {max(babble_fp[False]):.2f}, "
              f"with babble training {max(babble_fp[True]):.2f}; stock {stock_name} max {S_bte[:, CHAINSAW if task == 'chainsaw' else OWL].max():.2f}")
        pr = probs[(True, None)]
        for k in sorted(set(kinds[N])):
            m = kinds == k
            print(f"  false alarms (clean, probe+aug) on {k:22s} {(pr[m] >= .5).sum()}/{m.sum()}")
        if task == "owl":
            top5 = [set(np.argsort(S[None][idx == i].max(0))[::-1][:5]) for i in range(len(items))]
            for k in sorted(set(kinds)):
                m = np.where(kinds == k)[0]
                print(f"  stock top-5 contains 'Owl' for {k:22s} {sum(OWL in top5[i] for i in m)}/{len(m)}")


if __name__ == "__main__":
    main()
