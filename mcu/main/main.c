// Acoustic front-end firmware entry point.
//
// Milestones M0/M1: bring-up + USB-Serial/JTAG throughput benchmark.
// Host commands (single ASCII byte, over USB):
//   'I'            -> one-line ASCII status report ending in '\n'
//   'B' + u32 LE N -> stream N bytes of little-endian u32 counter pattern

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_chip_info.h"
#include "esp_heap_caps.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_rom_crc.h"
#include "esp_private/esp_clk.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "usb_link.h"

static const char *TAG = "main";

#define FRAME_BYTES 6u  // 3 channels x int16
#define RING_BYTES ((uint32_t)CONFIG_FE_SAMPLE_RATE_HZ * FRAME_BYTES * CONFIG_FE_RING_MS / 1000u)

static bool crc_self_test(void)
{
    static const char vec[] = "123456789";
    return esp_rom_crc32_le(0, (const uint8_t *)vec, 9) == 0xCBF43926u;
}

static void send_info(void)
{
    // Prove the ring buffer allocation will succeed at the configured size.
    void *ring = heap_caps_malloc(RING_BYTES, MALLOC_CAP_SPIRAM);
    bool ring_ok = ring != NULL;
    free(ring);

    char line[320];
    int n = snprintf(line, sizeof line,
                     "INFO idf=%s cpu_mhz=%d psram=%u spiram_free=%u spiram_largest=%u "
                     "ring_bytes=%" PRIu32 " ring_alloc=%s internal_free=%u crc_ok=%d\n",
                     esp_get_idf_version(), esp_clk_cpu_freq() / 1000000, (unsigned)esp_psram_get_size(),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM), RING_BYTES,
                     ring_ok ? "ok" : "FAIL", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     crc_self_test());
    usb_link_write(line, (size_t)n, pdMS_TO_TICKS(1000));
}

static void run_bench(uint32_t total)
{
    static uint32_t chunk[4096 / 4];
    uint32_t counter = 0;
    uint32_t remaining = total;
    while (remaining > 0) {
        uint32_t n = remaining < sizeof chunk ? remaining : sizeof chunk;
        for (uint32_t i = 0; i < n / 4; i++) {
            chunk[i] = counter++;
        }
        if (usb_link_write(chunk, n, pdMS_TO_TICKS(2000)) != n) {
            ESP_LOGW(TAG, "bench aborted: host stopped reading");
            return;
        }
        remaining -= n;
    }
}

static void command_task(void *arg)
{
    for (;;) {
        uint8_t cmd;
        if (usb_link_read(&cmd, 1, portMAX_DELAY) != 1) {
            continue;
        }
        switch (cmd) {
        case 'I':
            send_info();
            break;
        case 'B': {
            uint8_t b[4];
            size_t got = 0;
            while (got < 4) {
                size_t n = usb_link_read(b + got, 4 - got, pdMS_TO_TICKS(500));
                if (n == 0) {
                    break;
                }
                got += n;
            }
            if (got == 4) {
                run_bench((uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24);
            }
            break;
        }
        default:
            break;
        }
    }
}

void app_main(void)
{
    ESP_ERROR_CHECK(usb_link_init());
    // USB work lives on core 1 so core 0 stays free for capture.
    xTaskCreatePinnedToCore(command_task, "cmd", 4096, NULL, 5, NULL, 1);
}
