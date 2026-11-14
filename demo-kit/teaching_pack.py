"""Builds the boreal owl teaching pack: the recordings the presenter drops into "Teach a new sound" on stage.

The pack is whichever of 10, 15 or 20 boreal owl recordings works on the player's own samples with the widest margin:
a size works when the taught detector, run by the sensor library, reports both of the player's boreal owls and never
its tawny owl, and of the sizes that work the one whose lowest score on those boreal owls is highest is kept (the
smaller on a tie). Each size is tried exactly as the dashboard teaches:

- clips: the first 60 s of each recording, written as 32 kHz mono 16-bit WAV (the pack's files);
- summaries: those files in the teach page's windows (first 60 s, 5 s each), each clean and once mixed over the hall
  background at -3 to +15 dB, with the sensor library's own model (the windows and the mix are the ones the stored
  other-sounds library was built with, imported from its build script). The page draws its mix at random, so each
  size is tried with five different mixes and works only if it works with all of them;
- training: the teach request's own training function (web/src/teach/train.ts, run from Node), against every row
  of the stored other-sounds library (web/bucket/teach/other-sounds.f32);
- detection: the sensor library's replay command plays each player sample to a local stand-in server whose sound list
  holds only the taught detector, at the threshold the service stores (0.5).

Candidates are the experiment's boreal owl recordings, minus any by a recordist the player's samples use, any held-out
recording (kept for live testing) and any no-derivatives licence (the clips are trimmed), ranked one recording per
recordist first, songs before calls, longer before shorter. The sizes are nested: 15 is the first 10 plus 5 more.

Writes demo-kit/teaching_pack.json (every size tried, with the detections, and the chosen pack's credits) and, only
when a size works, the pack folder: the chosen clips and nothing else, so the presenter can drop the whole folder's
contents. The builder never deletes or overwrites a file: a rebuild adds the new clips, leaves identical ones as they
are, and refuses a folder holding anything else (another file, or a same-named clip with other contents) before it
writes the report or the folder; remove those by hand. If no size works it says which player samples were missed and
makes no pack.

usage (from the repository root, after experiments/efficientat-chainsaw/setup.sh has fetched the recordings with
XC_KEY; no other network is needed):
  uv run --project experiments/efficientat-chainsaw python demo-kit/teaching_pack.py [--samples DIR] [--out DIR]
The pack folder defaults to $FP_TEACHING_PACK, else ~/Desktop/Boreal owl teaching pack.
"""
import argparse
import filecmp
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXPERIMENT = os.path.join(ROOT, "experiments", "efficientat-chainsaw")
sys.path.insert(0, EXPERIMENT)
sys.path.insert(0, os.path.join(ROOT, "sensor-sdk"))
import build_negative_library as library  # noqa: E402  the one definition of windows and mixing
from forestpulse_sensor.devserver import serve  # noqa: E402
from forestpulse_sensor.model import EMBEDDING_DIM, MODEL_ID, MODEL_RATE, Model, to_model_audio  # noqa: E402

SIZES = (10, 15, 20)
FIRST_SECONDS = 60
# The page mixes each window over the hall at a random level and stretch, so a size works only if it works for
# every one of these mixes.
SEEDS = (11, 12, 13, 14, 15)
OTHER_SOUNDS = os.path.join(ROOT, "web", "bucket", "teach", "other-sounds.f32")
PLAYER = os.path.join(ROOT, "web", "bucket", "player")
REPORT = os.path.join(HERE, "teaching_pack.json")
CLIP = re.compile(r"boreal-owl-XC\d+\.wav")
DEFAULT_PACK = os.path.join(os.path.expanduser("~"), "Desktop", "Boreal owl teaching pack")
SOUND = {"id": "boreal-owl", "name": "Boreal owl", "category": "wildlife", "kind": "detector", "threshold": 0.5}
KEY = "teaching-pack"


def seconds(length):
    m, s = length.split(":")
    return int(m) * 60 + int(s)


def candidates(samples):
    """The ranked candidate recordings: [{recording, recordist, country, type, url, licence_url, path}]."""
    meta = json.load(open(f"{samples}/owls/meta.json"))
    held = library.held_out()
    player = {s["credit"]["recordist"] for s in json.load(open(f"{PLAYER}/samples.json"))["samples"]}
    pool = []
    for key, m in meta.items():
        species, file = key.split("/")
        rec = os.path.splitext(file)[0]
        if species != library.TARGET or rec in held or m["rec"] in player or "-nd" in m["lic"]:
            continue
        pool.append({"recording": f"XC{rec}", "recordist": m["rec"], "country": m["cnt"], "type": m["type"],
                     "url": f"https://xeno-canto.org/{rec}", "licence_url": m["lic"],
                     "length": seconds(m["length"]), "path": f"{samples}/owls/{key}"})
    pool.sort(key=lambda c: ("song" not in c["type"], -min(c["length"], FIRST_SECONDS), c["recording"]))
    first, rest, seen = [], [], set()
    for c in pool:
        (rest if c["recordist"] in seen else first).append(c)
        seen.add(c["recordist"])
    return first + rest


