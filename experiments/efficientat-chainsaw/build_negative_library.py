"""Builds what teaching a new sound trains against, and the teaching journey's owl clips.

Teaching (the dashboard's "Teach a new sound") trains a detector on summaries of the researcher's recordings
against stored summaries of other sounds. This script makes that stored library, with the sensor library's own
model file so its summaries are the ones a sensor computes:

  library   web/bucket/teach/other-sounds.f32   float32 little-endian rows of 960, clean then mixed per window
            web/bucket/teach/other-sounds.json  what each block of rows is, with credits
            web/bucket/teach/hall.wav           the hall background the browser mixes taught recordings over
  fixtures  web/tests/fixtures/owls/            two teaching sets of 6 boreal owl clips and their credits

Other sounds: every ESC-50 clip the experiment uses (all classes, chainsaw included), the other owls and the
cuckoo, the synthetic crowd babble and the hall recordings. Never a boreal owl, and never a recording in
heads/owl_holdout.json: those are the ones played on stage, so "not detected" there is honest.

Windows match the teach page and the sensor: the first 60 s of a recording in 5 s windows (a recording shorter
than 5 s is one window, one shorter than 1 s is skipped), each repeated to fill the model's 10 s. Every window
gives a clean summary and one mixed over a random stretch of the hall background at -3 to +15 dB.

usage (from this folder, after ./setup.sh with XC_KEY so samples/ has the recordings):
  uv run python build_negative_library.py [library] [fixtures] [--samples DIR]
"""
import argparse
import glob
import json
import os
import sys
import wave

import librosa
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "sensor-sdk"))
from forestpulse_sensor.model import EMBEDDING_DIM, MODEL_ID, MODEL_RATE, Model, to_model_audio  # noqa: E402

TEACH_OUT = os.path.join(ROOT, "web", "bucket", "teach")
FIXTURES_OUT = os.path.join(ROOT, "web", "tests", "fixtures", "owls")
HALL_BACKGROUND = os.path.join(HERE, "assets", "hall_background_30s.wav")
HALL_RECORDINGS = [HALL_BACKGROUND, os.path.join(HERE, "assets", "hall_event_001.wav")]
PLAYER_SAMPLES = os.path.join(ROOT, "web", "bucket", "player", "samples.json")

MAX_SECONDS = 60
RATIO_DB = (-3.0, 15.0)
SEED = 9
ESC50_LICENCE = "https://creativecommons.org/licenses/by-nc/3.0/"
TARGET = "Aegolius_funereus"

# The journey's teaching sets: 6 boreal owl recordings each, one per recordist, never a held-out recording or a
# recordist the player uses, never a no-derivatives licence (the clips are trimmed), first 20 s each. Chosen so a
# 6-clip detector catches the player's boreal owls and not the tawny owl (checked with the trained detector).
FIXTURE_SECONDS = 20
FIXTURE_SETS = {
    "teach-a": ["1097665", "278784", "307650", "312639", "638436", "625748"],
    "teach-b": ["560096", "632037", "782854", "801369", "985318", "356978"],
}


def windows(audio, rate):
    """Mono audio at its own rate -> the 32 kHz windows teaching uses (see the module docstring), each resampled on
    its own as the sensor library and the teach page do."""
    window = 5 * rate
    audio = audio[:MAX_SECONDS * rate]
    if len(audio) < rate:
        return []
    if len(audio) < window:
        return [to_model_audio(audio, rate)]
    return [to_model_audio(audio[i:i + window], rate) for i in range(0, len(audio) - window + 1, window)]


def mix(window, background, rng):
    """The window over a random stretch of the background, the window that many dB louder (RMS)."""
    ratio = rng.uniform(*RATIO_DB)
    off = rng.integers(0, len(background) - len(window) + 1)
    b = background[off:off + len(window)]
    gain = np.sqrt(np.mean(window ** 2) / (np.mean(b ** 2) + 1e-12)) / 10 ** (ratio / 20)
    return (window + gain * b).astype(np.float32)


def load(path, seconds=MAX_SECONDS):
    """Any recording -> (float32 mono at its own rate, rate), channels averaged as the sensor library does."""
    audio, rate = librosa.load(path, sr=None, mono=False, duration=seconds)
    mono = audio.mean(axis=0) if audio.ndim == 2 else audio
    return mono.astype(np.float32), int(rate)


def read_wav(path):
    with wave.open(path) as w:
        frames = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, w.getnchannels())
        return to_model_audio(frames, w.getframerate())


def held_out():
    """Recording ids (xeno-canto numbers) kept out of everything: played on stage or kept for live testing."""
    held = {os.path.splitext(os.path.basename(h["url"]))[0] for h in json.load(open(f"{HERE}/heads/owl_holdout.json"))}
    for s in json.load(open(PLAYER_SAMPLES))["samples"]:
        if s["source"]["dataset"] == "xeno-canto":
            held.add(s["source"]["recording"].removeprefix("XC"))
    return held


