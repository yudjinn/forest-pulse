"""Calibration sweeps: what each role's buzzer plays, as data, and the waveform it produces.

A pattern is (f_start_hz, f_mid_hz, f_end_hz, duration_ms). The buzzer plays a square wave whose frequency steps
every 1 ms, moving linearly from f_start to f_mid over the first half and from f_mid to f_end over the second.
The service sends the patterns with each run, so they can be retuned without changing the boards.
"""
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

STEP_MS = 1.0


@dataclass(frozen=True)
class Pattern:
    f_start_hz: float
    f_mid_hz: float
    f_end_hz: float
    duration_ms: float

    @classmethod
    def of(cls, value) -> "Pattern":
        """A Pattern from a Pattern, a 4-item sequence, or a mapping with the field names."""
        if isinstance(value, Pattern):
            return value
        if isinstance(value, Mapping):
            return cls(*(float(value[k]) for k in ("f_start_hz", "f_mid_hz", "f_end_hz", "duration_ms")))
        if isinstance(value, Sequence) and not isinstance(value, str) and len(value) == 4:
            return cls(*(float(v) for v in value))
        raise ValueError(f"not a sweep pattern: {value!r}")

    @property
    def band_hz(self) -> tuple[float, float]:
        freqs = (self.f_start_hz, self.f_mid_hz, self.f_end_hz)
        return min(freqs), max(freqs)

    def emit_args(self) -> tuple[float, float, float, float]:
        """The arguments of the node's emit hook, in order."""
        return self.f_start_hz, self.f_mid_hz, self.f_end_hz, self.duration_ms


DEFAULT_PATTERNS = {
    "A": Pattern(1500, 2500, 3500, 120),  # rises
    "B": Pattern(3500, 2500, 1500, 120),  # falls
    "C": Pattern(1500, 3500, 1500, 120),  # rises then falls
}


def parse_patterns(value) -> dict[str, Pattern]:
    """Role -> Pattern from a mapping whose values are anything Pattern.of() accepts."""
    if not isinstance(value, Mapping) or not value:
        raise ValueError("patterns must be a non-empty mapping of role to pattern")
    return {str(role): Pattern.of(p) for role, p in value.items()}


@lru_cache(maxsize=32)
def sweep(pattern: Pattern, fs: int) -> np.ndarray:
    """The stepped square-wave sweep at sample rate fs, amplitude 1, as float64.

    Phase-continuous across steps and synthesised from its odd harmonics below 0.45 fs, so it has no aliasing and
    can be shifted by a fraction of a sample. Treat the returned array as read-only (it is cached)."""
    n = int(round(pattern.duration_ms * fs / 1000))
    steps = max(1, int(round(pattern.duration_ms / STEP_MS)))
    step_of_sample = np.minimum((np.arange(n) * steps) // n, steps - 1)
    # frequency of each step, taken at the step's centre along the two linear legs
    u = (np.arange(steps) + 0.5) / steps
    f_step = np.where(u < 0.5,
                      pattern.f_start_hz + (pattern.f_mid_hz - pattern.f_start_hz) * (u / 0.5),
                      pattern.f_mid_hz + (pattern.f_end_hz - pattern.f_mid_hz) * ((u - 0.5) / 0.5))
    f = f_step[step_of_sample]
    phase = 2 * np.pi * np.concatenate(([0.0], np.cumsum(f[:-1]))) / fs
    out = np.zeros(n)
    k = 1
    while True:
        audible = k * f < 0.45 * fs
        if not audible.any():
            break
        out += np.where(audible, np.sin(k * phase) / k, 0.0)
        k += 2
    out *= 4 / np.pi
    out.setflags(write=False)
    return out
