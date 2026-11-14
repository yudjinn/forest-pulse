#include "usb_link.h"

#include "driver/usb_serial_jtag.h"
#include "sdkconfig.h"

esp_err_t usb_link_init(void)
{
    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = CONFIG_FE_USB_TX_BUF_BYTES,
        .rx_buffer_size = 1024,
    };
    return usb_serial_jtag_driver_install(&cfg);
}

size_t usb_link_write(const void *data, size_t len, TickType_t timeout)
{
    const uint8_t *p = data;
    size_t sent = 0;
    TickType_t start = xTaskGetTickCount();
    while (sent < len) {
        TickType_t elapsed = xTaskGetTickCount() - start;
        if (elapsed >= timeout && timeout != portMAX_DELAY) {
            break;
        }
        TickType_t remaining = (timeout == portMAX_DELAY) ? portMAX_DELAY : timeout - elapsed;
        int n = usb_serial_jtag_write_bytes(p + sent, len - sent, remaining);
        if (n > 0) {
            sent += (size_t)n;
        }
    }
    return sent;
}

size_t usb_link_read(void *data, size_t len, TickType_t timeout)
{
    int n = usb_serial_jtag_read_bytes(data, len, timeout);
    return n > 0 ? (size_t)n : 0;
}

bool usb_link_host_connected(void)
{
    return usb_serial_jtag_is_connected();
}
