"""Acoustic self-calibration: the sweeps each role plays, finding them in a 3-mic recording, the stage check, the
node's hooks and their self-check (hooks.py), taking part in a run (run.py) and a simulated stage (simulate.py)."""
from .detect import BOARD_MICS_M, Detection, find_beeps, max_offset_samples
from .patterns import DEFAULT_PATTERNS, Pattern, parse_patterns, sweep

__all__ = ["BOARD_MICS_M", "DEFAULT_PATTERNS", "Detection", "Pattern", "find_beeps", "max_offset_samples",
           "parse_patterns", "sweep"]
