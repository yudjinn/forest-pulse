#include "capture.h"

#include <math.h>
#include <stdatomic.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"

#include "fe_config.h"
#include "ring_buffer.h"
#include "trigger.h"

#if CONFIG_FE_SOURCE_MICS
#include "bit_capture.h"
#include "clock_gen.h"
#include "deserialize.h"
#include "driver/gpio.h"
#include "board_pins.h"
#else
#include "synth_source.h"
#endif

static const char *TAG = "capture";

#define RAW_BYTES 256u
#define STARTUP_DISCARD_BLOCKS (200u / FE_BLOCK_MS)  // ICS-43434 settling

static TaskHandle_t s_stream_task;
static int16_t s_block[FE_BLOCK_FRAMES * FE_CHANNELS];  // internal SRAM
static capture_diag_t s_diag;
static atomic_bool s_discontinuity;
static atomic_bool s_raw_req, s_raw_ready;
static uint8_t s_raw[RAW_BYTES];

// ---------------------------------------------------------------------------
// Common block sink: ring -> trigger -> wake streamer
// ---------------------------------------------------------------------------

static void process_block(void)
{
    const int64_t t0 = esp_timer_get_time();

    int64_t sq[FE_CHANNELS] = {0};
    for (uint32_t i = 0; i < FE_BLOCK_FRAMES; i++) {
        for (uint32_t c = 0; c < FE_CHANNELS; c++) {
            const int32_t v = s_block[i * FE_CHANNELS + c];
            sq[c] += v * v;
        }
    }
    for (uint32_t c = 0; c < FE_CHANNELS; c++) {
        const float rms = sqrtf((float)sq[c] / FE_BLOCK_FRAMES) / 32768.0f;
        s_diag.ch_dbfs[c] = 20.0f * log10f(rms > 1e-9f ? rms : 1e-9f);
    }

    const uint64_t first = ring_write_idx();
    ring_write(s_block, FE_BLOCK_FRAMES);
    trigger_process(s_block, FE_BLOCK_FRAMES, first + FE_BLOCK_FRAMES);
    xTaskNotifyGive(s_stream_task);

    const uint32_t dt = (uint32_t)(esp_timer_get_time() - t0);
    if (dt > s_diag.max_block_us) {
        s_diag.max_block_us = dt;
    }
    s_diag.avg_block_us = s_diag.avg_block_us ? (s_diag.avg_block_us * 31 + dt) / 32 : dt;
}

#if CONFIG_FE_SOURCE_MICS
// ---------------------------------------------------------------------------
// Real mics: I2S0 clocks + LCD_CAM bit capture + deserializer
// ---------------------------------------------------------------------------

static deser_t s_deser;
static int16_t s_tmp[((DESER_MAX_FEED + 2 * DESER_FRAME_BYTES) / DESER_FRAME_BYTES) * FE_CHANNELS];
static uint32_t s_fill;  // frames currently in s_block
static uint32_t s_discard = STARTUP_DISCARD_BLOCKS;

static void emit_frames(const int16_t *f, size_t n)
{
    while (n > 0) {
        const size_t take = (n < FE_BLOCK_FRAMES - s_fill) ? n : FE_BLOCK_FRAMES - s_fill;
        memcpy(s_block + (size_t)s_fill * FE_CHANNELS, f, take * FE_FRAME_BYTES);
        s_fill += take;
        f += take * FE_CHANNELS;
        n -= take;
        if (s_fill == FE_BLOCK_FRAMES) {
            s_fill = 0;
            if (s_discard > 0) {
                s_discard--;
            } else {
                process_block();
            }
        }
    }
}

static void consume_desc(uint32_t d)
{
    const uint8_t *buf = bitcap_desc_buf(d);
    const uint32_t len = bitcap_desc_len(d);
    if (len != BITCAP_DESC_BYTES) {
        s_diag.short_desc++;
    }
    if (atomic_load(&s_raw_req) && len >= RAW_BYTES) {
        memcpy(s_raw, buf, RAW_BYTES);
        atomic_store(&s_raw_req, false);
        atomic_store(&s_raw_ready, true);
    }
    const uint32_t losses = s_deser.sync_losses;
    const size_t n = deser_feed(&s_deser, buf, len, s_tmp);
    if (s_deser.sync_losses != losses) {
        s_diag.sync_losses += s_deser.sync_losses - losses;
        atomic_store(&s_discontinuity, true);
    }
    s_diag.locked = s_deser.locked;
    emit_frames(s_tmp, n);
}

