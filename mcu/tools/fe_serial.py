"""Shared serial helpers for talking to the front-end over USB-Serial/JTAG."""

import serial
from serial.tools import list_ports

DEFAULT_PORT = None  # auto-detect: other CDC devices (e.g. an UNO Q) can take /dev/ttyACM0


def find_esp32() -> str:
    """Path of the ESP32's native USB-Serial/JTAG port (USB VID 0x303A)."""
    ports = [p for p in list_ports.comports() if p.vid == 0x303A]
    if not ports:
        others = ", ".join(f"{p.device} ({p.description})" for p in list_ports.comports() if p.vid) or "none"
        raise SystemExit(f"no ESP32 (USB 303a) found; serial ports: {others}")
    return ports[0].device


def open_port(port: str | None = DEFAULT_PORT, timeout: float = 1.0) -> serial.Serial:
    """Open the port without resetting the chip.

    On the ESP32-S3 USB-Serial/JTAG, the state DTR=0 & RTS=1 resets the chip.
    Linux asserts both lines on open, and pyserial updates DTR before RTS, so
    requesting dtr=rts=False passes through that reset state. Keeping both
    asserted (the kernel's own state) never does.
    """
    s = serial.Serial()
    s.port = port or find_esp32()
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
