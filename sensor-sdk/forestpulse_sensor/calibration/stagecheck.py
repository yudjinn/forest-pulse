"""Stage check: are the stage and the buzzer good enough to calibrate?

usage: python -m forestpulse_sensor.calibration.stagecheck 1m.wav 3m.wav 5m.wav [--role A] [--beeps 10]

Each file is one board's 3-channel 16-bit recording while the buzzer, at the distance in the file's name, played
its sweep 10 times (play_sweeps() below does that through the node's emit hook). For each file it reports how many
beeps were found, the worst matched signal-to-noise, and how repeatably the mic-to-mic arrival differences came
out. PASS needs every beep found and none weak, at least 15 dB, and a spread within 2 samples, in every file, and
at least one file at 5 m or farther (the hard case).
"""
import argparse
import re
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .detect import BOARD_MICS_M, find_beeps
from .patterns import DEFAULT_PATTERNS, Pattern

MIN_SNR_DB = 15.0
MAX_SPREAD_SAMPLES = 2.0
FAR_M = 5.0
BEEPS = 10
INTERVAL_S = 1.0


def play_sweeps(emit, pattern="A", count: int = BEEPS, interval_s: float = INTERVAL_S, *, clock=time.monotonic,
                sleep=time.sleep) -> list[float]:
    """Plays a role's sweep `count` times, one every interval_s, through the node's emit hook.

    emit: the hook, called as emit(f_start_hz, f_mid_hz, f_end_hz, duration_ms).
    pattern: a role ("A", "B", "C") or a Pattern. Returns the clock time of each emit call.
    """
    p = DEFAULT_PATTERNS[pattern] if isinstance(pattern, str) else Pattern.of(pattern)
    args = tuple(int(v) if float(v).is_integer() else v for v in p.emit_args())
    start = clock()
    times = []
    for i in range(count):
        wait = start + i * interval_s - clock()
        if wait > 0:
            sleep(wait)
        times.append(clock())
        emit(*args)
    return times


@dataclass
class Row:
    file: str
    distance_m: float | None = None
    found: int | None = 0
    expected: int = BEEPS
    snr_db: float | None = None
    spread_samples: float | None = None
    problems: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def distance_from_name(path) -> float | None:
    """3m.wav, stage-5m.wav, 2.5m_take2.wav, 2,5 m.wav -> metres."""
    found = re.findall(r"(\d+(?:[.,]\d+)?)\s*m(?![a-z])", Path(path).stem.lower())
    return float(found[-1].replace(",", ".")) if found else None


def check_file(path, pattern: Pattern, beeps: int = BEEPS, mic_positions_m=BOARD_MICS_M) -> Row:
    row = Row(file=Path(path).name, expected=beeps, distance_m=distance_from_name(path))
    try:
        with wave.open(str(path)) as w:
            channels, width, fs = w.getnchannels(), w.getsampwidth(), w.getframerate()
            raw = w.readframes(w.getnframes())
    except (OSError, EOFError, wave.Error) as e:
        row.found = None
        row.problems.append(f"not a readable WAV file ({getattr(e, 'strerror', None) or e})")
        return row
    if channels != 3:
        row.problems.append(f"{channels} channel{'s' if channels != 1 else ''}, needs 3")
    if width != 2:
        row.problems.append(f"{8 * width}-bit, needs 16-bit")
    if row.distance_m is None:
        row.problems.append("no distance in its name (like 3m.wav)")
    if row.problems:
        row.found = None
        return row

    audio = np.frombuffer(raw, np.int16).reshape(-1, 3)
    found = find_beeps(audio, {"beep": pattern}, fs, mic_positions_m=mic_positions_m)
    found = sorted(sorted(found, key=lambda d: -d.snr_db)[:beeps], key=lambda d: d.position)
    row.found = len(found)
    if not found:
        row.problems.append("no beep found")
        return row
    row.snr_db = min(d.snr_db for d in found)
    if row.found < beeps:
        row.problems.append(f"{row.found} of {beeps} beeps found")
    weak = sum(d.weak for d in found)
    if weak:
        row.problems.append(f"{weak} weak")
    if row.snr_db < MIN_SNR_DB:
        row.problems.append(f"SNR below {MIN_SNR_DB:g} dB")
    whole = np.array([d.arrivals for d in found if not d.weak], float)
    if len(whole) >= 2:
        # mic-to-mic differences per beep, so the buzzer's own timing jitter drops out
        offsets = whole[:, [0, 0, 1]] - whole[:, [1, 2, 2]]
        row.spread_samples = float((offsets.max(axis=0) - offsets.min(axis=0)).max())
        if row.spread_samples > MAX_SPREAD_SAMPLES:
            row.problems.append(f"spread above {MAX_SPREAD_SAMPLES:g} samples")
    return row


@dataclass
class Report:
    rows: list
    problems: list  # about the set of files as a whole

    @property
    def passed(self) -> bool:
        return not self.problems and all(r.ok for r in self.rows)


def stage_check(paths, pattern: Pattern = DEFAULT_PATTERNS["A"], beeps: int = BEEPS,
                mic_positions_m=BOARD_MICS_M) -> Report:
    """One row per file, sorted by distance, and whether the stage passes."""
    rows = [check_file(p, pattern, beeps, mic_positions_m) for p in paths]
    rows.sort(key=lambda r: (r.distance_m is None, r.distance_m or 0, r.file))
    problems = []
    if not any(r.distance_m is not None and r.distance_m >= FAR_M for r in rows):
        problems.append(f"no recording at {FAR_M:g} m or farther")
    return Report(rows, problems)


def format_report(report: Report) -> str:
    rows = report.rows
    table = [("file", "distance", "beeps", "SNR", "spread", "result")]
    for r in rows:
        table.append((r.file,
                      "-" if r.distance_m is None else f"{r.distance_m:g} m",
                      "-" if r.found is None else f"{r.found}/{r.expected}",
                      "-" if r.snr_db is None else f"{r.snr_db:.1f} dB",
                      "-" if r.spread_samples is None else f"{r.spread_samples:.2f} samples",
                      "ok" if r.ok else "; ".join(r.problems)))
    widths = [max(len(line[i]) for line in table) for i in range(len(table[0]))]
    lines = ["  ".join(cell.ljust(w) for cell, w in zip(line, widths)).rstrip() for line in table]
    return "\n".join(lines + report.problems + ["PASS" if report.passed else "FAIL"])


def _pattern_arg(text):
    try:
        return Pattern.of(text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("needs four numbers: f_start_hz,f_mid_hz,f_end_hz,duration_ms") from None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("wavs", nargs="+", help="recordings named with their distance, like 1m.wav 3m.wav 5m.wav")
    ap.add_argument("--role", default="A", choices=sorted(DEFAULT_PATTERNS), help="whose sweep was played")
    ap.add_argument("--pattern", type=_pattern_arg,
                    help="the sweep instead of a role's: f_start_hz,f_mid_hz,f_end_hz,duration_ms")
    ap.add_argument("--beeps", type=int, default=BEEPS, help="how many times the sweep was played")
    args = ap.parse_args(argv)
    pattern = args.pattern or DEFAULT_PATTERNS[args.role]
    report = stage_check(args.wavs, pattern, args.beeps)
    print(format_report(report))
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
