#include "stream.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_private/esp_clk.h"
#include "esp_timer.h"

#include "capture.h"
#include "events.h"
#include "fe_config.h"
#include "protocol.h"
#include "ring_buffer.h"
#if CONFIG_FE_SOURCE_SYNTH
#include "synth_source.h"
#endif
#include "trigger.h"
#include "usb_link.h"

static const char *TAG = "stream";

// Packet assembly buffer: PCM is copied from the ring straight into place.
static uint8_t s_pkt[PKT_MAX_BYTES] __attribute__((aligned(4)));

typedef struct {
    bool active;
    uint64_t cursor;   // next frame to send
    uint64_t pre_end;  // trigger frame: [.., pre_end) is pre-trigger data
    uint64_t end;      // UINT64_MAX until the END event arrives
} stream_event_t;

static stream_event_t s_ev;
static uint32_t s_seq;
static uint8_t s_pending_flags;
static uint32_t s_overruns;
static uint32_t s_packets;

// ---------------------------------------------------------------------------
// USB transmission
// ---------------------------------------------------------------------------

// Returns true once the whole packet is queued. False means nothing was
// accepted (host not reading) and the caller should retry later. A partially
// accepted packet is always completed so the byte stream stays framed.
static bool send_packet(size_t len)
{
    size_t sent = usb_link_write(s_pkt, len, pdMS_TO_TICKS(50));
    if (sent == 0) {
        return false;
    }
    if (sent < len) {
        sent += usb_link_write(s_pkt + sent, len - sent, pdMS_TO_TICKS(2000));
        if (sent < len) {
            ESP_LOGW(TAG, "packet truncated (%u/%u)", (unsigned)sent, (unsigned)len);
        }
    }
    s_seq++;
    s_packets++;
    return true;
}

static bool send_pcm(uint8_t type, uint32_t frames)
{
    if (capture_take_discontinuity()) {
        s_pending_flags |= PKT_FLAG_SYNC_LOSS;
    }
    if (!ring_read(s_ev.cursor, frames, (int16_t *)(s_pkt + PKT_HEADER_BYTES))) {
        return false;  // overwritten under us; overrun check will skip ahead
    }
    const size_t len = pkt_finalize(s_pkt, type, s_pending_flags, FE_SAMPLE_RATE, s_seq, (uint16_t)frames);
    if (!send_packet(len)) {
        return false;
    }
    s_pending_flags = 0;
    s_ev.cursor += frames;
    return true;
}

static bool send_end(void)
{
    const size_t len = pkt_finalize(s_pkt, PKT_TYPE_END, s_pending_flags, FE_SAMPLE_RATE, s_seq, 0);
    if (!send_packet(len)) {
        return false;
    }
    s_pending_flags = 0;
    return true;
}

// ---------------------------------------------------------------------------
// Event packetizer. Returns true if it made progress (call again at once).
// ---------------------------------------------------------------------------

