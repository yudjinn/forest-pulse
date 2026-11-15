"""Glue between the receiver/pipeline and the Forest Pulse sensor SDK (sensor-sdk/).

The SDK runs the sound model, keeps the sound list in sync with the server and
sends events (sound, confidence, time, angle - never audio). We give it:
  - the audio: SensorTee forwards every AudioBlock to sensor.feed() and every
    EventEnd to sensor.end_of_audio(), next to the pipeline queue;
  - the angle: DetectionBearing is the SDK's angle_fn. The SDK calls it only
    for windows in which it detected a sound, so it also drives the LED arrow
    ("point at what was heard").

Angles: our bearing is counter-clockwise in the board frame (soc/README.md);
the API wants degrees clockwise from the board's marked forward
(forestpulse_sensor.board_to_angle; forward = top edge by default).
"""

from __future__ import annotations

import struct
import threading
from typing import Callable

import numpy as np

from bearing import BearingEstimator, Geometry
from climate import Climate
from events import AudioBlock, EventEnd, EventStart, PipelineReset

FS = 48000
STREAM_SWITCH_S = 0.1  # between 'X' and 'C': the ESP32 takes one stream request per 20 ms block


def board_to_angle(bearing_ccw_deg: float, forward_ccw_deg: float = 90.0) -> float:
    """Same as forestpulse_sensor.board_to_angle (kept here so this module
    imports without the SDK installed)."""
    return (forward_ccw_deg - bearing_ccw_deg) % 360.0


def server_ok(status: dict | None, now: float, max_age_s: float = 30.0) -> bool:
    """Is the server reachable, from Sensor.status? A check-in succeeded within max_age_s
    (3 check-in intervals) and the key isn't rejected. No SDK (status None) = no server."""
    if not status or status.get("key_rejected"):
        return False
    last = status.get("last_checkin_ok")
    return last is not None and now - last <= max_age_s


class SensorTee:
    """Receiver sink: everything goes to the pipeline queue; audio also feeds the SDK.
    sensor.feed() only queues, so the serial reader is never blocked.

    During location calibration (set_calibrating) the SDK keeps getting every
    block, but our own pipeline is bypassed: no event bearing, WAV or LED for
    the calibration stream. After calibration ends, the bypass stays on until
    that stream's EventEnd has passed (or a new event starts), so the pipeline
    never sees half of it."""

    def __init__(self, pipeline_queue, sensor, log=print):
        self.queue = pipeline_queue
        self.sensor = sensor
        self.log = log
        self._lock = threading.Lock()
        self._bypass = False
        self._release_at_end = False
        self.mono_mic: int | None = None  # TEST: 0-based column fed to the SDK as all 3 channels while calibrating
        self.dump_dir: str | None = None  # TEST: save each calibration stream's raw audio here (.npz)
        self._dump: list | None = None

    def set_calibrating(self, on: bool) -> None:
        with self._lock:
            if on:
                if not self._bypass:
                    self.queue.put(PipelineReset("location calibration"))
                self._bypass, self._release_at_end = True, False
                if self.dump_dir:
                    self._dump = []
            elif self._bypass:
                self._release_at_end = True
            dump = None if on else self._dump
            if not on:
                self._dump = None
        if dump:
            threading.Thread(target=self._write_dump, args=(dump,), daemon=True).start()

    def _write_dump(self, dump) -> None:
        """TEST: the raw 3-mic stream (before any mono copy) with, per block, the SDK stream position after it,
        so a report's positions can be found in the audio."""
        import os
        import time
        try:
            os.makedirs(self.dump_dir, exist_ok=True)
            path = os.path.join(self.dump_dir, time.strftime("calib-%Y%m%d-%H%M%S.npz", time.gmtime()))
            np.savez_compressed(path, pcm=np.concatenate([d[0] for d in dump]),
                                blocks=np.array([(len(d[0]), d[1], d[2]) for d in dump], np.int64))
            self.log(f"[calib] TEST: saved the calibration stream to {path}")
        except Exception as e:
            self.log(f"[calib] TEST: could not save the calibration stream: {e}")

    @property
    def bypassing(self) -> bool:
        return self._bypass

    def _to_pipeline(self, msg) -> bool:
        with self._lock:
            if not self._bypass:
                return True
            if self._release_at_end:
                if isinstance(msg, EventEnd):  # the calibration stream's end: swallow it, then resume
                    self._bypass = self._release_at_end = False
                    return False
                if isinstance(msg, EventStart):  # no end seen (stream never started?): resume on a new event
                    self._bypass = self._release_at_end = False
                    return True
            return False

    def put(self, msg) -> None:
        if self._to_pipeline(msg):
            self.queue.put(msg)
        if self.sensor is None:
            return
        try:
            if isinstance(msg, AudioBlock):
                # frame_offset 0 = first packet of a new event: a new burst for the SDK
                pcm = msg.pcm
                raw = pcm
                if self.mono_mic is not None and self._bypass:  # TEST: one mic for the calibration stream
                    pcm = pcm[:, [self.mono_mic] * 3]
                brk = msg.break_before or msg.frame_offset == 0
                self.sensor.feed(pcm, break_before=brk)
                dump = self._dump
                if dump is not None:
                    st = getattr(getattr(self.sensor, "_calibration", None), "stream", None)
                    dump.append((np.array(raw, copy=True), -1 if st is None else st.total, int(brk)))
            elif isinstance(msg, EventEnd):
                self.sensor.end_of_audio()
        except Exception as e:  # never let the SDK take the reader down
            self.log(f"[sdk] feed failed: {e}")


