// Acoustic front-end firmware entry point.
//
// Core 0: capture task (block source -> PSRAM ring -> trigger), never blocks on USB.
// Core 1: stream task (host commands + event packetizer -> USB-Serial/JTAG).
//
// Radios: Wi-Fi is never initialised and Bluetooth is compiled out
// (CONFIG_BT_ENABLED=n), so no RF current or radio interrupts exist.

#include "esp_log.h"

#include "capture.h"
#include "events.h"
#include "fe_config.h"
#include "ring_buffer.h"
#include "stream.h"
#include "trigger.h"

static const char *TAG = "main";

void app_main(void)
{
    ESP_ERROR_CHECK(ring_init(FE_RING_FRAMES, FE_BLOCK_FRAMES));
    events_init();
    trigger_init();

    TaskHandle_t stream = stream_start();
    capture_start(stream);
    ESP_LOGI(TAG, "running: %u Hz, ring %u frames, pre-trigger %u frames", (unsigned)FE_SAMPLE_RATE,
             (unsigned)FE_RING_FRAMES, (unsigned)FE_PRE_FRAMES);
}
