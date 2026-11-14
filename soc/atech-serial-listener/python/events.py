"""Messages from the reader thread (Receiver) to the worker thread (Pipeline)."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

PRE_TRIGGER_FRAMES = 192_000  # every event starts with exactly 4 s of pre-trigger audio


@dataclass
class EventStart:
    seq: int                 # first packet's seq_num
    t_wall: float            # time.time() when the first packet arrived
    joined_mid_event: bool   # first packet was LIVE (we missed the pre-trigger part)
    trigger_wall: float | None = None  # time.time() of the notify-line (D7) rise, if seen


@dataclass
class AudioBlock:
    pcm: np.ndarray          # (n, 3) int16
    frame_offset: int        # index of the first frame within the event
    live: bool               # False = pre-trigger
    break_before: bool       # discontinuity before this block (seq gap / flag)


@dataclass
class EventEnd:
    seq: int
    t_wall: float
    frames: int
    breaks: list[int] = field(default_factory=list)  # frame offsets where audio is discontinuous
    flags_seen: int = 0      # OR of all packet flags in the event
    seq_gaps: int = 0
