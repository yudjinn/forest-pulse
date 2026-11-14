#include "bit_capture.h"

#include <string.h>

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_private/esp_clk_tree_common.h"
#include "esp_heap_caps.h"
#include "esp_private/gdma.h"
#include "esp_private/periph_ctrl.h"
#include "esp_rom_gpio.h"
#include "freertos/queue.h"
#include "hal/cam_ll.h"
#include "hal/dma_types.h"
#include "soc/gpio_pins.h"
#include "soc/gpio_sig_map.h"

#include "board_pins.h"

static const char *TAG = "bitcap";

static gdma_channel_handle_t s_dma;
static dma_descriptor_t *s_desc;
static uint8_t *s_buf;
static QueueHandle_t s_eof_q;
static lcd_cam_dev_t *const s_hw = CAM_LL_GET_HW(0);

static bool IRAM_ATTR on_eof(gdma_channel_handle_t ch, gdma_event_data_t *ev, void *arg)
{
    const uint32_t idx = (uint32_t)((dma_descriptor_t *)ev->rx_eof_desc_addr - s_desc);
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR(s_eof_q, &idx, &woken);  // full queue = consumer far behind; it detects the gap
    return woken == pdTRUE;
}

static void cam_input(int pin, uint32_t signal)
{
    esp_rom_gpio_connect_in_signal(pin, signal, false);
}

static void sd_input(int pin)
{
    // ICS-43434 tri-states SD outside its slot; the pull-down keeps it at 0.
    gpio_config_t io = {.pin_bit_mask = 1ULL << pin, .mode = GPIO_MODE_INPUT, .pull_down_en = GPIO_PULLDOWN_ENABLE};
    gpio_config(&io);
}

