"""Events waiting for the server, kept on disk so a restart or a long outage loses nothing (up to a cap)."""
import json
import logging
import os
import threading

log = logging.getLogger(__name__)


class Outbox:
    def __init__(self, path: str, cap: int = 500):
        self.path, self.cap = path, cap
        self._lock = threading.Lock()
        self._events = []
        self.dropped = 0
        if os.path.exists(path):
            try:
                with open(path, errors="replace") as f:
                    for line in f:
                        try:
                            self._events.append(json.loads(line))
                        except ValueError:
                            pass  # a line cut short by a power loss
            except OSError as e:
                log.warning("could not read queued events, starting with none: %s", e)
            self._events = [e for e in self._events if isinstance(e, dict) and "event_id" in e][-cap:]

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
        # a failed write (a full disk) keeps the events in memory: they are still delivered, only a restart loses them
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w") as f:
                f.writelines(json.dumps(e) + "\n" for e in self._events)
            os.replace(tmp, self.path)
        except OSError as e:
            log.warning("could not save queued events to disk: %s", e)
