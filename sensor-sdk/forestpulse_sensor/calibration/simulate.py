"""A simulated stage of boards for calibration tests and journeys: what each board's 3 mics record, live, while the
boards beep at each other, behind SimulatedHooks with the same interface as the device team's hooks (hooks.py).

Room coordinates are the plan's: metres, x to the right, y up, facings in degrees clockwise from up. Each board has a
position, a facing, its own clock (an offset and a drift), a sample clock that drifts with it, a buzzer some
centimetres from its array, and a thermometer. Every board hears every emitted sweep, its own included: the direct
path (1/r, never louder than at NEAR_M, as the buzzer faces away from its own array) and one echo off a wall, over a
noise bed of the committed hall recording plus synthetic speech (render.py's pieces, meaning unchanged).

    room = Room()
    hooks = room.add(Board(0, 0, facing_deg=90))
    sensor = Sensor(url, key, calibration=hooks, clock=hooks.clock)
    hooks.connect(sensor.feed)

True time is the host's time.time(). Audio is produced in 20 ms blocks at the board's own (drifting) sample rate and
handed to the connected feed as the board's front-end would, the first block of a stream marked as a break.
"""
import math
import threading
import time
from dataclasses import dataclass, field

import numpy as np

from .detect import BOARD_MICS_M
from .patterns import DEFAULT_PATTERNS, Pattern, sweep
from .render import _add_delayed, _band_power, _hall, _plane_wave, _speech

NEAR_M = 0.25        # a buzzer is never louder at a mic than at this distance
BED_S = 8.0          # each board's noise bed, played back and forth so it never jumps
BLOCK_S = 0.02
PAD = 64


@dataclass
class Board:
    x_m: float
    y_m: float
    facing_deg: float = 0.0          # where the board's forward points on the plan, clockwise from up
    clock_offset_s: float = 0.0      # the board's clock minus true time
    drift_ppm: float = 0.0           # the board's clock and sample clock run this many parts per million fast
    emitter_offset_m: float = 0.05   # buzzer to the array's centre
    emitter_ccw_deg: float = 0.0     # the buzzer's direction from the array's centre, board frame (0 = toward mic 2)
    forward_ccw_deg: float = 90.0    # the board's marked forward in the board frame (90 = the top edge)
    thermometer: float | str | None = None  # what speed_of_sound() answers: None the room's, "fail" raises
    muted: bool = False              # emit() succeeds but the buzzer makes no sound
    stream_delay_s: float = 0.0      # audio starts flowing this long after start_stream()
    has_stream: bool = True          # False: start_stream() returns False
    bearing_fn: object = None        # bearing(window, band_hz) answers with this; None answers None (no bearing)
    name: str = field(default="", compare=False)


class SimulatedHooks:
    """One simulated board's calibration hooks (the interface in hooks.py), plus clock() for the board's own clock
    and connect(feed) for where its stream goes."""

    def __init__(self, room: "Room", board: Board, seed: int):
        self.room = room
        self.board = board
        self.fs = room.fs
        self.emitter_offset_m = board.emitter_offset_m
        self.forward_ccw_deg = board.forward_ccw_deg
        self.mic_positions_m = room.mic_positions_m
        self.emitted = []  # (true time, Pattern) of every emit() call
        self._feed = None
        self._lock = threading.Lock()
        self._stream = None  # (start true time, stop event, thread)
        self._pending = []   # (first sample, (n, 3) float) to add to this board's stream
        self._bed = room._noise_bed(seed)

    # ---- the hook interface ----------------------------------------------------------------------------------

    def start_stream(self) -> bool:
        if not self.board.has_stream:
            return False
        self.stop_stream()  # ends any running recording first, as the device's must
        t0 = time.time() + self.board.stream_delay_s
        stop = threading.Event()
        thread = threading.Thread(target=self._run, args=(t0, stop), name="fp-sim-stream", daemon=True)
        with self._lock:
            self._stream = (t0, stop, thread)
            self._pending = []
        thread.start()
        return True

    def stop_stream(self) -> None:
        with self._lock:
            stream, self._stream = self._stream, None
        if stream is not None:
            stream[1].set()
            if stream[2] is not threading.current_thread():
                stream[2].join(2)

    def emit(self, f_start_hz, f_mid_hz, f_end_hz, duration_ms):
        pattern = Pattern(f_start_hz, f_mid_hz, f_end_hz, duration_ms)
        at = time.time()
        self.emitted.append((at, pattern))
        if not self.board.muted:
            self.room._sound(self, pattern, at)
        return True

    def speed_of_sound(self) -> float:
        t = self.board.thermometer
        if t == "fail":
            raise RuntimeError("thermometer not responding")
        return self.room.speed_of_sound if t is None else float(t)

    def bearing(self, window, band_hz):
        # Pluggable (Board.bearing_fn): without one it answers None, which the contract allows ("cannot tell"), and
        # the run reports the beep without an angle.
        fn = self.board.bearing_fn
        return None if fn is None else fn(window, band_hz)

    # ---- simulation ------------------------------------------------------------------------------------------

    def clock(self) -> float:
        """This board's clock: true time plus its offset and drift."""
        now = time.time()
        b = self.board
        return now + b.clock_offset_s + b.drift_ppm * 1e-6 * (now - self.room.t_ref)

    def connect(self, feed) -> "SimulatedHooks":
        """Where the stream goes: feed(frames, break_before), as Sensor.feed."""
        self._feed = feed
        return self

    @property
    def sample_rate_true(self) -> float:
        return self.fs * (1 + self.board.drift_ppm * 1e-6)

    def streaming_since(self) -> float | None:
        with self._lock:
            return None if self._stream is None else self._stream[0]

    def _add(self, first: int, audio: np.ndarray) -> None:
        with self._lock:
            if self._stream is not None:
                self._pending.append((first, audio))

    def _run(self, t0: float, stop: threading.Event):
        n = int(round(BLOCK_S * self.fs))
        rate = self.sample_rate_true
        k = 0
        while not stop.is_set():
            due = t0 + (k + n) / rate
            wait = due - time.time()
            if wait > 0 and stop.wait(wait):
                return
            block = self._block(k, n)
            if self._feed is not None:
                self._feed(block, k == 0)
            k += n

    def _block(self, k: int, n: int) -> np.ndarray:
        idx = np.arange(k, k + n)
        size = len(self._bed)
        lap, at = np.divmod(idx, size)
        out = self._bed[np.where(lap % 2 == 0, at, size - 1 - at)].copy()
        with self._lock:
            keep = []
            for first, audio in self._pending:
                lo, hi = max(k, first), min(k + n, first + len(audio))
                if lo < hi:
                    out[lo - k:hi - k] += audio[lo - first:hi - first]
                if first + len(audio) > k + n:
                    keep.append((first, audio))
            self._pending = keep
        return np.clip(np.round(out), -32768, 32767).astype(np.int16)


