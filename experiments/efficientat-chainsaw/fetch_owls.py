"""Downloads xeno-canto recordings: boreal owl (target) and the Nordic owls/birds most likely to be confused with it.

usage: XC_KEY=<your xeno-canto API key> uv run python fetch_owls.py
Files land in samples/owls/<species>/<id>.mp3 with samples/owls/meta.json (recordist, country, licence).
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SPECIES = {  # scientific name -> max recordings
    "Aegolius funereus": 40,     # boreal (Tengmalm's) owl, the demo target
    "Glaucidium passerinum": 20,  # Eurasian pygmy owl: also a monotone series of notes
    "Strix aluco": 20,           # tawny owl
    "Strix uralensis": 20,       # Ural owl
    "Asio otus": 20,             # long-eared owl
    "Bubo bubo": 20,             # eagle owl
    "Cuculus canorus": 15,       # cuckoo: another repeated hoot in Finnish forests
}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples", "owls")


def query(name, key):
    gen, sp = name.lower().split()
    q = f"gen:{gen} sp:{sp} q:A len:5-90"
    url = "https://xeno-canto.org/api/3/recordings?" + urllib.parse.urlencode({"query": q, "key": key})
    return json.load(urllib.request.urlopen(url, timeout=60))["recordings"]


def main():
    key = os.environ.get("XC_KEY") or sys.exit("set XC_KEY")
    meta, jobs = {}, []
    for name, n in SPECIES.items():
        recs = query(name, key)
        # one recording per recordist first, so the test is not one person's microphone repeated
        seen, picked = set(), []
        for r in recs:
            if r["rec"] not in seen:
                seen.add(r["rec"]); picked.append(r)
        picked += [r for r in recs if r not in picked]
        folder = os.path.join(OUT, name.replace(" ", "_"))
        os.makedirs(folder, exist_ok=True)
        for r in picked[:n]:
            path = os.path.join(folder, f"{r['id']}.mp3")
            meta[f"{name.replace(' ', '_')}/{r['id']}.mp3"] = {k: r[k] for k in ("rec", "cnt", "type", "length", "lic")}
            jobs.append((r["file"], path))
        print(f"{name}: {len(recs)} available, taking {min(n, len(picked))}")
    def get(job):
        url, path = job
        for attempt in range(6):
            if os.path.exists(path):
                return
            try:
                urllib.request.urlretrieve(url, path + ".part")
                os.rename(path + ".part", path)
            except urllib.error.HTTPError as e:
                if e.code not in (429, 503):
                    raise
                time.sleep(2 ** attempt)  # xeno-canto rate-limits parallel downloads
    with ThreadPoolExecutor(2) as ex:
        list(ex.map(get, jobs))
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    print(f"downloaded {len(jobs)} files")


if __name__ == "__main__":
    main()
