"""Worker thread: events in, analysis + storage (+ optional uplink) + LED out.

Consumes EventStart / AudioBlock / EventEnd from the Receiver's queue.

During an event (live):
  - bearing on the newest 0.5 s window whenever enough new audio arrived;
  - classification every `classifier.live_every_s` on the newest <=10 s
    (only with a classifier; main.py passes none, the SDK classifies);
  - LED arrow once bearing windows pass the quality gate, only when
    led.source isn't "detections" (default: SDK detections drive the arrow
    through show_detection).
At the event end (final):
  - bearing over the whole event (0.5 s windows, 0.25 s hop, split at breaks),
    gated against the event's own pre-trigger background;
  - classification over the whole event (10 s windows, max score);
  - event record -> disk (WAV + JSON) -> uplink (if any); LED holds the final
    arrow for `led.hold_s`, then clears.

If the Uno Q falls behind, live analysis skips stale audio (it always looks at
the newest window) - the final analysis still sees everything.
"""

from __future__ import annotations

import math
import queue
import threading
import time
from dataclasses import asdict
from typing import Callable

import numpy as np

import led_arrow
from bearing import BearingEstimator, Geometry
from climate import Climate
from events import PRE_TRIGGER_FRAMES, AudioBlock, EventEnd, EventStart, PipelineReset

FS = 48000
BACKGROUND_S = 2.0  # first 2 s of the pre-trigger window = the event's own background
LIVE_SUMMARY_WINDOWS = 8  # live arrow = summary of the last N accepted windows


class _Event:
    def __init__(self, start: EventStart):
        self.start = start
        self.blocks: list[np.ndarray] = []
        self.frames = 0
        self.breaks: list[int] = []
        self.background_dbfs: float | None = None
        self.live_next = 0          # next frame at which a live bearing window is due
        self.live_windows: list = []
        self.live_class: dict | None = None
        self.class_next = 0
        self._cat: np.ndarray | None = None

    def audio(self) -> np.ndarray:
        if self._cat is None or len(self._cat) != self.frames:
            self._cat = np.concatenate(self.blocks) if self.blocks else np.zeros((0, 3), np.int16)
            self.blocks = [self._cat]
        return self._cat


def _dbfs(x: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean((x.astype(np.float64) - x.mean(axis=0)) ** 2))) / 32768.0
    return 20 * math.log10(max(rms, 1e-9))


