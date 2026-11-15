# Atech Serial Listener (Arduino UNO Q)

The node app for the Uno Q. The atech board (ESP32, 3 mics) streams binary audio packets over USB to the Uno Q's Linux side. The app:
- feeds every audio block to the Forest Pulse **sensor SDK** (`forestpulse-sensor`), which runs the sound model and the server's detectors and sends events to the server;
- estimates the **bearing** (GCC-PHAT / SRP-PHAT, speed of sound from a Modulino Thermo) for each SDK detection, and shows a **direction arrow** on the LED matrix for 10 s (`bearing.detections: false` sends detections without a direction, for a board with fewer than 3 mics);
- **stores** each ESP32 event locally (WAV + JSON with the whole event's bearing; newest 50 kept) for debugging;
- shows a status **ticker** on the matrix and node health on the RGB **status LED**;
- provides the **location calibration** hooks (ESP32 stream, a sweep on the Modulino Buzzer or the ATech Speaker, bearing of one arrival); the SDK also plays the researchers' **warning alarm** through the same `emit` hook;
- sets the ESP32 **trigger thresholds** from its config and reports them to the SDK for the plan card (trigger health).

The on-device ONNX classifier (`classifier.py`) and the stub uplink (`uplink.py`) are kept but not used (`classifier=None`, `uplink=None` in `main.py`); their model files aren't shipped (regenerate with `experiments/efficientat-chainsaw/export_onnx.py` if it's ever re-enabled).

```
atech ESP32 --USB CDC--> /dev/ttyACM0 (Linux host)
        |  (device mapped into)
        v
[serial-bridge container: socat]  TCP :5000 on the App's Docker network
        |
        v
[App Python container]
  reader thread:  Receiver (parse packets, follow events; never blocks) -> SensorTee
        |                                                                   |
        |  queue                                                            +--> sensor SDK (model, detectors, check-in,
  worker thread:  Pipeline -> bearing.py, storage.py                        |    events, calibration) -> server
        |                                                                   +--> DetectionBearing (angle_fn) -> LED arrow
  matrix thread:  MatrixDisplay (arrow > CAL > ticker)
        |
        +--Bridge "led_frame", "serial_event", "node_status", "emit"--------> [STM32 sketch]
        <--Bridge "trigger_pin" (D7), "climate", "modulino_status", "emit_done"--
        <--Bridge "send_to_board" (ESP32 commands)--------------------------
```

**Why the extra container:** App Lab's Python container is not given `/dev/tty*`, and `app.yaml` can't add devices. A custom Brick's `brick_compose.yaml` *can* (Docker Compose `devices:` key). That needs App Lab 0.7 or newer.

