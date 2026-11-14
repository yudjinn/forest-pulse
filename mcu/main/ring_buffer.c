#include "ring_buffer.h"

#include <assert.h>
#include <stdatomic.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"

#include "fe_config.h"

static const char *TAG = "ring";

static int16_t *s_data;
static uint32_t s_cap;
static uint32_t s_guard;
static _Atomic uint64_t s_write_idx;

esp_err_t ring_init(uint32_t cap_frames, uint32_t guard_frames)
{
    const size_t bytes = (size_t)cap_frames * FE_FRAME_BYTES;
    const size_t psram = esp_psram_get_size();
    if (psram < bytes) {
        ESP_LOGE(TAG, "PSRAM %u B < ring %u B", (unsigned)psram, (unsigned)bytes);
        return ESP_ERR_NO_MEM;
    }
    s_data = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
    if (s_data == NULL) {
        ESP_LOGE(TAG, "cannot allocate %u B ring in PSRAM", (unsigned)bytes);
        return ESP_ERR_NO_MEM;
    }
    memset(s_data, 0, bytes);
    s_cap = cap_frames;
    s_guard = guard_frames;
    atomic_store(&s_write_idx, 0);
    ESP_LOGI(TAG, "ring: %u frames (%u B) in PSRAM of %u B", (unsigned)cap_frames, (unsigned)bytes,
             (unsigned)psram);
    return ESP_OK;
}

void ring_write(const int16_t *src, uint32_t n)
{
    assert(n <= s_guard);
    const uint64_t w = atomic_load_explicit(&s_write_idx, memory_order_relaxed);
    const uint32_t slot = (uint32_t)(w % s_cap);
    const uint32_t first = (n < s_cap - slot) ? n : s_cap - slot;
    memcpy(s_data + (size_t)slot * FE_CHANNELS, src, (size_t)first * FE_FRAME_BYTES);
    if (n > first) {
        memcpy(s_data, src + (size_t)first * FE_CHANNELS, (size_t)(n - first) * FE_FRAME_BYTES);
    }
    // Publish only after the data is in place.
    atomic_store_explicit(&s_write_idx, w + n, memory_order_release);
}

uint64_t ring_write_idx(void)
{
    return atomic_load_explicit(&s_write_idx, memory_order_acquire);
}

uint64_t ring_oldest_valid(uint64_t w)
{
    // While writing block [w, w+guard) the writer may clobber frames down to
    // w + guard - cap, so only frames newer than that are safe.
    const uint64_t span = (uint64_t)s_cap - s_guard;
    return w > span ? w - span : 0;
}

bool ring_read(uint64_t start, uint32_t n, int16_t *dst)
{
    const uint64_t w0 = ring_write_idx();
    if (start < ring_oldest_valid(w0) || start + n > w0) {
        return false;
    }
    const uint32_t slot = (uint32_t)(start % s_cap);
    const uint32_t first = (n < s_cap - slot) ? n : s_cap - slot;
    memcpy(dst, s_data + (size_t)slot * FE_CHANNELS, (size_t)first * FE_FRAME_BYTES);
    if (n > first) {
        memcpy(dst + (size_t)first * FE_CHANNELS, s_data, (size_t)(n - first) * FE_FRAME_BYTES);
    }
    // Re-check after the copy (seqlock style): if the writer advanced far
    // enough to touch our range while we copied, the copy is unusable.
    atomic_thread_fence(memory_order_acquire);
    return start >= ring_oldest_valid(ring_write_idx());
}
