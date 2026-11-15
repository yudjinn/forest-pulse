# MCU: ESP32-S3 3-Mic Acoustic Front-End

ESP-IDF firmware for the ESP32-S3 on the ATech 14-port motherboard. It:
- captures three ICS-43434 I2S mics, all sampled on the same clock edge;
- keeps a rolling 6 s history in PSRAM;
- detects chainsaw/machinery sound;
- raises a "data incoming" line to the Arduino Uno Q;
- streams the 4 s pre-trigger window plus live audio over USB as CRC-checked binary packets.

The original brief is in `SPEC.md`; agreed deviations are [listed below](#deviations-from-specmd).
For where the MCU fits in the whole system, see the [repo README](../README.md).

## Status

| Part | State |
|---|---|
| Toolchain, PSRAM bring-up | done |
| USB throughput (768 KB/s sustained; needs ≥ 450 KB/s) | done |
| PSRAM ring, trigger, packetizer, host tools | done; acceptance tests pass (synthetic source) |
| I2S clock fan-out + LCD_CAM bit capture + deserializer | done; all 3 mics live, 48 kHz, 0 sync losses |
| Coherence gate + long-term floor adaptation | done; tuned on 2 min of hall audio (level 4 dB / ratio 0 dB / coherence 0.60) |
| Impulse (clap) clock-lock test, trigger tuning on real sound | next |

## TODO

- [x] **Trigger tuning (hall demo).** Defaults are now **level 4 dB / ratio 0 dB / coherence 0.60**, chosen with `tools/trigger_sim.py` on 2 min of hall background (`tools/events/background_hall_2min.wav`) plus the phone chainsaw clip:

  | Level / ratio / coherence | False events in 2 min (sim) | Clip detected after |
  |---|---|---|
  | old: 6 dB / 3 dB / 0.50 | 2 | 4.4 s |
  | **new: 4 / 0 / 0.60** | **0** | **2.4 s** |

  **Live on the board:** 3 events in one 2-minute window, during bursts of strongly coherent sound (0.88, probably nearby talking); 0 in the next 2.5 minutes. With the ratio gate at 0 dB, the MCU trigger means "a loud sound from one direction". Telling a chainsaw from a voice is the SoC classifier's job.
- [ ] **Clock-lock / impulse test:** claps from known directions, all 3 mics; inter-channel lag drift ≤ 1 sample over 10 min. Pairwise lags on ambient noise so far are inconclusive.
- [ ] **Real chainsaw recordings:** re-tune for outdoor use. A real saw has strong energy below 300 Hz, so the band-ratio (wind) gate can come back (it's at 0 dB for the phone-clip demo). Re-check the level and coherence margins with `trigger_sim.py`.
- [x] **CPU headroom:** measured core-0 load (`core0_load_pct` in `INFO`) is **55.7% at 80 MHz**: trigger ≈ 36%, deserialization and ring ≈ 20%. Staying at 80 MHz; switch to 160 MHz (`CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_160`) if per-block work grows.
- [x] **Regression:** synthetic-source build (`build_synth/`) passes all four `accept_buffer.py` tests after the capture rewrite.
- [ ] **Mic geometry for direction finding:** measure each mic's sound-port position (mm) on the board, plus the board's mounting heading.

## Modules and ports

Each port's two data lines (D1 = line A, D2 = line B) go straight to one
ESP32-S3 GPIO, with no mux. That is what "1:1 mapping" means on this board.

| Port(s) | Module | Signals → GPIO |
|---|---|---|
| 1-2 | Microphone 1 (ICS-43434) | **port 2**: D1 LR → GPIO5, D2 WS → GPIO4 · **port 1**: D1 SCK → GPIO9, D2 SD → GPIO8 |
| 9-10 | Microphone 2 | port 9: LR → GPIO40, WS → GPIO41 · port 10: SCK → GPIO1, SD → GPIO2 |
| 13-14 | Microphone 3 | port 13: LR → GPIO39, WS → GPIO38 · port 14: SCK → GPIO36, SD → GPIO35 |
| 6 | Data-out ("data incoming") to the Uno Q | D1 → GPIO13, HIGH for the whole event (3.3 V) |
| 8 | USB-C (to the Uno Q; also flashing) | native USB-Serial/JTAG |
| 3-4 | Speaker (ATech Speaker v2.2, MAX98357A) | **port 4**: D1 LRCLK → GPIO16, D2 BCLK → GPIO15 · **port 3**: D1 not connected, D2 DIN → GPIO18 |
| 7 | *(nothing plugged in)* | D2 GPIO7 is used **internally** as the camera VSYNC control pad; keep port 7 empty |
| 11 | *(console)* | GPIO43/44 = UART0 log output |

**Left-edge modules are rotated.** A module always plugs in with its 12 V pin
on its own left. So a 2-port module on the left edge (ports 1–6) sits rotated
180° compared with the right edge:
- Right edge: the module's first port (LR/WS) is the lower port number.
- Left edge: the first port is the higher one.

This was found on hardware: with the naive mapping, mic 1 got no clock and
stayed silent. All pins live in [`main/board_pins.h`](main/board_pins.h).

## Signal path

```
                 ┌──────────────────────── ESP32-S3 ─────────────────────────────────────┐
 mic1 ◄─BCLK,WS──┤ I2S0 (TX master, clocks only) ──GPIO matrix fan-out──► 3 port pairs   │
 mic2 ◄─BCLK,WS──┤                                                                       │
 mic3 ◄─BCLK,WS──┤                                                                       │
 mic1 ──SD──────►│ LCD_CAM camera (PCLK = BCLK pad)   bit0..2 = SD1..3, bit3 = WS        │
 mic2 ──SD──────►│        │ 1 byte per BCLK, 3.072 MB/s                                  │
 mic3 ──SD──────►│        ▼                                                              │
                 │ GDMA circular ring (internal SRAM, 32 × 3,840 B, EOF every 5 ms)      │
                 │        │ EOF ISR → queue                       core 0: capture task   │
                 │        ▼                                                              │
                 │ deserializer → int16 [m1,m2,m3] → 20 ms blocks ─┬─► trigger (mic1)    │
                 │                                                 ▼          │ events   │
                 │                          PSRAM ring (6 s, 1.73 MB)         ▼          │
                 │                                     │       core 1: stream task       │
                 │                                     └──► packetizer + CRC32 ──► USB ──┼──► Uno Q
                 │                                                    notify GPIO13 ─────┼──► Uno Q
                 └───────────────────────────────────────────────────────────────────────┘
```

## How it works

### 1. Shared clocks (`clock_gen.c`)

**I2S0** runs as a TX master in Philips mode, 32-bit stereo slots, 48 kHz:
- BCLK = 64 × 48 kHz = 3.072 MHz on mic1's SCK pin.
- WS = 48 kHz on mic1's WS pin.
- Its data path is unused (no DOUT pin; the DMA clocks out zeros).

**Fan-out:** the GPIO matrix routes the *same internal* `I2S0O_BCK_OUT` /
`I2S0O_WS_OUT` signals to mic2's and mic3's SCK/WS pins too. No wires join
the ports physically. Every mic sees the same edges; pad-to-pad skew is a
few ns, against a 20.8 µs sample period.

**Other setup:**
- **LR:** every mic's LR pin is driven LOW, so all three transmit in the left (WS-low) slot.
- **Clock jitter:** the S3 has no audio PLL, so BCLK comes from a fractional divider of 160 MHz. Edges jitter by about 6 ns, but the average rate is exact and all channels share it, so arrival-time differences are unaffected.

### 2. Bit capture (`bit_capture.c`): why the camera peripheral

The S3 has two I2S controllers, and each has one data input in standard mode.
With three mics on three separate SD wires, I2S alone can't capture them all
without joining wires. Instead, the **LCD_CAM camera interface** captures
the raw I2S lines in parallel.

**Inputs:**
- **PCLK** ← mic1's BCLK pad. The input path of an output pad sees exactly the edges the mics see.
- **DATA0/1/2** ← SD of mic1/2/3; **DATA3** ← WS; DATA4–7 ← constant 0.
- **Sampling:** on the BCLK rising edge. The mics change SD on the falling edge, leaving about 160 ns of margin.
- **HSYNC / DE** ← constant 1.
- **VSYNC** ← GPIO7, a pad the firmware drives. *The camera only starts capturing on a VSYNC rising edge* (found on hardware: a constant VSYNC never starts it). So start-up holds VSYNC low, starts the camera, then raises VSYNC once and leaves it high.

All three channels are sampled by **one peripheral on the same clock edge**.
That means zero inter-channel offset, and no drift is possible.

**Byte packing:**
- Each byte in DMA memory is one BCLK period: `bit0` SD1 · `bit1` SD2 · `bit2` SD3 · `bit3` WS.
- One stereo I2S frame is 64 bytes. At 48 kHz that's 3.072 MB/s.

**GDMA ring:**
- **Descriptors:** a circular chain of 32 descriptors × 3,840 B (60 I2S frames each), 122,880 B ≈ 40 ms of internal DMA RAM.
- **Free-running:** `owner_check` is off, so the DMA never stops; the consumer detects lag itself.
- **EOF:** the camera's `rec_data_bytelen` raises a GDMA EOF every 15,360 B (5 ms, 4 descriptors), instead of on VSYNC.
- **Interrupt:** the EOF ISR (allocated on core 0) posts the closing descriptor index to a FreeRTOS queue.

**Lag detection in the capture task:**
- If the queued EOFs plus the pending descriptors span almost the whole ring, the unread data is already being overwritten.
- The task then skips to the newest block, re-syncs the deserializer, counts a `dma_overrun`, and sets packet flag bit 1.

### 3. Deserializer (`deserialize.c`, pure C, host-tested)

**Frame layout (byte offsets within one 64-byte frame):**

```
 byte:  0   1   2  …  16  17 … 31 │ 32  33 … 63 │ 64 (next frame)
 WS:    0   0   0  …   0   0 …  0 │  1   1 …  1 │  0
 SD:    ·  MSB ─ top 16 bits ─┘ …  │  (right slot: tri-stated → 0)
```

**Finding frames:**
- **Lock:** find the WS falling edge (byte `p`). In Philips format the MSB follows one BCLK later, so bytes `p+1 … p+16` hold the top 16 bits of every mic.
- **Every frame is checked:** WS low at bytes 0 and 31, high at 32 and 63, and low again at 64.
- **On a mismatch:** drop the frame, count a `sync_loss`, re-lock on the next edge, and set packet flag bit 1.

**Bit gather:**
- Bytes `p+1 … p+16` are read as four little-endian 32-bit words.
- For mic *c*, `(w >> c) & 0x01010101` isolates its 4 bits at positions 0/8/16/24.
- Multiplying by `0x08040201` (2²⁷+2¹⁸+2⁹+1) moves them to bits 27…24, earliest byte as the MSB. The partial products never overlap, so there are no carries.
- Four nibbles make the 16-bit sample, in about 100 operations per frame.

**Feeding:** frames that straddle descriptor boundaries are carried over in a small work buffer.

**Test:** `tools/test_deserialize.c` feeds a random-phase, randomly chunked bitstream with an injected WS glitch. It checks bit-exact output and exactly one re-lock.

### 4. PSRAM ring buffer (`ring_buffer.c`)

**Layout:**
- **Size:** 6 s × 48,000 frames × 6 B = 1,728,000 B, in the 2 MB PSRAM, allocated with `MALLOC_CAP_SPIRAM` after checking `esp_psram_get_size()`.
- **Format:** interleaved `int16 [m1, m2, m3]`.
- **Indexing:** frames are addressed by a 64-bit monotonic index that never wraps. Slot = `index % 288,000`.

**Concurrency:**
- **Single writer:** the capture task (core 0) copies a 20 ms block, then publishes `write_idx` with release ordering. It never blocks.
- **Single reader:** the stream task (core 1) copies frames out, then *re-checks* `write_idx` (seqlock style). The copy is valid only if its first frame is still at least `capacity − one block` behind the writer, because the writer may be partway through overwriting the next block.
- **If the reader is lapped:** it jumps to the oldest intact frame and the next packet carries flag bit 0 (overrun).

**Timing budget:** 4 s pre-trigger plus 2 s headroom. The Uno Q must start reading within about 2 s of the notify line going high. After that, USB at 768 KB/s drains the backlog about 2.7× faster than real time.

### 5. Trigger (`trigger.c`, every 20 ms block)

A block counts as **positive** only if all three gates pass:

1. **Level (mic 1):** remove DC and compute RMS, smoothed over about 100 ms (single blocks swing ±3 dB, which would break the 5-in-a-row debounce). The smoothed level must be at least **4 dB** above the adaptive noise floor.
2. **Spectral (mic 1):** Hann window, then Goertzel bins every 50 Hz: 100–400 Hz (7), 1–3 kHz (9) and the 50 Hz wind bin. Mean band power and wind power are each smoothed over about 100 ms before taking the ratio, which must exceed **0 dB**. It's effectively relaxed for the hall demo, since phone/PA playback has little energy below ~300 Hz; raise it for outdoor use with real saws. (A single 20 ms bin of noise swings ±10 dB block to block; smoothed, background stays within −1.5 to +3 dB.)
3. **Coherence (all mics):** complex Goertzel on the 1–3 kHz bins of every mic. Cross- and auto-spectra are averaged over about 200 ms, then the mean magnitude-squared coherence is taken over the 3 mic pairs × 9 bins:
   - a distant point source (a chainsaw) is coherent across the array, so it scores near 1, whatever its direction;
   - wind turbulence, raindrops and a diffuse hall background are not. Measured in the hall: **0.24–0.38**.
   - The gate requires **> 0.60**. That's tuned on 2 min of hall audio: background 99th percentile 0.52, bursts up to 0.62. It's bypassed with the synthetic source, whose channels 2/3 carry frame counters.

**How the noise floor adapts (all on mic 1, every block, 50×/s):**

| When | Floor update |
|---|---|
| boot | the first 2 s average sets the starting floor (WARMUP) |
| non-positive block, outside an event | falls fast (α 0.1, ~200 ms) toward a quieter level; rises slowly (τ 20 s), **but not while the sound is coherent**: otherwise a directional source still below the margin drags the floor up behind it and never triggers (seen in the hall) |
| positive block while re-arming | rises with **τ 45 s**: a persistent sound (PA, fan, steady machinery) becomes background instead of blocking detection |
| during an event | frozen: a running saw can't raise its own threshold |

**State machine:**
- WARMUP (2 s) → IDLE → ARMING (5 positive blocks in a row) → ACTIVE → REARM.
- ACTIVE raises the notify line and ends after 2 s of quiet or 15 s after the trigger.
- REARM waits for a full quiet period before allowing the next event.

**CPU:** the trigger takes about 7.2 ms per 20 ms block at 80 MHz (≈36% of core 0). The whole capture task, including deserialization, is about **56%** (`core0_load_pct` in `INFO`).

All thresholds are in `idf.py menuconfig` → *Acoustic Front-End → Trigger*.
Watch them live with `uv run tools/receiver.py` (status + event capture).

### 6. Streamer and packets (`stream.c`, `protocol.c`)

**Event packets** (679 frames = 4,092 B each, one USB write per packet):
- `0x01` pre-trigger: `[trigger − 192,000, trigger)`;
- `0x02` live, as audio arrives;
- `0x03` end, with 0 frames.

**Sending rules:**
- `seq_num` increases across events.
- A packet the USB driver doesn't accept isn't counted as sent and is retried later. A partly accepted packet is always finished, so the byte stream stays aligned.

**Packet format** (little-endian, CRC32 IEEE over header + PCM, computed by the ROM `esp_rom_crc32_le`):

| Offset | Size | Field |
|---|---|---|
| 0 | 2 | magic `AA 55` |
| 2 | 1 | type (`01` pre, `02` live, `03` end) |
| 3 | 1 | flags: bit0 ring overrun, **bit1 capture sync loss (addition)** |
| 4 | 4 | sample_rate |
| 8 | 4 | seq_num |
| 12 | 2 | frame_count N |
| 14 | 6N | PCM int16 `[m1, m2, m3]` |
| 14+6N | 4 | CRC32 |

### 7. Tasks, cores, power

| Core | Task | Work |
|---|---|---|
| 0 (prio max−2) | capture | GDMA EOF ISR, deserialize, 20 ms blocks, ring write, trigger, notify GPIO |
| 1 (prio 5) | stream | USB commands, ring read, packetize, USB-Serial/JTAG (its ISR is on core 1 too) |

**Power:**
- CPU fixed at 80 MHz.
- Wi-Fi is never initialised and Bluetooth is compiled out.
- Light sleep isn't possible while I2S/DMA run.

## Host side

**Opening the port:** keep **DTR and RTS asserted** (pyserial `dtr=True, rts=True`
before `open()`). The state DTR=0 & RTS=1 resets the ESP32-S3. Right after a
flash, the first command can land while the chip reboots, so retry.

**Commands** (single bytes, some with argument bytes; replies are ASCII lines):

| Byte | Action |
|---|---|
| `I` | `INFO key=value …` status: capture lock, sync losses, per-mic dBFS, trigger state, … |
| `T` | force a trigger |
| `C` / `X` | start / stop a continuous (uncapped) event |
| `R` | `RAW <hex>`: 256 raw LCD_CAM bytes, for bring-up |
| `S` / `s` | synthetic chainsaw on/off (synthetic source only) |
| `B` + u32 | throughput benchmark (idle only) |
| `P` + 4 × u16 + u8 | play a calibration sweep on the speaker (ports 3-4): f_start, f_mid, f_end (Hz), duration (ms, ≤ 1000), all little-endian, then volume 0..255. No reply; ignored while one is playing. The speaker runs on I2S0's own clocks, so its samples are locked to the mics' frames. |
| `G` + id + i16 | set a trigger threshold at runtime (value × 100, little-endian): id `S` level margin dB (0..40), `R` band ratio dB (−30..30), `C` coherence (0..0.99, 0 = gate off). Replies `SET ok\|err …` with all three. Not stored: back to the menuconfig values after a reset (the Uno Q re-sends them). INFO shows `trig_*` (current) and `trig_default_*`. |

## Build, flash, test

**Build and flash.** ESP-IDF v5.5.6 is in `~/esp/esp-idf`. Its Python env runs on uv-managed Python 3.12, because the system Python (3.14) is too new for IDF 5.5.

```sh
. ./idf-env.sh                 # never source export.sh directly
idf.py build flash
idf.py menuconfig              # Acoustic Front-End: source (mics/synthetic), buffer, trigger
```

**Host tools** (`tools/`, a uv project):

```sh
cd tools
uv run usb_bench.py                                   # USB throughput gate
uv run receiver.py --duration 60                      # live status + save events as 3-channel WAV
uv run monitor.py                                     # status only (no event capture)
# Only ONE program can open the serial port at a time: use receiver.py when
# you want both status and recordings.
cc -O2 -I../main test_deserialize.c ../main/deserialize.c -o /tmp/td && /tmp/td
uv run trigger_sim.py events/*.wav                    # replay recordings through the trigger offline
```

**Synthetic-source test build.** The buffer-integrity tests need the synthetic
source, which puts the frame index in channels 2/3. It builds into its own
directory, so the main mic build's `sdkconfig` is untouched:

```sh
idf.py -B build_synth -D SDKCONFIG=build_synth/sdkconfig \
       -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.synth" build flash
cd tools && uv run accept_buffer.py [--acoustic | --cap | --overrun]
cd .. && idf.py flash                                  # back to the mic build
```

## Acceptance tests

1. **Buffer integrity** (`accept_buffer.py`, synthetic source). Trigger after more than 15 s of uptime. Requires:
   - exactly 192,000 contiguous pre-trigger frames;
   - every CRC valid, consecutive sequence numbers, no overrun flag;
   - first live frame == trigger frame;
   - the event ends with an END packet.

   **Passes**, including the acoustic-trigger, 15 s cap and late-host overrun variants.
2. **Clock lock** (to do): continuous event (`C`) for 10 min, with periodic impulses (claps) heard by all three mics. The inter-channel lag from cross-correlation must drift ≤ 1 sample. Expected 0, since one peripheral samples all channels on one clock.

## Deviations from SPEC.md

| Topic | SPEC.md | This firmware | Reason |
|---|---|---|---|
| Buffering | 48 kHz, 14 s ring, 10 s pre-trigger; 32 kHz fallback | 48 kHz, 6 s ring, **4 s pre-trigger**, 2 s headroom | 2 MB PSRAM; the fallback didn't fit either |
| Post-trigger | until 2 s cooldown | until 2 s cooldown, **capped at 15 s**; re-arm after quiet | agreed |
| Capture | I2S0 master + I2S1 slave, mic1+2 sharing SD | I2S0 clocks only, **LCD_CAM samples SD1/2/3 + WS** | 3 SD lines, 2 I2S inputs; same-edge sampling |
| Wake | wake a sleeping Linux host | notify line: Linux is always on, the line means "data incoming" | hackathon scope |
| Radios | `esp_wifi_stop()` / BT disable | Wi-Fi never initialised, BT compiled out | no RF at all |
| Flags | bit0 overrun | + **bit1 capture sync loss** | report dropped frames |
| Trigger | RMS gate + Goertzel ratio | + **inter-mic coherence gate**, long-term floor adaptation | reject wind/rain/diffuse hall noise |

## Bring-up notes

| Issue | Fix |
|---|---|
| LCD_CAM never captured with a constant VSYNC | drive VSYNC from GPIO7, raise it once after start |
| Mic 1 silent (SD line undriven) | left-edge module is rotated: swap mic1's port roles |
| Opening the serial port reset the chip | open with DTR/RTS asserted |
| First command after flashing is lost | host retries (`fe_serial.info()`) |
| System Python 3.14 too new for IDF 5.5 | uv-managed Python 3.12 via `idf-env.sh` |
