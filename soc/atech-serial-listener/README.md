# Atech Serial Listener (Arduino UNO Q)

The node app for the Uno Q. The atech board (ESP32, 3 mics) streams binary audio packets over USB to the Uno Q's Linux side. For each event the app:
- leaves **classification to the server SDK**. The on-device EfficientAT/ONNX classifier (`classifier.py`) is kept but commented out in `main.py` and `requirements.txt`, and its model files are no longer shipped (regenerate them with `experiments/efficientat-chainsaw/export_onnx.py` if it's ever re-enabled);
- estimates the **bearing** (GCC-PHAT / SRP-PHAT), using the speed of sound from a Modulino Thermo;
- **stores** the event (WAV + JSON);
- hands the record to the **uplink**, a stub until the server API exists;
- shows a **direction arrow** on the Uno Q's LED matrix for every event with a reliable bearing (`led.require_chainsaw` is off, since the node no longer classifies).

```
atech ESP32 --USB CDC--> /dev/ttyACM0 (Linux host)
        |  (device mapped into)
        v
[serial-bridge container: socat]  TCP :5000 on the App's Docker network
        |
        v
[App Python container]
  reader thread:  Receiver (parse packets, follow events; never blocks)
        | queue
  worker thread:  Pipeline -> bearing.py, classifier.py, storage.py, uplink.py
        |
        +--Bridge "led_frame" (arrow), "serial_event" (summary)--> [STM32 sketch]
        <--Bridge "trigger_pin" (D7), "climate" (Modulino Thermo)---
        <--Bridge "send_to_board" (single-byte commands I/T/C/X)----
```

**Why the extra container:** App Lab's Python container is not given `/dev/tty*`, and `app.yaml` can't add devices. A custom Brick's `brick_compose.yaml` *can* (Docker Compose `devices:` key). That needs App Lab 0.7 or newer.

**Hardware:**
- The UNO Q's USB-C port only acts as a USB host through a **powered USB-C hub**. Without one, nothing shows up in `lsusb`.
- The ESP32's notify line (ATech port 6 D1, 3.3 V, HIGH from trigger until the event's END packet) goes to UNO Q header pin **D7**. Its rising edge gives each event a precise trigger time.
- **Modulino Thermo** on the Qwiic connector (optional): temperature + humidity → speed of sound `c = 331.3 + 0.606·T + 0.0124·RH`. Without it, or after 60 s with no valid reading, 343 m/s is used. Each event record shows which value was used.

## Files (`python/`)

| File | Role |
|---|---|
| `main.py` | App Lab glue: socket reader, Bridge callbacks, builds the pipeline. The only file importing `arduino.app_utils`. |
| `receiver.py` | bytes → `EventStart` / `AudioBlock` / `EventEnd` (`events.py`), console summaries |
| `pipeline.py` | worker: live + final bearing, classification, record, storage, uplink, LED |
| `bearing.py` | GCC-PHAT pair delays + SRP-PHAT 1° grid; quality gate; circular mean |
| `classifier.py` | numpy mel frontend + ONNX Runtime; mono mix, 48 → 32 kHz, 10 s tiling |
| `climate.py` | Modulino readings → speed of sound, with fallback |
| `sdk_glue.py` | sensor SDK glue: `SensorTee` (audio → SDK + pipeline), `DetectionBearing` (`angle_fn`), `CalibrationHooks` (location calibration) |
| `led_arrow.py` | renders the 8×13 arrow (the sketch only displays it) |
| `storage.py` / `uplink.py` | events on disk (newest 50 kept) / **stub** uplink that queues records in `data/outbox/` |
| `config.json` | node id, mic geometry, thresholds, LED mounting rotation |
| `requirements.txt` | `numpy`, `onnxruntime` (installed by App Lab into the container) |

## What happens per event
- **Live, while streaming:**
  - a bearing for the newest 0.5 s window, every 0.5 s;
  - classification of the newest ≤10 s every 2 s;
  - once the event is classified as a chainsaw (score ≥ 0.2) and at least 3 bearing windows pass the quality gate, the LED arrow shows the current direction.
