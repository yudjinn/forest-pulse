# forestpulse-sensor

The sensor side of Forest Pulse. Give it the front-end's audio; it runs the sound model and the server's detectors,
sends events (sound, confidence, time, angle) and keeps its sound list in sync. It never sends audio. The contract
it implements is [docs/device-api.md](../docs/device-api.md).

```
ESP32 packets ─► your code (atech-serial-listener) ─► sensor.feed() ─► model + detectors ─► events ─► server
                                                         angle_fn(window) ◄─┘ (your bearing code)
```

## Install

Python 3.11+. Dependencies: `numpy`, `onnxruntime` (prebuilt for Linux ARM64). The 20 MB model ships inside the
package.

```sh
pip install ./sensor-sdk            # or add the folder to the app's requirements
python -m forestpulse_sensor.selftest
```

`selftest` checks this machine produces the reference model output and prints how long one 10 s window takes.
Run it on the Uno Q first.

## Use it in the Uno Q app

Config file (TOML):

```toml
server_url = "https://forestpulse.paxid.com"   # or the dev server, see below
sensor_key = "..."                              # the shared sensor key
sensor_id = "node-01"                           # optional, defaults to the hostname
state_dir = "/app/data/forestpulse"             # must survive restarts: queued events and the sound list live here
```

In `soc/atech-serial-listener/python/main.py`:

```python
from forestpulse_sensor import Sensor, board_to_angle

def bearing(window):
    """window: (N, 3) int16 at 48 kHz, the audio that was just classified. Return degrees, (degrees, 0-1
    confidence) or None. Degrees are clockwise from the board's forward; board_to_angle() converts a
    counter-clockwise board-frame bearing as in soc/README.md."""
    theta, confidence = my_srp_phat(window)            # your code
    return board_to_angle(theta), confidence

sensor = Sensor.from_file("/app/forestpulse.toml", angle_fn=bearing).start()

def on_audio(packet, mics, break_before: bool, frame_offset: int) -> None:
    sensor.feed_channels(mics, break_before=break_before or frame_offset == 0)

# in EventTracker._end(), after the END packet:
#     sensor.end_of_audio()
```

- `feed()` / `feed_channels()` only queue audio and return immediately, so the USB reader never stalls. The model
  runs on its own thread.
- Each burst is analysed every 2 s on its latest 10 s (shorter at the start of a burst, repeated to fill 10 s).
  `angle_fn` is called only for windows that produced a detection, with exactly that audio.
- The same sound is reported at most once every 5 s.
- Running the model yourself instead (for example with PyTorch): call `sensor.report(scores, embedding, angle_deg,
  angle_confidence)` per window and skip `feed()`. Your scores and embedding must match the reference: run your
  pipeline on `forestpulse_sensor/data/reference/*.wav` and compare with `expected.json` (embedding cosine
  similarity above 0.999). It must use 32 kHz mono, 10 s windows, shorter windows repeated to fill 10 s.

## When things go wrong

- **No network or server down:** keeps detecting with the last sound list it had (the built-in one before the
  first check-in), queues up to 500 events on disk (oldest dropped first) and delivers them when the server is
  back, each exactly once.
- **Wrong sensor key:** logs `sensor key rejected` and keeps everything queued; fixing the key delivers it.
- **Server sends a broken sound list:** keeps the previous list, logs why.
- **Model or `angle_fn` raises:** logged; the window is skipped or reported without an angle.
- `sensor.status` gives sound list version, queue length, dropped count, key state and last successful check-in.

## Before the real server exists

```sh
python -m forestpulse_sensor.devserver --host 0.0.0.0 --port 8787 --key dev-key
```

A local stand-in implementing the same API in memory. It prints every event. Point `server_url` at
`http://<laptop-ip>:8787` with `sensor_key = "dev-key"`. `PUT /dev/sounds` replaces the sound list,
`GET /dev/events` lists what arrived.

## Laptop as a sensor (stage backup)

```sh
pip install "./sensor-sdk[mic]"
python -m forestpulse_sensor.mic --config laptop.toml
```

Uses the laptop's microphone, so there is no angle.

## Tests

```sh
pip install "./sensor-sdk[dev]" && pytest sensor-sdk/tests
```

Three journeys against the dev server with the real model: detection with angle and sound-list updates (including a
broken list), surviving an outage, a wrong key and a restart, and the bring-your-own-model path.
