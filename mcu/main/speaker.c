#include "speaker.h"

#include <math.h>
#include <string.h>

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "clock_gen.h"
#include "fe_config.h"

static const char *TAG = "speaker";

#define CHUNK_FRAMES 240u  // 5 ms per write; the TX DMA holds several of these
#define TWO_PI 6.28318530718f
#define PI_F 3.14159265359f
// Raised-cosine fade in and out, so a sweep starts and ends without a click (nicer to stand next to). Costs no
// timing: on the library's detector a 20-40 ms fade moved nothing beyond 0.1 dB of matched signal. Short tones (the
// alarm's 120 ms) get at most a sixth of their length.
#define FADE_MS 20u

typedef struct {
    uint16_t f_start, f_mid, f_end, duration_ms;
    uint8_t volume;
} sweep_t;

static QueueHandle_t s_queue;
static int32_t s_chunk[CHUNK_FRAMES * 2];  // stereo frames, 32-bit slots (internal SRAM)

// The step frequency in effect at sample i of n (steps of 1 ms, frequency at the
// step's centre along the two linear legs), as patterns.sweep() computes it.
static float step_freq(const sweep_t *s, uint32_t i, uint32_t n, uint32_t steps)
{
    uint32_t k = (uint32_t)(((uint64_t)i * steps) / n);
    if (k >= steps) {
        k = steps - 1;
    }
    const float u = ((float)k + 0.5f) / (float)steps;
    if (u < 0.5f) {
        return (float)s->f_start + ((float)s->f_mid - (float)s->f_start) * (u / 0.5f);
    }
    return (float)s->f_mid + ((float)s->f_end - (float)s->f_mid) * ((u - 0.5f) / 0.5f);
}

static void play(const sweep_t *s)
{
    i2s_chan_handle_t tx = clock_gen_tx();
    const uint32_t n = FE_MS_TO_FRAMES(s->duration_ms);
    const uint32_t steps = s->duration_ms ? s->duration_ms : 1;  // one step per ms
    const float amp = (float)s->volume / 255.0f * 2147483000.0f;
    uint32_t fade = FE_MS_TO_FRAMES(FADE_MS);
    if (fade > n / 6) {
        fade = n / 6;
    }
    float phase = 0.0f;  // radians, kept in [0, 2 pi)
    uint32_t i = 0;
    while (i < n) {
        const uint32_t m = (n - i) < CHUNK_FRAMES ? (n - i) : CHUNK_FRAMES;
        for (uint32_t j = 0; j < m; j++, i++) {
            float g = 1.0f;
            if (i < fade) {
                g = 0.5f - 0.5f * cosf(PI_F * (float)i / (float)fade);
            } else if (i >= n - fade) {
                g = 0.5f - 0.5f * cosf(PI_F * (float)(n - 1 - i) / (float)fade);
            }
            const int32_t v = (int32_t)(amp * g * sinf(phase));
            s_chunk[2 * j] = v;
            s_chunk[2 * j + 1] = v;
            phase += TWO_PI * step_freq(s, i, n, steps) / (float)FE_SAMPLE_RATE;
            if (phase >= TWO_PI) {
                phase -= TWO_PI;
            }
        }
        size_t written = 0;
        if (i2s_channel_write(tx, s_chunk, m * 2 * sizeof(int32_t), &written, pdMS_TO_TICKS(200)) != ESP_OK) {
            ESP_LOGW(TAG, "write failed after %u of %u frames", (unsigned)i, (unsigned)n);
            return;
        }
    }
    // a few ms of silence so the amplifier ends on zero, not on the last sample
    memset(s_chunk, 0, sizeof s_chunk);
    size_t written = 0;
    i2s_channel_write(tx, s_chunk, sizeof s_chunk, &written, pdMS_TO_TICKS(200));
}

static void speaker_task(void *arg)
{
    sweep_t s;
    for (;;) {
        if (xQueueReceive(s_queue, &s, portMAX_DELAY) == pdTRUE) {
            play(&s);
        }
    }
}

esp_err_t speaker_start(void)
{
    s_queue = xQueueCreate(1, sizeof(sweep_t));
    if (s_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }
    // Core 1 with the stream task, above it so the DMA never runs dry mid-sweep
    // (each chunk takes well under its 5 ms to compute).
    if (xTaskCreatePinnedToCore(speaker_task, "speaker", 3072, NULL, 6, NULL, 1) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool speaker_play(uint16_t f_start_hz, uint16_t f_mid_hz, uint16_t f_end_hz, uint16_t duration_ms, uint8_t volume)
{
    const uint16_t f[3] = {f_start_hz, f_mid_hz, f_end_hz};
    for (int k = 0; k < 3; k++) {
        if (f[k] < 100 || f[k] > 20000) {
            return false;
        }
    }
    if (duration_ms == 0 || duration_ms > SPEAKER_MAX_MS || s_queue == NULL) {
        return false;
    }
    const sweep_t s = {f_start_hz, f_mid_hz, f_end_hz, duration_ms, volume};
    return xQueueSend(s_queue, &s, 0) == pdTRUE;
}
