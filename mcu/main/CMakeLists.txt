idf_component_register(
    SRCS "main.c" "usb_link.c"
    INCLUDE_DIRS "."
    REQUIRES esp_driver_usb_serial_jtag esp_psram esp_rom esp_hw_support esp_timer
)