class Room:
    """The stage: the boards on it, the speed of sound, one wall (the line y = wall_y_m), and how loud the buzzers
    are (level_db: a sweep's in-band signal-to-noise at 1 m against a board's noise bed)."""

    def __init__(self, *, speed_of_sound: float = 343.0, level_db: float = 30.0, wall_y_m: float = 2.5,
                 echo_gain: float = 0.6, speech_db: float = 0.0, fs: int = 48000, mic_positions_m=BOARD_MICS_M,
                 seed: int = 0):
        self.speed_of_sound = speed_of_sound
        self.level_db = level_db
        self.wall_y_m = wall_y_m
        self.echo_gain = echo_gain
        self.speech_db = speech_db
        self.fs = fs
        self.mic_positions_m = mic_positions_m
        self.seed = seed
        self.t_ref = time.time()
        self.boards: list[SimulatedHooks] = []
        self._noise_power = None
        self._lock = threading.Lock()

    def add(self, board: Board) -> SimulatedHooks:
        hooks = SimulatedHooks(self, board, self.seed * 1000 + len(self.boards))
        with self._lock:
            self.boards.append(hooks)
        return hooks

    # ---- geometry --------------------------------------------------------------------------------------------

    def mics(self, board: Board) -> np.ndarray:
        """The board's 3 mic positions in the room, (3, 2)."""
        local = np.asarray(self.mic_positions_m, float)[:, :2]
        local = local - local.mean(axis=0)
        return np.array([board.x_m, board.y_m]) + local @ _rotation(board).T

    def buzzer(self, board: Board) -> np.ndarray:
        a = math.radians(board.emitter_ccw_deg)
        local = board.emitter_offset_m * np.array([math.cos(a), math.sin(a)])
        return np.array([board.x_m, board.y_m]) + _rotation(board) @ local

    # ---- sound -----------------------------------------------------------------------------------------------

    def _noise_bed(self, seed: int) -> np.ndarray:
        rng = np.random.default_rng(seed)
        n = int(BED_S * self.fs)
        lo = min(p.band_hz[0] for p in DEFAULT_PATTERNS.values())
        hi = max(p.band_hz[1] for p in DEFAULT_PATTERNS.values())
        hall = _hall(n, self.fs, rng)
        speech = _speech(n, self.fs, rng)
        speech *= math.sqrt(_band_power(hall, self.fs, lo, hi).mean() / _band_power(speech[:, None], self.fs, lo, hi)[0]
                            * 10 ** (self.speech_db / 10))
        local = np.asarray(self.mic_positions_m, float)[:, :2]
        bed = hall + _plane_wave(speech, local - local.mean(axis=0), rng.uniform(0, 360), self.fs,
                                 self.speed_of_sound)
        if self._noise_power is None:
            self._noise_power = float(_band_power(bed, self.fs, lo, hi).mean())
        return bed

    def _sound(self, emitter: SimulatedHooks, pattern: Pattern, at: float) -> None:
        """emitter's buzzer played pattern at true time `at`: every streaming board gets its direct path and its
        echo off the wall, at the positions in its own stream where they arrive."""
        s = sweep(pattern, self.fs)
        amp_1m = math.sqrt(self._noise_power / _band_power(s[:, None], self.fs, *pattern.band_hz)[0]) \
            * 10 ** (self.level_db / 20)
        source = self.buzzer(emitter.board)
        image = np.array([source[0], 2 * self.wall_y_m - source[1]])
        c = self.speed_of_sound
        with self._lock:
            listeners = list(self.boards)
        for listener in listeners:
            t0 = listener.streaming_since()
            if t0 is None:
                continue
            rate = listener.sample_rate_true
            paths = []
            for m, mic in enumerate(self.mics(listener.board)):
                for point, gain in ((source, 1.0), (image, self.echo_gain)):
                    r = float(np.linalg.norm(point - mic))
                    paths.append((m, (at + r / c - t0) * rate, gain * amp_1m / max(r, NEAR_M)))
            first = int(math.floor(min(p[1] for p in paths))) - PAD
            length = int(math.ceil(max(p[1] for p in paths))) - first + len(s) + 2 * PAD
            audio = np.zeros((length, 3))
            for m, start, gain in paths:
                _add_delayed(audio[:, m], s, start - first, gain)
            listener._add(first, audio)


def _rotation(board: Board) -> np.ndarray:
    """Board frame to room: the board's forward (forward_ccw_deg in its frame) points along its facing."""
    a = math.radians(90.0 - board.facing_deg - board.forward_ccw_deg)
    return np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
