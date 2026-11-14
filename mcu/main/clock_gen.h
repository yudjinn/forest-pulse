#pragma once
// I2S0 as a pure clock generator: BCLK (64 x fs) and WS (fs), fanned out via
// the GPIO matrix to all three mic port pairs, so every mic and the LCD_CAM
// sampler see the same edges. Also drives each mic's LR pin low (left slot).

#include "esp_err.h"

esp_err_t clock_gen_init(void);   // configure; clocks not running yet
esp_err_t clock_gen_start(void);  // start BCLK/WS
