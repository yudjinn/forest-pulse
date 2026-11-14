#pragma once
// LCD_CAM camera-mode capture of the raw I2S lines into a circular GDMA ring.
//
// PCLK = mic1 BCLK pad; DATA0..2 = SD of mic1..3; DATA3 = WS; one byte per
// BCLK rising edge (3.072 MB/s at 48 kHz). The camera raises a GDMA EOF every
// BITCAP_EOF_BYTES (5 ms); the EOF descriptor index is posted to a queue.

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

#define BITCAP_DESC_BYTES 3840u   // 60 I2S frames x 64 B (fits 4095 max, 64-B aligned)
#define BITCAP_DESC_PER_EOF 4u    // EOF every 15,360 B = 5 ms
#define BITCAP_NUM_DESC 32u       // 122,880 B ring = 40 ms of slack
#define BITCAP_EOF_BYTES (BITCAP_DESC_BYTES * BITCAP_DESC_PER_EOF)

// Must be called from the task (core) that will service the interrupt.
esp_err_t bitcap_init(void);
esp_err_t bitcap_start(bool vsync_invert);  // then raise VSYNC to begin
void bitcap_stop(void);
void bitcap_set_vsync(int level);  // drive the VSYNC control pad

// Wait for the next EOF; returns the descriptor index that closed the block.
bool bitcap_wait_eof(uint32_t *desc_idx, TickType_t timeout);

// Diagnostics: count non-zero bytes across the whole DMA ring.
uint32_t bitcap_ring_nonzero(void);

// Number of EOFs queued but not yet taken.
uint32_t bitcap_backlog(void);

// Descriptor i: buffer and number of valid bytes.
const uint8_t *bitcap_desc_buf(uint32_t i);
uint32_t bitcap_desc_len(uint32_t i);
