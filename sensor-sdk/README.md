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

   The sensor checks in every 3 s; the plan shows a board Offline after 10 s without one. A board still on a
   library before 0.4.0 checks in every 10 s and flickers Offline: until it upgrades, add this line to the file:

   ```toml
   checkin_interval = 3
   ```

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

## Calibration hooks

With these, the board takes part when a researcher presses Calibrate: it beeps at the other boards and the plan
places them at the measured distances (the run itself is in [docs/device-api.md](../docs/device-api.md),
"Calibration"; version 0.3.0 or later). Give the sensor one object with the hooks below:

```python
class CalibrationHooks:
    fs = 48000                    # the stream's sample rate
    emitter_offset_m = 0.05       # buzzer to the centre of the mic array, metres
    forward_ccw_deg = 90.0        # the marked forward in the board frame (soc/README.md), as for board_to_angle()
    mic_positions_m = ((-0.04, 0.0), (0.0, 0.0), (0.0, -0.06))   # optional: measured mic positions, board frame

    def start_stream(self) -> bool: ...
    def stop_stream(self) -> None: ...
    def emit(self, f_start_hz, f_mid_hz, f_end_hz, duration_ms) -> None: ...
    def speed_of_sound(self) -> float: ...
    def bearing(self, window, band_hz): ...

sensor = Sensor.from_file(Path(__file__).with_name("forestpulse.toml"), angle_fn=bearing,
                          calibration=CalibrationHooks()).start()
```

- **`start_stream()`**: switch the front-end to continuous streaming. It must end any running recording first: the
  firmware ignores the start command while a recording is active. Return False when there is no stream. The
  streamed audio arrives through your usual `on_audio` callback and `sensor.feed_channels()`; mark the first packet
  `break_before=True` and any later gap the same way.
- **`stop_stream()`**: back to triggered recordings.
- **`emit(f_start_hz, f_mid_hz, f_end_hz, duration_ms[, volume])`**: play one sweep on the emitter now (the service
  sends the values, whole numbers when they are whole). Raise or return False if it fails. Give it a `volume` keyword
  to receive the level the researcher chose for the run (a fraction of full scale, 0 to 1; the alarm passes its
  own); without one it is never passed and the board plays at its own level.
- **`speed_of_sound()`**: metres per second from the board's thermometer. If it raises or answers outside 300 to
  380 m/s the library assumes 343 and the result says so.
- **`bearing(window, band_hz)`**: the direction of the one arrival in `window` (an (N, 3) int16 array at `fs`, the
  whole sweep from 5 ms before the beep's first path, so the band is wide enough to tell the mics' delays apart), using only `band_hz` (low, high). Return
  `(angle_deg, quality)` with degrees clockwise from the board's forward (as `angle_fn` does) and quality 0 to 1,
  or None if unsure. Each call must take under 200 ms; a slower answer is not used.
- **The self-check** runs when the sensor is created: every hook above must be there, and `fs`, `emitter_offset_m`
  and `forward_ccw_deg` set to numbers (`mic_positions_m`, when given, must list 3 mics). If anything is missing the
  log says what, and the board reports that it cannot calibrate; everything else works as before.
- During a run the board checks in every second, records continuously (the library keeps the last 20 s), and
  reports no sound events. It never sends audio.

The service turns the two boards' bearings of each other into their facings on the plan, so a bearing that is
wrong turns a board the wrong way; return None rather than guess.

To build and test without the boards, `forestpulse_sensor.calibration.simulate` has simulated hooks over a
simulated stage (positions, facings, clocks, buzzers, an echo and talk); `SimulatedHooks` has the same interface.

## Stage check (before the demo)

Whether the stage and the buzzer are good enough to calibrate, from three recordings:

