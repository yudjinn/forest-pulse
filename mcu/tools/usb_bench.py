"""M1: measure sustained USB-Serial/JTAG throughput and verify data integrity.

Usage: uv run usb_bench.py [--port /dev/ttyACM0] [--mb 16]
Go/no-go: >= 450 KB/s sustained (288 KB/s live @48 kHz + backlog catch-up).
"""

import argparse
import struct
import sys
import time

import numpy as np

from fe_serial import DEFAULT_PORT, info, open_port

REQUIRED_KBPS = 450.0
LIVE_KBPS = 288.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=DEFAULT_PORT)
    ap.add_argument("--mb", type=float, default=16.0, help="megabytes to transfer")
    args = ap.parse_args()

    total = int(args.mb * 1024 * 1024) // 4 * 4
    s = open_port(args.port, timeout=3.0)
    print("device:", info(s))

    s.write(b"B" + struct.pack("<I", total))
    buf = bytearray()
    t0 = None
    while len(buf) < total:
        chunk = s.read(min(65536, total - len(buf)))
        if not chunk:
            print(f"timeout after {len(buf)} bytes", file=sys.stderr)
            return 1
        if t0 is None:
            t0 = time.perf_counter()
            first = len(chunk)
        buf += chunk
    dt = time.perf_counter() - t0
    kbps = (len(buf) - first) / dt / 1000.0

    words = np.frombuffer(bytes(buf), dtype="<u4")
    bad = np.flatnonzero(words != np.arange(words.size, dtype=np.uint32))
    print(f"transferred {len(buf)} B in {dt:.2f} s -> {kbps:.0f} KB/s")
    print(f"pattern errors: {bad.size}" + (f" (first at word {bad[0]})" if bad.size else ""))
    catch_up_s = 4 * LIVE_KBPS / max(kbps - LIVE_KBPS, 1e-9)
    print(f"4 s backlog catch-up time at this rate: {catch_up_s:.1f} s")
    ok = kbps >= REQUIRED_KBPS and bad.size == 0
    print("RESULT:", "PASS" if ok else "FAIL", f"(need >= {REQUIRED_KBPS:.0f} KB/s, no errors)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