// Start clocks, then the camera. LCD_CAM only begins capturing on a VSYNC
// rising edge (a constant VSYNC never starts it - found on hardware), so
// VSYNC is held low through start and then raised once and left high.
static bool start_capture(uint32_t *first_eof)
{
    ESP_ERROR_CHECK(bitcap_init());
    ESP_ERROR_CHECK(clock_gen_init());
    ESP_ERROR_CHECK(clock_gen_start());
    bitcap_set_vsync(0);
    ESP_ERROR_CHECK(bitcap_start(false));
    vTaskDelay(pdMS_TO_TICKS(1));
    bitcap_set_vsync(1);
    if (!bitcap_wait_eof(first_eof, pdMS_TO_TICKS(100))) {
        return false;
    }
    ESP_LOGI(TAG, "LCD_CAM running");
    return true;
}

static uint32_t count_toggles(int pin)
{
    uint32_t t = 0;
    int last = gpio_get_level(pin);
    for (int i = 0; i < 20000; i++) {
        const int v = gpio_get_level(pin);
        t += v != last;
        last = v;
    }
    return t;
}

static void capture_task(void *arg)
{
    deser_init(&s_deser);
    s_diag.mics = true;
    uint32_t e;
    if (!start_capture(&e)) {
        s_diag.no_data = true;
        s_diag.toggles_bclk = count_toggles(PIN_MIC1_BCLK);
        s_diag.toggles_ws = count_toggles(PIN_MIC1_WS);
        s_diag.toggles_sd1 = count_toggles(PIN_MIC1_SD);
        s_diag.toggles_sd2 = count_toggles(PIN_MIC2_SD);
        s_diag.toggles_sd3 = count_toggles(PIN_MIC3_SD);
        s_diag.desc0_len = bitcap_desc_len(0);
        s_diag.buf_nonzero = bitcap_ring_nonzero();
        ESP_LOGE(TAG, "LCD_CAM produced no data with either VSYNC polarity");
        vTaskDelete(NULL);
        return;
    }
    uint32_t next = 0;  // next descriptor to consume (DMA started at desc 0)
    for (;;) {
        s_diag.eofs++;
        // If the EOFs still queued behind this one span (almost) the whole
        // DMA ring, the descriptors we have not read yet are already being
        // overwritten: skip to the newest block and resync. (The descriptor
        // count alone can't tell, since it wraps modulo the ring size.)
        const uint32_t backlog = bitcap_backlog();
        const uint32_t pending = (e + BITCAP_NUM_DESC - next) % BITCAP_NUM_DESC + 1;
        if ((backlog + 1) * BITCAP_DESC_PER_EOF > BITCAP_NUM_DESC - BITCAP_DESC_PER_EOF ||
            pending > BITCAP_NUM_DESC - BITCAP_DESC_PER_EOF) {
            while (bitcap_wait_eof(&e, 0)) {
                s_diag.eofs++;
            }
            s_diag.dma_overruns++;
            atomic_store(&s_discontinuity, true);
            deser_resync(&s_deser);
        } else {
            for (uint32_t i = 0; i < pending; i++) {
                consume_desc((next + i) % BITCAP_NUM_DESC);
            }
        }
        next = (e + 1) % BITCAP_NUM_DESC;

        while (!bitcap_wait_eof(&e, pdMS_TO_TICKS(100))) {
            s_diag.stalls++;
        }
    }
}

#else
// ---------------------------------------------------------------------------
// Synthetic source: paced by the RTOS tick (1 kHz -> exact 20 ms)
// ---------------------------------------------------------------------------

static void capture_task(void *arg)
{
    synth_init();
    TickType_t last_wake = xTaskGetTickCount();
    for (;;) {
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(FE_BLOCK_MS));
        synth_fill(s_block, FE_BLOCK_FRAMES, ring_write_idx());
        process_block();
    }
}
#endif

void capture_start(TaskHandle_t stream_task)
{
    s_stream_task = stream_task;
    // The GDMA interrupt is allocated on the core that registers it: core 0.
    xTaskCreatePinnedToCore(capture_task, "capture", 6144, NULL, configMAX_PRIORITIES - 2, NULL, 0);
}

void capture_get_diag(capture_diag_t *out)
{
    *out = s_diag;
}

bool capture_take_discontinuity(void)
{
    return atomic_exchange(&s_discontinuity, false);
}

void capture_request_raw(void)
{
    atomic_store(&s_raw_ready, false);
    atomic_store(&s_raw_req, true);
}

bool capture_get_raw(uint8_t *dst, size_t n)
{
    if (!atomic_load(&s_raw_ready)) {
        return false;
    }
    memcpy(dst, s_raw, n < RAW_BYTES ? n : RAW_BYTES);
    return true;
}