def write_clip(c, folder):
    """The first 60 s of a recording as a 32 kHz mono 16-bit WAV, peaks limited; returns its file name and seconds."""
    audio = to_model_audio(*library.load(c["path"], FIRST_SECONDS))
    peak = float(np.max(np.abs(audio))) or 1.0
    name = f"boreal-owl-{c['recording']}.wav"
    library.write_wav(os.path.join(folder, name), audio * min(1.0, 0.99 / peak))
    return name, round(len(audio) / MODEL_RATE, 2)


def pack_folder(out):
    """The pack folder, refused when it holds anything but a pack's clips (the builder never deletes a file)."""
    if os.path.exists(out):
        other = [f for f in os.listdir(out) if not f.startswith(".") and not CLIP.fullmatch(f)]
        if not os.path.isdir(out) or other:
            sys.exit(f"{out} is not a teaching pack folder (it holds {', '.join(other[:3]) or 'a file'}); "
                     "choose another with --out")
    return out


def blocking(out, pack, staging):
    """Files already in the pack folder that a rebuild would have to delete or overwrite: any not in the new pack,
    and any clip of the new pack whose contents differ from the one just built (an identical one is left as it is)."""
    if not os.path.isdir(out):
        return []
    keep = {c["file"] for c in pack}
    return sorted(f for f in os.listdir(out) if not f.startswith(".") and (
        f not in keep or not filecmp.cmp(os.path.join(out, f), os.path.join(staging, f), shallow=False)))


def worst_boreal(runs):
    """The lowest top confidence on the player's boreal owls over every mix (0 when one was missed)."""
    return min(r["top_confidence"] or 0.0 for run in runs for r in run["samples"] if r["kind"] == "boreal owl")


