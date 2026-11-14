"""Shared serial helpers for talking to the front-end over USB-Serial/JTAG."""

import serial

DEFAULT_PORT = "/dev/ttyACM0"


def open_port(port: str = DEFAULT_PORT, timeout: float = 1.0) -> serial.Serial:
    """Open the port without resetting the chip.

    On the ESP32-S3 USB-Serial/JTAG, the state DTR=0 & RTS=1 resets the chip.
    Linux asserts both lines on open, and pyserial updates DTR before RTS, so
    requesting dtr=rts=False passes through that reset state. Keeping both
    asserted (the kernel's own state) never does.
    """
    s = serial.Serial()
    s.port = port
    s.baudrate = 115200  # ignored by USB-Serial/JTAG, required by pyserial
    s.timeout = timeout
    s.dtr = True
    s.rts = True
    s.open()
    s.reset_input_buffer()
    return s


def info(s: serial.Serial) -> dict[str, str]:
    old_timeout = s.timeout
    s.timeout = 1.0
    try:
        # Retry: right after a flash/reset the chip may still be booting
        # (ROM/bootloader text is mirrored to USB and is skipped here).
        for _attempt in range(3):
            s.reset_input_buffer()
            s.write(b"I")
            for _ in range(200):
                line = s.readline().decode(errors="replace").strip()
                if line.startswith("INFO "):
                    return dict(kv.split("=", 1) for kv in line[5:].split())
                if not line:
                    break
        raise RuntimeError("no INFO reply from device")
    finally:
        s.timeout = old_timeout
