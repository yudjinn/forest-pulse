"""The sensor: turns 3-mic audio into events for the server, and keeps its sound list in sync.

Threads: `feed()` only queues audio and returns at once, so the caller's USB reader is never blocked. An analysis
thread runs the model; a sync thread checks in, pulls sound lists and delivers queued events.
"""
import json
import logging
import os
import queue
import socket
import threading
import time
import uuid
from importlib import resources

import numpy as np

from . import __version__
from .api import Api, BadRequest, KeyRejected, Unavailable, iso
from .model import MODEL_ID, Model, to_model_audio
from .outbox import Outbox
from .sounds import InvalidSoundList, SoundList

log = logging.getLogger("forestpulse_sensor")

WINDOW_S = 10.0       # analyse the latest 10 s (shorter at the start of an audio burst)
HOP_S = 2.0           # analyse every 2 s of new audio
MIN_WINDOW_S = 1.0    # never analyse less than this
REPEAT_S = 5.0        # report the same sound at most once per 5 s
MAX_BACKLOG_S = 60.0  # audio waiting for analysis beyond this is dropped (logged), never blocking feed()
BATCH = 100


class Sensor:
    def __init__(self, server_url: str, sensor_key: str, sensor_id: str | None = None, state_dir: str = "~/.forestpulse",
                 angle_fn=None, sample_rate: int = 48000, checkin_interval: float = 10.0, model: Model | None = None,
                 model_threads: int = 2):
        """
        angle_fn: optional callable(window) -> angle_deg | (angle_deg, confidence) | None, called once per window
            that produced a detection. `window` is the (N, channels) int16 audio that was classified, at
            `sample_rate`. Return degrees clockwise from the board's forward (0-360); see board_to_angle().
        """
        self.sensor_id = sensor_id or socket.gethostname()
        self.sample_rate = sample_rate
        self.angle_fn = angle_fn
        self.checkin_interval = checkin_interval
        self.state_dir = os.path.expanduser(state_dir)
        os.makedirs(self.state_dir, exist_ok=True)
        self.api = Api(server_url, sensor_key, self.sensor_id)
        self.outbox = Outbox(os.path.join(self.state_dir, "outbox.jsonl"))
        self.instance_id = uuid.uuid4().hex
        self._model = model
        self._model_threads = model_threads
        self._sounds, self._sounds_from_server = self._load_cached_sounds()
        self._last_reported = {}
        self._audio = queue.Queue()
        self._backlog_frames = 0
        self._backlog_lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._threads = []
        self.key_rejected = False
        self.last_checkin_ok = None
        self._want_sounds = False

    @classmethod
    def from_file(cls, path: str, **overrides) -> "Sensor":
        """TOML file with server_url, sensor_key and optionally sensor_id, state_dir."""
        import tomllib

        with open(os.path.expanduser(path), "rb") as f:
            cfg = tomllib.load(f)
        cfg.update(overrides)
        return cls(**cfg)

    # ---- lifecycle -------------------------------------------------------------------------------------------

    def start(self) -> "Sensor":
        if self._model is None:
            self._model = Model(threads=self._model_threads)
        for target, name in ((self._analysis_loop, "fp-analysis"), (self._sync_loop, "fp-sync")):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)
        log.info("sensor %s started (sound list %s, %d events queued)", self.sensor_id,
                 self._sounds.version if self._sounds_from_server else "built-in", len(self.outbox))
        return self

    def stop(self, flush_timeout: float = 5.0) -> None:
        """Finishes queued analysis, tries to deliver events for up to flush_timeout, then stops."""
        self._audio.put(("stop",))
        if self._threads:
            self._threads[0].join(timeout=60)
        deadline = time.monotonic() + flush_timeout
        while len(self.outbox) and time.monotonic() < deadline and not self.key_rejected:
            self._wake.set()
            time.sleep(0.1)
        self._stop.set()
        self._wake.set()
        for t in self._threads[1:]:
            t.join(timeout=15)

    # ---- audio in --------------------------------------------------------------------------------------------

    def feed(self, frames, break_before: bool = False) -> None:
        """Queue audio: (N, channels) int16 array at sample_rate. break_before: not contiguous with what came before."""
        frames = np.asarray(frames)
        if frames.ndim == 1:
            frames = frames[:, None]
        with self._backlog_lock:
            if self._backlog_frames + len(frames) > MAX_BACKLOG_S * self.sample_rate:
                log.warning("analysis is behind by more than %.0f s; dropping audio", MAX_BACKLOG_S)
                break_before = True
                self._drain_audio()
            self._backlog_frames += len(frames)
        self._audio.put(("audio", frames, break_before, time.time()))

    def feed_channels(self, channels, break_before: bool = False) -> None:
        """Same as feed() for separate per-mic sequences, e.g. the (mic1, mic2, mic3) array('h') of a packet."""
        self.feed(np.stack([np.frombuffer(c, dtype=np.int16) if isinstance(c, (bytes, bytearray, memoryview))
                            else np.asarray(c, dtype=np.int16) for c in channels], axis=1), break_before)

    def end_of_audio(self) -> None:
        """The current audio burst ended (the front-end's END packet): analyse what is left, start fresh next time."""
        self._audio.put(("end",))

    def report(self, scores, embedding, angle_deg=None, angle_confidence=None, detected_at: float | None = None) -> list:
        """For callers that run the model themselves: score one window and queue its events. Returns them."""
        return self._report(np.asarray(scores), np.asarray(embedding), detected_at or time.time(),
                            lambda: (angle_deg, angle_confidence))

    @property
    def status(self) -> dict:
        return {"sensor_id": self.sensor_id, "sound_list_version": self._sounds.version if self._sounds_from_server
                else None, "queued_events": len(self.outbox), "dropped_events": self.outbox.dropped,
                "key_rejected": self.key_rejected, "last_checkin_ok": self.last_checkin_ok}

    # ---- analysis --------------------------------------------------------------------------------------------

    def _drain_audio(self):
        try:
            while True:
                item = self._audio.get_nowait()
                if item[0] == "audio":
                    self._backlog_frames -= len(item[1])
                elif item[0] == "stop":
                    self._audio.put(item)
                    return
        except queue.Empty:
            pass

    def _analysis_loop(self):
        sr = self.sample_rate
        window, hop, minimum = int(WINDOW_S * sr), int(HOP_S * sr), int(MIN_WINDOW_S * sr)
        buf = np.zeros((0, 1), np.int16)
        since, total, start_time = 0, 0, None
        while True:
            item = self._audio.get()
            kind = item[0]
            if kind == "audio":
                _, frames, brk, arrived = item
                with self._backlog_lock:
                    self._backlog_frames -= len(frames)
                if brk or buf.shape[1] != frames.shape[1]:
                    buf, since, total, start_time = frames[:0], 0, 0, None
                buf = np.concatenate([buf, frames])[-window:]
                total += len(frames)
                since += len(frames)
                # frames arrive in bursts (the pre-trigger audio) and then live; the earliest estimate of when
                # frame 0 was recorded is the most accurate one
                est = arrived - total / sr
                start_time = est if start_time is None else min(start_time, est)
                if since >= hop and len(buf) >= minimum:
                    self._analyse(buf, start_time + total / sr)
                    since = 0
            elif kind in ("end", "stop"):
                if since >= sr // 2 and len(buf) >= minimum:
                    self._analyse(buf, start_time + total / sr)
                buf, since, total, start_time = buf[:0], 0, 0, None
                if kind == "stop":
                    return

    def _analyse(self, frames, end_time):
        try:
            scores, embedding = self._model.run(to_model_audio(frames, self.sample_rate))
        except Exception:
            log.exception("model failed on a %.1f s window", len(frames) / self.sample_rate)
            return

        def angle():
            if self.angle_fn is None:
                return None, None
            try:
                a = self.angle_fn(frames)
            except Exception:
                log.exception("angle_fn failed; reporting without an angle")
                return None, None
            return a if isinstance(a, tuple) else (a, None)

        self._report(scores, embedding, end_time, angle)

    def _report(self, scores, embedding, detected_at, angle):
        hits = [(s, c) for s, c in self._sounds.matches(scores, embedding)
                if detected_at - self._last_reported.get(s.id, -1e18) >= REPEAT_S]
        if not hits:
            return []
        deg, conf = angle()
        events = []
        for sound, confidence in hits:
            self._last_reported[sound.id] = detected_at
            e = {"event_id": str(uuid.uuid4()), "detected_at": iso(detected_at), "sound_id": sound.id,
                 "confidence": round(confidence, 4)}
            if deg is not None:
                e["angle_deg"] = round(float(deg) % 360.0, 2)
                if conf is not None:
                    e["angle_confidence"] = round(min(max(float(conf), 0.0), 1.0), 3)
            self.outbox.add(e)
            events.append(e)
            log.info("heard %s (%.2f)%s", sound.name, confidence,
                     f" at {e['angle_deg']:.0f} deg" if "angle_deg" in e else "")
        self._wake.set()
        return events

    # ---- sync with the server --------------------------------------------------------------------------------

    def _load_cached_sounds(self):
        path = os.path.join(self.state_dir, "sounds.json")
        if os.path.exists(path):
            try:
                with open(path) as f:
                    return SoundList.parse(json.load(f)), True
            except (InvalidSoundList, json.JSONDecodeError) as e:
                log.warning("ignoring cached sound list: %s", e)
        seed = json.loads(resources.files(__package__).joinpath("data/seed_sounds.json").read_text())
        return SoundList.parse(seed), False

    def _fetch_sounds(self):
        doc = self.api.sounds()
        try:
            new = SoundList.parse(doc)
        except InvalidSoundList as e:
            log.error("server sent an invalid sound list, keeping the previous one: %s", e)
            return
        tmp = os.path.join(self.state_dir, "sounds.json.tmp")
        with open(tmp, "w") as f:
            json.dump(doc, f)
        os.replace(tmp, os.path.join(self.state_dir, "sounds.json"))
        self._sounds, self._sounds_from_server = new, True
        self._want_sounds = False
        log.info("sound list %d: %s", new.version, ", ".join(s.name for s in new.sounds) or "(empty)")

    def _note_version(self, version):
        current = self._sounds.version if self._sounds_from_server else None
        if version is not None and version != current:
            self._want_sounds = True

    def _sync_loop(self):
        next_checkin, next_flush, backoff = 0.0, 0.0, 2.0
        while not self._stop.is_set():
            now = time.monotonic()
            if now >= next_checkin:
                next_checkin = now + self.checkin_interval
                try:
                    reply = self.api.checkin(instance_id=self.instance_id, sdk_version=__version__, model=MODEL_ID,
                                             sound_list_version=self._sounds.version if self._sounds_from_server
                                             else None, queued_events=len(self.outbox))
                    self._set_key_ok()
                    self.last_checkin_ok = time.time()
                    self._note_version(reply.get("sound_list_version"))
                    if self._want_sounds:
                        self._fetch_sounds()
                except KeyRejected:
                    self._set_key_rejected()
                except Unavailable as e:
                    log.warning("server unavailable (%s); %d events queued", e, len(self.outbox))
                except BadRequest as e:
                    log.error("check-in rejected: %s", e)
            if len(self.outbox) and now >= next_flush and not self.key_rejected:
                try:
                    self._flush()
                    backoff = 2.0
                except Unavailable as e:
                    next_flush = time.monotonic() + backoff
                    log.warning("could not deliver events (%s); retrying in %.0f s", e, backoff)
                    backoff = min(backoff * 2, 30.0)
                except KeyRejected:
                    self._set_key_rejected()
            flush_due = next_flush if len(self.outbox) and not self.key_rejected else next_checkin
            self._wake.wait(timeout=max(0.05, min(next_checkin, flush_due) - time.monotonic()))
            self._wake.clear()

    def _flush(self):
        while not self._stop.is_set():
            batch = self.outbox.peek(BATCH)
            if not batch:
                return
            try:
                reply = self.api.post_events(batch)
            except BadRequest as e:
                log.error("server rejected a batch of %d events as malformed, discarding it: %s", len(batch), e)
                self.outbox.remove(e_["event_id"] for e_ in batch)
                continue
            self._set_key_ok()
            done = []
            for r in reply.get("results", []):
                if r.get("status") == "rejected":
                    log.error("event %s rejected: %s", r.get("event_id"), r.get("reason"))
                done.append(r.get("event_id"))
            if not done:
                raise Unavailable("server returned no results for the batch")
            self.outbox.remove(done)
            self._note_version(reply.get("sound_list_version"))

    def _set_key_rejected(self):
        if not self.key_rejected:
            log.error("sensor key rejected by the server (HTTP 401): check sensor_key; %d events kept queued",
                      len(self.outbox))
        self.key_rejected = True

    def _set_key_ok(self):
        if self.key_rejected:
            log.info("sensor key accepted again; delivering queued events")
        self.key_rejected = False


def board_to_angle(bearing_ccw_deg: float, forward_ccw_deg: float = 90.0) -> float:
    """Convert a board-frame bearing (counter-clockwise from +x, as in soc/README.md) to the API's angle
    (clockwise from the board's forward). forward_ccw_deg is where forward points in the board frame; the default
    90 means the top edge of the board, away from mic 3."""
    return (forward_ccw_deg - bearing_ccw_deg) % 360.0
