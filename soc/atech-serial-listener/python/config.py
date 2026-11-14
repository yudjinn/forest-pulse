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
