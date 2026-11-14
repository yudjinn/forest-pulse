set(srcs
    "main.c"
    "usb_link.c"
    "protocol.c"
    "ring_buffer.c"
    "events.c"
    "trigger.c"
    "capture.c"
    "deserialize.c"
    "stream.c"
)
if(CONFIG_FE_SOURCE_SYNTH)
    list(APPEND srcs "synth_source.c")
else()
    list(APPEND srcs "clock_gen.c" "bit_capture.c")
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES
        esp_driver_usb_serial_jtag
        esp_driver_gpio
        esp_driver_i2s
        esp_psram
        esp_rom
        esp_hw_support
        esp_timer
        hal
        soc
)
