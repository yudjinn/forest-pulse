"""Simulated sensors for the calibration journeys: several sensor library instances in one process, each with the
library's simulated hooks on one shared simulated room (forestpulse_sensor.calibration.simulate), checking in to a
service every second. Boards are added and changed while it runs, so their device identities stay the same.

usage: python calibration_sensors.py <server_url> <sensor_key> <state dir>
One JSON command per line on stdin, each answered with one line on stdout, "ok" or "error <why>":
  {"add": {"id": "...", "hooks": "full" | "incomplete", <Board fields: x_m, y_m, facing_deg, clock_offset_s,
           drift_ppm, emitter_offset_m, thermometer, muted, stream_delay_s, ...>}}   "incomplete": no bearing hook
  {"set": {"id": "...", <Board fields>}}
  {"stop": true}
The library's log goes to stderr.
"""
import dataclasses
import json
import logging
import os
import sys
import types

from forestpulse_sensor import Model, Sensor
from forestpulse_sensor.calibration.simulate import Board, Room

FIELDS = {f.name for f in dataclasses.fields(Board)}


def incomplete(hooks):
    """The same hooks without bearing(): a device app that has not written its bearing code yet."""
    return types.SimpleNamespace(start_stream=hooks.start_stream, stop_stream=hooks.stop_stream, emit=hooks.emit,
                                 speed_of_sound=hooks.speed_of_sound, fs=hooks.fs,
                                 emitter_offset_m=hooks.emitter_offset_m, forward_ccw_deg=hooks.forward_ccw_deg)


def main():
    url, key, state = sys.argv[1:4]
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(threadName)s %(message)s")
    model = Model()
    room = Room()
    boards, sensors = {}, {}
    try:
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
                if "add" in cmd:
                    spec = dict(cmd["add"])
                    sid, kind = spec.pop("id"), spec.pop("hooks", "full")
                    board = Board(**{k: v for k, v in spec.items() if k in FIELDS})
                    hooks = room.add(board)
                    sensor = Sensor(url, key, sensor_id=sid, state_dir=os.path.join(state, sid), model=model,
                                    checkin_interval=1.0, clock=hooks.clock,
                                    calibration=hooks if kind == "full" else incomplete(hooks))
                    hooks.connect(sensor.feed)
                    boards[sid], sensors[sid] = board, sensor.start()
                elif "set" in cmd:
                    spec = dict(cmd["set"])
                    board = boards[spec.pop("id")]
                    for k, v in spec.items():
                        if k not in FIELDS:
                            raise KeyError(k)
                        setattr(board, k, v)
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
