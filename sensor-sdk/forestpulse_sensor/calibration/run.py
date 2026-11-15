"""A calibration run on this board, from the run in a check-in reply to the posted report (docs/device-api.md).

The service names the participants, their roles and the schedule; this board starts the continuous stream, says it
is ready once audio flows, beeps in its own slots, records every slot into a ring indexed by its own fed-sample
count, finds each beep there, stops the stream and posts where in its own stream it heard every beep. Wall-clock
time (corrected to the service's clock) only places slots and tells which slot a beep belongs to; the service ranges
on stream positions alone.

Sensor drives it: checkin_fields() and note_reply() around every check-in, feed() for every audio frame (True while
the stream runs, when the audio is the run's alone), and active, which also means "report no sound events".
"""
import logging
import threading
import time
from collections import deque
from datetime import UTC, datetime

import numpy as np

from .detect import find_beeps
from .hooks import BEARING_LIMIT_S, emit_with_volume, mic_positions, self_check, speed_of_sound
from .patterns import parse_patterns

log = logging.getLogger("forestpulse_sensor")

RING_S = 20.0               # the ring holds this much audio; a round older than that is an overrun
READY_AFTER_S = 1.0         # continuous audio for this long before confirming ready
STREAM_TIMEOUT_S = 15.0     # audio that never flows this long after start_stream() is no stream
SCHEDULE_TIMEOUT_S = 40.0   # a run never scheduled this long after ready is given up, with no report
STOP_AFTER_BEEP_S = 0.2     # record this long after the last expected beep
STOP_AFTER_SCHEDULE_S = 1.0  # and never longer than this after the schedule's end
REPORT_AFTER_SCHEDULE_S = 15.0  # the service's report deadline
SLOT_LEAD_S = 0.1           # a slot's window opens this long before the slot: the clock mapping is approximate
# and closes STOP_AFTER_BEEP_S after the sweep would end, so it stays inside the slot and recording can stop there
BEARING_BEFORE_S = 0.005    # the bearing window: from this long before the detected first path,
BEARING_WINDOW_S = 0.040    # this long, so the direct sound fills it before most echoes arrive
OFFSET_SAMPLES = 30         # the service clock offset comes from the fastest of the latest check-ins
ENDED_AFTER_REPLIES = 2     # the run has ended once this many replies in a row leave it out (one may be a hiccup)
INT16_MAX, INT16_MIN = 32767, -32768


