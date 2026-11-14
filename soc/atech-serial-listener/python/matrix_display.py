"""What the Uno Q's 8 x 13 LED matrix shows, frame by frame.

Priority, highest first:
  1. the direction arrow (set_arrow, from the pipeline; "" clears it);
  2. "CAL" while a location calibration runs (set_calibrating);
  3. the ticker: one scroll of e.g. "25.7°C 45% <cloud>" (temperature, humidity,
     server icon: cloud with a check = connected, with an X = not), then the
     live sound meter for meter_s, repeat. Parts without data are left out.

Rendering lives here (like led_arrow.py) so it is testable and previewable on
a laptop (python matrix_display.py); the sketch only draws the 104-char
'0'/'1' frames it receives. Frames are only sent when they change.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable

ROWS, COLS = 8, 13
BLANK = [0] * ROWS  # one empty column

# 3 x 5 font (rows top to bottom); drawn on rows 1-5 of the matrix.
_FONT_ROWS = {
    "0": ["###", "#.#", "#.#", "#.#", "###"],
    "1": [".#.", "##.", ".#.", ".#.", "###"],
    "2": ["###", "..#", "###", "#..", "###"],
    "3": ["###", "..#", ".##", "..#", "###"],
    "4": ["#.#", "#.#", "###", "..#", "..#"],
    "5": ["###", "#..", "###", "..#", "###"],
    "6": ["###", "#..", "###", "#.#", "###"],
    "7": ["###", "..#", ".#.", ".#.", ".#."],
    "8": ["###", "#.#", "###", "#.#", "###"],
    "9": ["###", "#.#", "###", "..#", "###"],
    "A": [".#.", "#.#", "###", "#.#", "#.#"],
    "B": ["##.", "#.#", "##.", "#.#", "##."],
    "C": [".##", "#..", "#..", "#..", ".##"],
    "D": ["##.", "#.#", "#.#", "#.#", "##."],
    "E": ["###", "#..", "##.", "#..", "###"],
    "F": ["###", "#..", "##.", "#..", "#.."],
    "G": [".##", "#..", "#.#", "#.#", ".##"],
    "H": ["#.#", "#.#", "###", "#.#", "#.#"],
    "I": ["###", ".#.", ".#.", ".#.", "###"],
    "J": ["..#", "..#", "..#", "#.#", ".#."],
    "K": ["#.#", "#.#", "##.", "#.#", "#.#"],
    "L": ["#..", "#..", "#..", "#..", "###"],
    "M": ["#.#", "###", "###", "#.#", "#.#"],
    "N": ["##.", "#.#", "#.#", "#.#", "#.#"],
    "O": [".#.", "#.#", "#.#", "#.#", ".#."],
    "P": ["##.", "#.#", "##.", "#..", "#.."],
    "Q": [".#.", "#.#", "#.#", "##.", ".##"],
    "R": ["##.", "#.#", "##.", "#.#", "#.#"],
    "S": [".##", "#..", ".#.", "..#", "##."],
    "T": ["###", ".#.", ".#.", ".#.", ".#."],
    "U": ["#.#", "#.#", "#.#", "#.#", "###"],
    "V": ["#.#", "#.#", "#.#", "#.#", ".#."],
    "W": ["#.#", "#.#", "###", "###", "#.#"],
    "X": ["#.#", "#.#", ".#.", "#.#", "#.#"],
    "Y": ["#.#", "#.#", ".#.", ".#.", ".#."],
    "Z": ["###", "..#", ".#.", "#..", "###"],
    ".": [".", ".", ".", ".", "#"],
    "-": ["...", "...", "###", "...", "..."],
    "%": ["#.#", "..#", ".#.", "#..", "#.#"],
    "°": ["##", "##", "..", "..", ".."],
    " ": ["..", "..", "..", "..", ".."],
}

# Full-height icons (8 rows). Cloud with a check mark / with an X.
ICON_OK = "\x01"
ICON_DOWN = "\x02"
_ICON_ROWS = {
    ICON_OK: [
        "..###....",
        ".#...##..",
        "#......#.",
        "#.......#",
        ".#######.",
        "......#..",
        "..#..#...",
        "...##....",
    ],
    ICON_DOWN: [
        "..###....",
        ".#...##..",
        "#......#.",
        "#.......#",
        ".#######.",
        "..#...#..",
        "...#.#...",
        "..#...#..",
    ],
}


def _cols(rows: list[str], top: int) -> list[list[int]]:
    """Glyph rows -> columns of the full 8-row height, glyph starting at row `top`."""
    out = []
    for c in range(len(rows[0])):
        col = [0] * ROWS
        for r, line in enumerate(rows):
            if line[c] == "#":
                col[top + r] = 1
        out.append(col)
    return out


GLYPHS = {ch: _cols(rows, 1) for ch, rows in _FONT_ROWS.items()}
GLYPHS.update({ch: _cols(rows, 0) for ch, rows in _ICON_ROWS.items()})


def render_text(text: str) -> list[list[int]]:
    """Text -> list of 8-row columns, one blank column between glyphs. Unknown chars are skipped."""
    out: list[list[int]] = []
    for ch in text.upper():
        g = GLYPHS.get(ch)
        if g is None:
            continue
        if out:
            out.append(list(BLANK))
        out.extend([list(c) for c in g])
    return out


def frame_from_cols(cols: list[list[int]]) -> list[list[int]]:
    """13 columns -> 8 x 13 frame (rows), padded with blank columns."""
    cols = (cols + [BLANK] * COLS)[:COLS]
    return [[cols[c][r] for c in range(COLS)] for r in range(ROWS)]


def to_wire(frame) -> str:
    return "".join("1" if v else "0" for row in frame for v in row)


def to_ascii(frame) -> str:
    return "\n".join("".join("#" if v else "." for v in row) for row in frame)


def scroll_frames(text: str) -> list[list[list[int]]]:
    """Every frame of one right-to-left scroll: starts and ends blank."""
    strip = [BLANK] * COLS + render_text(text) + [BLANK] * COLS
    return [frame_from_cols(strip[k:k + COLS]) for k in range(len(strip) - COLS + 1)]


def meter_height(level_db: float | None, full_db: float = 24.0) -> int:
    """Sound level above the noise floor (dB) -> bar height 0..8."""
    if level_db is None:
        return 0
    return int(round(min(max(level_db, 0.0), full_db) / full_db * ROWS))


def meter_frame(history) -> list[list[int]]:
    """Rolling bar graph, newest on the right. None entries (no data) show one dot on the bottom row."""
    hist = list(history)[-COLS:]
    hist = [None] * (COLS - len(hist)) + hist
    frame = [[0] * COLS for _ in range(ROWS)]
    for c, lv in enumerate(hist):
        if lv is None:
            if c % 2 == 0:
                frame[ROWS - 1][c] = 1
            continue
        for r in range(ROWS - meter_height(lv), ROWS):
            frame[r][c] = 1
    return frame


def ticker_text(status: dict) -> str:
    """e.g. '25.7°C 45% <cloud>'; temperature / humidity left out when unknown."""
    parts = []
    if status.get("temp_c") is not None:
        parts.append(f"{status['temp_c']:.1f}°C")
    if status.get("rh") is not None:
        parts.append(f"{status['rh']:.0f}%")
    parts.append(ICON_OK if status.get("server_ok") else ICON_DOWN)
    return " ".join(parts)


class MatrixDisplay:
    def __init__(self, send: Callable[[str], None], status_fn: Callable[[], dict], cfg: dict | None = None,
                 log=print, clock=time.monotonic):
        """send(frame_str): 104-char '0'/'1' (or '' = all off) to the sketch.
        status_fn(): {"temp_c", "rh", "server_ok", "level_db"}, any may be None.
        cfg: config.json "matrix" block."""
        cfg = cfg or {}
        self.send = send
        self.status_fn = status_fn
        self.log = log
        self.clock = clock
        self.ticker = bool(cfg.get("ticker", True))
        self.scroll_s = float(cfg.get("scroll_ms", 120)) / 1000.0
        self.meter_s = float(cfg.get("meter_s", 6.0))
        self._lock = threading.Lock()
        self._arrow = ""
        self._calibrating = False
        self._last_sent: str | None = None
        self._frames: list | None = None  # current scroll
        self._idx = 0
        self._meter_until: float | None = None
        self._meter_hist: deque = deque(maxlen=COLS)

    # ---- inputs (any thread) ---------------------------------------------------------

    def set_arrow(self, frame: str) -> None:
        """Pipeline display callback: an arrow frame, or '' when it clears."""
        with self._lock:
            self._arrow = frame or ""
            self._reset_cycle()
            self._emit(self._current())

    def set_calibrating(self, on: bool) -> None:
        with self._lock:
            self._calibrating = bool(on)
            self._reset_cycle()
            self._emit(self._current())

    # ---- frame loop ---------------------------------------------------------------------

    def step(self) -> str:
        """Advance one tick and send the frame if it changed. Returns the frame string."""
        with self._lock:
            frame = self._current(advance=True)
            self._emit(frame)
            return frame

    def start(self) -> "MatrixDisplay":
        def run():
            while True:
                try:
                    self.step()
                except Exception as e:  # never let the display take the app down
                    self.log(f"[matrix] {e!r}")
                time.sleep(self.scroll_s)
        threading.Thread(target=run, name="matrix", daemon=True).start()
        return self

    # ---- internals (lock held) ----------------------------------------------------------------

    def _reset_cycle(self) -> None:
        self._frames, self._idx, self._meter_until = None, 0, None

    def _status(self) -> dict:
        try:
            return self.status_fn() or {}
        except Exception as e:
            self.log(f"[matrix] status failed: {e!r}")
            return {}

    def _current(self, advance: bool = False) -> str:
        if self._arrow:
            return self._arrow
        if self._calibrating:
            return to_wire(frame_from_cols([BLANK] + render_text("CAL")))
        if not self.ticker:
            return ""
        if not advance and self._frames is None and self._meter_until is None:
            return self._last_sent if self._last_sent is not None else ""
        now = self.clock()
        if self._meter_until is not None:  # meter phase
            if now < self._meter_until:
                if advance:
                    self._meter_hist.append(self._status().get("level_db"))
                return to_wire(meter_frame(self._meter_hist))
            self._meter_until = None
        if self._frames is None:  # start a scroll with fresh values
            self._frames, self._idx = scroll_frames(ticker_text(self._status())), 0
        frame = to_wire(self._frames[self._idx])
        if advance:
            self._idx += 1
            if self._idx >= len(self._frames):  # scroll done -> meter
                self._frames = None
                self._meter_until = now + self.meter_s
                self._meter_hist.clear()
        return frame

    def _emit(self, frame: str) -> None:
        if frame != self._last_sent:
            self._last_sent = frame
            self.send(frame)


if __name__ == "__main__":  # preview: python matrix_display.py
    st = {"temp_c": 25.7, "rh": 45.2, "server_ok": True}
    fr = scroll_frames(ticker_text(st))
    print(f"{len(fr)} scroll frames; every 6th:\n")
    for f in fr[::6]:
        print(to_ascii(f), end="\n\n")
    for icon in (ICON_OK, ICON_DOWN):
        print(to_ascii(frame_from_cols([BLANK, BLANK] + render_text(icon))), end="\n\n")
    print(to_ascii(meter_frame([0, 3, 6, 12, 18, 24, 30, 20, 10, 5, None, 2, 8])))
    print()
    print(to_ascii(frame_from_cols([BLANK] + render_text("CAL"))))
