"""Render a direction arrow for the Uno Q's 8 x 13 LED matrix.

Frames are 8 rows x 13 columns, row 0 at the top. Angles follow the board
frame convention: 0 deg = right (+x), 90 deg = up (+y), counter-clockwise.
`rotation_deg` maps the ATech board frame onto how the Uno Q is mounted
(angle of the ATech +x axis as seen on the matrix).

The sketch only displays frames; drawing lives here so it is testable and can
be previewed in a terminal (`to_ascii`).
"""

from __future__ import annotations

import math

ROWS, COLS = 8, 13
CX, CY = (COLS - 1) / 2.0, (ROWS - 1) / 2.0  # matrix centre (6, 3.5)


def _plot(frame, x: float, y: float) -> None:
    c, r = int(round(x)), int(round(y))
    if 0 <= r < ROWS and 0 <= c < COLS:
        frame[r][c] = 1


def _line(frame, x0, y0, x1, y1) -> None:
    steps = max(1, int(math.ceil(max(abs(x1 - x0), abs(y1 - y0)) * 2)))
    for k in range(steps + 1):
        t = k / steps
        _plot(frame, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)


def arrow(angle_deg: float, rotation_deg: float = 0.0) -> list[list[int]]:
    """Arrow from the matrix centre toward angle_deg (tip near the edge)."""
    a = math.radians(angle_deg + rotation_deg)
    dx, dy = math.cos(a), -math.sin(a)  # screen y grows downward
    # Longest segment from the centre that stays inside the matrix.
    t_edge = min(
        (CX / abs(dx)) if dx else math.inf,
        (CY / abs(dy)) if dy else math.inf,
    )
    tip_x, tip_y = CX + dx * t_edge, CY + dy * t_edge
    tail_x, tail_y = CX - dx * min(t_edge, 2.5), CY - dy * min(t_edge, 2.5)
    frame = [[0] * COLS for _ in range(ROWS)]
    _line(frame, tail_x, tail_y, tip_x, tip_y)
    for side in (+1, -1):  # arrowhead barbs at +-140 degrees from the shaft
        b = a + side * math.radians(140)
        _line(frame, tip_x, tip_y, tip_x + 2.6 * math.cos(b), tip_y - 2.6 * math.sin(b))
    return frame


def blank() -> list[list[int]]:
    return [[0] * COLS for _ in range(ROWS)]


def to_wire(frame) -> str:
    """104-char '0'/'1' string, row-major, as sent to the sketch."""
    return "".join("1" if v else "0" for row in frame for v in row)


def to_ascii(frame) -> str:
    return "\n".join("".join("#" if v else "." for v in row) for row in frame)
