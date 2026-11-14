"""Live trigger monitor: level, floor, band ratio, inter-mic coherence, state.

Usage: uv run monitor.py [--port /dev/ttyACM0] [--hz 4]

Only one program can open the serial port at a time. To watch status AND
save events, run `uv run receiver.py` instead (it shows the same status).
Play a sound near the array (e.g. a chainsaw clip on a phone, held at a
distance) and watch coherence rise towards 1 while diffuse background stays low.
"""

import argparse
import time

from fe_serial import DEFAULT_PORT, info, open_port


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=DEFAULT_PORT)
    ap.add_argument("--hz", type=float, default=4.0)
    args = ap.parse_args()
    s = open_port(args.port)
    print(f"{'time':>6} {'state':>7} {'m1 dBFS':>8} {'floor':>7} {'ratio dB':>8} {'coh':>5}  gate bars")
    t0 = time.monotonic()
    while True:
        d = info(s)
        coh = float(d["coherence"])
        bar = "#" * int(coh * 20)
        print(
            f"{time.monotonic() - t0:6.1f} {d['state']:>7} {float(d['rms_dbfs']):8.1f} "
            f"{float(d['floor_dbfs']):7.1f} {float(d['ratio_db']):8.1f} {coh:5.2f}  {bar:<20}| events={d['events']}"
        )
        time.sleep(1.0 / args.hz)


if __name__ == "__main__":
    main()
