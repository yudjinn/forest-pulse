#pragma once
// Derived compile-time constants shared by all modules.

#include "sdkconfig.h"

#define FE_CHANNELS 3u
#define FE_FRAME_BYTES (FE_CHANNELS * 2u)  // interleaved int16 [m1, m2, m3]
#define FE_SAMPLE_RATE ((uint32_t)CONFIG_FE_SAMPLE_RATE_HZ)

// 20 ms processing block (960 frames at 48 kHz).
#define FE_BLOCK_MS 20u
#define FE_BLOCK_FRAMES (FE_SAMPLE_RATE * FE_BLOCK_MS / 1000u)

#define FE_MS_TO_FRAMES(ms) ((uint32_t)((uint64_t)FE_SAMPLE_RATE * (ms) / 1000u))
#define FE_RING_FRAMES FE_MS_TO_FRAMES(CONFIG_FE_RING_MS)
#define FE_PRE_FRAMES FE_MS_TO_FRAMES(CONFIG_FE_PRE_TRIGGER_MS)
