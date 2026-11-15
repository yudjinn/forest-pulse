#pragma once
// I2S0 as a pure clock generator: BCLK (64 x fs) and WS (fs), fanned out via
// the GPIO matrix to all three mic port pairs, so every mic and the LCD_CAM
// sampler see the same edges. Also drives each mic's LR pin low (left slot),
// and gives the speaker the same clocks plus I2S0's data line (speaker.h).

#include "driver/i2s_std.h"
#include "esp_err.h"

esp_err_t clock_gen_init(void);   // configure; clocks not running yet
esp_err_t clock_gen_start(void);  // start BCLK/WS
i2s_chan_handle_t clock_gen_tx(void);  // the TX channel (speaker data)
