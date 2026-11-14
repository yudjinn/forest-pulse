// Host unit test for main/deserialize.c.
// Build & run:  cc -O2 -Wall -Wextra -I../main test_deserialize.c ../main/deserialize.c -o /tmp/td && /tmp/td
//
// Generates a Philips I2S bitstream exactly as LCD_CAM would capture it
// (bit0..2 = SD of mic1..3, bit3 = WS, one byte per BCLK rising edge), with a
// random starting phase, random feed sizes, and an injected WS glitch, then
// checks every recovered sample.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "deserialize.h"

#define NFRAMES 20000

static int32_t samples[NFRAMES][3];  // 24-bit signed per mic

static uint8_t frame_byte(int f, int k)
{
    // Byte k of frame f. WS: low for k 0..31 (left), high 32..63 (right).
    uint8_t b = (k >= 32) ? (1u << 3) : 0;
    const int j = k - 1;  // left-slot bit index, MSB at k = 1
    for (int ch = 0; ch < 3; ch++) {
        int bit = 0;
        if (j >= 0 && j < 24) {
            bit = ((uint32_t)samples[f][ch] >> (23 - j)) & 1u;
        }
        // Right slot (LR low): mics are tri-stated -> pulled down -> 0.
        b |= (uint8_t)(bit << ch);
    }
    return b;
}

int main(void)
{
    srand(12345);
    for (int f = 0; f < NFRAMES; f++) {
        for (int ch = 0; ch < 3; ch++) {
            samples[f][ch] = (int32_t)((((uint32_t)rand() << 8) ^ (uint32_t)rand()) & 0xFFFFFFu);
            if (samples[f][ch] & 0x800000) {
                samples[f][ch] -= 0x1000000;  // sign-extend 24-bit
            }
        }
    }

    // Build the stream starting mid-frame (random phase).
    const int phase = 37;
    const size_t total = (size_t)NFRAMES * 64 - phase;
    uint8_t *stream = malloc(total);
    for (size_t i = 0; i < total; i++) {
        const size_t abs = i + phase;
        stream[i] = frame_byte((int)(abs / 64), (int)(abs % 64));
    }
    // Inject a WS glitch at frame 5000's mid-frame edge (WS low where it must
    // rise). A glitch elsewhere would not matter: SD bits are untouched.
    const size_t glitch = (size_t)5000 * 64 + 32 - phase;
    stream[glitch] &= (uint8_t)~(1u << 3);

    static deser_t d;
    deser_init(&d);
    static int16_t out[NFRAMES * 3];
    size_t got = 0;
    size_t pos = 0;
    while (pos < total) {
        size_t chunk = 1 + (size_t)rand() % DESER_MAX_FEED;
        if (chunk > total - pos) {
            chunk = total - pos;
        }
        got += deser_feed(&d, stream + pos, chunk, out + got * 3);
        pos += chunk;
    }

    // Frame 0 is partial (phase), so output starts at frame 1. The glitch
    // frame (5000) is dropped and the stream resyncs at the next WS edge.
    int errors = 0;
    size_t o = 0;
    for (int f = 1; f < NFRAMES - 1 && o < got; f++) {
        if (f == 5000) {
            continue;
        }
        for (int ch = 0; ch < 3; ch++) {
            const int16_t want = (int16_t)(samples[f][ch] >> 8);
            if (out[o * 3 + ch] != want) {
                if (errors++ < 5) {
                    printf("mismatch frame %d ch %d: got %d want %d\n", f, ch, out[o * 3 + ch], want);
                }
            }
        }
        o++;
    }
    const size_t expected = NFRAMES - 3;  // minus partial first, glitched, unflushed last
    printf("frames out=%zu expected=%zu sync_losses=%u errors=%d\n", got, expected, (unsigned)d.sync_losses,
           errors);
    const int ok = errors == 0 && got == expected && d.sync_losses == 1;
    printf("RESULT: %s\n", ok ? "PASS" : "FAIL");
    free(stream);
    return ok ? 0 : 1;
}
