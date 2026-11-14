#pragma once
// Turns the LCD_CAM byte stream back into 3-channel int16 frames.
//
// Each captured byte is one BCLK rising edge:
//   bit0 = SD mic1, bit1 = SD mic2, bit2 = SD mic3, bit3 = WS, bits 4-7 = 0
// A stereo I2S frame (2 x 32-bit slots) is 64 bytes. In Philips format WS
// falls one BCLK before the left-slot MSB, so if byte p is the first with
// WS=0, bytes p+1 .. p+16 carry the top 16 bits (MSB first) of every mic.
// All mics have LR tied low, so only the left slot carries data.
//
// Pure C, no ESP-IDF dependencies, so it is unit-tested on the host
// (tools/test_deserialize.c).

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define DESER_FRAME_BYTES 64u
#define DESER_WS_BIT 3u
#define DESER_MAX_FEED 4096u

typedef struct {
    uint8_t work[DESER_MAX_FEED + 2 * DESER_FRAME_BYTES];
    size_t work_len;
    bool locked;
    uint32_t sync_losses;  // lock lost after having been locked
    uint64_t frames;       // frames emitted since init
} deser_t;

void deser_init(deser_t *d);

// Drop buffered bytes and lock (after a capture gap); keeps the counters.
void deser_resync(deser_t *d);

// Feed `len` (<= DESER_MAX_FEED) captured bytes. Emits complete frames as
// interleaved int16 [m1, m2, m3] into `out` (room for at least
// (len + 2 * DESER_FRAME_BYTES) / DESER_FRAME_BYTES frames). Returns the
// number of frames written.
size_t deser_feed(deser_t *d, const uint8_t *data, size_t len, int16_t *out);
