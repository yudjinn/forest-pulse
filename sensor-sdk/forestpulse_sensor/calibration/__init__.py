"""Acoustic self-calibration: the sweeps each role plays, finding them in a 3-mic recording, and the stage check."""
from .detect import BOARD_MICS_M, Detection, find_beeps, max_offset_samples
from .patterns import DEFAULT_PATTERNS, Pattern, parse_patterns, sweep

__all__ = ["BOARD_MICS_M", "DEFAULT_PATTERNS", "Detection", "Pattern", "find_beeps", "max_offset_samples",
           "parse_patterns", "sweep"]
