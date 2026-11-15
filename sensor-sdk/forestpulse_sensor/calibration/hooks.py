"""The node's calibration hooks: what the device app hands the library, and the checks the library makes on them.

The hooks are one object (the device app's, or SimulatedHooks from simulate.py) with:

- start_stream() -> bool: switch the front-end to continuous audio, ending any running recording first (the firmware
  ignores the start command while a recording is active). False when there is no stream. The audio then arrives
  through the usual feed() / feed_channels() calls.
- stop_stream(): back to triggered recordings.
- emit(f_start_hz, f_mid_hz, f_end_hz, duration_ms[, volume]): play one sweep on the emitter. Raising, or returning
  False, is a failure. A hook that takes a `volume` keyword gets the run's level, a fraction of full scale (0 to 1),
  when the run sends one, and the alarm's; one without it plays at its own level.
- speed_of_sound() -> float: metres per second from the board's thermometer.
- bearing(window, band_hz) -> (angle_deg, quality) | None: the direction of the one arrival in `window` ((N, 3) int16
  at fs), within band_hz (lo, hi); degrees clockwise from the board's forward, quality 0 to 1. Called once per other
  board's beep; a call slower than BEARING_LIMIT_S is not used.
- fs (samples per second), emitter_offset_m (buzzer to the array's centre), forward_ccw_deg (where the board's
  marked forward points in the board frame, counter-clockwise from +x as in soc/README.md), and optionally
  mic_positions_m (the board frame, default the nominal BOARD_MICS_M).
"""
import inspect
import logging
import math

from .detect import BOARD_MICS_M

log = logging.getLogger("forestpulse_sensor")

HOOKS = ("start_stream", "stop_stream", "emit", "speed_of_sound", "bearing")
ATTRIBUTES = ("fs", "emitter_offset_m", "forward_ccw_deg")
FALLBACK_SPEED_OF_SOUND = 343.0
SPEED_OF_SOUND_RANGE = (300.0, 380.0)
BEARING_LIMIT_S = 0.2


def self_check(hooks) -> list[str]:
    """Why these hooks cannot calibrate, one reason per missing or unusable piece; empty when they can."""
    if hooks is None:
        return ["no calibration hooks given"]
    problems = [f"hook {name}() is missing" for name in HOOKS if not callable(getattr(hooks, name, None))]
    for name in ATTRIBUTES:
        value = getattr(hooks, name, None)
        if not _number(value):
            problems.append(f"attribute {name} is not set")
    fs = getattr(hooks, "fs", None)
    if _number(fs) and fs <= 0:
        problems.append("attribute fs must be positive")
    offset = getattr(hooks, "emitter_offset_m", None)
    if _number(offset) and offset < 0:
        problems.append("attribute emitter_offset_m must not be negative")
    try:
        mics = mic_positions(hooks)
        if len(mics) != 3 or any(len(m) < 2 for m in mics):
            problems.append("attribute mic_positions_m must list 3 mics")
    except (TypeError, ValueError):
        problems.append("attribute mic_positions_m must list 3 mics")
    return problems


def mic_positions(hooks):
    """The board-frame mic positions, metres: the hooks' own, or the nominal board's."""
    value = getattr(hooks, "mic_positions_m", None)
    return tuple(tuple(float(c) for c in m) for m in (BOARD_MICS_M if value is None else value))


def speed_of_sound(hooks) -> tuple[float, bool]:
    """(metres per second, fell back): the thermometer's value, or 343 when the hook raises or answers outside 300 to
    380 m/s."""
    try:
        c = float(hooks.speed_of_sound())
    except Exception as e:  # the device app's code: any failure falls back
        log.warning("speed_of_sound() failed (%s); assuming %.0f m/s", e, FALLBACK_SPEED_OF_SOUND)
        return FALLBACK_SPEED_OF_SOUND, True
    lo, hi = SPEED_OF_SOUND_RANGE
    if not (math.isfinite(c) and lo <= c <= hi):
        log.warning("speed_of_sound() returned %s, outside %.0f to %.0f m/s; assuming %.0f m/s", c, lo, hi,
                    FALLBACK_SPEED_OF_SOUND)
        return FALLBACK_SPEED_OF_SOUND, True
    return c, False


def _number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def emit_with_volume(emit, args, volume=None):
    """Calls the emit hook with the volume keyword when there is a volume and the hook takes one, else without it."""
    if volume is not None and takes_volume(emit):
        return emit(*args, volume=volume)
    return emit(*args)


def takes_volume(emit) -> bool:
    """Whether the emit hook accepts a `volume` keyword (named, or **kwargs)."""
    try:
        params = inspect.signature(emit).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(p.name == "volume" or p.kind is inspect.Parameter.VAR_KEYWORD for p in params)