def train(rows, work):
    positives = os.path.join(work, "positives.f32")
    np.asarray(rows, dtype="<f4").tofile(positives)
    out = subprocess.run(["node", os.path.join(HERE, "train_detector.ts"), positives, OTHER_SOUNDS],
                         check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


def detections(detector, samples, work):
    """Replays each player sample through the sensor library with only the taught detector listed:
    {file: (events, top confidence)}."""
    doc = {"model": MODEL_ID, "version": 1, "sounds": [{**SOUND, **detector}]}
    server, state = serve(port=0, key=KEY, sounds=doc, quiet=True)
    out = {}
    try:
        for s in samples:
            sensor_id = f"pack-{os.path.splitext(s['file'])[0]}"
            folder = tempfile.mkdtemp(prefix="replay-", dir=work)
            os.makedirs(f"{folder}/state")
            json.dump(doc, open(f"{folder}/state/sounds.json", "w"))  # the list a sensor keeps after fetching it
            with open(f"{folder}/sensor.toml", "w") as f:
                f.write(f'server_url = "http://127.0.0.1:{server.server_address[1]}"\nsensor_key = "{KEY}"\n'
                        f'sensor_id = "{sensor_id}"\nstate_dir = "{folder}/state"\ncheckin_interval = 1.0\n')
            env = {**os.environ, "PYTHONPATH": os.path.join(ROOT, "sensor-sdk")}
            replay = subprocess.run([sys.executable, "-m", "forestpulse_sensor.replay", "--config",
                                     f"{folder}/sensor.toml", f"{PLAYER}/{s['file']}"],
                                    env=env, capture_output=True, text=True)
            if replay.returncode or not re.search(r"^done: 0 event\(s\) still queued$", replay.stdout, re.M):
                sys.exit(f"replay of {s['file']} failed:\n{replay.stdout}{replay.stderr}")
            with state.lock:
                heard = [e for e in state.events if e["sensor_id"] == sensor_id]
            out[s["file"]] = (len(heard), max((e["confidence"] for e in heard), default=None))
    finally:
        server.shutdown()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--samples", default=f"{EXPERIMENT}/samples", help="the experiment's samples/ folder")
    ap.add_argument("--out", default=os.environ.get("FP_TEACHING_PACK") or DEFAULT_PACK, help="the pack folder")
    args = ap.parse_args()
    out = pack_folder(os.path.abspath(os.path.expanduser(args.out)))
    if not os.path.exists(f"{args.samples}/owls/meta.json"):
        sys.exit(f"no owl recordings in {args.samples}: run experiments/efficientat-chainsaw/setup.sh with XC_KEY")
    ranked = candidates(args.samples)
    if len(ranked) < max(SIZES):
        sys.exit(f"only {len(ranked)} candidate recordings, need {max(SIZES)}")
    player = json.load(open(f"{PLAYER}/samples.json"))["samples"]
    owls = [s for s in player if s["kind"] in ("boreal owl", "tawny owl")]
    assert {s["kind"] for s in owls} == {"boreal owl", "tawny owl"}

    model = Model(threads=4)
    background = library.read_wav(library.HALL_BACKGROUND)
    work = tempfile.mkdtemp(prefix="teaching-pack-")
    staging = os.path.join(work, "clips")
    os.makedirs(staging)
    try:
        # Per clip, as the teach page summarises a file: its windows clean, and the same windows mixed (per seed).
        clips, clean, mixed = [], [], {seed: [] for seed in SEEDS}
        rngs = {seed: np.random.default_rng(seed) for seed in SEEDS}
        for c in ranked[:max(SIZES)]:
            name, secs = write_clip(c, staging)
            clips.append({"file": name, "recording": c["recording"], "recordist": c["recordist"],
                          "country": c["country"], "type": c["type"], "url": c["url"],
                          "licence_url": c["licence_url"], "seconds": secs})
            ws = library.windows(library.read_wav(os.path.join(staging, name)), MODEL_RATE)
            clean.append([model.run(w)[1] for w in ws])
            for seed in SEEDS:
                mixed[seed].append([model.run(library.mix(w, background, rngs[seed]))[1] for w in ws])
            print(f"{len(clips):2d} {name}: {c['recordist']}, {c['type']}, {secs:.0f} s, {len(ws)} windows", flush=True)

        tried, chosen = [], None
        for size in SIZES:
            runs = []
            for seed in SEEDS:
                rows = [r for i in range(size) for r in clean[i] + mixed[seed][i]]
                detector = train(rows, work)
                assert len(detector["weights"]) == EMBEDDING_DIM
                heard = detections({"weights": detector["weights"], "bias": detector["bias"]}, player, work)
                results = [{"file": s["file"], "kind": s["kind"], "detections": heard[s["file"]][0],
                            "top_confidence": heard[s["file"]][1]} for s in player]
                missed = [r["file"] for r in results if r["kind"] == "boreal owl" and not r["detections"]]
                false_alarms = [r["file"] for r in results if r["kind"] == "tawny owl" and r["detections"]]
                runs.append({"seed": seed, "passed": not missed and not false_alarms, "missed": missed,
                             "false_alarms": false_alarms, "training_iterations": detector["iterations"],
                             "samples": results})
                print(f"size {size}, mix {seed}: {'works' if runs[-1]['passed'] else 'fails'}; " + ", ".join(
                    f"{r['file']} {r['detections']} ({r['top_confidence'] or 0:.2f})" for r in results), flush=True)
            passed = all(r["passed"] for r in runs)
            tried.append({"size": size, "passed": passed, "worst_boreal_confidence": worst_boreal(runs),
                          "recordings": [c["recording"] for c in clips[:size]],
                          "missed": sorted({f for r in runs for f in r["missed"]}),
                          "false_alarms": sorted({f for r in runs for f in r["false_alarms"]}), "mixes": runs})
        # Of the sizes that work, the widest margin on the player's boreal owls; the smaller size on a tie.
        working = [t for t in tried if t["passed"]]
        chosen = max(working, key=lambda t: (t["worst_boreal_confidence"], -t["size"]))["size"] if working else None
        for t in tried:
            print(f"size {t['size']}: {'works' if t['passed'] else 'fails'}, lowest boreal owl score "
                  f"{t['worst_boreal_confidence']:.2f}{', chosen' if t['size'] == chosen else ''}", flush=True)

        if chosen is not None:
            stale = blocking(out, clips[:chosen], staging)
            if stale:
                sys.exit(f"{out} also holds {', '.join(stale)}, which the new pack of {chosen} would delete or "
                         "overwrite; remove them by hand and run again (nothing was written)")
        report = {"species": "Boreal owl (Aegolius funereus)", "source": "xeno-canto", "first_seconds": FIRST_SECONDS,
                  "sizes_tried": list(SIZES), "chosen_size": chosen, "mix_seeds": list(SEEDS),
                  "how": "summaries with the sensor library's model, trained with web/src/teach/train.ts against "
                         "web/bucket/teach/other-sounds.f32, replayed through the sensor library at threshold 0.5; a size works only if it works for every mix seed, and the working size with the highest worst_boreal_confidence is chosen",
                  "sizes": tried, "pack": clips[:chosen] if chosen else []}
        with open(REPORT, "w") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
            f.write("\n")
        if chosen is None:
            print("No pack: no size up to 20 caught every player boreal owl without the tawny owl.")
            for t in tried:
                print(f"  size {t['size']}: missed {', '.join(t['missed']) or 'none'}; "
                      f"false alarms {', '.join(t['false_alarms']) or 'none'}")
            sys.exit(1)
        os.makedirs(out, exist_ok=True)
        for c in clips[:chosen]:
            if not os.path.exists(os.path.join(out, c["file"])):  # an identical clip is already there
                shutil.move(os.path.join(staging, c["file"]), os.path.join(out, c["file"]))
        print(f"pack of {chosen} -> {out}; report -> {os.path.relpath(REPORT, ROOT)}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
