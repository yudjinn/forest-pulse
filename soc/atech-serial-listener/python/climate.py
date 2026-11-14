"""Speed of sound from the Modulino Thermo (temperature + humidity).

The sketch reads the Modulino Thermo on the Uno Q's Qwiic bus and reports
Bridge.notify("climate", temp_c, rh_percent) every few seconds. Without a
fresh, plausible reading the default 343 m/s (~20 C dry air) is used.

    c = 331.3 + 0.606 * T + 0.0124 * RH      (T in C, RH in %)

Temperature dominates (0.6 m/s per C = 0.18 %/C); humidity adds at most
~1.2 m/s. A 10 C error shifts bearings by up to ~2 deg near end-fire.
"""

from __future__ import annotations

import threading
import time

DEFAULT_SPEED = 343.0
STALE_S = 60.0


def speed_of_sound(temp_c: float, rh_percent: float = 0.0) -> float:
    return 331.3 + 0.606 * temp_c + 0.0124 * rh_percent


class Climate:
    def __init__(self, default: float = DEFAULT_SPEED, stale_s: float = STALE_S, clock=time.monotonic):
        self.default = default
        self.stale_s = stale_s
        self.clock = clock
        self._lock = threading.Lock()
        self._t = self._rh = self._at = None

    def update(self, temp_c, rh_percent) -> None:
        """Called from the Bridge callback (any thread). Ignores implausible values."""
        try:
            t, rh = float(temp_c), float(rh_percent)
        except (TypeError, ValueError):
            return
        if not (-40.0 <= t <= 70.0 and 0.0 <= rh <= 100.0):
            return
        with self._lock:
            self._t, self._rh, self._at = t, rh, self.clock()

    def current(self) -> dict:
        """{"mps", "source", "temp_c", "rh"}; source "modulino" or "default"."""
        with self._lock:
            fresh = self._at is not None and self.clock() - self._at <= self.stale_s
            if fresh:
                return {"mps": round(speed_of_sound(self._t, self._rh), 2), "source": "modulino",
                        "temp_c": round(self._t, 2), "rh": round(self._rh, 1)}
        return {"mps": self.default, "source": "default", "temp_c": None, "rh": None}
