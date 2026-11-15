"""Linux (SoC) side of the node: App Lab glue around the processing pipeline.

    serial-bridge:5000 (socat owns /dev/ttyACM0)
        -> reader thread: Receiver (parse, follow events; never blocks)
        -> SensorTee -> sensor SDK (sound model, detectors, events to the server,
                        location calibration; bearing via DetectionBearing)
                     -> queue -> Pipeline worker: whole-event bearing (GCC/SRP-PHAT),
                        storage (WAV + JSON)
        -> LED matrix (arrow / CAL / ticker), status LED, event summaries to the
           STM32 sketch over the Bridge

Events (and their trigger time) come from the packet stream alone: no wire from
the ESP32 to the sketch. The sketch reports the Modulino Thermo
(temperature / humidity -> speed of sound) and Modulino presence, and plays
calibration sweeps on the Modulino Buzzer. Everything except this file is
plain Python (no App Lab imports) so it runs and is tested on a laptop:
see soc/dev/.

Commands to the ESP32 are single bytes: I (info), T (force event),
C / X (start / stop continuous event), plus G + id + int16 (trigger threshold). The sketch can send them through
Bridge "send_to_board".
"""

import logging
import os
import re
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
from matrix_display import MatrixDisplay
from pipeline import Pipeline
from receiver import Receiver
from sdk_glue import CalibrationHooks, DetectionBearing, SensorTee, server_ok
from storage import EventStore
from trigger_settings import TriggerSettings

SENSOR_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forestpulse.toml")

BRIDGE_HOST = os.environ.get("SERIAL_BRIDGE_HOST", "serial-bridge")
BRIDGE_PORT = int(os.environ.get("SERIAL_BRIDGE_PORT", "5000"))
RETRY_SECONDS = 2
RECV_BYTES = 65536          # the protocol asks for reads of 64 KB or more
INFO_RETRY_SECONDS = 1.0    # after connecting, send I until an INFO line arrives
INFO_MAX_TRIES = 15
INFO_LOG_EVERY_S = 60.0     # INFO is polled for the sound meter; log it only now and then


def log(s: str) -> None:
    print(s, flush=True)


def notify(name: str, *args) -> None:
    try:
        Bridge.notify(name, *args)
    except Exception as e:  # MCU not ready yet, router busy, ...
        log(f"[bridge] notify {name} failed: {e}")


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


# ------------------------------------------------------------------ LED matrix
# Arrow (pipeline) > "CAL" (calibration) > ticker: temperature, humidity, server
# icon, then the live sound meter (matrix_display.py). INFO polled for the meter.
_level = {"db": None, "at": 0.0}  # sound level above the ESP32's noise floor, from INFO


def matrix_status() -> dict:
    c = climate.current()
    fresh = _esp_ok and time.monotonic() - _level["at"] < 2.0
    return {"temp_c": c["temp_c"], "rh": c["rh"],
            "server_ok": server_ok(sensor.status if sensor else None, time.time()),
            "level_db": _level["db"] if fresh else None}


matrix = MatrixDisplay(lambda frame: notify("led_frame", frame), matrix_status, cfg["matrix"], log=log)

pipeline = Pipeline(
    cfg,
    store=EventStore(cfg["data_dir"], cfg["keep_events"]),  # local WAV + record per event (debug/calibration)
    uplink=None,  # events go to the server through the SDK
    # uplink=StubUplink(cfg["data_dir"], log=log, server_url=cfg["server_url"]),
    classifier=None,  # the SDK classifies
    # classifier=Classifier.load(cfg["classifier"]["model"], log=log),
    climate=climate,
    display=matrix.set_arrow,  # arrow frames / "" (clear); the ticker fills the gaps
    log=log,
    on_record=on_record,
)

# ------------------------------------------------------------------ sensor SDK

logging.basicConfig(level=logging.INFO, format="[sdk] %(message)s")  # SDK logs: heard ..., server ...
# One tee for the life of the app: the receiver writes to it, it feeds the SDK
# and the pipeline (bypassed while the SDK runs a location calibration).
tee = SensorTee(pipeline.queue, None, log=log)
if cfg.get("_local"):
    log(f"[app] board overrides from {os.path.basename(cfg['_local'])}")
_c = cfg["calibration"]
if _c.get("test_mono_mic"):
    tee.mono_mic = int(_c["test_mono_mic"]) - 1
    log(f"[calib] TEST: calibration stream uses mic{_c['test_mono_mic']} only (copied to all 3 channels)")
if _c.get("test_dump_calibration"):
    tee.dump_dir = os.path.join(cfg["data_dir"], "calibration")
    log(f"[calib] TEST: saving each calibration stream to {tee.dump_dir}")
