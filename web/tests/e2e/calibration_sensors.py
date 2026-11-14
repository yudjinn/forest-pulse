"""Simulated sensors for the calibration journeys: several sensor library instances in one process, each with the
library's simulated hooks on one shared simulated room (forestpulse_sensor.calibration.simulate), checking in to a
service every second. Boards are added and changed while it runs, so their device identities stay the same.

usage: python calibration_sensors.py <server_url> <sensor_key> <state dir>
One JSON command per line on stdin, each answered with one line on stdout, "ok" or "error <why>":
  {"add": {"id": "...", "hooks": "full" | "incomplete", <Board fields: x_m, y_m, facing_deg, clock_offset_s,
           drift_ppm, emitter_offset_m, thermometer, muted, stream_delay_s, ...>}}   "incomplete": no bearing hook
  {"set": {"id": "...", <Board fields>}}
     Both also take "bearing": "simulated" (the default, the simulator's true bearing) or "none" (never tells).
  {"hear": {"ids": [...], "wav": "<path>", "x_m": ..., "y_m": ...}}
     Those boards hear the recording, in real time, as if played at that point of the room: each reports what it
     detects with the angle its true position and facing give. Answered once the audio is fed.
  {"power_off": {"id": "..."}}
     That board stops, as one that lost power: no more check-ins, no stream.
  {"stop": true}
The library's log goes to stderr.
"""
import dataclasses
import json
import logging
import math
import os
import sys
import time
import types

from forestpulse_sensor import Model, Sensor
from forestpulse_sensor.calibration.simulate import Board, Room, no_bearing
from forestpulse_sensor.selftest import read_wav

FIELDS = {f.name for f in dataclasses.fields(Board)}
BEARINGS = {"simulated": None, "none": no_bearing}
PACKET_S = 0.02


def incomplete(hooks):
    """The same hooks without bearing(): a device app that has not written its bearing code yet."""
    return types.SimpleNamespace(start_stream=hooks.start_stream, stop_stream=hooks.stop_stream, emit=hooks.emit,
                                 speed_of_sound=hooks.speed_of_sound, fs=hooks.fs,
                                 emitter_offset_m=hooks.emitter_offset_m, forward_ccw_deg=hooks.forward_ccw_deg)


def set_bearing(board, kind):
    if kind not in BEARINGS:
        raise ValueError(f"bearing must be one of {sorted(BEARINGS)}")
    board.bearing_fn = BEARINGS[kind]


def hear(boards, sensors, ids, wav, x_m, y_m):
    """The boards hear the recording played at (x_m, y_m), fed live; each sensor's angle is the true one."""
    frames, rate = read_wav(wav)
    for sid in ids:
        board = boards[sid]
        angle = (math.degrees(math.atan2(x_m - board.x_m, y_m - board.y_m)) - board.facing_deg) % 360.0
        sensors[sid].angle_fn = lambda window, a=angle: a
    n = int(PACKET_S * rate)
    began = time.monotonic()
    for i in range(0, len(frames), n):
        for sid in ids:
            sensors[sid].feed(frames[i:i + n], break_before=(i == 0))
        wait = began + (i + n) / rate - time.monotonic()
        if wait > 0:
            time.sleep(wait)
    for sid in ids:
        sensors[sid].end_of_audio()


def main():
    url, key, state = sys.argv[1:4]
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(threadName)s %(message)s")
    model = Model()
    room = Room()
    boards, sensors, all_hooks = {}, {}, {}
    try:
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
                if "add" in cmd:
                    spec = dict(cmd["add"])
                    sid, kind = spec.pop("id"), spec.pop("hooks", "full")
                    bearing = spec.pop("bearing", "simulated")
                    board = Board(**{k: v for k, v in spec.items() if k in FIELDS})
                    set_bearing(board, bearing)
                    hooks = room.add(board)
                    sensor = Sensor(url, key, sensor_id=sid, state_dir=os.path.join(state, sid), model=model,
                                    checkin_interval=1.0, clock=hooks.clock,
                                    calibration=hooks if kind == "full" else incomplete(hooks))
                    hooks.connect(sensor.feed)
                    boards[sid], sensors[sid], all_hooks[sid] = board, sensor.start(), hooks
                elif "set" in cmd:
                    spec = dict(cmd["set"])
                    board = boards[spec.pop("id")]
                    for k, v in spec.items():
                        if k == "bearing":
                            set_bearing(board, v)
                        elif k not in FIELDS:
                            raise KeyError(k)
                        else:
                            setattr(board, k, v)
                elif "hear" in cmd:
                    spec = cmd["hear"]
                    hear(boards, sensors, spec["ids"], spec["wav"], float(spec["x_m"]), float(spec["y_m"]))
                elif "power_off" in cmd:
                    sid = cmd["power_off"]["id"]
                    sensors.pop(sid).stop(flush_timeout=0)
                    all_hooks[sid].stop_stream()
                elif cmd.get("stop"):
                    break
                else:
                    raise ValueError("unknown command")
                print("ok", flush=True)
            except Exception as e:  # report and keep serving; the journey fails on the answer
                print(f"error {type(e).__name__}: {e}", flush=True)
    finally:
        for sensor in sensors.values():
            sensor.stop(flush_timeout=0)
    print("ok", flush=True)


if __name__ == "__main__":
    main()
