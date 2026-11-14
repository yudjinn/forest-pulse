#include "deserialize.h"

#include <string.h>

#define WS(b) (((b) >> DESER_WS_BIT) & 1u)

void deser_init(deser_t *d)
{
    memset(d, 0, sizeof *d);
}

void deser_resync(deser_t *d)
{
    d->work_len = 0;
    d->locked = false;
}

static inline uint32_t load_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

// Collect bit `ch` from 4 consecutive bytes (packed in w) into a nibble,
// first byte -> most significant. (w >> ch) & 0x01010101 leaves the bits at
// positions 0/8/16/24; multiplying by 2^27 + 2^18 + 2^9 + 1 moves them to
// 27/26/25/24 with no overlapping partial products (so no carries).
static inline uint32_t gather_nibble(uint32_t w, unsigned ch)
{
    return (((w >> ch) & 0x01010101u) * 0x08040201u) >> 24 & 0xFu;
}

// Bytes p[1..16] -> top 16 bits of each mic.
static inline void extract_frame(const uint8_t *p, int16_t *out)
{
    const uint32_t w0 = load_le32(p + 1);
    const uint32_t w1 = load_le32(p + 5);
    const uint32_t w2 = load_le32(p + 9);
    const uint32_t w3 = load_le32(p + 13);
    for (unsigned ch = 0; ch < 3; ch++) {
        const uint32_t v = gather_nibble(w0, ch) << 12 | gather_nibble(w1, ch) << 8 | gather_nibble(w2, ch) << 4 |
                           gather_nibble(w3, ch);
        out[ch] = (int16_t)(uint16_t)v;
    }
}

// A valid frame starting at p: WS low for bytes 0..31, high for 32..63, and
// the next frame starts low again at p[64]. Checking the four edges catches
// both slips and noise on WS.
static inline bool frame_ok(const uint8_t *p)
{
    return WS(p[0]) == 0 && WS(p[31]) == 0 && WS(p[32]) == 1 && WS(p[63]) == 1 && WS(p[64]) == 0;
}

size_t deser_feed(deser_t *d, const uint8_t *data, size_t len, int16_t *out)
{
    if (len > DESER_MAX_FEED) {
        len = DESER_MAX_FEED;
    }
    memcpy(d->work + d->work_len, data, len);
    const size_t n = d->work_len + len;
    const uint8_t *w = d->work;
    size_t i = 0;
    size_t frames = 0;

    for (;;) {
        if (!d->locked) {
            // Find a WS falling edge: w[i-1] high, w[i] low.
            size_t k = i ? i : 1;
            while (k < n && !(WS(w[k - 1]) == 1 && WS(w[k]) == 0)) {
                k++;
            }
            if (k >= n) {
                i = n - 1;  // keep the last byte: an edge may straddle feeds
                break;
            }
            i = k;
            d->locked = true;
        }
        if (i + DESER_FRAME_BYTES + 1 > n) {
            break;  // need the whole frame plus the next frame's first byte
        }
        if (!frame_ok(w + i)) {
            d->locked = false;
            d->sync_losses++;
            i++;
            continue;
        }
        extract_frame(w + i, out + frames * 3);
        frames++;
        i += DESER_FRAME_BYTES;
    }

    d->work_len = n - i;
    memmove(d->work, w + i, d->work_len);
    d->frames += frames;
    return frames;
}
