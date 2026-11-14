"""Play WAV files through the sensor as if the front-end had sent them, to test without the ESP32.

usage: python -m forestpulse_sensor.replay capture.wav [more.wav ...]                  # local, prints what is heard
       python -m forestpulse_sensor.replay --config sensor.toml capture.wav            # sends to that server

Each file is one audio burst, fed in front-end-sized packets. 16-bit WAV, any channel count and sample rate.
"""
import argparse
import logging
import tempfile
import time

from .selftest import read_wav
from .sensor import Sensor

PACKET = 679


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("wavs", nargs="+")
    ap.add_argument("--config", help="TOML with server_url and sensor_key; omit to use a local stand-in server")
    ap.add_argument("--angle", type=float, help="pretend the bearing code returned this angle (degrees)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    angle_fn = (lambda window: args.angle) if args.angle is not None else None
    server = None
    rates = {read_wav(w)[1] for w in args.wavs}
    if len(rates) != 1:
        raise SystemExit(f"all files must share one sample rate, got {sorted(rates)}")
    rate = rates.pop()
    if args.config:
        sensor = Sensor.from_file(args.config, sample_rate=rate, angle_fn=angle_fn)
    else:
        from .devserver import serve

        server, _ = serve(port=0, key="replay")
        port = server.server_address[1]
        sensor = Sensor(f"http://127.0.0.1:{port}", "replay", sensor_id="replay", sample_rate=rate,
                        state_dir=tempfile.mkdtemp(prefix="forestpulse-replay-"), angle_fn=angle_fn,
                        checkin_interval=1.0)
    sensor.start()
    for path in args.wavs:
        frames, _ = read_wav(path)
        print(f"--- {path}: {len(frames) / rate:.1f} s, {frames.shape[1]} channel(s)", flush=True)
        for i in range(0, len(frames), PACKET):
            while sensor.backlog_seconds > 10:  # faster than real time, but never past the safety buffer
                time.sleep(0.05)
            sensor.feed(frames[i:i + PACKET], break_before=(i == 0))
        sensor.end_of_audio()
    time.sleep(1.0)
    sensor.stop(flush_timeout=10)
    print(f"done: {sensor.status['queued_events']} event(s) still queued", flush=True)
    if server:
        server.shutdown()


if __name__ == "__main__":
    main()
