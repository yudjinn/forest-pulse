"""On-disk event store: <data_dir>/events/<event_id>.wav + .json.

Audio is kept as 3-channel 48 kHz int16 WAV (stdlib only). Only the newest
`keep` events are retained so the Uno Q's storage can't fill up; events still
waiting in the uplink outbox are never deleted.
"""

from __future__ import annotations

import json
import os
import wave

import numpy as np


class EventStore:
    def __init__(self, data_dir: str, keep: int = 50):
        self.dir = os.path.join(data_dir, "events")
        os.makedirs(self.dir, exist_ok=True)
        self.keep = keep

    def save(self, event_id: str, audio: np.ndarray, record: dict, sample_rate: int = 48000) -> str:
        wav_path = os.path.join(self.dir, f"{event_id}.wav")
        tmp = wav_path + ".tmp"
        with wave.open(tmp, "wb") as w:
            w.setnchannels(audio.shape[1])
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(np.ascontiguousarray(audio, dtype="<i2").tobytes())
        os.replace(tmp, wav_path)  # atomic: never leave half-written files
        self.write_record(event_id, record)
        self._prune()
        return wav_path

    def write_record(self, event_id: str, record: dict) -> str:
        path = os.path.join(self.dir, f"{event_id}.json")
        with open(path + ".tmp", "w") as f:
            json.dump(record, f, indent=2)
        os.replace(path + ".tmp", path)
        return path

    def _prune(self, protected: set[str] | None = None) -> None:
        ids = sorted({os.path.splitext(n)[0] for n in os.listdir(self.dir) if n.endswith((".wav", ".json"))})
        protected = protected or set()
        for eid in ids[: max(0, len(ids) - self.keep)]:
            if eid in protected:
                continue
            for ext in (".wav", ".json"):
                try:
                    os.remove(os.path.join(self.dir, eid + ext))
                except FileNotFoundError:
                    pass
