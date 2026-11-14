#include "synth_source.h"

#include <math.h>
#include <stdatomic.h>

#include "fe_config.h"

#define SINE_BITS 10u
#define SINE_LEN (1u << SINE_BITS)

// Chainsaw-ish: 150 Hz combustion fundamental + harmonics, mid/high tones,
// broadband noise.
static const struct {
    float hz;
    int16_t amp;
} k_tones[] = {
    {150, 6000}, {300, 4000}, {450, 3000}, {600, 2000}, {750, 1500}, {900, 1000},
    {1200, 800}, {1750, 800}, {2300, 800}, {2850, 800},
};
#define N_TONES (sizeof k_tones / sizeof k_tones[0])

static int16_t s_sine[SINE_LEN];
static uint32_t s_phase[N_TONES];
static uint32_t s_step[N_TONES];
static uint32_t s_rng = 0x12345678u;
static atomic_bool s_sound_on;

static inline int32_t noise(int32_t amp)
{
    s_rng ^= s_rng << 13;  // xorshift32
    s_rng ^= s_rng >> 17;
    s_rng ^= s_rng << 5;
    return (int32_t)(s_rng % (uint32_t)(2 * amp + 1)) - amp;
}

void synth_init(void)
{
    for (uint32_t i = 0; i < SINE_LEN; i++) {
        s_sine[i] = (int16_t)lrintf(32767.0f * sinf(2.0f * (float)M_PI * i / SINE_LEN));
    }
    for (size_t t = 0; t < N_TONES; t++) {
        s_step[t] = (uint32_t)((double)k_tones[t].hz * 4294967296.0 / FE_SAMPLE_RATE);
    }
}

void synth_set_sound(bool on)
{
    atomic_store(&s_sound_on, on);
}

void synth_fill(int16_t *out, uint32_t n, uint64_t first_frame)
{
    const bool sound = atomic_load(&s_sound_on);
    for (uint32_t i = 0; i < n; i++) {
        int32_t v = noise(40);  // ~ -63 dBFS background
        if (sound) {
            for (size_t t = 0; t < N_TONES; t++) {
                v += (k_tones[t].amp * s_sine[s_phase[t] >> (32 - SINE_BITS)]) >> 15;
                s_phase[t] += s_step[t];
            }
            v += noise(300);
        }
        const uint32_t idx = (uint32_t)(first_frame + i);
        out[i * FE_CHANNELS + 0] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
        out[i * FE_CHANNELS + 1] = (int16_t)(idx & 0xFFFFu);
        out[i * FE_CHANNELS + 2] = (int16_t)(idx >> 16);
    }
}
