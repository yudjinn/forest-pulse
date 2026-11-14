"""Byte stream -> events. Runs in the reader thread and must never block.

Receiver.feed(bytes) parses packets (atech_protocol), follows the
pre-trigger / live / end sequence, prints a per-second console summary, and
pushes EventStart / AudioBlock / EventEnd messages to `sink` (a queue.Queue
drained by the Pipeline worker). ASCII reply lines (INFO ..., RAW ...) go to
`on_text`.
"""

from __future__ import annotations

import math
import time
from typing import Callable

import numpy as np

from atech_protocol import EVENT_END, FLAG_RING_OVERRUN, FLAG_SYNC_LOSS, LIVE, PRE_TRIGGER, StreamParser
from events import PRE_TRIGGER_FRAMES, AudioBlock, EventEnd, EventStart


def _dbfs(peak: int) -> str:
    return "  -inf" if peak <= 0 else f"{20 * math.log10(peak / 32768):6.1f}"


class Receiver:
    def __init__(
        self,
        sink,
        on_text: Callable[[str], None] | None = None,
        log: Callable[[str], None] = lambda s: print(s, flush=True),
        trigger_rise: Callable[[], float | None] | None = None,
    ):
        """trigger_rise: returns time.time() of an unused notify-line rise (and
        marks it used), or None. Lets events carry the precise trigger time."""
        self.sink = sink
        self.on_text = on_text or (lambda s: None)
        self.log = log
        self.trigger_rise = trigger_rise or (lambda: None)
        self.parser = StreamParser()
        self.last_seq = None
        self.in_event = False
        self._reset()

    def _reset(self):
        self.frames = 0
        self.packets = 0
        self.breaks: list[int] = []
        self.flags_seen = 0
        self.seq_gaps = 0
        self.peaks = [0, 0, 0]
        self.win_peaks = [0, 0, 0]
        self.win_start = 0
        self.rate = 48000
        self.last_type = None

    # ------------------------------------------------------------------ input

    def feed(self, data: bytes) -> None:
        for kind, item in self.parser.feed(data):
            if kind == "packet":
                self._on_packet(item)
            else:
                self.on_text(item)

    def _on_packet(self, p) -> None:
        brk = False
        if self.last_seq is not None and p.seq_num != (self.last_seq + 1) & 0xFFFFFFFF:
            brk = True
            missing = (p.seq_num - self.last_seq - 1) & 0xFFFFFFFF
            if self.in_event:
                self.seq_gaps += 1
                self.log(f"[atech] seq gap: {missing} packet(s) missing before #{p.seq_num}")
        if p.flags:
            brk = True
            self.flags_seen |= p.flags
            what = [n for f, n in ((FLAG_RING_OVERRUN, "ring overrun"), (FLAG_SYNC_LOSS, "capture sync loss")) if p.flags & f]
            self.log(f"[atech] packet #{p.seq_num}: {', '.join(what) or hex(p.flags)}")
        self.last_seq = p.seq_num

        if p.msg_type == EVENT_END:
            if self.in_event:
                self._end(p)
            return
        if not self.in_event:
            self._start(p)
        elif brk:
            self.breaks.append(self.frames)
        if p.msg_type == LIVE and self.last_type == PRE_TRIGGER and self.frames > self.win_start:
            self._print_window()  # close the pre-trigger window at the trigger
        self.last_type = p.msg_type

        pcm = np.frombuffer(p.pcm, dtype="<i2").reshape(-1, 3)
        self.sink.put(AudioBlock(pcm, self.frames, p.msg_type == LIVE, brk and self.packets > 0))
        if len(pcm):
            pk = np.abs(pcm.astype(np.int32)).max(axis=0)
            self.win_peaks = [max(a, int(b)) for a, b in zip(self.win_peaks, pk)]
            self.peaks = [max(a, int(b)) for a, b in zip(self.peaks, pk)]
        self.frames += p.frame_count
        self.packets += 1
        self.rate = p.sample_rate or self.rate
        if self.frames - self.win_start >= self.rate:
            self._print_window()

    # ---------------------------------------------------------------- events

    def _t(self, frame: int) -> float:
        return (frame - PRE_TRIGGER_FRAMES) / self.rate

    def _print_window(self):
        phase = "pre " if self.last_type == PRE_TRIGGER else "live"
        a, b, c = (_dbfs(x) for x in self.win_peaks)
        self.log(f"[atech] {phase} t={self._t(self.win_start):+6.2f}..{self._t(self.frames):+6.2f}s "
                 f"peak dBFS mic1 {a} mic2 {b} mic3 {c}")
        self.win_peaks = [0, 0, 0]
        self.win_start = self.frames

    def _start(self, p):
        self._reset()
        self.in_event = True
        joined = p.msg_type != PRE_TRIGGER
        rise = self.trigger_rise()
        self.sink.put(EventStart(p.seq_num, time.time(), joined, rise))
        extra = " (joined mid-event, live audio only)" if joined else ""
        if rise is not None:
            extra += f", D7 rose {time.time() - rise:.3f}s before first packet"
        self.log(f"[atech] === event start, packet #{p.seq_num}{extra}")

    def _end(self, p):
        if self.frames > self.win_start:
            self._print_window()
        live_s = max(0, self.frames - PRE_TRIGGER_FRAMES) / self.rate
        a, b, c = (_dbfs(x) for x in self.peaks)
        self.log(f"[atech] === event end, packet #{p.seq_num}: {self.packets} packets, {self.frames} frames "
                 f"({self.frames / self.rate:.2f}s, {live_s:.2f}s after trigger), {len(self.breaks)} break(s), "
                 f"peak dBFS mic1 {a} mic2 {b} mic3 {c}")
        self.sink.put(EventEnd(p.seq_num, time.time(), self.frames, list(self.breaks), self.flags_seen, self.seq_gaps))
        self.in_event = False
