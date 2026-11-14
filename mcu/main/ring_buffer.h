#pragma once
// Single-producer / single-consumer PSRAM ring of 3-channel int16 frames.
//
// Frames are addressed by a 64-bit monotonic index (never wraps). The writer
// (capture task, core 0) never blocks. The reader (stream task, core 1)
// validates every copy after the fact: a read succeeds only if the writer
// could not have overwritten any of the copied frames during the copy.

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

// cap_frames: ring capacity. guard_frames: largest single ring_write().
esp_err_t ring_init(uint32_t cap_frames, uint32_t guard_frames);

// Append n (<= guard_frames) interleaved frames.
void ring_write(const int16_t *frames, uint32_t n);

// Total frames ever written (index of the next frame to be written).
uint64_t ring_write_idx(void);

// Oldest frame index guaranteed intact while the writer is at `w`.
uint64_t ring_oldest_valid(uint64_t w);

// Copy frames [start, start+n) into dst. Returns false if any of those frames
// is not yet written or was (or may have been) overwritten.
bool ring_read(uint64_t start, uint32_t n, int16_t *dst);