- **At the event end:**
  - bearing over the whole event (0.5 s windows, 0.25 s hop, never across a discontinuity);
  - classification over 10 s windows (best chainsaw score);
  - the record (`data/events/<id>.json`, schema as in [`soc/README.md`](../README.md) §4) plus the WAV, then the uplink stub;
  - the arrow holds for 10 s, then clears.
- **Bearing quality gate:**
  - the window isn't quieter than the event's own pre-trigger background;
  - the SRP peak is at least 3× the median;
  - the three pair delays agree within 1 sample;
  - at least 3 such windows are needed for a bearing.

  On 2 min of hall background this yields no bearing. On the phone-clip test event it gives 276.7° ± 0.9°.

## LED matrix
Rendered in Python (`matrix_display.py`, `led_arrow.py`); the sketch only draws the frames. Highest priority first:
1. **Direction arrow**, for 10 s after the SDK detects a sound with a reliable bearing.
2. **"CAL"** while a location calibration runs.
3. **Ticker**: one scroll of temperature, humidity and a server icon (a cloud with a check mark when connected, with an X when not), then the **live sound meter** for 6 s (a rolling bar graph of the level above the ESP32's noise floor; 8 rows = 24 dB), then repeat. Temperature and humidity are left out without a Modulino Thermo.

`config.json` `matrix`: `ticker` (false = arrow only), `scroll_ms` (120), `meter_s` (6), `level_poll_s` (0.25: how often the ESP32's INFO is polled for the meter; INFO is logged only once per connection and then once a minute). Preview on a laptop: `python python/matrix_display.py`.

## Status LED (LED3, the RGB LED next to the matrix)
Highest priority first:

| LED | Meaning |
|---|---|
| red, solid | the ESP32 isn't connected or hasn't answered `INFO`, or the Python app stopped reporting (no `node_status` for 10 s), e.g. while the app restarts |
| blue, solid | an event is being recorded (from the packet stream; the D7 wire isn't needed) |
| yellow, slow blink (1 s on / 1 s off) | no server connection: no successful SDK check-in for 30 s, the key was rejected, or no `forestpulse.toml` |
| green, solid | all good |

Python sends `node_status(esp_ok, server_ok, recording)` on every change (within 0.25 s) and at least every 2 s, and logs ESP32/server changes as `[status] ESP32 OK, server OK`. The LED is active-low (common anode): the sketch writes `LOW` to light a colour.

## Location calibration
Contract and method: [`LocationCalibrationIntegrationSpec.md`](../../LocationCalibrationIntegrationSpec.md). The sensor SDK runs the calibration; this app only provides `CalibrationHooks` (`sdk_glue.py`):
- `start_stream()` / `stop_stream()` send `C` / `X` to the ESP32 (continuous stream). While calibrating, every block still goes to the SDK, but our own pipeline is bypassed: no event bearing, WAV or LED.
- Every node plays the same rising sweep (`calibration.sweep`, 1.5 → 3.5 kHz, 300 ms) in its own 500 ms slot; the SDK tells beeps apart by slot. Set `calibration.test_beep_every_s` to hear it every few seconds.
- `emit(f_start, f_mid, f_end, ms)` → Bridge `emit` → the sketch plays a stepped sweep on the Modulino Buzzer and answers `emit_done` (logged as `[calib] sketch played the sweep`).
- `speed_of_sound()` comes from the Modulino Thermo; `bearing(window, band)` gives the direction of one arrival (the early part of a beep, or all of it), clockwise from forward.
- Static facts: `emitter_offset_m` (`config.json` `calibration.emitter_offset_cm`, measure it with a ruler), mic positions, forward.

The hooks are registered only if the installed SDK's `Sensor` takes a `calibration` argument. Otherwise the log shows `[calib] this SDK has no location calibration yet`.

**Updating the SDK on the board:** App Lab reinstalls packages only when `requirements.txt` changes, so a new SDK on `main` is not picked up by a restart. Run this, then restart the app:
`docker exec atech-serial-listener-main-1 uv pip install --python /app/.cache/.venv/bin/python --reinstall-package forestpulse-sensor "forestpulse-sensor @ https://github.com/yudjinn/forest-pulse/archive/refs/heads/main.zip#subdirectory=sensor-sdk"`

## Setup
1. SSH into the board, plug in the atech board through the hub, and run `ls -l /dev/serial/by-id/ /dev/ttyACM*`.
2. In `bricks/serial_bridge/brick_compose.yaml`, set the host device path.
   - The ESP32's by-id name contains `:`, which Compose's short `devices:` syntax can't take, so this uses `/dev/ttyACM0`.
   - The baud rate is ignored by USB CDC.
3. **Model files:** none needed; the sensor SDK brings its own model. (Only the disabled on-device classifier used `python/models/`.)
4. **`config.json`:**
   - `led.rotation_deg`: the angle of the ATech board's +x axis (mic1 → mic2) as seen on the Uno Q's matrix, so the arrow points the right way in the room.
   - `mic_positions_cm`: replace with measured sound-port positions when you have them.
   - `trigger`: ESP32 trigger thresholds (`snr_db`, `ratio_db`, `coherence`); `null` = firmware default (4 dB, 0 dB, 0.60). Lower = more sensitive. The server can override them through the check-in once the SDK relays them ([`TriggerSettingsSpec.md`](../../TriggerSettingsSpec.md)). The app re-sends them after every ESP32 reset; the log shows `[trigger] ESP32 thresholds now …`.
5. Copy this folder to `~/ArduinoApps/` on the board and start it: `arduino-app-cli app start user:atech-serial-listener` (or press Run in App Lab). `sketch/sketch.yaml` is required by App CLI 0.14+.
6. **The Python console should show:**
   - `[app] … classifier on` and `[serial] connected to serial-bridge:5000`;
   - an `INFO …` line from the ESP32;
   - per event: `=== event start`, per-second peak lines, `[class] live …`, `[led] arrow -> … deg`, `[event] … bearing … conf …`, then `[uplink] stub: …`.

## Not yet verified on the device
The processing code is tested on a laptop (`soc/dev/`: 33 tests, plus replay of recorded events and live runs against the ESP32). These parts can only be checked on the Uno Q:
- **The sketch compiles.** It uses `Arduino_LED_Matrix` (`matrix.begin()`, `setGrayscaleBits(1)`, `draw(uint8_t[104])`) and `Arduino_Modulino` (`Modulino.begin(Wire1)`, `ModulinoThermo`). If App Lab doesn't auto-install `Arduino_Modulino`, add it to `sketch/sketch.yaml` `libraries:`.
- **The Bridge accepts** the 104-character `led_frame` string and the two-float `climate` notify.
- **`onnxruntime` installs** from `requirements.txt` in the App Lab container (aarch64 wheel).
- **Timing on the Cortex-A53:**
  - final processing is ~1 s per 7.5 s event on a laptop, so expect several seconds on the device; it runs after the event, and the reader never waits;
  - live bearing must keep up at one window per 0.5 s;
  - the classifier uses 2 ONNX threads.

## Develop on a laptop
See [`../dev/`](../dev/): `uv run pytest`, `uv run replay.py <event.wav>` (prints the record and an ASCII LED preview), `uv run run_local.py` (live against the ESP32 on USB, found by its USB ID).

## Serial port settings (socat)
- `noctty,rawer`: without these, 0x03/0x1C bytes in the audio are taken as Ctrl-C/Ctrl-\ and kill socat.
- `hupcl=0`: keeps DTR=RTS asserted between connections (DTR=0 with RTS=1 resets the ESP32).

## Quick checks if it doesn't work
- `docker ps` shows the `serial-bridge` container is running. `docker logs <id>` shows socat's output.
- `cannot resolve serial-bridge`: the two containers aren't on a shared network. Set `SERIAL_BRIDGE_HOST` or publish the port and use the host IP.
- `ring overrun` right after starting: packets were dropped while nothing was reading. That's expected once.
- `no INFO reply`: check that the ESP32 isn't in a boot loop (`docker logs` of serial-bridge, `dmesg`).
- `classifier disabled: …`: the model files are missing or `onnxruntime` didn't install.
