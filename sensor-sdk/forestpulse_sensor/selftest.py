"""Checks that this machine computes the same model output as the reference, and how fast.

usage: python -m forestpulse_sensor.selftest            # check the bundled ONNX model
       python -m forestpulse_sensor.selftest --write    # (maintainers) regenerate expected.json

If you run the model some other way (for example PyTorch), compare your scores and embedding for the clips in
data/reference/ against data/reference/expected.json: cosine similarity of the embeddings should be above 0.999.
"""
import json
import sys
import time
import wave
from importlib import resources

import numpy as np

from .model import LABELS, Model, to_model_audio

REF = resources.files(__package__).joinpath("data/reference")
CLIPS = ["chainsaw.wav", "hall.wav", "rain.wav"]


def read_wav(path):
    with wave.open(str(path)) as w:
        frames = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, w.getnchannels())
        return frames, w.getframerate()


def run(model, name):
    frames, rate = read_wav(REF.joinpath(name))
    return model.run(to_model_audio(frames, rate))


def main():
    model = Model(threads=1)
    if "--write" in sys.argv:
        out = {}
        for name in CLIPS:
            scores, emb = run(model, name)
            top = np.argsort(scores)[::-1][:5]
            out[name] = {"top": [[LABELS[i], round(float(scores[i]), 4)] for i in top],
                         "embedding": [round(float(v), 6) for v in emb]}
        REF.joinpath("expected.json").write_text(json.dumps(out))
        print("wrote expected.json")
        return
    expected = json.loads(REF.joinpath("expected.json").read_text())
    ok = True
    for name in CLIPS:
        scores, emb = run(model, name)
        ref = np.array(expected[name]["embedding"])
        cos = float(emb @ ref / (np.linalg.norm(emb) * np.linalg.norm(ref)))
        top = LABELS[int(np.argmax(scores))]
        good = cos > 0.999 and top == expected[name]["top"][0][0]
        ok &= good
        print(f"{'PASS' if good else 'FAIL'} {name:13s} top label {top!r}, embedding match {cos:.5f}")
    t0 = time.perf_counter()
    for _ in range(5):
        model.run(np.zeros(320000, np.float32))
    print(f"model speed on this machine (1 thread): {(time.perf_counter() - t0) / 5 * 1000:.0f} ms per window")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
