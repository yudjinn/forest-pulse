"""Prepares the demo player's samples and keeps the seeded chainsaw detector honest about them.

Reads the experiment's local recordings (experiments/efficientat-chainsaw: ./setup.sh fetches them, XC_KEY needed
for the owls), so it needs no network. Run from the repository root in the experiment's environment:

  uv run --project experiments/efficientat-chainsaw python demo-kit/player_samples.py prepare
  (cd experiments/efficientat-chainsaw && uv run python train_heads.py chainsaw)
  uv run --project experiments/efficientat-chainsaw python demo-kit/player_samples.py check
  uv run --project experiments/efficientat-chainsaw python demo-kit/player_samples.py seed --version 2 \
      --migration web/migrations/<stamp>_retrained_chainsaw.sql

prepare  trims each sample to a seamless loop of at most 30 s, matches every sample to one RMS level, and writes
         them with their credits (samples.json) into web/bucket/player/, which the deploy mirrors into the bucket.
check    reports whether any chainsaw sample shares an ESC-50 source recording with the clips the chainsaw detector
         (heads/chainsaw.json) trained on. Exits non-zero if one does, or if the detector does not record them.
seed     copies the retrained chainsaw detector into the sensor library's built-in list at the given list version
         and writes the service migration that replaces the seeded detector and bumps the served list version.
"""
import argparse
import csv
import json
import os
import sys

import librosa
import numpy as np
import soundfile
from scipy.ndimage import minimum_filter1d, uniform_filter1d

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
EXP = os.path.join(ROOT, "experiments", "efficientat-chainsaw")
SAMPLES = os.path.join(EXP, "samples")
HEAD = os.path.join(EXP, "heads", "chainsaw.json")
OUT = os.path.join(ROOT, "web", "bucket", "player")
SEED = os.path.join(ROOT, "sensor-sdk", "forestpulse_sensor", "data", "seed_sounds.json")

RATE = 32000          # the sound model's rate: what the sensors resample to anyway
MAX_SECONDS = 30.0
FADE_SECONDS = 0.1    # loop crossfade
SNAP_SECONDS = 1.5    # how far a cut may move to land in a quiet moment
TARGET_DBFS = -20.0   # RMS level every sample is matched to
PEAK = 0.95           # peak limiter ceiling: the owls' crest factor would clip otherwise

ESC50_LICENCE = ("CC BY-NC 3.0", "https://creativecommons.org/licenses/by-nc/3.0/")

# Chainsaws: one ESC-50 clip from each of three source recordings whose Freesound uploaders have no other recording
# among ESC-50's chainsaws (so no take of the same saw or microphone stays in training), each one the stock model
# already calls a chainsaw. ESC-50 does not list uploaders; they are from each recording's Freesound page.
# Owls: the experiment's held-out recordings (recordists with no other recording in its set), skipping the
# no-derivatives licences because every sample is trimmed and loudness-matched. `start` picks the segment.
PICKS = [
    {"id": "chainsaw-1", "name": "Chainsaw 1", "kind": "chainsaw", "esc50": "1-116765-A-41.wav",
     "recordist": "UncleSigmund"},
    {"id": "chainsaw-2", "name": "Chainsaw 2", "kind": "chainsaw", "esc50": "1-64398-A-41.wav",
     "recordist": "Benboncan"},
    {"id": "chainsaw-3", "name": "Chainsaw 3", "kind": "chainsaw", "esc50": "4-169127-A-41.wav",
     "recordist": "fkurz"},
    {"id": "boreal-owl-1", "name": "Boreal owl 1", "kind": "boreal owl", "xc": "Aegolius_funereus/1145038", "start": 0},
    {"id": "boreal-owl-2", "name": "Boreal owl 2", "kind": "boreal owl", "xc": "Aegolius_funereus/217840", "start": 23},
    {"id": "tawny-owl", "name": "Tawny owl", "kind": "tawny owl", "xc": "Strix_aluco/1080086", "start": 0},
]

