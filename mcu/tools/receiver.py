"""Receive events from the front-end, validate them, save 3-channel WAVs, and
show live trigger status (level / floor / ratio / coherence / state).

Only one program can have the serial port open at a time, so this is also
the live monitor: use it instead of running monitor.py alongside.

Usage:
  uv run receiver.py [--port /dev/ttyACM0] [--out events/] [--duration 60]
                     [--status-hz 4 | --status-hz 0] [--trigger-after S]
                     [--sound-after S --sound-for S]
"""

import argparse
import os
import sys
import time

from fe_protocol import Assembler, Parser, seq_gaps, write_wav
from fe_serial import DEFAULT_PORT, info, open_port


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=DEFAULT_PORT)
    ap.add_argument("--out", default="events")
    ap.add_argument("--duration", type=float, default=60.0, help="seconds to listen")
    ap.add_argument("--status-hz", type=float, default=4.0, help="live status rate (0 = off)")
    ap.add_argument("--trigger-after", type=float, help="send force-trigger 'T' after S seconds")
    ap.add_argument("--sound-after", type=float, help="synthetic chainsaw on after S seconds")
    ap.add_argument("--sound-for", type=float, default=5.0, help="synthetic chainsaw duration")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    s = open_port(args.port, timeout=0.05)
    print("device:", info(s))

    parser, asm = Parser(), Assembler()
    t0 = time.monotonic()
    next_status = 0.0
    sent_t = sound_on = sound_off = False
    if args.status_hz > 0:
        print(f"{'time':>6} {'state':>7} {'m1 dBFS':>8} {'floor':>7} {'ratio dB':>8} {'coh':>5}  coherence")
    while (now := time.monotonic() - t0) < args.duration:
        if args.status_hz > 0 and now >= next_status:
            s.write(b"I")  # reply arrives interleaved between packets
            next_status = now + 1.0 / args.status_hz
        for line in parser.lines:
            if line.startswith("INFO "):
                d = dict(kv.split("=", 1) for kv in line[5:].split() if "=" in kv)
                coh = float(d.get("coherence", 0))
                print(
                    f"{now:6.1f} {d.get('state', '?'):>7} {float(d.get('rms_dbfs', 0)):8.1f} "
                    f"{float(d.get('floor_dbfs', 0)):7.1f} {float(d.get('ratio_db', 0)):8.1f} {coh:5.2f}  "
                    f"{'#' * int(coh * 20):<20}| events={d.get('events')} streaming={d.get('streaming')}"
                )
        parser.lines.clear()
        if args.trigger_after is not None and not sent_t and now >= args.trigger_after:
            s.write(b"T")
            sent_t = True
            print(f"[{now:6.2f}s] sent T")
        if args.sound_after is not None:
            if not sound_on and now >= args.sound_after:
                s.write(b"S")
                sound_on = True
                print(f"[{now:6.2f}s] synth sound ON")
            if sound_on and not sound_off and now >= args.sound_after + args.sound_for:
                s.write(b"s")
                sound_off = True
                print(f"[{now:6.2f}s] synth sound OFF")
        for p in parser.feed(s.read(65536)):
            ev = asm.add(p)
            if ev is not None:
                path = os.path.join(args.out, f"event_{len(asm.done):03d}.wav")
                write_wav(path, ev)
                print(
                    f"[{now:6.2f}s] event {len(asm.done)}: pre={ev.pre_frames} live={ev.live_frames} "
                    f"({ev.live_frames / ev.sample_rate:.2f} s) overrun={ev.overrun} "
                    f"seq_gaps={seq_gaps(ev.seqs)} -> {path}"
                )
    if asm.current is not None:
        print(f"event still open at exit: pre={asm.current.pre_frames} live={asm.current.live_frames}")
    print(
        f"packets={len(asm.all_seqs)} seq_gaps={seq_gaps(asm.all_seqs)} "
        f"crc_errors={parser.crc_errors} junk_bytes={parser.junk_bytes}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
