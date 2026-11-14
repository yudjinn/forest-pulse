# System Overview & Target Architecture
Build custom ESP-IDF (C/C++) firmware for an ESP32-S3 mounted on an ATech 14-port motherboard acting as a low-power, sample-accurate 3-channel acoustic front-end.
The firmware continuously captures synchronized audio from three ICS-43434 I2S MEMS microphones into a PSRAM circular buffer, detects acoustic signatures matching chainsaws or heavy machinery, wakes an Arduino Uno Q (Linux host), and streams the 10-second pre-trigger audio window plus live post-trigger frames over USB-CDC.

1. Hardware & I2S Clock Synchronization RequirementsMicrophone Array: Three ICS-43434 24-bit I2S microphones arranged in a ~5 cm equilateral triangle.Zero-Drift Clock Topology (Mandatory): All three microphones must be driven by the exact same hardware bit clock (BCLK) and word select (WS) edges to preserve sub-sample Time Difference of Arrival (TDOA) phase accuracy for downstream GCC-PHAT processing:I2S0 (Master): Configured in standard Philips stereo mode generating BCLK and WS. Reads Mic 1 (LR tied GND, Left channel) and Mic 2 (LR tied 3.3V, Right channel) over a shared DIN (SD) line.I2S1 (Slave): Configured in slave mode reading Mic 3 (LR tied GND) on a second DIN (SD) pin.GPIO Matrix Fan-Out: Route I2S0's BCLK and WS output signals internally via the ESP32-S3 GPIO matrix (esp_rom_gpio_connect_out_signal / esp_rom_gpio_connect_in_signal) to drive both I2S1's slave clock inputs and the physical clock pins of the second ATech motherboard port pair. Do not use independent clock dividers for I2S0 and I2S1.Configurable Pin Mapping: Isolate all ATech 14-port Data A / Data B GPIO assignments and the WAKE GPIO pin in a dedicated board_pins.h configuration header.
2. Audio Format & PSRAM Ring BufferSample Rate & Bit Depth:Capture at 48,000 Hz (provides ~7.0 samples max TDOA across a 5 cm baseline).Extract the upper 16 significant bits from each 24-bit I2S word and store as signed int16_t, interleaved per frame as [ch0, ch1, ch2] (6 bytes per sample frame; 288 KB/s total throughput).PSRAM Allocation & Lap-Around Protection:Verify PSRAM size at boot via esp_psram_get_size().Target pre-trigger window: 10 seconds (2,880,000 bytes at 48 kHz).Allocate a 14-second circular buffer (4,032,000 bytes) in external SPI RAM (heap_caps_malloc(..., MALLOC_CAP_SPIRAM)). The extra 4 seconds of headroom prevents the live DMA write pointer from overwriting the oldest pre-trigger samples while a ~3.5-second USB-CDC flush is in progress.Fallback rule: If detected PSRAM is < 8 MB (e.g., 2 MB R2 variant), automatically step down sample rate to 32,000 Hz (192 KB/s) to fit the ring buffer cleanly in available PSRAM.
3. Acoustic Trigger & Power ManagementRadio Shutdown: Explicitly disable Wi-Fi and Bluetooth (esp_wifi_stop(), esp_bt_controller_disable()) at boot to minimize current draw and prevent RF/interrupt jitter.Frame Cadence: Process incoming DMA buffers in 20 ms chunks (960 samples/channel at 48 kHz) inside internal SRAM before copying into the PSRAM ring buffer.Two-Stage Pre-Trigger Gate (evaluated on Channel 0):Adaptive RMS Gate: Track a slow exponential moving average of background noise RMS and require current frame RMS to exceed the noise floor by a configurable SNR margin.Goertzel Spectral Ratio: Compute lightweight Goertzel magnitudes targeting chainsaw/combustion fundamental and harmonic bands (80–400 Hz and 1,000–3,000 Hz) and compare against sub-80 Hz energy to reject low-frequency wind buffeting.Debouncing & Hold:Trigger assertion: Require $N$ consecutive positive 20 ms frames (default N = 5, i.e., 100 ms) to reject transient clicks/snaps.Post-trigger hold: Continue streaming live frames after the trigger until the signal remains below threshold for a configurable cooldown (default 2.0 s).
4. Uno Q Wake & USB-CDC Binary Protocol
- Hardware Wake Signal: Upon trigger confirmation, drive a dedicated WAKE GPIO pin HIGH (held HIGH for the duration of the active event) to wake/signal the Arduino Uno Q Linux host.
- USB-CDC Transport:
  - Use native USB-CDC (TinyUSB or USB Serial/JTAG) configured for high-throughput binary transfer.
  - Flush data in 4 KB chunks so the Full-Speed USB PHY sustains ~850–950 KB/s without blocking I2S DMA interrupts.
- Packet Framing: Stream packets using a deterministic little-endian binary format (no JSON or ASCII encoding):
Offset|Size|Field|Description
0|2 B|magic|Sync header 0xAA, 0x55
2|1 B|msg_type0x01 = Pre-trigger dump, 0x02 = Live continuationframe, 0x03 = Event end
3|1 B|flagsBit 0: Ring buffer overrun flag
4|4 B|sample_rateuint32_t (e.g., 48000)
8|4 B|seq_numMonotonic uint32_t packet counter
12|2 B|frame_countuint16_t number of 3-channel frames in payload
14|6 * N B|pcm_dataInterleaved int16_t samples [ch0, ch1, ch2, ...]14 + 6N4 Bcrc32Standard IEEE 802.3 CRC32 over header + pcm_data
5. FreeRTOS Task Architecture & Verification Criteria
- Task Isolation:
  - Core 0 (High Priority): I2S DMA read loop, int16_t packing, PSRAM ring buffer writes, and 20 ms Goertzel/RMS trigger evaluation. Must never block on USB I/O.
  - Core 1 (Normal Priority): USB-CDC packetizer and 4 KB chunked ring-buffer reader, synchronized with Core 0 via atomic read/write indices or a lock-free ring buffer descriptor.
- Acceptance Tests to Include in Code/README:
  - Clock Lock Check: Simultaneous impulse test across all 3 mics shows <= 1 sample drift over a continuous 10-minute run.
  - Buffer Integrity Check: Triggering after >15 seconds of uptime outputs an intact, contiguous 10-second pre-trigger
  - window (480,000 frames) with valid CRC32 checksums and overrun == 0.
