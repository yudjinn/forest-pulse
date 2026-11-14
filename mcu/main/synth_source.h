#pragma once
// Synthetic 3-channel source standing in for the LCD_CAM capture (until M2).
//   ch0 (mic1): low-level noise, plus a chainsaw-like signal when enabled
//   ch1 (mic2): frame index bits 0..15   } lets the host verify every frame
//   ch2 (mic3): frame index bits 16..31  } arrives exactly once, in order

#include <stdbool.h>
#include <stdint.h>

void synth_init(void);
void synth_fill(int16_t *frames, uint32_t n, uint64_t first_frame);
void synth_set_sound(bool on);
