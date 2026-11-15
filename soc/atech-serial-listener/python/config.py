"""Node configuration: python/config.json merged over defaults, then python/config.local.json (if present).

config.local.json is per-board and git-ignored; scripts/deploy-nodes.py never sends or overwrites it, so
board-specific or test settings put there survive redeploys.
Environment overrides: ATECH_CONFIG (path to a JSON file), ATECH_CONFIG_LOCAL, ATECH_DATA_DIR.
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
    "mic_positions_cm": [[-4.0, 0.0], [0.0, 0.0], [0.0, -8.0]],
    "speed_of_sound_mps": 343.0,
    "test_tone_hz": 0,  # TEST: LED arrow for a pure tone at this frequency (match FE_TEST_TONE_HZ); 0 = off
    "forward_ccw_deg": 90.0,  # board's marked forward in the board frame (90 = top edge, away from mic3)
    # detections: send each detection's direction to the server; false on a board with fewer than 3 mics fitted,
    # whose directions would be noise and put sounds in the wrong place on the plan.
    "bearing": {"detections": True, "window_s": 0.5, "final_hop_s": 0.25, "min_snr_db": 0.0, "min_windows": 3, "min_peak_ratio": 3.0,
                "max_closure_samples": 1.0, "band_hz": [200, 8000]},
    "classifier": {"model": "models/mn10_as.onnx", "chainsaw_threshold": 0.2, "live_every_s": 2.0},
    "led": {"source": "detections", "rotation_deg": 0, "hold_s": 10.0, "min_change_deg": 5.0, "require_chainsaw": False},
    # LED matrix when no arrow shows (matrix_display.py): scroll temperature, humidity and the
    # server icon, then the live sound meter (ESP32 INFO polled every level_poll_s).
    "matrix": {"ticker": True, "scroll_ms": 120, "meter_s": 6.0, "level_poll_s": 0.25},
    # ESP32 trigger thresholds (trigger_settings.py); null = firmware default (menuconfig).
    # The SDK reports them at each check-in (read-only on the plan card). Lower = more sensitive.
    "trigger": {"snr_db": None, "ratio_db": None, "coherence": None},
    # Location calibration (LocationCalibrationIntegrationSpec.md): the SDK runs it, we provide the hooks.
    "calibration": {"emitter": "buzzer",            # "buzzer": the sketch's Modulino Buzzer; "speaker": the
                    # ATech Speaker module on the ESP32 (ports 3-4), played on the mics' own clock
                    "speaker_volume": 96,           # 0..255; the mics clip on their own beep when too loud
                    "emitter_offset_cm": 3.0,       # s_i: buzzer to the mic array's centre (ruler)
                    "band_hz": [1000, 4000],        # default bearing band when the SDK gives none
                    "nfft": 2048,                   # bearing of one short arrival (the SDK gives 40 ms)
                    # gates for that one arrival: on the SDK's 40 ms windows of its sweeps these keep 96 %
                    # of bearings, worst accepted error ~12 deg (soc/dev/tests/test_calibration.py)
                    "min_peak_ratio": 2.5, "max_closure_samples": 1.5,
                    # TEST only: play test_beep every test_beep_every_s (0 = off). In a calibration run the
                    # service sends each role's sweep; this is the SDK's role A sweep (rising 1.5 -> 3.5 kHz).
                    "test_beep": [1500, 2500, 3500, 120],   # f_start, f_mid, f_end (Hz), ms
                    "test_beep_every_s": 0,
                    # TEST only (put them in config.local.json on one board): fake this node's bearing of every
                    # other node's beep (degrees clockwise from forward, quality 1), and feed the SDK one mic
                    # copied into all 3 channels during calibration (1-based: 2 = mic2) so the SDK's mean of the
                    # 3 mics' arrival times is that mic's. Works for a 2-node run; a 3-node run fails its
                    # angle check with faked bearings.
                    "test_fake_bearing_deg": None,
                    "test_mono_mic": None,
                    # TEST only: save every calibration stream's raw 3-mic audio to <data_dir>/calibration/
                    "test_dump_calibration": False},
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
    local = os.environ.get("ATECH_CONFIG_LOCAL") or os.path.join(os.path.dirname(os.path.abspath(path)),
                                                                   "config.local.json")
    if os.path.exists(local):
        with open(local) as f:
            cfg = _merge(cfg, json.load(f))
        cfg["_local"] = local
    cfg = copy.deepcopy(cfg)
    cfg["data_dir"] = os.environ.get("ATECH_DATA_DIR") or cfg["data_dir"] or os.path.join(HERE, "..", "data")
    model = cfg["classifier"]["model"]
    if model and not os.path.isabs(model):
        cfg["classifier"]["model"] = os.path.join(HERE, model)
    return cfg