def parse_time(value) -> float | None:
    """A UTC ISO 8601 time (as the service sends it) as seconds since the epoch, or None."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC).timestamp()
    except ValueError:
        return None


def slots(order, start_at: float, slot_ms: float, round_gap_ms: float, rounds: int):
    """Every slot of a run as (round, role, start seconds): each round plays the order (forward in even rounds,
    reversed in odd ones) one slot each, and the next round starts round_gap_ms after the last slot of the one
    before ends."""
    round_s = (len(order) * slot_ms + round_gap_ms) / 1000
    out = []
    for r in range(rounds):
        roles = list(order) if r % 2 == 0 else list(order)[::-1]
        out += [(r, role, start_at + r * round_s + k * slot_ms / 1000) for k, role in enumerate(roles)]
    return out


def schedule_end(order, start_at: float, slot_ms: float, round_gap_ms: float, rounds: int) -> float:
    """When the last slot of a run ends, seconds."""
    return start_at + ((rounds - 1) * (len(order) * slot_ms + round_gap_ms) + len(order) * slot_ms) / 1000


class Aborted(Exception):
    """The run left the check-in reply (it ended or this board was dropped), or the sensor stopped."""


class Stream:
    """The continuous stream since start_stream(): a ring of the latest RING_S seconds, indexed by the number of
    samples fed since the stream started, with where the audio broke and when each contiguous stretch started on
    this board's clock."""

    def __init__(self, fs: int, seconds: float = RING_S):
        self.fs = fs
        self.size = int(round(seconds * fs))
        self.ring = np.zeros((self.size, 3), np.int16)
        self.total = 0
        self.breaks = []    # stream positions not contiguous with the sample before
        self.segments = []  # [start position, earliest estimate of its wall time] per contiguous stretch
        self.lock = threading.Lock()

    def feed(self, frames, break_before: bool, now: float) -> None:
        frames = np.asarray(frames)
        with self.lock:
            if frames.ndim != 2 or frames.shape[1] != 3 or not len(frames):
                if frames.size:
                    self._break()
                return
            if break_before or not self.segments:
                self._break()
            n = len(frames)
            if n >= self.size:
                frames, skipped = frames[-self.size:], n - self.size
                self.total += skipped
                n = self.size
            at = self.total % self.size
            first = min(n, self.size - at)
            self.ring[at:at + first] = frames[:first]
            self.ring[:n - first] = frames[first:]
            self.total += n
            segment = self.segments[-1]
            # frames arrive in bursts and late, never early: the earliest estimate of the stretch's start is best
            estimate = now - (self.total - segment[0]) / self.fs
            segment[1] = estimate if segment[1] is None else min(segment[1], estimate)

    def _break(self):
        self.breaks.append(self.total)
        self.segments.append([self.total, None])

    def contiguous_s(self) -> float:
        with self.lock:
            return (self.total - self.segments[-1][0]) / self.fs if self.segments else 0.0

    def position(self, t: float) -> float | None:
        """The stream position recorded at wall time t (this board's clock), or None before any audio."""
        with self.lock:
            for start, t0 in reversed(self.segments):
                if t0 is not None and (t - t0) * self.fs >= 0:
                    return start + (t - t0) * self.fs
            return None

    def read(self, lo: int, hi: int):
        """The audio from stream position lo up to hi, or None when part of it is gone or not yet fed."""
        with self.lock:
            if lo < self.total - self.size or hi > self.total or lo >= hi:
                return None
            idx = np.arange(lo, hi) % self.size
            return self.ring[idx].copy()

    def problem(self, lo: int, hi: int) -> str | None:
        """Why the audio from lo to hi cannot be trusted, or None."""
        with self.lock:
            if hi > self.total:
                return "dropped"
            if lo < self.total - self.size:
                return "overrun"
            if any(lo < b < hi for b in self.breaks):
                return "break"
        return None


class Calibrator:
    """This board's side of calibration: whether it can take part, and the run it is taking part in."""

    def __init__(self, hooks, api, clock, wake):
        self.hooks = hooks
        self.api = api
        self.clock = clock
        self._wake = wake
        self.problems = self_check(hooks)
        self.capable = not self.problems
        if hooks is not None and self.problems:
            log.warning("calibration disabled, the hooks failed the self-check: %s", "; ".join(self.problems))
        self._lock = threading.Lock()
        self._run = None
        self._done = deque(maxlen=50)
        self._offsets = deque(maxlen=OFFSET_SAMPLES)  # (round trip, service clock minus this board's)
        self._missing = 0  # replies in a row without the run
        self.stream = None

    @property
    def active(self) -> bool:
        return self._run is not None

    def checkin_fields(self) -> dict:
        fields = {"calibration_capable": self.capable}
        run = self._run
        if run is not None and run.ready:
            fields["calibration_ack"] = run.id
        return fields

    def note_reply(self, reply: dict, sent: float, received: float) -> None:
        """A check-in reply, with this board's clock when the check-in was sent and when the reply arrived."""
        server = parse_time(reply.get("server_time"))
        # a clock stepped back during the request (NTP soon after boot) gives a round trip of zero or less, which
        # would win as the fastest sample for the next 30 check-ins with a wrong offset
        if server is not None and received - sent > 0:
            self._offsets.append((received - sent, server - (sent + received) / 2))
        if not self.capable:
            return
        block = reply.get("calibration")
        with self._lock:
            run = self._run
            if not isinstance(block, dict):
                self._missing += 1
                if run is not None and self._missing >= ENDED_AFTER_REPLIES:
                    run.abort("the run ended")
                return
            self._missing = 0
            if run is not None and run.id == block.get("run_id"):
                run.update(block)
                return
            if run is not None:
                run.abort("another run started")
            if block.get("run_id") in self._done:
                return
            try:
                run = Run(self, block)
            except (KeyError, TypeError, ValueError) as e:
                log.error("ignoring a calibration run the service sent: %s", e)
                self._done.append(block.get("run_id"))
                return
            self._run = run
        log.info("calibration run %s: taking part as %s", run.id, run.role)
        run.start()

    def offset(self) -> float:
        """The service's clock minus this board's, from the fastest recent check-in."""
        if not self._offsets:
            return 0.0
        return min(self._offsets)[1]

    def feed(self, frames, break_before: bool) -> bool:
        stream = self.stream
        if stream is None:
            return False
        stream.feed(frames, break_before, self.clock())
        return True

    def stop(self) -> None:
        run = self._run
        if run is not None:
            run.abort("the sensor stopped")
            run.join(5)

    def _finished(self, run) -> None:
        with self._lock:
            self._done.append(run.id)
            if self._run is run:
                self._run = None
        self._wake()