class DetectionBearing:
    """angle_fn for the SDK: bearing of the newest `recent_s` of a detection window.

    Returns (angle_deg clockwise from forward, confidence) or None when no
    reliable bearing (same quality gate as the pipeline, without the
    background-SNR part: the SDK's window has no separate background).
    Calls on_bearing(board-frame deg) for each located detection (LED arrow).
    Runs on the SDK's analysis thread, so it has its own estimator.
    """

    def __init__(self, cfg: dict, climate: Climate, on_bearing: Callable[[float], None] | None = None,
                 recent_s: float = 2.0, log=print):
        b = cfg["bearing"]
        self.b = b
        self.est = BearingEstimator(Geometry.from_cm(cfg["mic_positions_cm"]), FS,
                                    band_hz=tuple(b["band_hz"]), c=cfg["speed_of_sound_mps"])
        self.climate = climate
        self.forward = cfg["forward_ccw_deg"]
        self.on_bearing = on_bearing or (lambda deg: None)
        self.recent = int(recent_s * FS)
        self.log = log
        self._lock = threading.Lock()

    def __call__(self, window: np.ndarray):
        with self._lock:
            self.est.set_speed_of_sound(self.climate.current()["mps"])
            seg = np.asarray(window)[-self.recent:]
            b = self.b
            ws = self.est.series(seg, b["window_s"], b["final_hop_s"])
            acc = [w for w in ws if BearingEstimator.accept(w, None, 0.0, b["min_peak_ratio"],
                                                            b["max_closure_samples"])]
            s = BearingEstimator.summarize(ws, acc, b["min_windows"])
        if s.bearing_deg is None:
            self.log(f"[sdk] detection without a reliable bearing ({len(acc)}/{len(ws)} windows)")
            return None
        angle = board_to_angle(s.bearing_deg, self.forward)
        self.log(f"[sdk] detection bearing {s.bearing_deg:.1f} deg board frame -> angle {angle:.1f} deg "
                 f"(conf {s.confidence}, {s.n_windows}/{len(ws)} windows, c={self.est.c} m/s)")
        self.on_bearing(s.bearing_deg)
        return angle, s.confidence


