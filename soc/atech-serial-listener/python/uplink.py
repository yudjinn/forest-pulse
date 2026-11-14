"""Uplink to the server - STUB until the server API is defined.

The pipeline calls `uplink.submit(record, wav_path)` once per finished event.
The stub only logs what it would send and drops a copy of the record into
<data_dir>/outbox/ so nothing is lost; a real implementation (HTTP/MQTT,
retry until acknowledged) can later drain that outbox. Keep the interface:

    class Uplink:
        def submit(self, record: dict, wav_path: str) -> None: ...   # must not block
        def close(self) -> None: ...
"""

from __future__ import annotations

import json
import os


class StubUplink:
    def __init__(self, data_dir: str, log=print, server_url: str | None = None):
        self.outbox = os.path.join(data_dir, "outbox")
        os.makedirs(self.outbox, exist_ok=True)
        self.log = log
        self.server_url = server_url

    def submit(self, record: dict, wav_path: str) -> None:
        path = os.path.join(self.outbox, f"{record['event_id']}.json")
        with open(path, "w") as f:
            json.dump({"record": record, "audio_path": wav_path}, f, indent=2)
        cls = record.get("classification") or {}
        brg = record.get("bearing") or {}
        self.log(f"[uplink] stub: would send to {self.server_url or '(no server)'}: {record['event_id']} "
                 f"({cls.get('label', '?')} {cls.get('score', 0):.2f}, bearing {brg.get('deg')}) "
                 f"+ {os.path.basename(wav_path)}; queued in outbox/")

    def close(self) -> None:
        pass
