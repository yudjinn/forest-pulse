#pragma once
// Thin wrapper over the USB-Serial/JTAG driver: the only code that touches
// the USB peripheral. Binary-safe; nothing else may print to this port.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"

esp_err_t usb_link_init(void);

// Queue all `len` bytes for transmission. Returns bytes accepted before
// `timeout` expired (== len on success).
size_t usb_link_write(const void *data, size_t len, TickType_t timeout);

// Read up to `len` bytes; returns count read (0 on timeout).
size_t usb_link_read(void *data, size_t len, TickType_t timeout);

// True when a host has the port configured (USB SOF seen recently).
bool usb_link_host_connected(void);
