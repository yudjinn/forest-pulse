"""Shared helpers for running the Uno Q app's pipeline on a laptop."""
import os
import sys
import wave

import numpy as np

APP_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "atech-serial-listener", "python")
sys.path.insert(0, os.path.abspath(APP_PY))

import config  # noqa: E402
import led_arrow  # noqa: E402
from atech_protocol import EVENT_END, LIVE, PRE_TRIGGER, build_packet  # noqa: E402
from classifier import Classifier  # noqa: E402
from climate import Climate  # noqa: E402
from events import PRE_TRIGGER_FRAMES  # noqa: E402
from pipeline import Pipeline  # noqa: E402
from receiver import Receiver  # noqa: E402
from storage import EventStore  # noqa: E402
from uplink import StubUplink  # noqa: E402


def load_wav(path: str) -> np.ndarray:
    with wave.open(path) as w:
        assert w.getnchannels() == 3 and w.getsampwidth() == 2 and w.getframerate() == 48000, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, 3)


def encode_event(audio: np.ndarray, seq0: int = 0) -> bytes:
    pre, live = audio[:PRE_TRIGGER_FRAMES], audio[PRE_TRIGGER_FRAMES:]
    out, seq = bytearray(), seq0
    for kind, part in ((PRE_TRIGGER, pre), (LIVE, live)):
        for st in range(0, len(part), 679):
            out += build_packet(kind, seq, np.ascontiguousarray(part[st:st + 679], dtype="<i2").tobytes())
            seq += 1
    out += build_packet(EVENT_END, seq)
    return bytes(out)


def make_pipeline(data_dir: str, cfg_over: dict | None = None, classifier: bool = False,
                  display=None, log=print, climate: Climate | None = None) -> Pipeline:
    cfg = config.load()
    cfg["data_dir"] = data_dir
    for k, v in (cfg_over or {}).items():
        if isinstance(v, dict):
            cfg[k].update(v)
        else:
            cfg[k] = v
    clf = Classifier.load(cfg["classifier"]["model"], log=log) if classifier else None
    return Pipeline(cfg, EventStore(data_dir, cfg["keep_events"]), StubUplink(data_dir, log=log),
                    classifier=clf, climate=climate, display=display, log=log)


def replay(audio: np.ndarray, pipe: Pipeline, log=print) -> dict:
    """Run one event through Receiver + Pipeline synchronously; returns the record."""
    rx = Receiver(pipe.queue, log=log)
    data = encode_event(audio)
    for i in range(0, len(data), 65536):
        rx.feed(data[i:i + 65536])
        pipe.drain()
    return pipe.records[-1]
