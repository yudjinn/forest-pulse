"""Replay a recorded 3-channel event WAV through the Uno Q pipeline on a laptop.

The WAV is treated as one ESP32 event (first 4 s pre-trigger, rest live),
encoded into real protocol packets and fed through Receiver + Pipeline
exactly as on the device. Prints the event record and the LED arrow.

Usage: uv run replay.py ../../mcu/tools/events/event_001.wav [--no-require-chainsaw] [--temp 25 --rh 40]
"""
import argparse
import json
import tempfile

from harness import Climate, led_arrow, load_wav, make_pipeline, replay


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--no-require-chainsaw", action="store_true", help="show the arrow for any located source")
    ap.add_argument("--temp", type=float, help="simulate a Modulino Thermo reading (C)")
    ap.add_argument("--rh", type=float, default=50.0)
    ap.add_argument("--quiet", action="store_true", help="hide per-second receiver lines")
    args = ap.parse_args()

    frames = []
    climate = Climate()
    if args.temp is not None:
        climate.update(args.temp, args.rh)
    log = (lambda s: None if s.startswith("[atech]") else print(s)) if args.quiet else print
    with tempfile.TemporaryDirectory() as d:
        pipe = make_pipeline(d, {"led": {"require_chainsaw": not args.no_require_chainsaw}},
                             display=frames.append, log=log, climate=climate)
        rec = replay(load_wav(args.wav), pipe, log=log)
    rec["bearing"]["series"] = f"<{len(rec['bearing']['series'])} windows>"
    print(json.dumps(rec, indent=2))
    lit = [f for f in frames if f]
    if lit:
        print("\nLED matrix (last arrow):")
        bits = lit[-1]
        print(led_arrow.to_ascii([[int(bits[r * 13 + c]) for c in range(13)] for r in range(8)]))
    else:
        print("\nLED matrix: no arrow (not classified as chainsaw, or no reliable bearing)")


if __name__ == "__main__":
    main()