if _c.get("test_fake_bearing_deg") is not None:
    log(f"[calib] TEST: faking every calibration bearing as {_c['test_fake_bearing_deg']} deg "
        "(fine for a 2-node run; a 3-node run fails its angle check)")
# Location calibration (LocationCalibrationIntegrationSpec.md): the SDK runs it
# and calls these hooks for the stream (ESP32 C/X), buzzer, speed of sound and bearing.
calibration = CalibrationHooks(cfg, climate, send_command=lambda c: send_command(c), notify=notify, tee=tee, log=log,
                               on_calibrating=matrix.set_calibrating,
                               buzzer_ok=lambda: None if _modulino_last is None else _modulino_last[1])
# ESP32 trigger thresholds from config.json "trigger" (config.local.json per board);
# re-applied after every ESP32 reset. The SDK reports them at each check-in (trigger health, read-only).
trigger = TriggerSettings(lambda b: send_command(b), cfg["trigger"], log=log)
sensor = None
if os.path.exists(SENSOR_CONFIG):
    try:
        import inspect

        from forestpulse_sensor import Sensor

        angle_fn = None
        if cfg["bearing"].get("detections", True):
            angle_fn = DetectionBearing(cfg, climate, on_bearing=pipeline.show_detection, log=log)
        else:
            log("[sdk] detections are sent without a direction (bearing.detections is off)")
        extra = {}
        sdk_params = inspect.signature(Sensor.__init__).parameters
        if "calibration" in sdk_params:
            extra["calibration"] = calibration
        else:
            log("[calib] this SDK has no location calibration yet; hooks not registered")
        if "trigger_settings" in sdk_params:
            extra["trigger_settings"] = trigger  # trigger health hook: the SDK reports .current() at each check-in
        else:
            log("[trigger] this SDK can't relay trigger settings yet; using config.json only")
        sensor = Sensor.from_file(SENSOR_CONFIG, angle_fn=angle_fn, **extra).start()
        tee.sensor = sensor
    except Exception as e:  # missing package, bad config: keep capturing, log why
        log(f"[sdk] sensor not started: {e!r}")
else:
    log(f"[sdk] no {os.path.basename(SENSOR_CONFIG)} next to main.py: not sending events "
        f"(copy forestpulse.example.toml and fill in sensor_key / sensor_id)")

# ------------------------------------------------------------------ serial link

_sock = None
_sock_lock = threading.Lock()
_esp_ok = False  # connected to the bridge and the ESP32 answered INFO since
_rx = None       # the current Receiver (its in_event drives the blue LED)


def send_command(cmd: str | bytes) -> bool:
    """Send a command to the ESP32: one letter (I, T, C, X) or a command with its argument
    bytes (b"G..." trigger setting). False if not connected."""
    with _sock_lock:
        if _sock is None:
            return False
        try:
            _sock.sendall(cmd.encode("ascii") if isinstance(cmd, str) else cmd)
            return True
        except OSError:
            return False


def _reader() -> None:
    global _sock, _esp_ok, _rx
    while True:
        try:
            s = socket.create_connection((BRIDGE_HOST, BRIDGE_PORT), timeout=5)
            poll_s = float(cfg["matrix"]["level_poll_s"]) if cfg["matrix"]["ticker"] else 0.0
            s.settimeout(min(INFO_RETRY_SECONDS, poll_s) if poll_s > 0 else INFO_RETRY_SECONDS)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            with _sock_lock:
                _sock = s
            log(f"[serial] connected to {BRIDGE_HOST}:{BRIDGE_PORT}")
            # End a recording left running by an earlier app or connection, or a stop that never reached the ESP32
            # (a continuous calibration stream never ends by itself and would grow without bound); the firmware
            # ignores X when idle. A run streaming now keeps its stream.
            if not calibration.streaming:
                send_command("X")

            state = {"info": False, "info_logged": 0.0}

            def on_text(line: str) -> None:
                global _esp_ok
                if line.startswith("INFO"):
                    now = time.monotonic()
                    if not state["info"] or now - state["info_logged"] >= INFO_LOG_EVERY_S:
                        log(f"[atech] {line}")  # polled ~4x/s for the meter: log the first and then 1/min
                        state["info_logged"] = now
                    state["info"] = True
                    _esp_ok = True
                    kv = dict(re.findall(r"(\w+)=(-?[\d.]+)", line))
                    if "rms_dbfs" in kv and "floor_dbfs" in kv:
                        _level["db"], _level["at"] = float(kv["rms_dbfs"]) - float(kv["floor_dbfs"]), now
                else:
                    log(f"[atech] {line}")
                trigger.on_text(line)  # INFO / SET: track thresholds, re-apply after an ESP32 reset

            rx = _rx = Receiver(tee, on_text=on_text, log=log)
            tries, last = 0, 0.0
            while True:
                now = time.monotonic()
                if not state["info"] and tries < INFO_MAX_TRIES and now - last >= INFO_RETRY_SECONDS:
                    send_command("I")
                    tries, last = tries + 1, now
                    if tries == INFO_MAX_TRIES:
                        log("[serial] no INFO reply from the ESP32 yet; still listening")
                elif state["info"] and poll_s > 0 and now - last >= poll_s:
                    send_command("I")  # sound level for the matrix meter
                    last = now
                try:
                    chunk = s.recv(RECV_BYTES)
                except TimeoutError:
                    continue
                if not chunk:
                    raise ConnectionError("bridge closed the connection")
                rx.feed(chunk)
        except OSError as e:
            log(f"[serial] {e}; retrying in {RETRY_SECONDS}s")
        except Exception as e:
            # anything else would end the reader and leave the board deaf while the app runs: reconnect instead
            log(f"[serial] reader failed ({e!r}); reconnecting in {RETRY_SECONDS}s")
        finally:
            _esp_ok = False
            with _sock_lock:
                if _sock is not None:
                    try:
                        _sock.close()
                    except OSError:
                        pass
                    _sock = None
        time.sleep(RETRY_SECONDS)


