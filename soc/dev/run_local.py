"""Run the Uno Q app's pipeline on a laptop against the ESP32 on USB.

Same Receiver + Pipeline as python/main.py, but reading /dev/ttyACM0 directly
(DTR/RTS asserted) instead of the serial-bridge container, and printing the
LED arrow in the terminal. Events are stored under ./data/.

The ESP32 is found by its USB ID (Espressif 303a); other CDC devices such
as the UNO Q itself also show up as /dev/ttyACM*.

Usage: uv run run_local.py [--port PATH] [--force-after 3] [--no-require-chainsaw] [--temp 22]
"""
import argparse
import time

import serial
from serial.tools import list_ports

from harness import Climate, led_arrow, make_pipeline
from receiver import Receiver


def find_esp32() -> str:
    ports = [p for p in list_ports.comports() if p.vid == 0x303A]
    if not ports:
        others = ", ".join(f"{p.device} ({p.description})" for p in list_ports.comports() if p.vid) or "none"
        raise SystemExit(f"no ESP32 (USB 303a) found; serial ports: {others}")
    return ports[0].device


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", help="default: auto-detect the ESP32 by USB ID")
    ap.add_argument("--data", default="data")
    ap.add_argument("--force-after", type=float, help="send T (force an event) after N seconds")
    ap.add_argument("--duration", type=float, default=0, help="stop after N seconds (0 = run forever)")
    ap.add_argument("--no-require-chainsaw", action="store_true")
    ap.add_argument("--temp", type=float, help="simulated Modulino Thermo temperature (C)")
    ap.add_argument("--rh", type=float, default=50.0)
    ap.add_argument("--test-tone", type=float, default=0, help="TEST: LED arrow for a pure tone at this Hz")
    args = ap.parse_args()

    def show(bits: str) -> None:
        if not bits:
            print("[led] (cleared)")
            return
        print(led_arrow.to_ascii([[int(bits[r * 13 + c]) for c in range(13)] for r in range(8)]))

    climate = Climate()
    if args.temp is not None:
        climate.update(args.temp, args.rh)
        climate.stale_s = float("inf")
    pipe = make_pipeline(args.data, {"led": {"require_chainsaw": not args.no_require_chainsaw},
                                     "test_tone_hz": args.test_tone},
                         display=show, climate=climate)
    pipe.start()

    s = serial.Serial()
    s.port, s.baudrate, s.timeout = args.port or find_esp32(), 115200, 0.05
    print(f"[serial] {s.port}")
    s.dtr = s.rts = True  # DTR=0 & RTS=1 would reset the ESP32
    s.open()
    rx = Receiver(pipe.queue, on_text=lambda t: print(f"[atech] {t}"))
    s.write(b"I")
    t0, forced = time.monotonic(), False
    try:
        while not args.duration or time.monotonic() - t0 < args.duration:
            if args.force_after is not None and not forced and time.monotonic() - t0 >= args.force_after:
                s.write(b"T")
                forced = True
            rx.feed(s.read(65536))
    except KeyboardInterrupt:
        pass
    time.sleep(1.0)  # let the worker finish the last event


if __name__ == "__main__":
    main()
