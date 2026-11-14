"""Warnings from the service (docs/device-api.md, "Warnings"): the alarm named on a check-in reply, played once per id
on its own thread through the buzzer hook, and its result confirmed on the check-ins after it ends.

Sensor drives it: checkin_fields() before every check-in, note_reply() after every successful one, and silenced,
which means "report no sound events and drop the audio" while the alarm sounds. The alarm plays off the sync thread,
so check-ins and event delivery go on while it sounds and a slow buzzer never takes the board offline.
"""
import logging
import threading
import time
from collections import deque

from .alarm import DURATION_S, play_alarm

log = logging.getLogger("forestpulse_sensor")

# Audio fed this long after the alarm ends is dropped too: the front-end delivers what it recorded a little late, so
# the alarm's last tone can still be on its way when the alarm returns.
TAIL_S = 0.5


class Warnings:
    """This board's side of warnings: whether it can play the alarm (its hooks include the buzzer), the alarm it is
    playing, and the confirmations still to send."""

    def __init__(self, hooks, wake):
        emit = getattr(hooks, "emit", None)
        self._emit = emit if callable(emit) else None
        self._wake = wake
        self._lock = threading.Lock()
        self._playing = None      # the id of the alarm sounding now
        self._quiet_until = 0.0   # monotonic: audio is dropped until then (the alarm's tail)
        self._played = deque(maxlen=50)  # ids already played (or playing), so each plays once
        self._confirm = deque()   # {"id", "result"} still to confirm, oldest first, one per check-in

    @property
    def capable(self) -> bool:
        return self._emit is not None

    @property
    def silenced(self) -> bool:
        """The alarm is sounding (or just ended): no sound events, and the audio is not analysed."""
        with self._lock:
            return self._playing is not None or time.monotonic() < self._quiet_until

    def checkin_fields(self) -> dict:
        fields = {"can_warn": self.capable}
        with self._lock:
            if self._confirm:
                fields["alarm_done"] = dict(self._confirm[0])
        return fields

    def note_reply(self, reply: dict, sent: dict, calibrating: bool) -> None:
        """A successful check-in's reply, with the fields that check-in sent: the confirmation it carried is done, and
        an alarm on the reply starts unless this board already played it, is playing one, or is calibrating."""
        done = sent.get("alarm_done")
        with self._lock:
            if done is not None and self._confirm and self._confirm[0] == done:
                self._confirm.popleft()
        block = reply.get("alarm")
        if not isinstance(block, dict) or not isinstance(block.get("id"), str):
            return
        warning = block["id"]
        with self._lock:
            if warning in self._played or self._playing is not None:
                return  # each id plays once; a new alarm while one sounds is ignored until it is done
            if self._emit is None:
                log.warning("warning %s: the service sent an alarm but the hooks have no emit(); not played", warning)
                self._played.append(warning)
                return
            if calibrating:
                log.warning("warning %s: not played, this board is taking part in a calibration run", warning)
                self._played.append(warning)
                return
            self._playing = warning
            self._played.append(warning)
        threading.Thread(target=self._play, args=(warning,), name="fp-alarm", daemon=True).start()

    def _play(self, warning: str) -> None:
        log.info("warning %s: playing the alarm (%.1f s)", warning, DURATION_S)
        try:
            ok = play_alarm(self._emit)
        except Exception:  # play_alarm catches the hook's failures; anything else is still a failed alarm
            log.exception("warning %s: the alarm failed", warning)
            ok = False
        with self._lock:
            self._playing = None
            self._quiet_until = time.monotonic() + TAIL_S
            self._confirm.append({"id": warning, "result": "played" if ok else "failed"})
        log.info("warning %s: alarm %s", warning, "played" if ok else "failed")
        self._wake()  # confirm at the first check-in after the alarm ends