**Hardware:**
- The UNO Q's USB-C port only acts as a USB host through a **powered USB-C hub**. Without one, nothing shows up in `lsusb`.
- The ESP32's notify line (ATech port 6 D1, 3.3 V, HIGH from trigger until the event's END packet) goes to UNO Q header pin **D7**. Its rising edge gives each event a precise trigger time. Optional: on the current nodes it reads HIGH all the time (likely wiring), so event times fall back to the end of the event minus its live length.
- **Modulino Buzzer** on the Qwiic connector: plays the calibration sweeps and the alarm (`calibration.emitter: "buzzer"`, the default). The sketch rescans the Qwiic bus every 5 s and logs `[modulino]` changes.
- **ATech Speaker module** (optional, MAX98357A on the atech board's ports 3-4): with `calibration.emitter: "speaker"` the ESP32 plays the sweeps instead (`P` command, `calibration.speaker_volume` 0..255, default 96), on the mics' own clock. Too loud and the board's mics clip on its own beep, which invalidates the round. Set `emitter_offset_cm` to the speaker's distance from the array's centre.
- **Modulino Thermo** on the Qwiic connector (optional): temperature + humidity → speed of sound `c = 331.3 + 0.606·T + 0.0124·RH`. Without it, or after 60 s with no valid reading, 343 m/s is used. Each event record shows which value was used.

## Files (`python/`)

| File | Role |
|---|---|
| `main.py` | App Lab glue: socket reader, Bridge callbacks, SDK start-up, status LED loop. The only file importing `arduino.app_utils`. |
| `receiver.py` / `atech_protocol.py` | bytes → `EventStart` / `AudioBlock` / `EventEnd` (`events.py`), console summaries |
| `sdk_glue.py` | `SensorTee` (audio → SDK + pipeline), `DetectionBearing` (the SDK's `angle_fn`), `CalibrationHooks`, `server_ok` |
| `pipeline.py` | worker: whole-event bearing, record, storage; holds and clears the LED arrow |
| `bearing.py` | GCC-PHAT pair delays + SRP-PHAT 1° grid; quality gate; circular mean |
| `climate.py` | Modulino readings → speed of sound, with fallback |
| `matrix_display.py` / `led_arrow.py` | LED matrix: ticker, sound meter, "CAL" / the 8×13 arrow (the sketch only draws frames) |
| `trigger_settings.py` | ESP32 trigger thresholds (`G` command); re-applied after an ESP32 reset; `current()` is the SDK's trigger health hook |
| `storage.py` | events on disk (`data/events/`, newest 50 kept) |
| `config.py` / `config.json` | defaults / node settings: mic geometry, bearing gates, LED rotation, matrix, trigger, calibration. `config.local.json` (git-ignored, optional) overrides per board. |
| `forestpulse.example.toml` | template for `forestpulse.toml` (server URL, sensor key, sensor ID; secret, git-ignored) |
| `requirements.txt` | `numpy`, `forestpulse-sensor` (installed by App Lab into the container) |
| `classifier.py`, `uplink.py` | **not used** (see above) |

## What happens per sound
- **The ESP32 triggers** on a loud, coherent sound and sends 4 s of pre-trigger audio plus the live audio (up to 15 s).
- **The SDK** gets every block. When a detector fires, it calls `angle_fn` (`DetectionBearing`, unless `bearing.detections` is false): bearing over the newest 2 s of its window (0.5 s windows, 0.25 s hop), returned clockwise from forward. The log shows `[sdk] detection bearing …`, the matrix shows the arrow for 10 s, and the SDK sends the event with the angle.
- **At the event end** the local pipeline computes the bearing over the whole event (never across a discontinuity) and writes `data/events/<id>.json` + `.wav` (record format in [`soc/README.md`](../README.md) §4; `classification` is null).
- **Bearing quality gate** (`config.json` `bearing`):
  - the window isn't quieter than the event's own pre-trigger background (whole-event bearing only: the SDK's window has no separate background);
  - the SRP peak is at least 3× the median;
  - the three pair delays agree within 1 sample;
  - at least 3 such windows are needed for a bearing.

  On 2 min of hall background this yields no bearing. On the phone-clip test event it gives 276.7° ± 0.9°.
- `led.source` `"detections"` (default) lets SDK detections drive the arrow. Any other value makes the local pipeline drive it from ESP32 events (`led.require_chainsaw` then needs the disabled classifier).

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
The sensor SDK runs it. Contract: [`sensor-sdk/README.md`](../../sensor-sdk/README.md) "Calibration hooks" and [`docs/device-api.md`](../../docs/device-api.md) "Calibration"; **upstream is the source of truth**. This app provides `CalibrationHooks` (`sdk_glue.py`), which pass the SDK's own `self_check()` (tested in `soc/dev`):
- `start_stream()` sends `X` (ends any running recording: the firmware ignores `C` during one), waits 100 ms, then sends `C` (continuous stream). `stop_stream()` sends `X`. The reader also sends `X` on every (re)connect unless a run is streaming, so a lost stop never leaves the ESP32 in continuous mode. While calibrating every block still goes to the SDK, but our own pipeline is bypassed (no event bearing, WAV or arrow) and the matrix shows "CAL".
- `emit(f_start, f_mid, f_end, ms)`:
  - `calibration.emitter: "buzzer"` (default): Bridge `emit` → the sketch plays the stepped sweep on the Modulino Buzzer and answers `emit_done`. Returns False when the sketch reported no buzzer.
  - `"speaker"`: sends `P` + the sweep + `speaker_volume` to the ESP32 (no Modulino needed). Returns False when the ESP32 isn't connected.
  - The service sends each role's sweep with the run (currently A rises, B falls, C rises and falls, 3–5 kHz, 300 ms, 6 rounds); the SDK's alarm calls it with constant tones.
- `speed_of_sound()` from the Modulino Thermo; `bearing(window, band_hz)` gives the direction of one arrival (the SDK passes 40 ms from 5 ms before the first path), clockwise from forward, or None when unsure. Gates: `calibration.min_peak_ratio` 2.5, `max_closure_samples` 1.5.
- Static facts: `fs`, `emitter_offset_m` (`calibration.emitter_offset_cm`: ruler distance from the emitter to the **centre of the mic array**), `forward_ccw_deg`, `mic_positions_m` (board frame).
- **Distance only:** when a board's `bearing()` returns None, the service calibrates the distances and keeps the facings set on the plan (2 or 3 sensors).
- **Test and debug settings** (put them in `python/config.local.json`; it is git-ignored and never overwritten by `scripts/deploy-nodes.py`). The log says `[calib] TEST: …` at start-up:
  - `calibration.test_mono_mic` (e.g. `2`): during calibration the SDK gets that one mic copied into all 3 channels, so distances are measured at it, and `bearing()` answers None (distance-only calibration).
  - `calibration.test_fake_bearing_deg` (e.g. `0`): `bearing()` always answers that angle with quality 1. Ignored when `test_mono_mic` is set.
  - `calibration.test_dump_calibration: true`: saves each calibration stream's raw 3-mic audio to `data/calibration/calib-<time>.npz` (with the SDK's stream position per block) for offline replay.
  - `calibration.test_beep_every_s` > 0 plays `calibration.test_beep` (the SDK's default role-A sweep, 1.5–3.5 kHz) periodically, to hear the buzzer.

The hooks are registered only if the installed SDK's `Sensor` takes a `calibration` argument. Otherwise the log shows `[calib] this SDK has no location calibration yet`.

**Updating the SDK on the board:** App Lab reinstalls packages only when `requirements.txt` changes, so a new SDK on `main` is not picked up by a restart. Run this, then restart the app:
`docker exec atech-serial-listener-main-1 uv pip install --python /app/.cache/.venv/bin/python --reinstall-package forestpulse-sensor "forestpulse-sensor @ https://github.com/yudjinn/forest-pulse/archive/refs/heads/main.zip#subdirectory=sensor-sdk"`

## Setup
1. SSH into the board, plug in the atech board through the hub, and run `ls -l /dev/serial/by-id/ /dev/ttyACM*`.
2. In `bricks/serial_bridge/brick_compose.yaml`, set the host device path.
   - The ESP32's by-id name contains `:`, which Compose's short `devices:` syntax can't take, so this uses `/dev/ttyACM0`.
   - The baud rate is ignored by USB CDC.
3. **Sensor config:** copy `python/forestpulse.example.toml` to `python/forestpulse.toml` (mode 600) and fill in the sensor key and `sensor_id = "fp-<wlan0 MAC without colons>"`. Without it the app runs but sends nothing (`[sdk] no forestpulse.toml …`). No model files are needed: the SDK brings its own.
4. **`config.json`:**
   - `led.rotation_deg`: the angle of the ATech board's +x axis (mic1 → mic2) as seen on the Uno Q's matrix, so the arrow points the right way in the room.
   - `mic_positions_cm`: replace with measured sound-port positions when you have them.
   - Per-board differences go in `python/config.local.json` instead (merged over `config.json`; the log says `[app] board overrides from config.local.json`).
   - `trigger`: ESP32 trigger thresholds (`snr_db`, `ratio_db`, `coherence`); `null` = firmware default (4 dB, 0 dB, 0.60). Lower = more sensitive; `coherence: 0` turns that gate off (needed with only one mic fitted). The app re-sends them after every ESP32 reset; the log shows `[trigger] ESP32 thresholds now …`. The SDK reports the values the ESP32 confirmed at each check-in, and the plan card shows them; this is read-only, so the server never changes them ([`docs/device-api.md`](../../docs/device-api.md) "Trigger health").
5. Copy this folder to `~/ArduinoApps/` on the board and start it: `arduino-app-cli app start user:atech-serial-listener` (or press Run in App Lab). `sketch/sketch.yaml` is required by App CLI 0.14+. For the nodes in `scripts/nodes.txt`, `scripts/deploy-nodes.py` does this and flashes the ESP32 ([`docs/agents/nodes.md`](../../docs/agents/nodes.md)).
6. **The Python console should show:**
   - `[serial] connected to serial-bridge:5000`, then an `INFO …` line from the ESP32;
   - `[app] node …, data in …, sensor SDK on: fp-…`;
   - `[status] ESP32 OK, server OK` (and a green status LED);
   - per sound: `=== event start`, per-second peak lines, `[sdk] heard …`, `[sdk] detection bearing …`, `[led] arrow -> … deg`, then `[event] … bearing … conf …` at the event end.

## Develop on a laptop
See [`../dev/`](../dev/): `uv run pytest` (89 tests, including the SDK's own calibration `self_check` and a real `Sensor`), `uv run replay.py <event.wav>` (prints the record and an ASCII LED preview), `uv run run_local.py` (live against the ESP32 on USB, found by its USB ID).

## Serial port settings (socat)
- `noctty,rawer`: without these, 0x03/0x1C bytes in the audio are taken as Ctrl-C/Ctrl-\ and kill socat.
- `hupcl=0`: keeps DTR=RTS asserted between connections (DTR=0 with RTS=1 resets the ESP32).

## Quick checks if it doesn't work
- `docker ps` shows the `serial-bridge` container is running. `docker logs <id>` shows socat's output.
- `cannot resolve serial-bridge`: the two containers aren't on a shared network. Set `SERIAL_BRIDGE_HOST` or publish the port and use the host IP.
- `ring overrun` right after starting: packets were dropped while nothing was reading. That's expected once.
- `no INFO reply`: check that the ESP32 isn't in a boot loop (`docker logs` of serial-bridge, `dmesg`).
- `[sdk] sensor not started: …`: `forestpulse-sensor` didn't install or `forestpulse.toml` is invalid.
- `[sdk] … 403` or the server never OK: an old SDK on the board (Cloudflare blocks pre-0.2.0 clients): reinstall it (above), or the venue Wi-Fi is down.
