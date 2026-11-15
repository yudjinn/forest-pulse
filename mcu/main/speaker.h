#pragma once
// Calibration sweeps on the ATech Speaker module (MAX98357A, I2S) at ports 3-4.
//
// The speaker gets I2S0's own BCLK/WS, the clocks every mic and the LCD_CAM
// sampler run on, and its audio on I2S0's data-out line, so a played sample is
// locked to a captured one. The waveform is the sensor library's sweep model
// (forestpulse_sensor/calibration/patterns.py): frequency stepped every 1 ms,
// linear from f_start to f_mid over the first half and on to f_end over the
// second, phase-continuous, taken at each step's centre; a sine instead of the
// buzzer's square wave (the library matches only inside the sweep's band, where
// the two are the same), with a 20 ms raised-cosine fade at each end.

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define SPEAKER_MAX_MS 1000u

// Starts the playback task. Call after clock_gen_init() (it writes to I2S0 TX).
esp_err_t speaker_start(void);

// Queues one sweep; false when one is already playing or queued, or the values
// are out of range (frequencies 100..20000 Hz, 1..SPEAKER_MAX_MS ms).
// volume: 0..255, full scale at 255.
bool speaker_play(uint16_t f_start_hz, uint16_t f_mid_hz, uint16_t f_end_hz, uint16_t duration_ms, uint8_t volume);
