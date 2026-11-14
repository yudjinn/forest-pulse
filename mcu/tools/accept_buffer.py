"""Acceptance test: buffer integrity (synthetic source).

Default run (forced trigger):
  - waits until device uptime > 16 s (ring has lapped at least twice)
  - sends 'T', receives the whole event
  - PASS requires: pre-trigger frames == pre_frames (192,000 at 48 kHz),
    all CRCs valid, consecutive seq_nums, overrun flag never set,
    embedded frame index contiguous across the whole event (no drop/dup),
    first live frame == trigger frame, event closed by an END packet.

--acoustic: trigger via synthetic chainsaw ('S') instead of 'T'
            (exercises the RMS + Goertzel gate and debounce).
--cap:      hold the sound for 20 s and verify live streaming stops at 15 s.
--overrun:  stop reading for 4 s after trigger -> overrun flag MUST be set.
"""

import argparse
import sys
import time

import numpy as np

from fe_protocol import Assembler, Parser, seq_gaps, synth_frame_index
from fe_serial import DEFAULT_PORT, info, open_port


def wait_uptime(s, min_ms: int) -> dict:
    while True:
        d = info(s)
        if int(d["uptime_ms"]) >= min_ms and d["state"] in ("idle", "arming"):
            return d
        time.sleep(0.5)


def receive_event(s, timeout: float, pause_s: float = 0.0, stop_sound_after: float | None = None):
    parser, asm = Parser(), Assembler()
    t0 = time.monotonic()
    if pause_s:
        time.sleep(pause_s)  # simulate a host that is late to start reading
    sound_stopped = False
    while time.monotonic() - t0 < timeout:
        if stop_sound_after is not None and not sound_stopped and time.monotonic() - t0 >= stop_sound_after:
            s.write(b"s")
            sound_stopped = True
        for p in parser.feed(s.read(65536)):
            ev = asm.add(p)
            if ev is not None:
                if not sound_stopped and stop_sound_after is not None:
                    s.write(b"s")
                return ev, parser, asm
    return None, parser, asm


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=DEFAULT_PORT)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--acoustic", action="store_true")
    mode.add_argument("--cap", action="store_true")
    mode.add_argument("--overrun", action="store_true")
    args = ap.parse_args()

    s = open_port(args.port, timeout=0.05)
    s.write(b"s")  # make sure synthetic sound is off
    d = wait_uptime(s, 16000)
    rate, pre_expected = int(d["rate"]), int(d["pre_frames"])
    print(f"device: uptime={d['uptime_ms']} ms state={d['state']} floor={d['floor_dbfs']} dBFS")

    s.reset_input_buffer()
    if args.acoustic or args.cap:
        s.write(b"S")
        hold = 20.0 if args.cap else 3.0
        ev, parser, asm = receive_event(s, timeout=40.0, stop_sound_after=hold)
    else:
        s.write(b"T")
        ev, parser, asm = receive_event(s, timeout=30.0, pause_s=4.0 if args.overrun else 0.0)

    checks: list[tuple[str, bool, str]] = []
    if ev is None:
        print("FAIL: no complete event received")
        return 1

    audio = ev.audio()
    idx = synth_frame_index(audio).astype(np.int64)
    steps = np.diff(idx) & 0xFFFFFFFF
    discontinuities = int(np.count_nonzero(steps != 1))
    first_live = synth_frame_index(ev.live[0])[0] if ev.live else None
    trigger_ok = first_live is not None and (int(first_live) - int(idx[0])) & 0xFFFFFFFF == ev.pre_frames

    if args.overrun:
        checks.append(("overrun flag set", ev.overrun, f"flags={sorted(set(ev.flags))}"))
        checks.append(("discontinuity present", discontinuities > 0, f"{discontinuities}"))
    else:
        checks.append(("pre-trigger frames", ev.pre_frames == pre_expected, f"{ev.pre_frames} (want {pre_expected})"))
        checks.append(("overrun == 0", not ev.overrun, f"flags={sorted(set(ev.flags))}"))
        checks.append(("frame index contiguous", discontinuities == 0, f"{discontinuities} breaks"))
        checks.append(("first live frame == trigger", trigger_ok, f"first_live={first_live}"))
    checks.append(("CRC errors == 0", parser.crc_errors == 0, f"{parser.crc_errors}"))
    checks.append(("seq consecutive", seq_gaps(ev.seqs) == 0, f"{seq_gaps(ev.seqs)} gaps"))
    checks.append(("ended with END packet", ev.ended, ""))
    if args.cap:
        want = int(15.0 * rate)
        checks.append(("live capped at 15 s", ev.live_frames == want, f"{ev.live_frames} (want {want})"))
    elif not args.overrun:
        checks.append(("live duration", ev.live_frames > 0, f"{ev.live_frames / rate:.2f} s"))

    ok = True
    for name, passed, detail in checks:
        ok &= passed
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}: {detail}")
    print(f"packets={len(ev.seqs)} pre={ev.pre_frames} live={ev.live_frames} junk_bytes={parser.junk_bytes}")
    print("RESULT:", "PASS" if ok else "FAIL")
    s.write(b"s")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