esp_err_t bitcap_init(void)
{
    s_eof_q = xQueueCreate(16, sizeof(uint32_t));
    ESP_RETURN_ON_FALSE(s_eof_q, ESP_ERR_NO_MEM, TAG, "queue");

    // ---- Pins -> CAM input signals -----------------------------------------
    sd_input(PIN_MIC1_SD);
    sd_input(PIN_MIC2_SD);
    sd_input(PIN_MIC3_SD);
    cam_input(PIN_MIC1_BCLK, CAM_PCLK_IDX);
    cam_input(PIN_MIC1_SD, CAM_DATA_IN0_IDX);
    cam_input(PIN_MIC2_SD, CAM_DATA_IN1_IDX);
    cam_input(PIN_MIC3_SD, CAM_DATA_IN2_IDX);
    cam_input(PIN_MIC1_WS, CAM_DATA_IN3_IDX);
    for (uint32_t i = 4; i < 8; i++) {
        cam_input(GPIO_MATRIX_CONST_ZERO_INPUT, CAM_DATA_IN0_IDX + i);
    }
    // No frame structure: VSYNC / HSYNC / DE held constant so the camera
    // captures continuously. (VSYNC polarity is chosen at start.)
    {
        gpio_config_t io = {.pin_bit_mask = 1ULL << PIN_CAM_VSYNC, .mode = GPIO_MODE_INPUT_OUTPUT};
        gpio_config(&io);
        gpio_set_level(PIN_CAM_VSYNC, 0);
        cam_input(PIN_CAM_VSYNC, CAM_V_SYNC_IDX);
    }
    cam_input(GPIO_MATRIX_CONST_ONE_INPUT, CAM_H_SYNC_IDX);
    cam_input(GPIO_MATRIX_CONST_ONE_INPUT, CAM_H_ENABLE_IDX);

    // ---- LCD_CAM module clock + camera config -------------------------------
    PERIPH_RCC_ACQUIRE_ATOMIC(PERIPH_LCD_CAM_MODULE, ref_count)
    {
        if (ref_count == 0) {
            cam_ll_enable_bus_clock(0, true);
            cam_ll_reset_register(0);
        }
    }
    ESP_RETURN_ON_ERROR(esp_clk_tree_enable_src(SOC_MOD_CLK_PLL_F160M, true), TAG, "clk src");
    PERIPH_RCC_ATOMIC()
    {
        cam_ll_select_clk_src(0, CAM_CLK_SRC_PLL160M);
        cam_ll_set_group_clock_coeff(0, 4, 0, 0);  // 40 MHz core clock; PCLK comes from BCLK
    }
    cam_ll_enable_stop_signal(s_hw, false);         // never stop on FIFO full
    cam_ll_swap_dma_data_byte_order(s_hw, false);
    cam_ll_reverse_dma_data_bit_order(s_hw, false);
    cam_ll_enable_vsync_generate_eof(s_hw, false);  // EOF by byte count, not VSYNC
    cam_ll_set_recv_data_bytelen(s_hw, BITCAP_EOF_BYTES - 1);
    cam_ll_enable_hs_line_int(s_hw, false);
    cam_ll_enable_vsync_filter(s_hw, false);
    cam_ll_enable_invert_pclk(s_hw, false);         // sample on BCLK rising edge
    cam_ll_set_input_data_width(s_hw, 8);
    cam_ll_enable_invert_de(s_hw, false);
    cam_ll_enable_invert_hsync(s_hw, false);
    cam_ll_set_vh_de_mode(s_hw, false);
    cam_ll_enable_rgb_yuv_convert(s_hw, false);

    // ---- GDMA circular descriptor ring in internal SRAM -----------------------
    s_buf = heap_caps_aligned_alloc(64, BITCAP_DESC_BYTES * BITCAP_NUM_DESC, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    s_desc = heap_caps_aligned_calloc(4, BITCAP_NUM_DESC, sizeof(dma_descriptor_t),
                                      MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    ESP_RETURN_ON_FALSE(s_buf && s_desc, ESP_ERR_NO_MEM, TAG, "dma buffers");
    memset(s_buf, 0, BITCAP_DESC_BYTES * BITCAP_NUM_DESC);
    for (uint32_t i = 0; i < BITCAP_NUM_DESC; i++) {
        s_desc[i].dw0.size = BITCAP_DESC_BYTES;
        s_desc[i].dw0.owner = DMA_DESCRIPTOR_BUFFER_OWNER_DMA;
        s_desc[i].buffer = s_buf + i * BITCAP_DESC_BYTES;
        s_desc[i].next = &s_desc[(i + 1) % BITCAP_NUM_DESC];
    }

    gdma_channel_alloc_config_t ac = {.direction = GDMA_CHANNEL_DIRECTION_RX};
    ESP_RETURN_ON_ERROR(gdma_new_ahb_channel(&ac, &s_dma), TAG, "dma channel");
    ESP_RETURN_ON_ERROR(gdma_connect(s_dma, GDMA_MAKE_TRIGGER(GDMA_TRIG_PERIPH_CAM, 0)), TAG, "dma connect");
    // owner_check off: the ring is free-running; the consumer detects lag itself.
    gdma_strategy_config_t st = {.owner_check = false, .auto_update_desc = false};
    ESP_RETURN_ON_ERROR(gdma_apply_strategy(s_dma, &st), TAG, "dma strategy");
    gdma_transfer_config_t tc = {.max_data_burst_size = 32, .access_ext_mem = false};
    ESP_RETURN_ON_ERROR(gdma_config_transfer(s_dma, &tc), TAG, "dma transfer");
    gdma_rx_event_callbacks_t cbs = {.on_recv_eof = on_eof};
    ESP_RETURN_ON_ERROR(gdma_register_rx_event_callbacks(s_dma, &cbs, NULL), TAG, "dma callbacks");
    return ESP_OK;
}

esp_err_t bitcap_start(bool vsync_invert)
{
    cam_ll_enable_invert_vsync(s_hw, vsync_invert);
    xQueueReset(s_eof_q);
    ESP_RETURN_ON_ERROR(gdma_reset(s_dma), TAG, "dma reset");
    ESP_RETURN_ON_ERROR(gdma_start(s_dma, (intptr_t)s_desc), TAG, "dma start");
    cam_ll_reset(s_hw);
    cam_ll_fifo_reset(s_hw);
    cam_ll_start(s_hw);
    return ESP_OK;
}

void bitcap_set_vsync(int level)
{
    gpio_set_level(PIN_CAM_VSYNC, level);
}

void bitcap_stop(void)
{
    cam_ll_stop(s_hw);
    gdma_stop(s_dma);
}

uint32_t bitcap_ring_nonzero(void)
{
    uint32_t n = 0;
    for (uint32_t i = 0; i < BITCAP_DESC_BYTES * BITCAP_NUM_DESC; i++) {
        n += s_buf[i] != 0;
    }
    return n;
}

uint32_t bitcap_backlog(void)
{
    return (uint32_t)uxQueueMessagesWaiting(s_eof_q);
}

bool bitcap_wait_eof(uint32_t *desc_idx, TickType_t timeout)
{
    return xQueueReceive(s_eof_q, desc_idx, timeout) == pdTRUE;
}

const uint8_t *bitcap_desc_buf(uint32_t i)
{
    return s_buf + (i % BITCAP_NUM_DESC) * BITCAP_DESC_BYTES;
}

uint32_t bitcap_desc_len(uint32_t i)
{
    return s_desc[i % BITCAP_NUM_DESC].dw0.length;
}
