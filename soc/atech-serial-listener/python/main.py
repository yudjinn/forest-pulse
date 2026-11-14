"""Linux (SoC) side of the node: App Lab glue around the processing pipeline.

    serial-bridge:5000 (socat owns /dev/ttyACM0)
        -> reader thread: Receiver (parse, follow events; never blocks)
        -> queue -> Pipeline worker: bearing (GCC/SRP-PHAT), classifier (ONNX),
           storage (WAV + JSON), uplink (stub)
        -> LED matrix arrow + event summaries to the STM32 sketch over the Bridge

The sketch reports the ESP32 notify line (header D7) and the Modulino Thermo
(temperature / humidity -> speed of sound). Everything except this file is
plain Python (no App Lab imports) so it runs and is tested on a laptop:
see soc/dev/.

Commands to the ESP32 are single bytes: I (info), T (force event),
C / X (start / stop continuous event). The sketch can send them through
Bridge "send_to_board".
"""

import logging
import os
import socket
import threading
import time

from arduino.app_utils import App, Bridge

import config

# Classification and the uplink are done by the Forest Pulse sensor SDK
# (sensor-sdk/, package forestpulse_sensor): we feed it the audio and give it
# the bearing (sdk_glue.py); it runs the sound model, keeps the server's sound
# list and sends events. Our own attempts are kept but disabled:
#   - on-device ONNX classifier: classifier.py, models/
#   - stub uplink: uplink.py
# from classifier import Classifier
# from uplink import StubUplink
from climate import Climate
from pipeline import Pipeline
from receiver import Receiver
from sdk_glue import DetectionBearing, SensorTee
from storage import EventStore

SENSOR_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forestpulse.toml")

BRIDGE_HOST = os.environ.get("SERIAL_BRIDGE_HOST", "serial-bridge")
BRIDGE_PORT = int(os.environ.get("SERIAL_BRIDGE_PORT", "5000"))
RETRY_SECONDS = 2
RECV_BYTES = 65536          # the protocol asks for reads of 64 KB or more
INFO_RETRY_SECONDS = 1.0    # after connecting, send I until an INFO line arrives
INFO_MAX_TRIES = 15


def log(s: str) -> None:
    print(s, flush=True)


def notify(name: str, *args) -> None:
    try:
        Bridge.notify(name, *args)
    except Exception as e:  # MCU not ready yet, router busy, ...
        log(f"[bridge] notify {name} failed: {e}")


# ---------------------------------------------------------------- notify pin (D7)

_trigger_lock = threading.Lock()
_trigger_state = None   # last reported level (0/1), None until the first report
_trigger_rise = None    # time.time() of the last rising edge
_trigger_unused = False  # rise not yet attached to an event


def on_trigger_pin(state) -> None:
    """Sketch: Bridge.notify("trigger_pin", 0/1) on every D7 edge (+ periodic resend)."""
    global _trigger_state, _trigger_rise, _trigger_unused
    state = 1 if int(state) else 0
    with _trigger_lock:
        prev = _trigger_state
        if state == prev:
            return
        _trigger_state = state
        if prev is not None and state:
            _trigger_rise, _trigger_unused = time.time(), True
    if prev is None:
        log(f"[trigger] D7 {'HIGH' if state else 'LOW'} (initial level)")
    else:
        log(f"[trigger] D7 {'HIGH (event starting)' if state else 'LOW'}")


def take_trigger_rise():
    """Receiver: precise trigger time for a new event, if D7 rose recently."""
    global _trigger_unused
    with _trigger_lock:
        if _trigger_unused and _trigger_rise is not None and time.time() - _trigger_rise < 10:
            _trigger_unused = False
            return _trigger_rise
    return None


# ------------------------------------------------------------------ pipeline

cfg = config.load()
climate = Climate(default=cfg["speed_of_sound_mps"])


_last_c = None


def on_climate(temp_c, rh) -> None:
    """Sketch: Bridge.notify("climate", temp_c, rh_percent) from the Modulino Thermo."""
    global _last_c
    climate.update(temp_c, rh)
    c = climate.current()
    if c["source"] == "modulino" and (_last_c is None or abs(c["mps"] - _last_c) >= 0.5):
        _last_c = c["mps"]
        log(f"[climate] {c['temp_c']} C, {c['rh']} %RH -> speed of sound {c['mps']} m/s")


