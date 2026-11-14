#pragma once
// Capture task (core 0, high priority): produces 20 ms blocks, writes them to
// the PSRAM ring, runs the trigger, and wakes the stream task. Never blocks
// on USB.
//
// Source (menuconfig FE_SOURCE): real mics via I2S0 clocks + LCD_CAM bit
// capture, or the synthetic test source.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

typedef struct {
    bool mics;            // true = LCD_CAM source, false = synthetic
    bool no_data;         // LCD_CAM never produced an EOF
    bool locked;          // deserializer locked to WS
    uint32_t eofs;        // GDMA EOF interrupts handled
    uint32_t sync_losses; // WS framing lost (frames dropped)
    uint32_t dma_overruns;// consumer fell a full DMA ring behind
    uint32_t short_desc;  // descriptors closed with fewer bytes than size
    uint32_t stalls;      // 100 ms without an EOF while running
    float ch_dbfs[3];     // last block RMS per mic
    // Bring-up diagnostics, filled when no EOF arrives:
    uint32_t toggles_bclk, toggles_ws, toggles_sd1, toggles_sd2, toggles_sd3;  // level changes in 20k polls
    uint32_t desc0_len, buf_nonzero;                 // did DMA write anything?
    uint32_t load_permille;  // capture task busy time on core 0, last 1 s window
    uint32_t avg_block_us;
    uint32_t max_block_us;
} capture_diag_t;

void capture_start(TaskHandle_t stream_task);
void capture_get_diag(capture_diag_t *out);

// True (and cleared) if frames were lost since the last call -> packet flag.
bool capture_take_discontinuity(void);

// Raw LCD_CAM bytes for bring-up: request, then poll until it returns true.
void capture_request_raw(void);
bool capture_get_raw(uint8_t *dst, size_t n);
