"""The gunshot detector's data: what it trains on, what is kept back to test it, and how a clip becomes embeddings.

Positives are forest gunshots (fetch_gunshots.sh): shotguns and hunting guns heard by recorders in Belize and Vietnam,
up to 1,000 m away. Negatives are forest background from the same recorders, ESC-50 bangs and knocks that are not
gunshots, the sounds of people indoors, people talking (LibriSpeech), the chainsaw clips and the ESC-50 forest and
machinery sounds, and the hall and babble (heard on their own, and mixed under every clip). Talking matters most: the
first detectors without it took a hall full of people talking for a gunshot.

The test set is never trained on, and is kept apart by occasion, not by clip, so no test shot was also heard by a
training recorder (the Belize firings were recorded by 13 recorders at once):
- Belize: the night of the controlled firings (26 April 2017) and every survey day from March 2019 on.
- Vietnam: every recording from 19 and 20 November 2019, including two continuous recordings whose 2,391 background
  clips are the most realistic false-alarm test.
- ESC-50: fold 5, and every fireworks clip.
- LibriSpeech: every fifth speaker.

Embeddings are cached in samples/gunshot/embeddings.npz by clip and by what was done to it, so training again with
other choices costs only what is new.
"""
import datetime
import glob
import hashlib
import os
import re

import numpy as np
from scipy.signal import butter, sosfiltfilt

from classifier import SAMPLE_RATE

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "samples")
CACHE = os.path.join(SAMPLES, "gunshot", "embeddings.npz")
WIN = 5 * SAMPLE_RATE
# Fireworks are a gunshot's closest sound; a detector taught to ignore them may also miss distant shots, so they test
# it rather than train it.
TEST_ONLY_CLASSES = {"fireworks"}
TEST_FOLD = "5"
BELIZE_TEST_FROM = datetime.date(2019, 3, 1)
BELIZE_TEST_DAYS = {datetime.date(2017, 4, 26)}
VIETNAM_TEST_PREFIXES = ("20191119_", "20191120_")


def _esc50():
    return {l.split(",")[0]: l.strip().split(",") for l in open(f"{SAMPLES}/esc50.csv").readlines()[1:]}


def _occasion(name):
    """(source, occasion) of a forest clip: the Belize recorder day, or the Vietnam source recording."""
    m = re.match(r"^([0-9A-F]{8})", name)
    if m:
        return "belize", datetime.datetime.fromtimestamp(int(m.group(1), 16), datetime.UTC).date()
    return "vietnam", re.search(r"(\d{8}_\d{6})", name).group(1)


def _held_out(source, occasion):
    if source == "belize":
        return occasion >= BELIZE_TEST_FROM or occasion in BELIZE_TEST_DAYS
    return occasion.startswith(VIETNAM_TEST_PREFIXES)


def items():
    """Every clip as (path, label 0/1, group, kind, test): kind says where it comes from, test whether it is held out."""
    out = []
    for label, folder in ((1, "gunshot"), (0, "noise")):
        for p in sorted(glob.glob(f"{SAMPLES}/gunshot/{folder}/*.wav")):
            source, occasion = _occasion(os.path.basename(p))
            out.append((p, label, f"{source}:{occasion}", f"{source} {folder}", _held_out(source, occasion)))
    for p in sorted(glob.glob(f"{SAMPLES}/speech/*/*.flac")):
        speaker = os.path.basename(os.path.dirname(p))
        out.append((p, 0, f"librispeech:{speaker}", "librispeech speech", int(speaker) % 5 == 0))
    meta = _esc50()
    seen = set()
    for folder in ("chainsaw", "negative", "confusers"):
        for p in sorted(glob.glob(f"{SAMPLES}/{folder}/*.wav")):
            name = os.path.basename(p)
            if name in seen:
                continue
            seen.add(name)
            m = meta[name]
            cls, fold, rec = m[3], m[1], m[5]
            out.append((p, 0, f"esc50:{rec}", f"esc50 {cls}", fold == TEST_FOLD or cls in TEST_ONLY_CLASSES))
    return out


def load(path):
    import librosa
    return librosa.load(path, sr=SAMPLE_RATE, mono=True)[0]


def windows(wav, longest=40 * SAMPLE_RATE):
    """5 s windows of a recording. A clip under 5 s is one window as it is: the model repeats it to fill its 10 s,
    as the sensor library does, rather than hearing it followed by silence."""
    wav = wav[:longest]
    if len(wav) <= WIN:
        return [wav]
    return [wav[i:i + WIN] for i in range(0, len(wav) - WIN + 1, WIN)]


_LOWPASS = {}


