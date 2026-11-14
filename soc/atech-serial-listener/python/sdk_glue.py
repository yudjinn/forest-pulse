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

import threading
from typing import Callable

import numpy as np

from bearing import BearingEstimator, Geometry
from climate import Climate
from events import AudioBlock, EventEnd

FS = 48000


def board_to_angle(bearing_ccw_deg: float, forward_ccw_deg: float = 90.0) -> float:
    """Same as forestpulse_sensor.board_to_angle (kept here so this module
    imports without the SDK installed)."""
    return (forward_ccw_deg - bearing_ccw_deg) % 360.0


class SensorTee:
    """Receiver sink: everything goes to the pipeline queue; audio also feeds the SDK.
    sensor.feed() only queues, so the serial reader is never blocked."""

    def __init__(self, pipeline_queue, sensor, log=print):
        self.queue = pipeline_queue
        self.sensor = sensor
        self.log = log

    def put(self, msg) -> None:
        self.queue.put(msg)
        if self.sensor is None:
            return
        try:
            if isinstance(msg, AudioBlock):
                # frame_offset 0 = first packet of a new event: a new burst for the SDK
                self.sensor.feed(msg.pcm, break_before=msg.break_before or msg.frame_offset == 0)
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