LICENCE_NAMES = {"by-nc-sa": "CC BY-NC-SA", "by-nc": "CC BY-NC", "by-sa": "CC BY-SA", "by": "CC BY",
                 "by-nc-nd": "CC BY-NC-ND", "by-nd": "CC BY-ND"}


def licence_name(url):
    parts = url.rstrip("/").split("/")
    return f"{LICENCE_NAMES[parts[-2]]} {parts[-1]}"


def envelope(x, hop):
    """RMS per hop-sized frame."""
    n = len(x) // hop
    return np.sqrt(np.mean(x[:n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)


def quietest(env, hop, around, lo, hi):
    """Sample index of the quietest frame within SNAP_SECONDS of `around`, kept inside [lo, hi]."""
    a = max(lo, int(around - SNAP_SECONDS * RATE)) // hop
    b = min(hi, int(around + SNAP_SECONDS * RATE)) // hop
    if b <= a:
        return int(around)
    return int((a + int(np.argmin(env[a:b]))) * hop)


def loop(x, start_s):
    """Cuts at most MAX_SECONDS from start_s at quiet moments, drops silent edges, and crossfades the seam."""
    hop = RATE // 100
    env = envelope(x, hop)
    audible = np.nonzero(env > env.max() * 10 ** (-50 / 20))[0]
    first, last = int(audible[0] * hop), int((audible[-1] + 1) * hop)
    start = max(first, int(start_s * RATE))
    end = min(last, start + int(MAX_SECONDS * RATE))
    if start > first:
        start = quietest(env, hop, start, first, end)
    if end < last:
        end = quietest(env, hop, end - SNAP_SECONDS * RATE, start, end)
    y = x[start:end].astype(np.float64)
    f = int(FADE_SECONDS * RATE)
    # The last f samples are blended into the first f and dropped: playing the result in a loop runs straight
    # from y[-f-1] into what is mostly the old tail, and out of the blend into the original y[f].
    t = np.linspace(0, np.pi / 2, f)
    head = y[:f] * np.sin(t) + y[-f:] * np.cos(t)
    return np.concatenate([head, y[f:-f]])


def level(y):
    """Scales to TARGET_DBFS RMS under a smooth peak limiter (5 ms lookahead, gain never above what a peak needs)."""
    target = 10 ** (TARGET_DBFS / 20)
    a = int(0.005 * RATE)
    z = y
    for _ in range(6):
        z = z * (target / np.sqrt(np.mean(z ** 2)))
        need = np.minimum(1.0, PEAK / np.maximum(np.abs(z), 1e-9))
        z = z * uniform_filter1d(minimum_filter1d(need, 2 * a + 1), a + 1)
    return z


def esc50_rows():
    with open(os.path.join(SAMPLES, "esc50.csv")) as fh:
        return {r["filename"]: r for r in csv.DictReader(fh)}


def prepare(_args):
    esc = esc50_rows()
    xc_meta = json.load(open(os.path.join(SAMPLES, "owls", "meta.json")))
    clips, entries = [], []
    for pick in PICKS:
        if "esc50" in pick:
            row = esc[pick["esc50"]]
            assert row["category"] == "chainsaw", pick
            x, _ = librosa.load(os.path.join(SAMPLES, "chainsaw", pick["esc50"]), sr=RATE, mono=True)
            source = {"dataset": "ESC-50", "clip": pick["esc50"], "recording": row["src_file"]}
            credit = {"recordist": pick["recordist"], "source": f"ESC-50, Freesound {row['src_file']}",
                      "url": f"https://freesound.org/s/{row['src_file']}/",
                      "licence": ESC50_LICENCE[0], "licence_url": ESC50_LICENCE[1]}
            y = loop(x, 0)
        else:
            m = xc_meta[pick["xc"] + ".mp3"]
            xc_id = pick["xc"].split("/")[1]
            assert "-nd" not in m["lic"], f"{pick['xc']}: no-derivatives licence, cannot trim or level it"
            x, _ = librosa.load(os.path.join(SAMPLES, "owls", pick["xc"] + ".mp3"), sr=RATE, mono=True)
            source = {"dataset": "xeno-canto", "recording": xc_id}
            credit = {"recordist": m["rec"], "source": f"xeno-canto XC{xc_id}", "url": f"https://xeno-canto.org/{xc_id}",
                      "licence": licence_name(m["lic"]), "licence_url": m["lic"]}
            y = loop(x, pick["start"])
        clips.append(y)
        entries.append({"id": pick["id"], "name": pick["name"], "kind": pick["kind"], "file": f"{pick['id']}.wav",
                        "credit": credit, "source": source})

    os.makedirs(OUT, exist_ok=True)
    for y, e in zip(clips, entries):
        z = level(y)
        e["seconds"] = round(len(z) / RATE, 2)
        soundfile.write(os.path.join(OUT, e["file"]), z.astype(np.float32), RATE, subtype="PCM_16")
        rms, peak = (20 * np.log10(v) for v in (np.sqrt(np.mean(z ** 2)), np.max(np.abs(z))))
        print(f"{e['file']}: {e['seconds']} s, {rms:.1f} dBFS RMS, peak {peak:.1f} dBFS, {e['credit']['source']}")
    doc = {"rms_dbfs": TARGET_DBFS, "samples": entries}
    with open(os.path.join(OUT, "samples.json"), "w") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


def check(_args):
    samples = json.load(open(os.path.join(OUT, "samples.json")))["samples"]
    mine = {s["source"]["recording"]: s["file"] for s in samples if s["source"]["dataset"] == "ESC-50"}
    trained = json.load(open(HEAD))["trained_on"].get("sources")
    if trained is None:
        sys.exit("FAIL: the chainsaw detector does not record its training source recordings; retrain it")
    shared = sorted(set(mine) & set(trained))
    for rec in shared:
        print(f"FAIL: {mine[rec]} shares ESC-50 source recording {rec} with the detector's training clips")
    if shared:
        sys.exit(1)
    print(f"OK: no chainsaw sample shares a source recording with the detector's {len(trained)} training "
          f"source recordings ({', '.join(f'{f} from {r}' for r, f in sorted(mine.items()))})")


def seed(args):
    check(args)
    head = json.load(open(HEAD))
    weights = [round(float(w), 7) for w in head["weights"]]
    doc = json.load(open(SEED))
    [chainsaw] = [s for s in doc["sounds"] if s["id"] == "chainsaw"]
    chainsaw["weights"], chainsaw["bias"] = weights, head["bias"]
    doc["version"] = args.version
    with open(SEED, "w") as fh:
        json.dump(doc, fh, ensure_ascii=False)
    sql = (
        "-- The seeded chainsaw detector, retrained without the ESC-50 source recordings the demo player plays\n"
        "-- (demo-kit/player_samples.py), verbatim from the sensor library's built-in list. Bumping the version makes\n"
        "-- sensors already holding the old detector fetch the new one.\n\n"
        f"UPDATE sounds SET weights = '{json.dumps(weights, separators=(',', ':'))}', bias = {head['bias']!r} "
        "WHERE id = 'chainsaw';\n"
        "UPDATE sound_list SET version = version + 1 WHERE id = 1;\n"
    )
    with open(args.migration, "w") as fh:
        fh.write(sql)
    print(f"built-in list at version {args.version}; migration {os.path.relpath(args.migration, ROOT)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("prepare").set_defaults(run=prepare)
    sub.add_parser("check").set_defaults(run=check)
    s = sub.add_parser("seed")
    s.add_argument("--version", type=int, required=True)
    s.add_argument("--migration", required=True)
    s.set_defaults(run=seed)
    args = ap.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