class CalibrationHooks:
    """Hardware side of location calibration; the SDK (forestpulse_sensor.calibration) runs it.
    Contract: sensor-sdk/README.md "Calibration hooks" and forestpulse_sensor/calibration/hooks.py
    (upstream is the source of truth). Any SDK thread may call any hook.

    send_command(c) -> bool sends a command to the ESP32 ('C' / 'X', or b'P' + a sweep for the speaker);
    notify(name, *args) is Bridge.notify (the sketch plays the sweep);
    tee is the SensorTee (bypasses our own pipeline while calibrating);
    buzzer_ok() -> bool | None: whether the sketch found the Modulino Buzzer (None = not known yet)."""

    def __init__(self, cfg: dict, climate: Climate, send_command: Callable[[str], bool],
                 notify: Callable[..., None], tee: SensorTee | None = None, log=print,
                 on_calibrating: Callable[[bool], None] | None = None,
                 buzzer_ok: Callable[[], bool | None] | None = None, sleep=None):
        c = cfg["calibration"]
        self.c = c
        self.fs = FS
        # The SDK measures arrivals as the mean over the 3 mics (the array's centre); s_i is the
        # buzzer's distance from that centre. Mic positions: board frame, as configured.
        self.emitter_offset_m = float(c["emitter_offset_cm"]) / 100.0
        self.mic_positions_m = tuple((x / 100.0, y / 100.0) for x, y in cfg["mic_positions_cm"])
        self.forward_ccw_deg = float(cfg["forward_ccw_deg"])
        self.geometry = Geometry.from_cm(cfg["mic_positions_cm"])
        self.climate = climate
        self.send_command = send_command
        self.notify = notify
        self.tee = tee
        # a run's continuous stream is on: between a successful start_stream() and the next stop_stream(), whether
        # or not that stop reached the ESP32
        self.streaming = False
        self.log = log
        self.on_calibrating = on_calibrating or (lambda on: None)
        self.buzzer_ok = buzzer_ok or (lambda: None)
        self._sleep = sleep or __import__("time").sleep
        self._est: dict = {}  # (lo, hi) -> BearingEstimator
        self._lock = threading.Lock()

    # ---- stream control ----------------------------------------------------------

    def start_stream(self) -> bool:
        """Continuous streaming. The firmware ignores 'C' while a triggered recording runs, so end it
        first with 'X' (which also ends a normal recording), then start."""
        if self.tee is not None:
            self.tee.set_calibrating(True)
        ok = bool(self.send_command("X"))
        if ok:
            self._sleep(STREAM_SWITCH_S)
            ok = bool(self.send_command("C"))
        self.streaming = ok
        self.log(f"[calib] continuous stream {'started' if ok else 'NOT started (ESP32 not connected)'}")
        if not ok and self.tee is not None:
            self.tee.set_calibrating(False)
        self.on_calibrating(ok)
        return ok

    def stop_stream(self) -> None:
        self.streaming = False
        if not self.send_command("X"):
            # the reader sends X again when it reconnects, so the ESP32 never stays in continuous mode
            self.log("[calib] could not send X to stop the continuous stream (ESP32 not connected)")
        if self.tee is not None:
            self.tee.set_calibrating(False)
        self.on_calibrating(False)
        self.log("[calib] continuous stream stopped")

    # ---- emitter ---------------------------------------------------------------

    def emit(self, f_start_hz, f_mid_hz, f_end_hz, duration_ms) -> bool:
        """Play one sweep now. False when the sketch reported no buzzer; raises on bad values."""
        args = [int(round(float(v))) for v in (f_start_hz, f_mid_hz, f_end_hz, duration_ms)]
        if not all(0 < f <= 20000 for f in args[:3]) or not 0 < args[3] <= 1000:
            raise ValueError(f"emit: bad sweep {args}")
        if self.c.get("emitter") == "speaker":
            # 'P' + f_start, f_mid, f_end, ms (uint16 LE) + volume: the ESP32 plays it on the mics' clock
            volume = max(0, min(255, int(self.c.get("speaker_volume", 96))))
            if not self.send_command(b"P" + struct.pack("<HHHHB", *args, volume)):
                self.log("[calib] emit: ESP32 not connected")
                return False
            self.log(f"[calib] emit {args[0]}->{args[1]}->{args[2]} Hz, {args[3]} ms on the speaker (volume {volume})")
            return True
        if self.buzzer_ok() is False:
            self.log("[calib] emit: no Modulino Buzzer")
            return False
        self.notify("emit", *args)
        self.log(f"[calib] emit {args[0]}->{args[1]}->{args[2]} Hz, {args[3]} ms")
        return True

    # ---- physics / direction -------------------------------------------------------

    def speed_of_sound(self) -> float:
        return float(self.climate.current()["mps"])

    def _estimator(self, band_hz) -> BearingEstimator:
        key = (float(band_hz[0]), float(band_hz[1]))
        est = self._est.get(key)
        if est is None:
            est = self._est[key] = BearingEstimator(self.geometry, FS, nfft=int(self.c["nfft"]), band_hz=key,
                                                    c=self.speed_of_sound())
        return est

    def bearing(self, window, band_hz=None):
        if self.tee is not None and self.tee.mono_mic is not None:
            # one mic copied to all 3 channels: no direction to tell. The service then calibrates the distance only
            # and keeps the facings set on the plan (a faked bearing would overwrite them).
            return None
        fake = self.c.get("test_fake_bearing_deg")
        if fake is not None:  # TEST: see config.py
            return float(fake) % 360.0, 1.0
        return self._bearing(window, band_hz)

    def _bearing(self, window, band_hz=None):
        """(angle_deg clockwise from forward, quality 0..1) of the one arrival in `window`, or None.
        A window shorter than one FFT frame is centred in it (a short burst at the edge of a Hann window would be lost)."""
        x = np.asarray(window)
        if x.ndim != 2 or x.shape[1] != 3 or len(x) < 64:
            return None
        n = int(self.c["nfft"])
        if len(x) < n:
            pad = n - len(x)
            x = np.pad(x.astype(np.float64) - x.mean(axis=0), ((pad // 2, pad - pad // 2), (0, 0)))
        with self._lock:
            est = self._estimator(band_hz or self.c["band_hz"])
            est.set_speed_of_sound(self.speed_of_sound())
            w = est.analyse_window(x)
        min_pr, max_cl = float(self.c["min_peak_ratio"]), float(self.c["max_closure_samples"])
        if w.peak_ratio < min_pr or w.closure_samples > max_cl:
            self.log(f"[calib] no reliable bearing (peak ratio {w.peak_ratio:.1f}, closure {w.closure_samples:.2f})")
            return None
        # sharper SRP peak and more consistent pair delays -> higher quality
        q = min(1.0, w.peak_ratio / (3 * min_pr)) * (1.0 - 0.5 * w.closure_samples / max_cl)
        angle = board_to_angle(w.bearing_deg, self.forward_ccw_deg)
        self.log(f"[calib] arrival bearing {w.bearing_deg:.0f} deg board frame -> angle {angle:.0f} deg (q {q:.2f})")
        return angle, round(q, 3)