1. One board on the stage records continuously (the receiver's 3-channel 16-bit capture).
2. A second board, or the buzzer held by hand, 1 m away plays its sweep 10 times, 1 s apart. From the device
   app, with only the emit hook:

   ```python
   from forestpulse_sensor.calibration.stagecheck import play_sweeps
   play_sweeps(hooks.emit)            # role A's sweep; play_sweeps(hooks.emit, "B") for B's
   ```

   Save the recording as `1m.wav`. Repeat at 3 m and 5 m (`3m.wav`, `5m.wav`). The distance must be in the name.
3. Run the check:

   ```sh
   python -m forestpulse_sensor.calibration.stagecheck 1m.wav 3m.wav 5m.wav
   ```

   ```
   file    distance  beeps  SNR      spread        result
   1m.wav  1 m       10/10  46.2 dB  0.09 samples  ok
   3m.wav  3 m       10/10  37.0 dB  0.20 samples  ok
   5m.wav  5 m       10/10  32.0 dB  0.78 samples  ok
   PASS
   ```

- **beeps:** how many of the 10 were found.
- **SNR:** the worst beep's signal-to-noise after matching against the sweep.
- **spread:** how much the arrival differences between the mics vary from beep to beep, in samples; it shows how
  precisely arrivals are found, whatever the buzzer's own timing.
- **PASS** needs, in every file: all beeps found and none weak (a mic missed it, or the mics disagree by more than
  the array allows), SNR at least 15 dB, spread at most 2 samples; and at least one file at 5 m or farther.
  Otherwise the row (or a line under the table) says why and the check ends with **FAIL** (exit code 1); a file
  that is not 3-channel 16-bit, or has no beep, is a fail too.

A FAIL means: don't rely on calibration on this stage; place the sensors by hand. If the service's sweeps were
retuned, pass the one played: `--pattern 1500,2500,3500,120`.

## Warning alarm

When a researcher sends a logging warning, every board that heard the logging plays the alarm on its buzzer, standing
in for a radio warning to the loggers. It uses the `emit` hook from the calibration hooks above; nothing else to
wire: a board whose hooks have `emit` tells the service it can warn, even when the other calibration hooks are
missing. `play_alarm` is there since version 0.4.0; taking warnings from the service on the check-in reply needs
0.6.0 or later (the contract is [docs/device-api.md](../docs/device-api.md), "Warnings"). To hear the alarm on a
board from the device app:

```python
from forestpulse_sensor.alarm import play_alarm
play_alarm(hooks.emit)            # True when every tone played, False if emit raised or returned False
```

- **The sound:** constant tones alternating 3500 Hz and 2500 Hz, each 120 ms, one starting every 150 ms (a 30 ms
  gap), 33 tones, about 5 s. Each tone is `emit(f, f, f, 120)`. The tones start on the clock, whatever the hook
  takes; a hook that raises or returns False stops the alarm at once, and the log says which tone failed.
- **The hook:** `emit` must accept equal start, middle and end frequencies (a constant tone) and return within the
  tone's duration.
- **During a warning** the alarm plays on a thread of its own, so the board keeps checking in and delivering events
  while it sounds. The sensor reports no sound events while the alarm plays, and the audio fed meanwhile (and for
  half a second after, which the front-end may still be delivering) never reaches sound checking and is not counted
  in recordings per minute, so its own alarm never counts as logging. Then it is back to normal, and it confirms
  played or failed at the next check-in. A board already playing ignores a new alarm until it is done, and a board
  taking part in a calibration run never plays one. `sensor.status` says `can_warn` and `alarm_playing`.

## Trigger health hook

Optional (version 0.5.0 or later). With it, the plan card shows what the front-end's trigger is set to and how quiet
the room is. Without it, the card still shows recordings per minute, which the library counts itself: the audio
bursts that started in the last 60 s, a burst being audio fed with `break_before=True` (a laptop microphone streams
without breaks, so it counts none).

Pass your existing trigger settings object as it is:

```python
trigger = TriggerSettings(send_command, cfg["trigger"])    # your object: current() and update()
sensor = Sensor.from_file(Path(__file__).with_name("forestpulse.toml"), angle_fn=bearing,
                          trigger_settings=trigger).start()
```

The library uses only these, on any object:

- **`current()`**: the trigger values the front-end confirmed, as a dict with any of `snr_db`, `ratio_db` and
  `coherence` (numbers), or None before the front-end has reported. Other keys are ignored.
- **`noise_floor_dbfs()`** (optional): the front-end's current noise floor in dBFS, or None. Add it to your object
  to have the card show the noise floor.

The library reads them at each check-in, on its sync thread, and never changes them: it never calls `update()` or
anything else. They should answer in well under 50 ms, since a slow answer delays that check-in.

When an answer is unusable, the board still checks in and only that value is left out: a call that raises,
`current()` returning something other than a dict or None, or a value that is not a number. The log says why, once
per kind of problem (not at every check-in), and also says once when `current()` returned None or the object has no
`noise_floor_dbfs()`.

To check the wiring, point the board at the dev server (quick start, step 5). It prints each check-in:

```
node-01: check-in, 12 recordings/min, trigger snr_db 4.0 ratio_db 0.0 coherence 0.6, noise floor -52.0 dBFS
node-01: check-in, 0 recordings/min, trigger missing, noise floor missing
```

## Tests

```sh
pip install "./sensor-sdk[dev]" && pytest sensor-sdk/tests
```

Journeys against the dev server with the real model: detection with angle and sound-list updates (including a
broken list), surviving an outage, a wrong key and a restart, the check-in interval, the bring-your-own-model path,
trigger health from a well-behaved and a broken hook, a warning's alarm played while check-ins go on and confirmed
(and a failing buzzer confirming failed), and a calibration run of two simulated boards whose reports
range to the true distance. Two focused calibration tests: finding each
role's sweep under hall noise, speech and a wall echo, and the stage check on simulated recordings.