class Pipeline:
    def __init__(
        self,
        cfg: dict,
        store,
        uplink,
        classifier=None,
        climate: Climate | None = None,
        display: Callable[[str], None] | None = None,
        log: Callable[[str], None] = lambda s: print(s, flush=True),
        on_record: Callable[[dict], None] | None = None,
    ):
        """display(frame) receives a 104-char LED frame string ('' = clear);
        on_record(record) is called once per finished event."""
        self.cfg = cfg
        self.store = store
        self.uplink = uplink
        self.classifier = classifier
        self.climate = climate or Climate(default=cfg["speed_of_sound_mps"])
        self.display = display or (lambda f: None)
        self.on_record = on_record or (lambda r: None)
        self.log = log
        b = cfg["bearing"]
        self.est = BearingEstimator(Geometry.from_cm(cfg["mic_positions_cm"]), FS,
                                    band_hz=tuple(b["band_hz"]), c=cfg["speed_of_sound_mps"])
        self.win = int(b["window_s"] * FS)
        # TEST: pure-tone detection + narrowband bearing (config "test_tone_hz", 0 = off)
        self.tone_hz = float(cfg.get("test_tone_hz") or 0)
        self.tone_est = None
        if self.tone_hz:
            self.tone_est = BearingEstimator(Geometry.from_cm(cfg["mic_positions_cm"]), FS,
                                             band_hz=(self.tone_hz - 100, self.tone_hz + 100),
                                             c=cfg["speed_of_sound_mps"])
            log(f"[test] TEST MODE: LED arrow for a {self.tone_hz:.0f} Hz tone")
        self.queue: queue.Queue = queue.Queue()
        self.ev: _Event | None = None
        self.led_deg: float | None = None
        self.led_clear_at: float | None = None
        self.records: list[dict] = []  # finished event records (for tests / harness)
        self._led_lock = threading.Lock()  # show_detection() is called from the SDK's thread
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------- threading

    def start(self) -> None:
        self._thread = threading.Thread(target=self.run, name="pipeline", daemon=True)
        self._thread.start()

    def run(self) -> None:
        # One bad block must not end this thread: the LED arrow would never clear and the queue would grow by the
        # live audio until the board runs out of memory. Failures are logged at most every 5 s.
        last_logged = 0.0
        while True:
            try:
                self._step()
            except Exception as e:
                now = time.monotonic()
                if now - last_logged >= 5.0:
                    self.log(f"[event] pipeline step failed, carrying on: {e!r}")
                    last_logged = now

    def _step(self) -> None:
        try:
            msg = self.queue.get(timeout=0.5)
        except queue.Empty:
            self._led_tick()
            return
        self.handle(msg)
        while True:  # drain: append everything that's waiting, then analyse once
            try:
                self.handle(self.queue.get_nowait())
            except queue.Empty:
                break
        self._live_step()
        self._led_tick()

    def drain(self) -> None:
        """Synchronous processing of everything queued (tests / offline replay)."""
        while True:
            try:
                self.handle(self.queue.get_nowait())
            except queue.Empty:
                break
            self._live_step()

    # --------------------------------------------------------------- messages

    def handle(self, msg) -> None:
        if isinstance(msg, EventStart):
            self.ev = _Event(msg)
            self.ev.live_next = PRE_TRIGGER_FRAMES if not msg.joined_mid_event else 0
            self.ev.class_next = self.ev.live_next
        elif isinstance(msg, AudioBlock) and self.ev is not None:
            ev = self.ev
            if msg.break_before:
                ev.breaks.append(ev.frames)
            ev.blocks.append(msg.pcm)
            ev.frames += len(msg.pcm)
            if ev.background_dbfs is None and not ev.start.joined_mid_event and ev.frames >= BACKGROUND_S * FS:
                ev.background_dbfs = _dbfs(ev.audio()[: int(BACKGROUND_S * FS)])
        elif isinstance(msg, EventEnd) and self.ev is not None:
            self._finish(self.ev, msg)
            self.ev = None
        elif isinstance(msg, PipelineReset):
            if self.ev is not None:
                self.log(f"[event] dropped the event in progress ({msg.reason})")
            self.ev = None

    # ------------------------------------------------------------------- live

    def _update_speed(self) -> dict:
        c = self.climate.current()
        self.est.set_speed_of_sound(c["mps"])
        if self.tone_est is not None:
            self.tone_est.set_speed_of_sound(c["mps"])
        return c

    def tone_db(self, x: np.ndarray) -> float:
        """TEST: tone bin over the mean of its neighbours (+-150..200 Hz), mic mean, Hann window."""
        mono = x.astype(np.float64).mean(axis=1)
        spec = np.abs(np.fft.rfft((mono - mono.mean()) * np.hanning(len(mono)))) ** 2
        df = FS / len(mono)
        k = int(round(self.tone_hz / df))
        nb = [int(round((self.tone_hz + d) / df)) for d in (-200, -150, 150, 200)]
        return 10 * math.log10((spec[k - 1:k + 2].max() + 1e-12) / (np.mean(spec[nb]) + 1e-12))

    def _test_tone_step(self, window: np.ndarray, t_s: float) -> None:
        """TEST: if the test tone is present, point the LED at it (narrowband bearing)."""
        db = self.tone_db(window)
        if db < 20.0:
            return
        w = self.tone_est.analyse_window(window, t_s=t_s)
        if w.closure_samples > self.cfg["bearing"]["max_closure_samples"]:
            self.log(f"[test] tone {self.tone_hz:.0f} Hz ({db:.0f} dB) but inconsistent delays "
                     f"(closure {w.closure_samples:.2f} samples)")
            return
        self.log(f"[test] tone {self.tone_hz:.0f} Hz ({db:.0f} dB) at {w.bearing_deg:.0f} deg board frame")
        self._show(w.bearing_deg, hold=True)

    def _live_step(self) -> None:
        ev = self.ev
        if ev is None or ev.frames < max(ev.live_next, self.win):
            return
        self._update_speed()
        audio = ev.audio()
        b = self.cfg["bearing"]
        if ev.frames >= ev.live_next:
            w = self.est.analyse_window(audio[-self.win:], t_s=(ev.frames - PRE_TRIGGER_FRAMES) / FS)
            ev.live_next = ev.frames + self.win  # newest window only; skip stale audio
            if self.tone_est is not None:
                self._test_tone_step(audio[-self.win:], w.t_s)
            if BearingEstimator.accept(w, ev.background_dbfs, b["min_snr_db"], b["min_peak_ratio"],
                                       b["max_closure_samples"]):
                ev.live_windows.append(w)
        c = self.cfg["classifier"]
        if self.classifier is not None and ev.frames >= ev.class_next:
            ev.live_class = self.classifier.classify(audio[-10 * FS:])
            ev.class_next = ev.frames + int(c["live_every_s"] * FS)
            self.log(f"[class] live t={(ev.frames - PRE_TRIGGER_FRAMES) / FS:+.1f}s "
                     f"chainsaw {ev.live_class['chainsaw']:.2f} top {ev.live_class['top'][0][0]}")
        if self._eligible(ev.live_class) and len(ev.live_windows) >= b["min_windows"]:
            s = BearingEstimator.summarize(ev.live_windows, ev.live_windows[-LIVE_SUMMARY_WINDOWS:], b["min_windows"])
            if s.bearing_deg is not None:
                self._show(s.bearing_deg, hold=False)

    def _eligible(self, cls: dict | None) -> bool:
        """Should the pipeline itself drive the LED? With led.source "detections"
        (default) the SDK's detections drive it instead (show_detection)."""
        if self.cfg["led"].get("source", "detections") == "detections":
            return False
        if not self.cfg["led"]["require_chainsaw"]:
            return True
        return cls is not None and cls["chainsaw"] >= self.cfg["classifier"]["chainsaw_threshold"]

    # ------------------------------------------------------------------ final

    def _finish(self, ev: _Event, end: EventEnd) -> None:
        t0 = time.monotonic()
        audio = ev.audio()
        b = self.cfg["bearing"]
        sos = self._update_speed()
        windows = []
        bounds = [0] + sorted(set(ev.breaks) | set(end.breaks)) + [len(audio)]
        for lo, hi in zip(bounds, bounds[1:]):  # never analyse across a discontinuity
            if hi - lo >= self.win:
                windows += self.est.series(audio[lo:hi], b["window_s"], b["final_hop_s"],
                                           t0_s=(lo - PRE_TRIGGER_FRAMES) / FS)
        accepted = [w for w in windows if BearingEstimator.accept(
            w, ev.background_dbfs, b["min_snr_db"], b["min_peak_ratio"], b["max_closure_samples"])]
        summ = BearingEstimator.summarize(windows, accepted, b["min_windows"])

        cls = self.classifier.classify_event(audio) if self.classifier is not None else None
        thr = self.cfg["classifier"]["chainsaw_threshold"]
        chainsaw = cls is not None and cls["chainsaw"] >= thr  # label: classifier only

        live_s = max(0, len(audio) - PRE_TRIGGER_FRAMES) / FS
        trigger_wall = ev.start.trigger_wall or (end.t_wall - live_s)  # D7 rise, else end - live length
        event_id = f"{self.cfg['node_id']}-{time.strftime('%Y%m%dT%H%M%S', time.gmtime(trigger_wall))}-{end.seq}"
        record = {
            "node_id": self.cfg["node_id"],
            "event_id": event_id,
            "t_trigger_utc": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(trigger_wall))
            + f".{int((trigger_wall % 1) * 1000):03d}Z",
            "t_trigger_source": "notify_pin" if ev.start.trigger_wall else "end_minus_live",
            "duration_s": round(len(audio) / FS, 3),
            "pre_trigger_s": round(min(len(audio), PRE_TRIGGER_FRAMES) / FS, 3) if not ev.start.joined_mid_event else 0.0,
            "sample_rate": FS,
            "classification": None if cls is None else {
                "label": "chainsaw" if chainsaw else cls["top"][0][0],
                "score": round(cls["chainsaw"], 3),
                "machinery_score": round(cls["machinery"], 3),
                "top": [[n, round(s, 3)] for n, s in cls["top"][:5]],
            },
            "bearing": {
                "frame": "board",
                "deg": None if summ.bearing_deg is None else round(summ.bearing_deg, 1),
                "spread_deg": None if summ.spread_deg is None else round(summ.spread_deg, 1),
                "confidence": summ.confidence,
                "n_windows": summ.n_windows,
                "n_windows_total": len(windows),
                "background_dbfs": None if ev.background_dbfs is None else round(ev.background_dbfs, 1),
                "series": [[round(w.t_s, 2), w.bearing_deg] for w in accepted],
                "speed_of_sound": sos,
            },
            "integrity": {
                "seq_gaps": end.seq_gaps,
                "breaks": len(bounds) - 2,
                "overrun": bool(end.flags_seen & 0x01),
                "sync_loss": bool(end.flags_seen & 0x02),
                "joined_mid_event": ev.start.joined_mid_event,
            },
            "processing_s": None,
        }
        record["processing_s"] = round(time.monotonic() - t0, 3)
        wav = self.store.save(event_id, audio, record)
        self.records.append(record)
        cl = record["classification"]
        self.log(f"[event] {event_id}: {record['duration_s']}s, "
                 f"class {cl['label'] if cl else 'n/a'} ({cl['score'] if cl else '-'}), "
                 f"bearing {record['bearing']['deg']} deg +-{record['bearing']['spread_deg']} "
                 f"conf {summ.confidence} ({summ.n_windows}/{len(windows)} windows), "
                 f"processed in {record['processing_s']}s")
        if self.uplink is not None:  # events go to the server through the SDK; see main.py
            self.uplink.submit(record, wav)
        self.on_record(record)

        if summ.bearing_deg is not None and self._eligible(cls):  # LED: classifier + config
            self._show(summ.bearing_deg, hold=True)
        elif self.led_deg is not None and self._eligible(cls):
            self.led_clear_at = time.monotonic()  # pipeline-driven LED, nothing located: clear now

    # -------------------------------------------------------------------- LED

    def show_detection(self, deg: float) -> None:
        """Arrow toward a detected sound (board-frame deg), held for led.hold_s.
        Called by sdk_glue.DetectionBearing on the SDK's analysis thread."""
        self._show(deg, hold=True)

    def _show(self, deg: float, hold: bool) -> None:
        with self._led_lock:
            self._show_locked(deg, hold)

    def _show_locked(self, deg: float, hold: bool) -> None:
        led = self.cfg["led"]
        changed = self.led_deg is None or abs((deg - self.led_deg + 180) % 360 - 180) >= led["min_change_deg"]
        if changed:
            self.led_deg = deg
            self.display(led_arrow.to_wire(led_arrow.arrow(deg, led["rotation_deg"])))
            self.log(f"[led] arrow -> {deg:.0f} deg (board frame)")
        self.led_clear_at = time.monotonic() + led["hold_s"] if hold else None

    def _led_tick(self) -> None:
        with self._led_lock:
            self._led_tick_locked()

    def _led_tick_locked(self) -> None:
        if self.led_clear_at is not None and time.monotonic() >= self.led_clear_at:
            self.led_clear_at = None
            self.led_deg = None
            self.display("")
            self.log("[led] cleared")