def sources(samples):
    """[(path, entry)] for every recording in the library, with what the manifest says about it."""
    out = []
    esc = {l.split(",")[0]: l.strip().split(",") for l in open(f"{samples}/esc50.csv").readlines()[1:]}
    for p in sorted(glob.glob(f"{samples}/chainsaw/*.wav")) + sorted(glob.glob(f"{samples}/negative/*.wav")):
        m = esc[os.path.basename(p)]
        out.append((p, {"kind": m[3], "dataset": "ESC-50", "recording": os.path.basename(p),
                        "credit": {"source": f"ESC-50, Freesound {m[5]}", "url": f"https://freesound.org/s/{m[5]}/",
                                   "licence_url": ESC50_LICENCE}}))
    meta = json.load(open(f"{samples}/owls/meta.json"))
    held = held_out()
    for p in sorted(glob.glob(f"{samples}/owls/*/*.mp3")):
        key = os.path.relpath(p, f"{samples}/owls")
        species, rec = key.split("/")[0], os.path.splitext(os.path.basename(p))[0]
        if species == TARGET or rec in held:
            continue
        out.append((p, {"kind": species.replace("_", " "), "dataset": "xeno-canto", "recording": f"XC{rec}",
                        "credit": {"recordist": meta[key]["rec"], "url": f"https://xeno-canto.org/{rec}",
                                   "licence_url": meta[key]["lic"]}}))
    out.append((f"{samples}/babble.wav", {"kind": "crowd babble", "dataset": "synthetic", "recording": "babble.wav",
                                          "credit": {"source": "make_babble.sh, macOS voices"}}))
    for p in HALL_RECORDINGS:
        out.append((p, {"kind": "hall", "dataset": "Forest Pulse", "recording": os.path.basename(p),
                        "credit": {"source": "recorded in the hackathon hall"}}))
    return out


def build_library(samples):
    model = Model(threads=4)
    background = read_wav(HALL_BACKGROUND)
    rng = np.random.default_rng(SEED)
    rows, entries = [], []
    for i, (path, entry) in enumerate(sources(samples)):
        ws = windows(*load(path))
        if not ws:
            continue
        clean = [model.run(w)[1] for w in ws]
        mixed = [model.run(mix(w, background, rng))[1] for w in ws]
        rows += clean + mixed
        entries.append({**entry, "windows": len(ws)})
        if (i + 1) % 50 == 0:
            print(f"{i + 1} recordings, {len(rows)} rows", flush=True)
    X = np.asarray(rows, dtype="<f4")
    assert X.shape[1] == EMBEDDING_DIM and np.isfinite(X).all()
    assert not any(e["dataset"] == "xeno-canto" and e["recording"].removeprefix("XC") in held_out() for e in entries)
    os.makedirs(TEACH_OUT, exist_ok=True)
    X.tofile(f"{TEACH_OUT}/other-sounds.f32")
    manifest = {"model": MODEL_ID, "dim": EMBEDDING_DIM, "rows": len(X), "dtype": "float32",
                "layout": "per recording: one clean row per window, then one mixed row per window",
                "window_seconds": 5, "max_seconds": MAX_SECONDS, "mixed_ratio_db": list(RATIO_DB),
                "background": "teach/hall.wav", "seed": SEED, "recordings": entries}
    json.dump(manifest, open(f"{TEACH_OUT}/other-sounds.json", "w"), indent=1, ensure_ascii=False)
    write_wav(f"{TEACH_OUT}/hall.wav", background)
    print(f"{len(entries)} recordings, {len(X)} rows ({X.nbytes / 1e6:.1f} MB) -> {os.path.relpath(TEACH_OUT, ROOT)}")


def write_wav(path, audio):
    pcm = np.clip(np.round(audio * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(MODEL_RATE)
        w.writeframes(pcm.tobytes())


def build_fixtures(samples):
    meta = json.load(open(f"{samples}/owls/meta.json"))
    held = held_out()
    player = {s["credit"]["recordist"] for s in json.load(open(PLAYER_SAMPLES))["samples"]}
    credits = []
    for folder, recs in FIXTURE_SETS.items():
        os.makedirs(f"{FIXTURES_OUT}/{folder}", exist_ok=True)
        for f in glob.glob(f"{FIXTURES_OUT}/{folder}/*.wav"):
            os.remove(f)
        recordists = set()
        for rec in recs:
            m = meta[f"{TARGET}/{rec}.mp3"]
            assert rec not in held and m["rec"] not in player and m["rec"] not in recordists, rec
            assert "-nd" not in m["lic"], f"{rec}: no-derivatives licence"
            recordists.add(m["rec"])
            audio = to_model_audio(*load(f"{samples}/owls/{TARGET}/{rec}.mp3", FIXTURE_SECONDS))
            peak = float(np.max(np.abs(audio))) or 1.0
            write_wav(f"{FIXTURES_OUT}/{folder}/XC{rec}.wav", audio * min(1.0, 0.99 / peak))
            credits.append({"file": f"{folder}/XC{rec}.wav", "recording": f"XC{rec}", "recordist": m["rec"],
                            "country": m["cnt"], "url": f"https://xeno-canto.org/{rec}", "licence_url": m["lic"],
                            "seconds": round(len(audio) / MODEL_RATE, 2)})
    json.dump({"species": "Boreal owl (Aegolius funereus)", "source": "xeno-canto", "first_seconds": FIXTURE_SECONDS,
               "clips": credits}, open(f"{FIXTURES_OUT}/credits.json", "w"), indent=1, ensure_ascii=False)
    print(f"{len(credits)} fixture clips -> {os.path.relpath(FIXTURES_OUT, ROOT)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", nargs="*", default=["library"], choices=["library", "fixtures"])
    ap.add_argument("--samples", default=f"{HERE}/samples", help="the experiment's samples/ folder")
    args = ap.parse_args()
    if "library" in args.what:
        build_library(args.samples)
    if "fixtures" in args.what:
        build_fixtures(args.samples)


if __name__ == "__main__":
    main()