def on_record(r: dict) -> None:
    cls, brg = r.get("classification") or {}, r["bearing"]
    notify("serial_event", f"EVENT {cls.get('label', 'n/a')} {cls.get('score', 0):.2f} "
                           f"bearing {brg['deg']} conf {brg['confidence']}")


pipeline = Pipeline(
    cfg,
    store=EventStore(cfg["data_dir"], cfg["keep_events"]),  # local WAV + record per event (debug/calibration)
    uplink=None,  # events go to the server through the SDK
    # uplink=StubUplink(cfg["data_dir"], log=log, server_url=cfg["server_url"]),
    classifier=None,  # the SDK classifies
    # classifier=Classifier.load(cfg["classifier"]["model"], log=log),
    climate=climate,
    display=lambda frame: notify("led_frame", frame),
    log=log,
    on_record=on_record,
)

# ------------------------------------------------------------------ sensor SDK

logging.basicConfig(level=logging.INFO, format="[sdk] %(message)s")  # SDK logs: heard ..., server ...
sensor = None
if os.path.exists(SENSOR_CONFIG):
    try:
        from forestpulse_sensor import Sensor

        angle_fn = DetectionBearing(cfg, climate, on_bearing=pipeline.show_detection, log=log)
        sensor = Sensor.from_file(SENSOR_CONFIG, angle_fn=angle_fn).start()
    except Exception as e:  # missing package, bad config: keep capturing, log why
        log(f"[sdk] sensor not started: {e!r}")
else:
    log(f"[sdk] no {os.path.basename(SENSOR_CONFIG)} next to main.py: not sending events "
        f"(copy forestpulse.example.toml and fill in sensor_key / sensor_id)")

# ------------------------------------------------------------------ serial link

_sock = None
_sock_lock = threading.Lock()


def send_command(cmd: str) -> bool:
    """Send a single-byte command (I, T, C, X) to the ESP32. False if not connected."""
    with _sock_lock:
        if _sock is None:
            return False
        try:
            _sock.sendall(cmd.encode("ascii"))
            return True
        except OSError:
            return False


def _reader() -> None:
    global _sock
    while True:
        try:
            s = socket.create_connection((BRIDGE_HOST, BRIDGE_PORT), timeout=5)
            s.settimeout(INFO_RETRY_SECONDS)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            with _sock_lock:
                _sock = s
            log(f"[serial] connected to {BRIDGE_HOST}:{BRIDGE_PORT}")

            state = {"info": False}

            def on_text(line: str) -> None:
                log(f"[atech] {line}")
                if line.startswith("INFO"):
                    state["info"] = True

            rx = Receiver(SensorTee(pipeline.queue, sensor, log=log), on_text=on_text, log=log,
                          trigger_rise=take_trigger_rise)
            tries, last = 0, 0.0
            while True:
                now = time.monotonic()
                if not state["info"] and tries < INFO_MAX_TRIES and now - last >= INFO_RETRY_SECONDS:
                    send_command("I")
                    tries, last = tries + 1, now
                    if tries == INFO_MAX_TRIES:
                        log("[serial] no INFO reply from the ESP32 yet; still listening")
                try:
                    chunk = s.recv(RECV_BYTES)
                except TimeoutError:
                    continue
                if not chunk:
                    raise ConnectionError("bridge closed the connection")
                rx.feed(chunk)
        except OSError as e:
            log(f"[serial] {e}; retrying in {RETRY_SECONDS}s")
        finally:
            with _sock_lock:
                if _sock is not None:
                    try:
                        _sock.close()
                    except OSError:
                        pass
                    _sock = None
        time.sleep(RETRY_SECONDS)


Bridge.provide("send_to_board", send_command)   # sketch -> ESP32 commands
Bridge.provide("trigger_pin", on_trigger_pin)   # sketch reports D7
Bridge.provide("climate", on_climate)           # sketch reports the Modulino Thermo

log(f"[app] node {cfg['node_id']}, data in {os.path.abspath(cfg['data_dir'])}, "
    f"sensor SDK {'on: ' + sensor.sensor_id if sensor else 'OFF'}")
pipeline.start()
threading.Thread(target=_reader, name="serial-reader", daemon=True).start()
App.run()
