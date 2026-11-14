"""Node configuration: python/config.json merged over defaults.

Environment overrides: ATECH_CONFIG (path to a JSON file), ATECH_DATA_DIR.
"""

from __future__ import annotations

import copy
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULTS = {
    "node_id": "node-01",
    "data_dir": None,  # default: <app>/data (next to python/)
    "keep_events": 50,
    "mic_positions_cm": [[-4.0, 0.0], [0.0, 0.0], [0.0, -6.0]],
    "speed_of_sound_mps": 343.0,
    "test_tone_hz": 0,  # TEST: LED arrow for a pure tone at this frequency (match FE_TEST_TONE_HZ); 0 = off
    "forward_ccw_deg": 90.0,  # board's marked forward in the board frame (90 = top edge, away from mic3)
    "bearing": {"window_s": 0.5, "final_hop_s": 0.25, "min_snr_db": 0.0, "min_windows": 3, "min_peak_ratio": 3.0,
                "max_closure_samples": 1.0, "band_hz": [200, 8000]},
    "classifier": {"model": "models/mn10_as.onnx", "chainsaw_threshold": 0.2, "live_every_s": 2.0},
    "led": {"source": "detections", "rotation_deg": 0, "hold_s": 10.0, "min_change_deg": 5.0, "require_chainsaw": False},
    # LED matrix when no arrow shows (matrix_display.py): scroll temperature, humidity and the
    # server icon, then the live sound meter (ESP32 INFO polled every level_poll_s).
    "matrix": {"ticker": True, "scroll_ms": 120, "meter_s": 6.0, "level_poll_s": 0.25},
    # ESP32 trigger thresholds (trigger_settings.py); null = firmware default (menuconfig).
    # The server can change them through the check-in reply. Lower = more sensitive.
    "trigger": {"snr_db": None, "ratio_db": None, "coherence": None},
    # Location calibration (LocationCalibrationIntegrationSpec.md): the SDK runs it, we provide the hooks.
    "calibration": {"emitter_offset_cm": 3.0,       # s_i: buzzer to array centre (ruler)
                    "band_hz": [1000, 4000],        # default bearing band when the SDK gives none
                    "nfft": 2048,                   # bearing of one short arrival (~43 ms)
                    "min_peak_ratio": 3.0, "max_closure_samples": 1.0,
                    # the shared calibration sweep (every node plays the same; the server's "sweep" overrides)
                    "sweep": [1500, 2500, 3500, 300],       # f_start, f_mid, f_end (Hz), ms: rising 1.5 -> 3.5 kHz
                    "test_beep_every_s": 0},                # TEST: play the sweep periodically (0 = off)
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load(path: str | None = None) -> dict:
    path = path or os.environ.get("ATECH_CONFIG") or os.path.join(HERE, "config.json")
    cfg = DEFAULTS
    if os.path.exists(path):
        with open(path) as f:
            cfg = _merge(DEFAULTS, json.load(f))
    cfg = copy.deepcopy(cfg)
    cfg["data_dir"] = os.environ.get("ATECH_DATA_DIR") or cfg["data_dir"] or os.path.join(HERE, "..", "data")
    model = cfg["classifier"]["model"]
    if model and not os.path.isabs(model):
        cfg["classifier"]["model"] = os.path.join(HERE, model)
    return cfg