class Run:
    def __init__(self, cal: Calibrator, block: dict):
        self.cal = cal
        self.id = str(block["run_id"])
        self.role = str(block["role"])
        self.patterns = parse_patterns(block["patterns"])
        self.slot_ms = float(block["slot_ms"])
        self.round_gap_ms = float(block["round_gap_ms"])
        self.rounds = int(block["rounds"])
        self.order = [str(r) for r in block["order"]]
        volume = block.get("volume")
        self.volume = float(volume) if isinstance(volume, (int, float)) and 0 < volume <= 1 else None
        if self.role not in self.order or any(r not in self.patterns for r in self.order):
            raise ValueError(f"run {self.id}: role {self.role} or a pattern is missing from the run")
        self.start_at = None
        self.ready = False
        self._stream = None  # this run's stream while it runs
        self._scheduled = threading.Event()
        self._aborted = threading.Event()
        self._why = None
        self._thread = threading.Thread(target=self._go, name="fp-calibration", daemon=True)
        self.update(block)

    def start(self):
        self._thread.start()

    def join(self, timeout):
        if self._thread.is_alive():
            self._thread.join(timeout)

    def update(self, block: dict) -> None:
        start = parse_time(block.get("start_at"))
        if start is not None and not self._scheduled.is_set():
            self.order = [str(r) for r in block.get("order", self.order)]
            self.start_at = start
            self._scheduled.set()

    def abort(self, why: str) -> None:
        if not self._aborted.is_set():
            self._why = why
            self._aborted.set()

    # ---- the run's own thread ----------------------------------------------------------------------------------

    def _go(self):
        hooks, cal = self.cal.hooks, self.cal
        c, fallback = speed_of_sound(hooks)
        report = {"run_id": self.id, "role": self.role, "fs": hooks.fs, "speed_of_sound": round(c, 2),
                  "speed_of_sound_fallback": fallback, "emitter_offset_m": float(hooks.emitter_offset_m),
                  "errors": [], "rounds": []}
        deadline = None
        try:
            stream = Stream(int(hooks.fs))
            with cal._lock:
                self._stream = cal.stream = stream
            try:
                started = hooks.start_stream()
            except Exception:
                log.exception("start_stream() failed")
                started = False
            if started is False:
                report["errors"].append("no_stream")
            elif not self._wait_for_audio(stream):
                log.error("calibration run %s: no audio %.0f s after start_stream()", self.id, STREAM_TIMEOUT_S)
                report["errors"].append("no_stream")
            else:
                self.ready = True
                cal._wake()
                log.info("calibration run %s: stream flowing, ready", self.id)
                give_up = time.monotonic() + SCHEDULE_TIMEOUT_S
                while not self._scheduled.is_set():
                    self._check()
                    if time.monotonic() > give_up:
                        raise Aborted("never scheduled")
                    self._scheduled.wait(0.1)
                self._check()
                offset = cal.offset()
                end = schedule_end(self.order, self.start_at, self.slot_ms, self.round_gap_ms, self.rounds)
                deadline = end + REPORT_AFTER_SCHEDULE_S - offset
                plan = slots(self.order, self.start_at, self.slot_ms, self.round_gap_ms, self.rounds)
                if not self._beep(plan, offset):
                    report["errors"].append("emit_failed")
                else:
                    self._record_until(stream, plan, offset, end)
                    self._stop_stream()
                    report["rounds"] = self._analyse(stream, plan, offset, c)
                    if not self._heard_own(report["rounds"]):
                        report["errors"].append("own_beep_not_heard")
        except Aborted as e:
            log.info("calibration run %s stopped: %s", self.id, e)
            self._stop_stream()
            cal._finished(self)
            return
        except Exception:
            log.exception("calibration run %s failed", self.id)
            self._stop_stream()
            cal._finished(self)
            return
        self._stop_stream()
        self._post(report, deadline if deadline is not None else cal.clock() + REPORT_AFTER_SCHEDULE_S)
        cal._finished(self)

    def _check(self):
        if self._aborted.is_set():
            raise Aborted(self._why)

    def _sleep_until(self, t: float):
        """Waits until this board's clock reads t; raises Aborted if the run ends meanwhile."""
        while True:
            self._check()
            left = t - self.cal.clock()
            if left <= 0:
                return
            self._aborted.wait(min(left, 0.5))

    def _wait_for_audio(self, stream: Stream) -> bool:
        """True once audio has flowed without a break for READY_AFTER_S; False when it never does."""
        give_up = time.monotonic() + STREAM_TIMEOUT_S
        while stream.contiguous_s() < READY_AFTER_S:
            self._check()
            if time.monotonic() > give_up:
                return False
            self._aborted.wait(0.05)
        return True

    def _beep(self, plan, offset) -> bool:
        """Plays this board's sweep at each of its slots. False when the buzzer failed."""
        pattern = self.patterns[self.role]
        args = tuple(int(v) if float(v).is_integer() else v for v in pattern.emit_args())
        for _, role, start in plan:
            if role != self.role:
                continue
            local = start - offset
            if local < self.cal.clock() - 0.05:
                continue  # learnt of the schedule too late for this slot
            self._sleep_until(local)
            try:
                ok = emit_with_volume(self.cal.hooks.emit, args, self.volume)
            except Exception:
                log.exception("emit() failed")
                return False
            if ok is False:
                log.error("emit() returned False")
                return False
        return True

    def _record_until(self, stream: Stream, plan, offset, end):
        """Keeps recording until the last expected beep plus 200 ms is in the ring, or the schedule's end plus 1 s
        on this board's clock."""
        last = max(start for _, _, start in plan)
        tail = max(p.duration_ms for p in self.patterns.values()) / 1000 + STOP_AFTER_BEEP_S
        give_up = end + STOP_AFTER_SCHEDULE_S - offset
        while self.cal.clock() < give_up:
            self._check()
            target = stream.position(last + tail - offset)
            if target is not None and stream.total >= target:
                return
            self._aborted.wait(0.02)

    def _stop_stream(self):
        """Stops this run's stream, unless a newer run already took the stream over."""
        with self.cal._lock:
            mine = self._stream is not None and self.cal.stream is self._stream
            self._stream = None
            if mine:
                self.cal.stream = None
        if not mine:
            return
        try:
            self.cal.hooks.stop_stream()
        except Exception:
            log.exception("stop_stream() failed")

    def _analyse(self, stream: Stream, plan, offset, c):
        fs = stream.fs
        window_s = SLOT_LEAD_S + max(p.duration_ms for p in self.patterns.values()) / 1000 + STOP_AFTER_BEEP_S
        window_s = min(window_s, self.slot_ms / 1000)
        mics = mic_positions(self.cal.hooks)
        rounds = []
        for r in range(self.rounds):
            mine = [(role, start) for rr, role, start in plan if rr == r]
            window = [stream.position(start - offset - SLOT_LEAD_S) for _, start in mine]
            if any(w is None for w in window):
                rounds.append({"round": r, "valid": False, "problems": ["dropped"], "detections": []})
                continue
            lo = int(np.floor(window[0]))
            hi = int(np.ceil(window[-1] + window_s * fs))
            problems = []
            problem = stream.problem(lo, hi)
            if problem:
                problems.append(problem)
            audio = None if problem in ("dropped", "overrun") else stream.read(lo, hi)
            if audio is None and not problems:
                problems.append("dropped")
            detections = []
            if audio is not None:
                if (audio >= INT16_MAX).any() or (audio <= INT16_MIN).any():
                    problems.append("clipped")
                for (role, _), w in zip(mine, window):
                    a = int(np.floor(w)) - lo
                    b = min(len(audio), a + int(np.ceil(window_s * fs)))
                    d = self._find(audio[a:b], role, fs, lo + a, mics, c)
                    if d is not None:
                        detections.append(self._describe(d, role, stream, fs))
            rounds.append({"round": r, "valid": not problems, "problems": problems, "detections": detections})
        return rounds

    def _find(self, audio, role, fs, offset, mics, c):
        """The strongest whole detection of the slot's role in its window; the strongest weak one when none is
        whole (reported, never ranged on); None when nothing was heard."""
        if len(audio) == 0:
            return None
        found = find_beeps(audio, {role: self.patterns[role]}, fs, mic_positions_m=mics, speed_of_sound=c,
                           offset=offset)
        found = [d for d in found if d.role == role]
        if not found:
            return None
        return max(found, key=lambda d: (not d.weak, d.snr_db))

    def _describe(self, d, role, stream: Stream, fs):
        own = role == self.role
        angle, quality = (None, None) if own or d.weak else self._bearing(d, stream, fs)
        return {"emitter": role, "own": own, "position": round(float(d.position), 3), "snr_db": round(d.snr_db, 2),
                "weak": bool(d.weak), "angle_deg": angle, "angle_quality": quality}

    def _bearing(self, d, stream: Stream, fs):
        pattern = self.patterns[d.role]
        lo = int(np.floor(d.position - BEARING_BEFORE_S * fs))
        hi = lo + int(round(BEARING_WINDOW_S * fs))
        window = stream.read(lo, hi)
        if window is None:
            return None, None
        began = time.monotonic()
        try:
            got = self.cal.hooks.bearing(window, pattern.band_hz)
        except Exception:
            log.exception("bearing() failed")
            return None, None
        took = time.monotonic() - began
        if took > BEARING_LIMIT_S:
            log.warning("bearing() took %.0f ms, over the %.0f ms limit; not used", took * 1000,
                        BEARING_LIMIT_S * 1000)
            return None, None
        if got is None:
            return None, None
        try:
            angle, quality = got
            return round(float(angle) % 360.0, 2), round(min(max(float(quality), 0.0), 1.0), 3)
        except (TypeError, ValueError):
            log.error("bearing() returned %r, not (angle_deg, quality)", got)
            return None, None

    def _heard_own(self, rounds) -> bool:
        """The own beep was found whole in some round that had its audio (a run whose audio never arrived is
        judged on its rounds, not on the buzzer)."""
        heard = [r for r in rounds if not {"dropped", "overrun"} & set(r["problems"])]
        if not heard:
            return True
        return any(d["own"] and not d["weak"] for r in heard for d in r["detections"])

    def _post(self, report, deadline):
        while True:
            try:
                self.cal.api.post_calibration(report)
                log.info("calibration run %s: report posted%s", self.id,
                         f" ({', '.join(report['errors'])})" if report["errors"] else "")
                return
            except Exception as e:  # KeyRejected and BadRequest end it; Unavailable retries until the deadline
                name = type(e).__name__
                if name in ("KeyRejected", "BadRequest") or self._aborted.is_set() or self.cal.clock() > deadline:
                    log.error("calibration run %s: report not delivered (%s: %s)", self.id, name, e)
                    return
                self._aborted.wait(1.0)
