# forestpulse-sensor

The sensor side of Forest Pulse. Give it the front-end's audio; it runs the sound model and the server's detectors,
sends events (sound, confidence, time, angle) and keeps its sound list in sync. It never sends audio. The contract
it implements is [docs/device-api.md](../docs/device-api.md).

```
ESP32 packets ─► atech-serial-listener ─► sensor.feed_channels() ─► model + detectors ─► events ─► server
                                              angle_fn(window) ◄─┘ (your bearing code)
```

## Quick start on the Uno Q

1. **Add the dependency.** Put this line in `soc/atech-serial-listener/python/requirements.txt` (next to
   `main.py`; App Lab installs it into the app's environment when the app runs):

   ```
   forestpulse-sensor @ https://github.com/yudjinn/forest-pulse/archive/refs/heads/main.zip#subdirectory=sensor-sdk
   ```

   Boards need version 0.2.0 or later: the live site refuses older versions before they reach the server, and they
   look like they cannot reach it. To update an installed copy, `pip install --upgrade` the same line.

   No git needed. Installs `numpy` and `onnxruntime` (prebuilt for Linux ARM64) and the bundled 20 MB model;
   about 130 MB in total. Checked on Linux ARM64 with Python 3.13.

2. **Check the board computes the right thing, and how fast.** In the app's Python environment (or any Python 3.11+
   on the board with the package installed):

   ```sh
   python -m forestpulse_sensor.selftest
   ```

   Three `PASS` lines and the time per 10 s window. Please send us that number.

3. **Create `forestpulse.toml` next to `main.py`:**

   ```toml
   server_url = "https://forestpulse.paxid.com"
   sensor_key = "<live sensor key>"          # from the Forest Pulse team; "dev-key" for the dev server below
   sensor_id = "node-01"                     # optional, defaults to the hostname; must differ per board
   ```

   Queued events and the cached sound list are kept in `forestpulse-state/` next to this file, so they survive
   restarts as long as the app folder does.

4. **Wire it into `main.py`:**

   ```python
   from pathlib import Path
   from forestpulse_sensor import Sensor, board_to_angle

   def bearing(window):
       """window: (N, 3) int16 at 48 kHz, exactly the audio that was just classified.
       Return degrees, (degrees, confidence 0-1), or None if unsure."""
       theta, confidence = my_srp_phat(window)        # your code, board frame as in soc/README.md
       return board_to_angle(theta), confidence

   sensor = Sensor.from_file(Path(__file__).with_name("forestpulse.toml"), angle_fn=bearing).start()

   def on_audio(packet, mics, break_before: bool, frame_offset: int) -> None:
       sensor.feed_channels(mics, break_before=break_before or frame_offset == 0)

   # and at the end of EventTracker._end(), after the END packet:
   #     sensor.end_of_audio()
   ```

   Until the bearing code exists, leave out `angle_fn`; events then arrive without an angle.

5. **Or try it against a dev server on a laptop on the same network** (`server_url = "http://<laptop-ip>:8787"`):

   ```sh
   pip install ./sensor-sdk
   python -m forestpulse_sensor.devserver --host 0.0.0.0 --port 8787 --key dev-key
   ```

   It prints every event the board sends. Play a chainsaw near the mics and you should see
   `node-01: chainsaw 0.9x angle ...`.

## Angle convention

The API wants degrees **clockwise from the board's forward**, 0 to 360, seen from above. Forward must be marked on
the board. `board_to_angle(theta)` converts the counter-clockwise board-frame bearing from `soc/README.md`
(0 = toward mic 2, 90 = top edge), assuming forward is the **top edge, away from mic 3**. If forward is another
edge, pass it: `board_to_angle(theta, forward_ccw_deg=0)` means forward points toward mic 2.

## What the library does with the audio

- `feed()` / `feed_channels()` only queue audio and return immediately, so the USB reader never stalls. The model
  runs on its own thread (2 cores).
- Each burst is analysed every 2 s on its latest 10 s; shorter at the start of a burst, repeated to fill 10 s, which
  the model needs. `angle_fn` runs only for windows that produced a detection.
- The same sound is reported at most once every 5 s.
- The model is loaded once at `start()` (well under a second) and stays in memory (about 120 MB). Between bursts it
  uses no CPU.

## Testing without the ESP32

```sh
python -m forestpulse_sensor.replay capture.wav            # local stand-in server, prints what is heard
python -m forestpulse_sensor.replay --angle 45 capture.wav # pretend the bearing code said 45 degrees
python -m forestpulse_sensor.replay --config forestpulse.toml capture.wav   # send to a real server
```

Any 16-bit WAV, for example the receiver's 3-channel captures. Each file is played as one burst.

## When things go wrong

- **No network or server down:** keeps detecting with the last sound list it had (a built-in one before the first
  check-in), queues up to 500 events on disk (oldest dropped first) and delivers each exactly once when the server
  is back.
- **Wrong sensor key:** logs `sensor key rejected` and keeps everything queued; fixing the key delivers it.
- **Server sends a broken sound list:** keeps the previous list and logs why.
- **Model or `angle_fn` raises:** logged; the window is skipped or reported without an angle.
- **Analysis more than 60 s behind:** drops the oldest audio and logs it, rather than blocking the reader.
- `sensor.status` gives sound list version, queue length, dropped count, key state and last successful check-in.

## Running the model yourself instead

If you keep your own model pipeline, call `sensor.report(scores, embedding, angle_deg, angle_confidence)` per window
and don't call `feed()`. It must match ours exactly: 32 kHz mono, 10 s windows, shorter ones repeated to fill 10 s.
Run your pipeline on `forestpulse_sensor/data/reference/*.wav` and compare with `expected.json` (embedding cosine
similarity above 0.999). Using the bundled model through `feed()` avoids all of this.

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
