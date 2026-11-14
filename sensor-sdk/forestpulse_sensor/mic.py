"""Run this computer as a sensor using its own microphone (the stage backup). One mic, so no angle.

usage: python -m forestpulse_sensor.mic --config sensor.toml
Needs the `mic` extra: pip install "forestpulse-sensor[mic]"
"""
import argparse
import logging
import threading

from .sensor import Sensor


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", required=True, help="TOML with server_url, sensor_key, optional sensor_id")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    import sounddevice as sd

    sensor = Sensor.from_file(args.config, sample_rate=48000).start()
    stream = sd.InputStream(samplerate=48000, channels=1, dtype="int16", blocksize=4800,
                            callback=lambda data, n, t, status: sensor.feed(data.copy(), break_before=bool(status)))
    with stream:
        print(f"listening as {sensor.sensor_id}; Ctrl+C to stop", flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
    sensor.stop()


if __name__ == "__main__":
    main()