static bool pump_event(void)
{
    fe_event_t ev;
    if (!s_ev.active) {
        if (!events_receive(&ev, 0) || ev.type != FE_EVT_START) {
            return false;
        }
        const uint64_t want = ev.frame > FE_PRE_FRAMES ? ev.frame - FE_PRE_FRAMES : 0;
        const uint64_t oldest = ring_oldest_valid(ring_write_idx());
        s_ev = (stream_event_t){
            .active = true,
            .cursor = want > oldest ? want : oldest,
            .pre_end = ev.frame,
            .end = UINT64_MAX,
        };
        ESP_LOGI(TAG, "event start @%" PRIu64 ", pre-trigger from %" PRIu64, ev.frame, s_ev.cursor);
        return true;
    }

    if (s_ev.end == UINT64_MAX && events_receive(&ev, 0)) {
        if (ev.type == FE_EVT_END) {
            s_ev.end = ev.frame;
        }
    }

    // Writer lapped us (host slow/absent): jump to the oldest intact frame,
    // one block further in for margin, and flag the discontinuity.
    const uint64_t w = ring_write_idx();
    const uint64_t oldest = ring_oldest_valid(w);
    if (s_ev.cursor < oldest) {
        s_ev.cursor = oldest + FE_BLOCK_FRAMES;
        s_pending_flags |= PKT_FLAG_OVERRUN;
        s_overruns++;
    }

    const bool pre = s_ev.cursor < s_ev.pre_end;
    uint64_t limit = pre ? s_ev.pre_end : (s_ev.end < w ? s_ev.end : w);
    if (limit > w) {
        limit = w;
    }
    const uint64_t avail = limit > s_ev.cursor ? limit - s_ev.cursor : 0;

    if (avail >= PKT_MAX_FRAMES) {
        return send_pcm(pre ? PKT_TYPE_PRE : PKT_TYPE_LIVE, PKT_MAX_FRAMES);
    }
    // Partial packets only at the pre/live boundary and at event end.
    if (avail > 0 && (pre || limit == s_ev.end)) {
        return send_pcm(pre ? PKT_TYPE_PRE : PKT_TYPE_LIVE, (uint32_t)avail);
    }
    if (s_ev.end != UINT64_MAX && s_ev.cursor >= s_ev.end) {
        if (send_end()) {
            ESP_LOGI(TAG, "event end @%" PRIu64, s_ev.end);
            s_ev.active = false;
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Host commands
// ---------------------------------------------------------------------------

static void send_info(void)
{
    trig_stats_t t;
    trigger_get_stats(&t);
    capture_diag_t c;
    capture_get_diag(&c);
    char line[640];
    const int n = snprintf(
        line, sizeof line,
        "INFO idf=%s cpu_mhz=%d psram=%u rate=%" PRIu32 " ring_frames=%" PRIu32 " pre_frames=%" PRIu32
        " uptime_ms=%" PRIu64 " write_idx=%" PRIu64 " state=%s rms_dbfs=%.1f floor_dbfs=%.1f ratio_db=%.1f coherence=%.2f"
        " events=%" PRIu32 " packets=%" PRIu32 " overruns=%" PRIu32 " streaming=%d avg_block_us=%" PRIu32
        " max_block_us=%" PRIu32 " internal_free=%u crc_ok=%d src=%s cam_no_data=%d locked=%d"
        " eofs=%" PRIu32 " sync_losses=%" PRIu32 " dma_overruns=%" PRIu32 " short_desc=%" PRIu32
        " stalls=%" PRIu32 " m1_dbfs=%.1f m2_dbfs=%.1f m3_dbfs=%.1f tog_bclk=%" PRIu32 " tog_ws=%" PRIu32 " tog_sd1=%" PRIu32 " tog_sd2=%" PRIu32 " tog_sd3=%" PRIu32
        " desc0_len=%" PRIu32 " buf_nonzero=%" PRIu32 "\n",
        esp_get_idf_version(), esp_clk_cpu_freq() / 1000000, (unsigned)esp_psram_get_size(), FE_SAMPLE_RATE,
        FE_RING_FRAMES, FE_PRE_FRAMES, (uint64_t)(esp_timer_get_time() / 1000), ring_write_idx(),
        trigger_state_name(t.state), t.rms_dbfs, t.floor_dbfs, t.ratio_db, t.coherence, t.events, s_packets, s_overruns,
        s_ev.active, c.avg_block_us, c.max_block_us, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        pkt_crc_self_test(), c.mics ? "mics" : "synth", c.no_data, c.locked, c.eofs, c.sync_losses,
        c.dma_overruns, c.short_desc, c.stalls, c.ch_dbfs[0], c.ch_dbfs[1], c.ch_dbfs[2], c.toggles_bclk,
        c.toggles_ws, c.toggles_sd1, c.toggles_sd2, c.toggles_sd3, c.desc0_len, c.buf_nonzero);
    usb_link_write(line, (size_t)n, pdMS_TO_TICKS(500));
}

// 'R': hex dump of 256 raw LCD_CAM bytes (bit0-2 SD mic1-3, bit3 WS).
static void send_raw(void)
{
    static const char hex[] = "0123456789abcdef";
    uint8_t raw[256];
    capture_request_raw();
    for (int i = 0; i < 20 && !capture_get_raw(raw, sizeof raw); i++) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (!capture_get_raw(raw, sizeof raw)) {
        usb_link_write("RAW none\n", 9, pdMS_TO_TICKS(500));
        return;
    }
    char line[4 + 2 * sizeof raw + 1];
    memcpy(line, "RAW ", 4);
    for (size_t i = 0; i < sizeof raw; i++) {
        line[4 + 2 * i] = hex[raw[i] >> 4];
        line[5 + 2 * i] = hex[raw[i] & 15];
    }
    line[sizeof line - 1] = '\n';
    usb_link_write(line, sizeof line, pdMS_TO_TICKS(500));
}

static void run_bench(uint32_t total)
{
    uint32_t *chunk = (uint32_t *)s_pkt;
    uint32_t counter = 0;
    while (total > 0) {
        const uint32_t n = total < PKT_MAX_BYTES ? total : PKT_MAX_BYTES;
        for (uint32_t i = 0; i < n / 4; i++) {
            chunk[i] = counter++;
        }
        if (usb_link_write(chunk, n, pdMS_TO_TICKS(2000)) != n) {
            return;
        }
        total -= n;
    }
}

static void handle_command(uint8_t cmd)
{
    switch (cmd) {
    case 'I':
        send_info();
        break;
    case 'T':
        trigger_request_force();
        break;
    case 'C':
        trigger_request_continuous(true);
        break;
    case 'X':
        trigger_request_continuous(false);
        break;
    case 'R':
        send_raw();
        break;
#if CONFIG_FE_SOURCE_SYNTH
    case 'S':
        synth_set_sound(true);
        break;
    case 's':
        synth_set_sound(false);
        break;
#endif
    case 'B': {
        uint8_t b[4];
        size_t got = 0;
        while (got < 4) {
            const size_t n = usb_link_read(b + got, 4 - got, pdMS_TO_TICKS(500));
            if (n == 0) {
                return;
            }
            got += n;
        }
        if (!s_ev.active) {  // never interleave bench data with packets
            run_bench((uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24);
        }
        break;
    }
    default:
        break;
    }
}

static void stream_task(void *arg)
{
    // Installed here so the USB-Serial/JTAG interrupt is allocated on core 1,
    // keeping core 0 exclusively for capture.
    ESP_ERROR_CHECK(usb_link_init());
    for (;;) {
        uint8_t cmd;
        while (usb_link_read(&cmd, 1, 0) == 1) {
            handle_command(cmd);
        }
        if (!pump_event()) {
            // Nothing to send: sleep until the next capture block (or 25 ms,
            // so commands stay responsive).
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(25));
        }
    }
}

TaskHandle_t stream_start(void)
{
    TaskHandle_t h;
    xTaskCreatePinnedToCore(stream_task, "stream", 6144, NULL, 5, &h, 1);
    return h;
}
