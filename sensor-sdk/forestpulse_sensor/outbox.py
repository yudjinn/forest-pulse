"""Events waiting for the server, kept on disk so a restart or a long outage loses nothing (up to a cap)."""
import json
import os
import threading


class Outbox:
    def __init__(self, path: str, cap: int = 500):
        self.path, self.cap = path, cap
        self._lock = threading.Lock()
        self._events = []
        self.dropped = 0
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    try:
                        self._events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass  # a line cut short by a power loss
            self._events = self._events[-cap:]

    def __len__(self):
        with self._lock:
            return len(self._events)

    def add(self, event: dict) -> None:
        with self._lock:
            self._events.append(event)
            if len(self._events) > self.cap:
                self.dropped += len(self._events) - self.cap
                self._events = self._events[-self.cap:]  # oldest go first
            self._save()

    def peek(self, n: int) -> list:
        with self._lock:
            return list(self._events[:n])

    def remove(self, event_ids) -> None:
        ids = set(event_ids)
        with self._lock:
            self._events = [e for e in self._events if e["event_id"] not in ids]
            self._save()

    def _save(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            f.writelines(json.dumps(e) + "\n" for e in self._events)
        os.replace(tmp, self.path)