def lowpass(wav, hz):
    """The recording as an 8 kHz recorder would have heard it: nothing above `hz`."""
    if hz not in _LOWPASS:
        _LOWPASS[hz] = butter(8, hz, btype="low", fs=SAMPLE_RATE, output="sos")
    return sosfiltfilt(_LOWPASS[hz], wav).astype(np.float32)


def mix(wav, noise, snr_db, rng):
    """`wav` with a random stretch of `noise` under it, `snr_db` quieter."""
    n = len(wav)
    if len(noise) <= n:
        noise = np.tile(noise, -(-(n + 1) // len(noise)))
    off = rng.integers(0, len(noise) - n)
    b = noise[off:off + n]
    g = np.sqrt(np.mean(wav ** 2) / (np.mean(b ** 2) + 1e-12)) / 10 ** (snr_db / 20)
    return (wav + g * b).astype(np.float32)


class Embeddings:
    """The model's embeddings and label scores of clips, cached by clip and variant ("clean", "mix ...")."""

    def __init__(self, tagger):
        self.tagger = tagger
        self.store = dict(np.load(CACHE)) if os.path.exists(CACHE) else {}
        self.added = 0

    def _get(self, key, make):
        if "emb " + key not in self.store:
            wins = make()
            s, e = self.tagger.analyse_batch(wins) if wins else (np.zeros((0, 527)), np.zeros((0, 960)))
            self.store["emb " + key], self.store["scores " + key] = e.astype(np.float32), s.astype(np.float32)
            self.added += 1
            if self.added % 300 == 0:
                self.save()
        return self.store["emb " + key], self.store["scores " + key]

    def get(self, key, make):
        """The embeddings of the windows `make()` returns, under `key`, computed once."""
        return self._get(key, make)[0]

    def scores(self, key, make):
        """The model's own 527 label scores for the same windows."""
        return self._get(key, make)[1]

    def save(self):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        np.savez(CACHE[:-4] + ".tmp.npz", **self.store)
        os.replace(CACHE[:-4] + ".tmp.npz", CACHE)


def _seed(*parts):
    return int.from_bytes(hashlib.sha256("|".join(map(str, parts)).encode()).digest()[:8], "little")


def training_set(emb, train, noise):
    """The embeddings the detector trains on, and their labels (1 gunshot, 0 not). Each clip is heard clean and with
    babble or the hall under it at -3 to +15 dB, and the babble and the hall are negatives of their own; every
    full-band negative is heard a third time through an 8 kHz recorder's band, so a band-limited recording is never on
    its own a sign of a gunshot (the forest clips all are). `noise` is a list of (name, audio)."""
    parts, labels = [], []
    names = ",".join(n for n, _ in noise)
    for p, label, _, kind, _ in train:
        rel = os.path.relpath(p, SAMPLES)
        clean = emb.get(f"clean {rel}", lambda: windows(load(p)))
        rng = np.random.default_rng(_seed(rel, names))
        pick, snr = int(rng.integers(len(noise))), float(rng.uniform(-3, 15))
        mixed = emb.get(f"mix {rel} {noise[pick][0]} {snr:.3f}",
                        lambda: [mix(w, noise[pick][1], snr, rng) for w in windows(load(p))])
        parts += [clean, mixed]
        labels += [label] * (len(clean) + len(mixed))
        if label == 0 and not kind.startswith(("belize", "vietnam")):
            band = emb.get(f"lowpass4000 {rel}", lambda: [lowpass(w, 4000) for w in windows(load(p))])
            parts.append(band)
            labels += [0] * len(band)
    for name, audio in noise:
        quiet = emb.get(f"noise {name} {len(audio)}",
                        lambda: [audio[i:i + WIN] for i in range(0, len(audio) - WIN, WIN // 2)])
        parts.append(quiet)
        labels += [0] * len(quiet)
    emb.save()
    return np.concatenate(parts), np.array(labels)


# The detector is made stricter than the regression's own midpoint: at a sensor's sensitivity (50% by default) it
# answers as the regression would at 90%. On the held-out set that keeps 91 of 94 gunshots and silences people
# talking in the hall, which otherwise reached 87%.
STRICTER_AS = 0.9


def fit(X, Y):
    """A logistic regression on the embeddings, with the standardisation folded in and made stricter by STRICTER_AS:
    score = sigmoid(w . emb + b)."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    sc = StandardScaler().fit(X)
    clf = LogisticRegression(C=0.1, max_iter=3000, class_weight="balanced").fit(sc.transform(X), Y)
    w = clf.coef_[0] / sc.scale_
    b = float(clf.intercept_[0] - np.sum(clf.coef_[0] * sc.mean_ / sc.scale_))
    return w, b - float(np.log(STRICTER_AS / (1 - STRICTER_AS)))
