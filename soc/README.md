# SoC: Arduino Uno Q (Linux) Node Software

The Linux side of a sensor node. It:
- receives audio events from the ESP32-S3 front-end ([`mcu/`](../mcu/)) over USB;
- validates them and puts each event back together;
- classifies the sound;
- estimates the **bearing** (the direction the sound comes from, relative to the board);
- uploads results to the server over Wi-Fi.

Status: **running on the Uno Q** (hot-plug serial bridge, ESP32 connected). **Classification moved to the server SDK**: the node sends the audio file and the bearing. The on-device classifier below is kept but disabled. Earlier status: [`atech-serial-listener/`](atech-serial-listener/) is an Arduino App Lab app. It:
- receives events and classifies them (EfficientAT `mn10_as`, ONNX, from [`experiments/efficientat-chainsaw`](../experiments/efficientat-chainsaw/));
- estimates the bearing (GCC-PHAT / SRP-PHAT, with the speed of sound from a Modulino Thermo);
- stores each event and queues it for a **stub** uplink;
- shows a direction arrow on the LED matrix for chainsaws.

See its README for files, setup and what still needs checking on the device. Laptop tests and harness: [`dev/`](dev/).
For the system picture, see the [repo README](../README.md).

## Responsibilities

| Do | Don't |
|---|---|
| keep the USB port open and read continuously | real-time capture or triggering (the MCU does that) |
| validate CRC/sequence numbers, put events back together | change the MCU packet format without updating `mcu/` |
| classify (chainsaw / machinery / other) | |
| estimate the bearing on segments classified as chainsaw | locate the source (the server combines several nodes' bearings into a location) |
| upload event metadata + audio to the server (Wi-Fi) | |

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
USB ──► parser (CRC, resync) ──► event assembler ──► classifier ──► bearing estimator ──► uplink (Wi-Fi)
                                       │                  │                │
                                       └─ WAV/FLAC ───────┴── labels ──────┴──► event record
```

1. **Event assembler:** builds a `(frames, 3)` int16 array per event, with discontinuity markers taken from flags and sequence gaps.
2. **Classifier (TBD):** chainsaw / heavy machinery / other, with a score, over short windows (for example 0.5–1 s). It decides **which windows** the bearing estimator uses, so the bearing is the chainsaw's and not that of a nearby talker or PA.
3. **Bearing estimator:** see section 3.
4. **Event record + upload:** see section 4.

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
- **TODO, measure the real positions:** measure each mic's *sound port* position to ±1 mm and replace the nominal values in a config file. A 1 mm error ≈ 0.14 samples ≈ 1–2° near broadside.

Largest possible delay (`d / c · fs`, c = 343 m/s, fs = 48 kHz):

| Pair | Spacing | Max delay |
|---|---|---|
| mic1–mic2 | 4.0 cm | 117 µs = **5.6 samples** |
| mic2–mic3 | 6.0 cm | 175 µs = **8.4 samples** |
| mic1–mic3 | 7.2 cm | 210 µs = **10.1 samples** |

### Algorithm
For each analysis window (0.25–0.5 s, 50% overlap) that the classifier accepts:

1. **Arrival-time difference per pair (GCC-PHAT):** for each pair, compute R(τ) = IFFT( X₁·X₂* / |X₁·X₂*| ) over 100 Hz–8 kHz. Search only |τ| ≤ that pair's maximum delay (plus a small margin), and interpolate around the peak (parabolic) to get a fraction of a sample.
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
- **Speed of sound** varies about 0.17% per °C. Use c = 331.3 + 0.606·T (°C) if a temperature is available; otherwise 343 m/s.
- **Resolution is direction-dependent.** It's best broadside to a pair and worst end-on. The triangle's two pairs at 90° to each other cover each other's weak directions.
- **Echoes.** Indoors (the hall), expect noisy bearings: PHAT weighting plus averaging over time are essential. Outdoors, a few degrees should be achievable.

### Validation
- **Claps or clicks from known angles** (for example every 45°, 1–2 m away), with the receiver capturing WAVs. Check the computed bearing against the true angle and refine the geometry if there's a consistent error.
- This shares recordings with the MCU's clock-lock acceptance test. The firmware samples all mics on the same clock edge, so the inter-channel offset is 0 by design. The test proves it.

## 4. Uplink to the server (demo: Wi-Fi for everything)

**For the demo,** send both the metadata and the audio over Wi-Fi. LoRaWAN isn't available; later it would carry **metadata only** (bearing, class, time), since raw audio (~5.5 MB per event) can't fit.

**Proposed event record** (JSON; transport TBD: HTTP POST or MQTT):

```json
{
  "node_id": "node-01",
  "event_id": "node-01-000123",
  "t_trigger_utc": "2026-11-14T12:34:56.789Z",
  "t_accuracy_s": 0.05,
  "duration_s": 9.6,
  "sample_rate": 48000,
  "classification": {"label": "chainsaw", "score": 0.91},
  "bearing": {"frame": "board", "deg": 37.0, "spread_deg": 6.5, "confidence": 0.8, "n_windows": 14},
  "integrity": {"crc_errors": 0, "seq_gaps": 0, "overrun": false, "sync_loss": false},
  "audio_url": "…/node-01-000123.flac"
}
```

- **Audio:** 3-channel 48 kHz int16. Compress it losslessly (FLAC), since the server may re-run bearing estimation or classification.
- **Store and forward:** keep events on disk until the server acknowledges them, so a Wi-Fi outage loses nothing.

## 5. Multi-node (planned)

- **One node for now. Later there will be several,** each reporting bearings in its own board frame.
- **The server holds each node's configuration:** position, plus heading of its board +x axis. It turns bearings into world directions and intersects them to estimate where the source is.
- **Node clocks must be NTP-synced** so the server can match events. A ~50 ms timestamp is plenty for matching bearings, because a chainsaw runs for seconds.
- Locating a source from arrival-time differences *between* nodes would need sample-accurate clocks (GPS PPS) and a protocol timestamp. **That isn't planned.**

## TODO

- [x] Choose the Uno Q pin for the notify line: STM32 header D7.
- [x] Receiver: `atech-serial-listener` (App Lab app, socat bridge brick, reconnects); processing split into plain-Python modules.
- [x] GCC-PHAT + SRP-PHAT bearing with a quality gate. Synthetic tests: ≤ 1° error down to 0 dB SNR. The phone-clip event gives 276.7° ± 0.9°; hall background gives no bearing.
- [x] Classifier: the experiment's `Tagger` exported to ONNX (`export_onnx.py`); app path matches `Tagger` to 1.5e-6, 31/40 vs 0/36 on ESC-50.
- [x] Speed of sound from the Modulino Thermo, falling back to 343 m/s.
- [x] LED-matrix arrow toward classified chainsaws (`led.rotation_deg` for mounting).
- [x] Event record (§4 schema) + WAV on disk, newest 50 kept; trigger time from the D7 rise (else end − live length).
- [ ] **Run on the Uno Q:** sketch compiles (LED matrix + Modulino libraries), `onnxruntime` installs, Bridge payloads, A53 timing. See the app README "Not yet verified on the device".
- [ ] **Demo classification:** the hall phone-clip test scored chainsaw 0.005 (top: Speech/Vehicle). Play it louder or closer, or tune the threshold on clips captured in the hall.
- [ ] Measure the real mic sound-port positions (±1 mm) → `config.json` `mic_positions_cm`; validate with claps at known angles.
- [ ] Uplink: replace `StubUplink` once the server API exists (teammate). Records are queued in `data/outbox/`. FLAC compression optional.
- [ ] NTP on the Uno Q (record timestamps use the system clock).
