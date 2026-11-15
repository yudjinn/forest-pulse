"""ESP32 trigger thresholds, adjustable at runtime (from config; current() is the SDK's trigger health hook).

The ESP32 boots with its compiled-in defaults (menuconfig) and keeps no state,
so this module owns the desired values and re-sends them whenever the ESP32
(re)connects or resets (= whenever an INFO line arrives whose values differ).

Settings (all optional; None / absent = the firmware's compiled-in default):
    snr_db     level gate: block RMS above the adaptive noise floor by more than this, 0..40 dB
    ratio_db   spectral gate: band energy (100-400 Hz + 1-3 kHz) over wind energy, -30..30 dB
    coherence  coherence gate: inter-mic agreement over 1-3 kHz, 0..0.99 (0 = gate off)
Lower = more sensitive (more events, more false triggers).

Wire format (mcu/main/stream.c): b"G" + id (b"S" / b"R" / b"C") + int16 LE of value x 100.
The ESP32 answers "SET ok|err id=.. value=.. snr_db=.. ratio_db=.. coherence=.." and its INFO
line carries trig_snr_db= trig_ratio_db= trig_coherence= plus the defaults (trig_default_*).

Plain Python (no App Lab imports): tested in soc/dev/tests/test_trigger_settings.py.
"""

from __future__ import annotations

import re
import struct
import threading
from typing import Callable

# name -> (wire id, min, max)
PARAMS = {
    "snr_db": (b"S", 0.0, 40.0),
    "ratio_db": (b"R", -30.0, 30.0),
    "coherence": (b"C", 0.0, 0.99),
}
_INFO_KEYS = {"trig_snr_db": "snr_db", "trig_ratio_db": "ratio_db", "trig_coherence": "coherence"}
_DEFAULT_KEYS = {"trig_default_snr_db": "snr_db", "trig_default_ratio_db": "ratio_db",
                 "trig_default_coherence": "coherence"}
_SET_KEYS = {"snr_db": "snr_db", "ratio_db": "ratio_db", "coherence": "coherence"}
_KV = re.compile(r"(\w+)=(-?[\d.]+)")


def encode(name: str, value: float) -> bytes:
    wid, lo, hi = PARAMS[name]
    v = float(value)
    if not lo <= v <= hi:
        raise ValueError(f"{name}={v} out of range {lo}..{hi}")
    return b"G" + wid + struct.pack("<h", int(round(v * 100)))


class TriggerSettings:
    def __init__(self, send: Callable[[bytes], bool], initial: dict | None = None, log=print):
        """send(bytes) -> bool writes to the ESP32 (False if not connected).
        initial: config.json "trigger" block; None values = firmware default."""
        self.send = send
        self.log = log
        self._lock = threading.Lock()
        self._desired: dict[str, float] = {}
        self._device: dict[str, float] = {}  # last values the ESP32 reported (INFO / SET)
        self._defaults: dict[str, float] = {}  # the firmware's compiled-in values (INFO)
        self.update(initial or {}, source="config", apply=False)

    # ---- desired values -------------------------------------------------------------

    def update(self, settings: dict, source: str = "server", apply: bool = True) -> dict:
        """Merge new desired values: unknown keys are ignored, invalid values rejected and logged,
        None puts a value back to the firmware default. Returns the desired set."""
        changed = False
        with self._lock:
            for name, v in (settings or {}).items():
                if name not in PARAMS:
                    continue
                if v is None:
                    changed |= self._desired.pop(name, None) is not None
                    continue
                try:
                    encode(name, v)  # range check
                except (ValueError, TypeError) as e:
                    self.log(f"[trigger] ignoring {source} setting: {e}")
                    continue
                if self._desired.get(name) != float(v):
                    self._desired[name] = float(v)
                    changed = True
            desired = dict(self._desired)
        if changed:
            self.log(f"[trigger] desired settings ({source}): {desired or 'firmware defaults'}")
            if apply:
                self.apply()
        return desired

    def desired(self) -> dict:
        with self._lock:
            return dict(self._desired)

    def current(self) -> dict | None:
        """What the ESP32 last confirmed (for the check-in), or None before the first report."""
        with self._lock:
            return dict(self._device) if self._device else None

    # ---- device side ----------------------------------------------------------------

    def _target(self) -> dict:
        """Desired values, with the firmware default for anything not set (once known)."""
        return {**self._defaults, **self._desired}

    def apply(self) -> bool:
        """Send every target value that differs from what the ESP32 reported."""
        with self._lock:
            todo = {k: v for k, v in self._target().items()
                    if k not in self._device or abs(self._device[k] - v) > 0.005}
        ok = True
        for name, v in todo.items():
            ok &= bool(self.send(encode(name, v)))
        return ok

    def on_text(self, line: str) -> None:
        """Feed every text line from the ESP32 (INFO / SET)."""
        if line.startswith("INFO"):
            kv = _KV.findall(line)
            vals = {_INFO_KEYS[k]: float(v) for k, v in kv if k in _INFO_KEYS}
            if not vals:
                return  # older firmware: thresholds not adjustable
            with self._lock:
                first = not self._device
                self._device.update(vals)
                self._defaults.update({_DEFAULT_KEYS[k]: float(v) for k, v in kv if k in _DEFAULT_KEYS})
            if first:
                self.log(f"[trigger] ESP32 thresholds: {vals}")
            self.apply()  # after a (re)connect or ESP32 reset: re-send what differs
        elif line.startswith("SET"):
            vals = {_SET_KEYS[k]: float(v) for k, v in _KV.findall(line) if k in _SET_KEYS}
            with self._lock:
                self._device.update(vals)
            if line.startswith("SET ok"):
                self.log(f"[trigger] ESP32 thresholds now {vals}")
            else:
                self.log(f"[trigger] ESP32 rejected a setting: {line.strip()}")
