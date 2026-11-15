# SoC: Arduino Uno Q (Linux) Node Software

The Linux side of a sensor node. It:
- receives audio events from the ESP32-S3 front-end ([`mcu/`](../mcu/)) over USB;
- validates them and puts each event back together;
- feeds the audio to the Forest Pulse **sensor SDK** ([`sensor-sdk/`](../sensor-sdk/)), which recognises the sound and sends events to the server over Wi-Fi;
- estimates the **bearing** (the direction the sound comes from) for each detection and hands it to the SDK;
- takes part in **location calibration** (sweeps between nodes on the Modulino Buzzer or the ATech Speaker; the SDK runs it) and plays the **warning alarm** when the server sends one.

Status: **running on two Uno Q nodes** (`forestpulse1`, `forestpulse2`; see [`docs/agents/nodes.md`](../docs/agents/nodes.md)). The app is [`atech-serial-listener/`](atech-serial-listener/), an Arduino App Lab app. Besides feeding the SDK it:
- estimates bearings with GCC-PHAT / SRP-PHAT, using the speed of sound from a Modulino Thermo;
- keeps the newest 50 events on disk (WAV + JSON record) for debugging;
- drives the LED matrix (direction arrow, status ticker) and the RGB status LED;
- passes the ESP32 trigger thresholds from its config to the firmware, and reports them through the SDK (trigger health on the plan card).

The on-device ONNX classifier (`classifier.py`) and the stub uplink (`uplink.py`) are still in the tree but not used: the SDK classifies and uploads. See the app README for files, setup and the LED meanings. Laptop tests and harness: [`dev/`](dev/).
For the system picture, see the [repo README](../README.md).

## Responsibilities

