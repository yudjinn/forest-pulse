#include "clock_gen.h"

#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_private/gpio.h"
#include "soc/io_mux_reg.h"
#include "esp_check.h"
#include "esp_rom_gpio.h"
#include "soc/gpio_sig_map.h"

#include "board_pins.h"
#include "fe_config.h"

static const char *TAG = "clock_gen";
static i2s_chan_handle_t s_tx;

static void output_signal(int pin, uint32_t signal)
{
    gpio_func_sel(pin, PIN_FUNC_GPIO);
    gpio_set_direction(pin, GPIO_MODE_OUTPUT);
    esp_rom_gpio_connect_out_signal(pin, signal, false, false);
}

static void drive_low(int pin)
{
    gpio_config_t io = {.pin_bit_mask = 1ULL << pin, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&io);
    gpio_set_level(pin, 0);
}

esp_err_t clock_gen_init(void)
{
    // LR low on every mic -> all transmit in the left (WS low) slot.
    drive_low(PIN_MIC1_LR);
    drive_low(PIN_MIC2_LR);
    drive_low(PIN_MIC3_LR);

    // TX master: generates BCLK/WS. Its data line goes to the speaker: the TX
    // DMA clocks out zeros (auto_clear) except while speaker.c plays a sweep.
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    cc.auto_clear = true;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&cc, &s_tx, NULL), TAG, "new channel");

    i2s_std_config_t sc = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(FE_SAMPLE_RATE),  // MCLK 256 fs, BCLK 64 fs
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg =
            {
                .mclk = I2S_GPIO_UNUSED,
                .bclk = PIN_MIC1_BCLK,
                .ws = PIN_MIC1_WS,
                .dout = PIN_SPK_DIN,
                .din = I2S_GPIO_UNUSED,
            },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s_tx, &sc), TAG, "std mode");

    // Fan the same internal BCLK/WS signals out to mic2 and mic3 ports.
    output_signal(PIN_MIC2_BCLK, I2S0O_BCK_OUT_IDX);
    output_signal(PIN_MIC3_BCLK, I2S0O_BCK_OUT_IDX);
    output_signal(PIN_MIC2_WS, I2S0O_WS_OUT_IDX);
    output_signal(PIN_MIC3_WS, I2S0O_WS_OUT_IDX);

    // ...and to the speaker, so its samples are locked to the mics' frames.
    output_signal(PIN_SPK_BCLK, I2S0O_BCK_OUT_IDX);
    output_signal(PIN_SPK_WS, I2S0O_WS_OUT_IDX);

    // Let LCD_CAM sample mic1's BCLK/WS pads (input path on an output pad),
    // so it sees exactly the edges the mics see.
    gpio_input_enable(PIN_MIC1_BCLK);
    gpio_input_enable(PIN_MIC1_WS);
    return ESP_OK;
}

i2s_chan_handle_t clock_gen_tx(void)
{
    return s_tx;
}

esp_err_t clock_gen_start(void)
{
    return i2s_channel_enable(s_tx);
}