Bridge.provide("send_to_board", send_command)   # sketch -> ESP32 commands
Bridge.provide("climate", on_climate)           # sketch reports the Modulino Thermo
_modulino_last = None


def on_modulino_status(thermo_ok, buzzer_ok, i2c) -> None:
    """Sketch: every 5 s, whether the Modulino Thermo / Buzzer answered and what's on the Qwiic bus."""
    global _modulino_last
    st = (bool(int(thermo_ok)), bool(int(buzzer_ok)), str(i2c))
    if st != _modulino_last:
        _modulino_last = st
        log(f"[modulino] thermo {'OK' if st[0] else 'MISSING'}, buzzer {'OK' if st[1] else 'MISSING'}, "
            f"Qwiic bus devices: {st[2]}")


Bridge.provide("modulino_status", on_modulino_status)
Bridge.provide("emit_done", lambda ok: log("[calib] sketch played the sweep" if int(ok)
                                           else "[calib] sketch: no Modulino Buzzer, sweep NOT played"))

STATUS_EVERY_S = 2.0   # resend at least this often (the sketch shows red after 10 s of silence)
STATUS_POLL_S = 0.25   # changes (event start/end) go out within this


def _status_loop() -> None:
    """Status LED (sketch LED3): ESP32 connected, server reachable, event being recorded
    (from the packet stream)."""
    last, last_log, sent_at = None, None, 0.0
    while True:
        rx = _rx
        cur = (_esp_ok, server_ok(sensor.status if sensor else None, time.time()),
               bool(_esp_ok and rx is not None and rx.in_event))
        if cur != last or time.monotonic() - sent_at >= STATUS_EVERY_S:
            notify("node_status", *(int(v) for v in cur))
            last, sent_at = cur, time.monotonic()
        if cur[:2] != last_log:
            log(f"[status] ESP32 {'OK' if cur[0] else 'NOT CONNECTED'}, "
                f"server {'OK' if cur[1] else 'UNREACHABLE'}")
            last_log = cur[:2]
        time.sleep(STATUS_POLL_S)


def _test_beep_loop(every_s: float, sweep) -> None:
    """TEST: play the calibration sweep every `every_s` seconds (config calibration.test_beep_every_s)."""
    while True:
        time.sleep(every_s)
        try:
            calibration.emit(*sweep)
        except Exception as e:
            log(f"[calib] test beep failed: {e!r}")


if cfg["calibration"].get("test_beep_every_s"):
    log(f"[calib] TEST: beep {cfg['calibration']['test_beep']} every {cfg['calibration']['test_beep_every_s']} s")
    threading.Thread(target=_test_beep_loop, name="test-beep", daemon=True,
                     args=(float(cfg["calibration"]["test_beep_every_s"]), cfg["calibration"]["test_beep"])).start()

log(f"[app] node {cfg['node_id']}, data in {os.path.abspath(cfg['data_dir'])}, "
    f"sensor SDK {'on: ' + sensor.sensor_id if sensor else 'OFF'}")
pipeline.start()
matrix.start()
threading.Thread(target=_reader, name="serial-reader", daemon=True).start()
threading.Thread(target=_status_loop, name="status-led", daemon=True).start()
App.run()