| Do | Don't |
|---|---|
| keep the USB port open and read continuously | real-time capture or triggering (the MCU does that) |
| validate CRC/sequence numbers, put events back together | change the MCU packet format without updating `mcu/` |
| feed the audio to the sensor SDK, which classifies and uploads | run its own sound model (the SDK does that) |
| estimate the bearing of each SDK detection | locate the source (the server combines several nodes' bearings into a location) |
| provide the calibration hooks (stream, emitter, bearing of one arrival) | solve node positions (the server does that) |

## 1. Input from the MCU

### USB link
- **Device:** the ESP32-S3 native USB Serial/JTAG appears as a CDC-ACM device, `/dev/ttyACM*` (VID:PID `303a:1001`). Baud rate is ignored.
- **Open with DTR and RTS both asserted** (pyserial: set `dtr=True, rts=True` *before* `open()`). The state DTR=0 & RTS=1 **resets the ESP32-S3**. pyserial's default open sequence passes through that state.
- **Read all the time.** Live audio is 288 KB/s, and the link sustains 768 KB/s.
  - When an event starts, 4 s of pre-trigger audio is already waiting, and the MCU's ring buffer has only **2 s** of headroom.
  - If the reader isn't draining the port within **~2 s** of the event start, audio is overwritten and packets carry the overrun flag.
- **After an MCU reset or flash,** the first command can land while the chip boots. Retry `I` until an `INFO` line comes back.
- **Reference implementation:** `mcu/tools/fe_serial.py` (port handling) and `mcu/tools/fe_protocol.py` (parser and event assembler). Reuse them.

### Notify line
- **What it is:** ATech port 6 D1 (ESP32 GPIO13), **3.3 V logic**. HIGH from trigger until the event's END packet.
- **Optional:** the packet stream alone is enough to detect events. The line is useful for waking processing or for LEDs.
- **Wiring:** connected to Uno Q STM32 header pin **D7** (3.3 V, no level shifter). The sketch in `atech-serial-listener/` reports each edge to Linux over the bridge.
  - The Uno Q's STM32 header pins are 3.3 V.
  - The Linux SoC's own GPIOs are 1.8 V, so they **need a level shifter**.
  - Through the STM32 side, the Linux app gets the state over the Arduino App Lab bridge/RPC.

### Packets
Little-endian. CRC32 (IEEE, same as `zlib.crc32`) over header + PCM. Full details are in [`mcu/README.md`](../mcu/README.md#6-streamer-and-packets-streamc-protocolc).

| Offset | Size | Field |
|---|---|---|
| 0 | 2 | magic `AA 55` |
| 2 | 1 | type: `01` pre-trigger, `02` live, `03` end (0 frames) |
| 3 | 1 | flags: bit0 ring overrun (frames skipped), bit1 capture sync loss (frames dropped) |
| 4 | 4 | sample_rate (48000) |
| 8 | 4 | seq_num (counts up across events) |
| 12 | 2 | frame_count N (≤ 679) |
| 14 | 6N | PCM int16 interleaved `[mic1, mic2, mic3]` |
| 14+6N | 4 | CRC32 |

**An event** is a run of `01` packets (exactly 192,000 frames = 4 s before the trigger), then `02` packets (live, up to 15 s), then one `03`. Rules:
- **Re-sync** on the magic `AA 55`.
- **Drop** packets that fail the CRC.
- A **sequence-number gap or a set flag means a discontinuity.** Don't run bearing estimation across it.
- **ASCII lines** (`INFO …`, `RAW …`) can appear *between* packets as replies to commands. The parser skips them, or picks them up for status.

### Timestamps
Packets carry no clock. Within an event, sample timing is exact: frame *n* is *n*/48000 s after the event's first frame. **Absolute time comes from the SoC clock (NTP).**
- **Estimating the trigger time:** once the reader has caught up with the live stream, the newest frame received is roughly "now" (within ~50 ms of USB/OS buffering). Work back from there.
- **Possible future protocol addition:** if fusing several nodes ever needs better than ~50 ms, add the MCU's frame index or a timestamp to the packet header. It isn't needed for bearing-only fusion.

## 2. Processing pipeline

```
USB ──► parser (CRC, resync) ──► event assembler ──► SensorTee ──┬──► sensor SDK: model + detectors ──► events ──► server
                                                                  │          └── angle_fn(window) ──► DetectionBearing (bearing, LED arrow)
                                                                  └──► Pipeline: event bearing ──► WAV + JSON record on disk
```

1. **Event assembler:** builds a `(frames, 3)` int16 array per event, with discontinuity markers taken from flags and sequence gaps.
2. **SensorTee** (`sdk_glue.py`): every audio block goes to both the SDK and the local pipeline. During a location calibration the local pipeline is bypassed.
3. **Sensor SDK:** runs the sound model and the server's detectors. For each detection it calls `angle_fn` with the audio window; `DetectionBearing` estimates the bearing over the newest 2 s (section 3), returns it clockwise from the board's forward direction, and shows the LED arrow. The SDK sends the event (sound, confidence, time, angle). It never sends audio.
4. **Pipeline** (`pipeline.py`): the whole event's bearing, written with the audio to `data/events/` (section 4). Its record has `classification: null`, since the node doesn't classify.

## 3. Bearing estimation

### Array geometry (board frame)
The mics form a **right triangle with the right angle at mic 2**:
- mic 1 ↔ mic 2 ≈ **4 cm** (along the top of the board);
- mic 2 ↔ mic 3 ≈ **6 cm** (down the right side).

| Mic | Board port | x (cm) | y (cm) |
|---|---|---|---|
| mic1 | 1-2 (top-left) | −4.0 | 0.0 |
| mic2 | 9-10 (top-right) | 0.0 | 0.0 |
| mic3 | 13-14 (lower-right) | 0.0 | −6.0 |

- **Board frame:** +x points from mic1 toward mic2 (left → right across the top); +y points toward the top of the board, away from mic3. The array plane is the board plane.
- **Bearing θ** is measured in that plane, counter-clockwise from +x: 0° = the mic2 side, 90° = the top edge.
- **For now bearing stays in board coordinates.** The server maps it to the world using each node's configured position and heading.
- **These are nominal positions** (`config.json` `mic_positions_cm`). Measuring each mic's *sound port* to ±1 mm is still a TODO: a 1 mm error ≈ 0.14 samples ≈ 1–2° near broadside.

Largest possible delay (`d / c · fs`, c = 343 m/s, fs = 48 kHz):

| Pair | Spacing | Max delay |
|---|---|---|
| mic1–mic2 | 4.0 cm | 117 µs = **5.6 samples** |
| mic2–mic3 | 6.0 cm | 175 µs = **8.4 samples** |
| mic1–mic3 | 7.2 cm | 210 µs = **10.1 samples** |

### Algorithm
For each analysis window (0.5 s, 0.25 s hop; `config.json` `bearing`):

1. **Arrival-time difference per pair (GCC-PHAT):** for each pair, compute R(τ) = IFFT( X₁·X₂* / |X₁·X₂*| ) over 200 Hz–8 kHz. Search only |τ| ≤ that pair's maximum delay (plus a small margin), and interpolate around the peak (parabolic) to get a fraction of a sample.
2. **Bearing (SRP-PHAT grid, preferred):**
   - For θ = 0…359° in 1° steps, the expected delay for pair (i, j) is τᵢⱼ(θ) = ((rⱼ − rᵢ) · u(θ)) / c · fs, where u(θ) = (cos θ, sin θ).
   - Score(θ) = Σ over pairs of Rᵢⱼ(τᵢⱼ(θ)).
   - Pick the θ with the highest score. This uses all three pairs consistently and tolerates echoes better than solving for the three delays separately.
   - Least squares on the three delays is an acceptable cross-check.
3. **Quality checks → confidence:**
   - *Delays add up:* τ₁₂ + τ₂₃ ≈ τ₁₃ (within ~1 sample) for a single source.
   - *Sharp peak:* the SRP peak stands well above the median score; the GCC-PHAT peaks are clearly above the rest.
   - *Stable over time:* bearings agree across consecutive windows. Report the circular mean and spread for the event.
4. **Output per event:** `bearing_deg` (board frame), `bearing_spread_deg`, `confidence`, `n_windows`. Optionally a time series of bearings (a moving saw).

### Limitations
- **2-D only.** Three mics in one plane give azimuth but not elevation. A source above the board can't be told from its mirror image below it, which is fine with the board mounted level and sources near the ground.
- **Far-field assumption.** The array is ~7 cm across, so treating the sound as a flat wave is accurate beyond ~1 m.
- **Speed of sound** varies about 0.17% per °C. The app uses c = 331.3 + 0.606·T + 0.0124·RH from the Modulino Thermo, or 343 m/s without a fresh reading (`climate.py`).
- **Resolution is direction-dependent.** It's best broadside to a pair and worst end-on. The triangle's two pairs at 90° to each other cover each other's weak directions.
- **Echoes.** Indoors (the hall), expect noisy bearings: PHAT weighting plus averaging over time are essential. Outdoors, a few degrees should be achievable.

### Validation
- **Claps or clicks from known angles** (for example every 45°, 1–2 m away), with the receiver capturing WAVs. Check the computed bearing against the true angle and refine the geometry if there's a consistent error.
- This shares recordings with the MCU's clock-lock acceptance test. The firmware samples all mics on the same clock edge, so the inter-channel offset is 0 by design. The test proves it.

## 4. Uplink and local records

- **Server uplink is the sensor SDK's job.** It sends events (sound, confidence, time, angle) to `forestpulse.paxid.com`, queues them in `forestpulse-state/` while offline, and keeps the sound list in sync. Contract: [`docs/device-api.md`](../docs/device-api.md). Configuration: `python/forestpulse.toml` on each board (server URL, sensor key, sensor ID `fp-<wlan0 MAC>`); it's secret and git-ignored.
- **Local record per event** (`data/events/<event_id>.json` + `.wav`, newest 50 kept; `pipeline.py`):

```json
{
  "node_id": "node-01",
  "event_id": "node-01-20261114T123456-123",
  "t_trigger_utc": "2026-11-14T12:34:56.789Z",
  "t_trigger_source": "notify_pin",
  "duration_s": 9.6,
  "pre_trigger_s": 4.0,
  "sample_rate": 48000,
  "classification": null,
  "bearing": {"frame": "board", "deg": 37.0, "spread_deg": 6.5, "confidence": 0.8, "n_windows": 14,
              "n_windows_total": 37, "background_dbfs": -62.1, "series": [[0.25, 36.0]], "speed_of_sound": 344.1},
  "integrity": {"seq_gaps": 0, "breaks": 0, "overrun": false, "sync_loss": false, "joined_mid_event": false},
  "processing_s": 0.8
}
```

`t_trigger_source` is `notify_pin` when the D7 rise was seen, otherwise `end_minus_live` (event end minus the live length).

## 5. Multi-node

- **Each node reports bearings** as an angle clockwise from its forward direction (`forward_ccw_deg`, board +y by default).
- **The server holds each node's position and heading.** It turns bearings into world directions and intersects them to estimate where the source is.
- **Positions and headings come from location calibration:** 2 or 3 nodes play sweeps in turn and measure each other's ranges and bearings; the SDK runs it and the server solves the layout. A node whose bearing hook answers None (one mic, e.g. `test_mono_mic`) gets distances only, and keeps the facing set on the plan. Node side: `CalibrationHooks` in `sdk_glue.py` (app README, "Location calibration").
- **Clocks:** the boards sync with NTP (`systemd-timesyncd`). ~50 ms is plenty for matching bearings, because a chainsaw runs for seconds.
- Locating a source from arrival-time differences *between* nodes would need sample-accurate clocks (GPS PPS) and a protocol timestamp. **That isn't planned.**

## TODO

- [ ] **Measure the real mic sound-port positions** (±1 mm) → `config.json` `mic_positions_cm`; validate with claps at known angles.
- [ ] **Notify line (D7) reads HIGH all the time** on the bench: probably wiring. The status LED no longer needs it, but without a rise event times fall back to `end_minus_live`.
- [ ] **Noise floor on the plan card (optional):** the SDK's trigger health hook can also report `noise_floor_dbfs()`; `TriggerSettings` doesn't provide it yet (the ESP32's INFO has `floor_dbfs`).
- [ ] **Bearings on the current nodes:** both run calibration with `test_mono_mic` (distance only), and `forestpulse2` (mic2 only) sends detections without a direction (`bearing.detections: false`). Facings come from the plan until a node has a full array whose bearings pass in the sweep's 3–5 kHz band.
