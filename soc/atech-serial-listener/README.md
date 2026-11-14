# Atech Serial Listener (Arduino UNO Q)

The atech board (ESP32, 3 mics) streams binary audio packets over USB CDC serial to the UNO Q's Linux side. The app decodes them, prints event summaries in the Python console and forwards event start/end to the MCU.

```
atech ESP32 --USB CDC--> /dev/ttyACM0 (Linux host)
        |  (device mapped into)
        v
[serial-bridge container: socat]  TCP :5000 on the App's Docker network
        |
        v
[App Python container: main.py + atech_protocol.py]  --Bridge.notify("serial_event")-->  [STM32 sketch]
        <--Bridge "send_to_board" (single-byte commands I/T/C/X)----------------------
```

**Why the extra container:** App Lab's Python container is not given `/dev/tty*`, and `app.yaml` can't add devices. A custom Brick's `brick_compose.yaml` *can* (Docker Compose `devices:` key). That needs App Lab 0.7 or newer.

**Hardware:**
- The UNO Q's USB-C port only acts as a USB host through a **powered USB-C hub**. Without one, nothing shows up in `lsusb`.
- The ESP32's notify line (ATech port 6 D1, 3.3 V, HIGH from trigger until the event's END packet) goes to UNO Q header pin **D7**. The sketch reports each edge to Python (`trigger_pin`), which logs it and the delay to the event's first packet.

## Setup
1. SSH into the board, plug in the atech board through the hub, run `ls -l /dev/serial/by-id/ /dev/ttyACM*`.
2. In `bricks/serial_bridge/brick_compose.yaml`, set the host device path. The ESP32's by-id name contains `:`, which Compose's short `devices:` syntax can't take, so this uses `/dev/ttyACM0`. The baud rate is ignored by USB CDC.
3. Copy this folder to `~/ArduinoApps/` on the board, then start it: `arduino-app-cli app start user:atech-serial-listener` (or press Run in App Lab). `sketch/sketch.yaml` is required by App CLI 0.14+.
4. The Python console shows `[serial] connected to serial-bridge:5000`, an `INFO ...` line from the ESP32, then for each event:
   `=== event start`, one `pre`/`live` line per second of audio with peak dBFS per mic, and `=== event end` with a summary.

## Protocol
See the docstring in `python/atech_protocol.py`. Packets start with `AA 55`, carry 3 × int16 mic samples at 48 kHz, and end with a CRC-32. A seq gap or a set flag marks a break in the audio. Put your own processing in `on_audio()` in `python/main.py`.

## Serial port settings (socat)
- `noctty,rawer`: without these, 0x03/0x1C bytes in the audio are taken as Ctrl-C/Ctrl-\ and kill socat.
- `hupcl=0`: keeps DTR=RTS asserted between connections (DTR=0 with RTS=1 resets the ESP32).

## Quick checks if it doesn't work
- `docker ps` shows the `serial-bridge` container is running. `docker logs <id>` shows socat's output.
- `cannot resolve serial-bridge`: the two containers aren't on a shared network. Set `SERIAL_BRIDGE_HOST` or publish the port and use the host IP.
- `ring overrun` right after starting: packets were dropped while nothing was reading. That's expected once.
- `no INFO reply`: check that the ESP32 isn't in a boot loop (`docker logs` of serial-bridge, `dmesg`).
