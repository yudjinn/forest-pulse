"""Simulated boards for the warnings journey: sensor library instances in one process on the calibration journeys'
simulated hooks (one shared simulated room), checking in to a service every second. A board with a buzzer plays a
warning's alarm through its simulated emit(), which records every tone.

usage: FP_SENSOR_KEY=<sensor key> python warnings_sensors.py <server_url> <state dir>
One JSON command per line on stdin, each answered with one line on stdout: "ok", "ok <JSON>" or "error <why>":
  {"add": {"id": "...", "x_m": ..., "buzzer": true | false}}   false: the same hooks without emit()
  {"hear": {"ids": [...], "wav": "<path>"}}
     Those boards hear the recording, in real time. Answered once the audio is fed.
  {"hear_during_alarm": {"ids": [...], "wav": "<path>"}}
     Waits (up to 30 s) until every one of those boards has started its alarm, then they hear the recording in real
     time for as long as the alarm sounds, as their mics record whatever is around them while it plays.
  {"tones": {"id": "..."}}   answered with the board's emit() calls: [[seconds since the first, f_start_hz,
     f_mid_hz, f_end_hz, duration_ms], ...]
  {"power_off": {"id": "..."}}   that board stops, as one that lost power: no more check-ins.
  {"stop": true}
The library's log goes to stderr.
"""
import json
import logging
import os
import sys
import time
import types

from calibration_sensors import hear
from forestpulse_sensor import Model, Sensor
from forestpulse_sensor.alarm import DURATION_S
from forestpulse_sensor.calibration.simulate import Board, Room
from forestpulse_sensor.selftest import read_wav


def without_buzzer(hooks):
    """The same hooks without emit(): a board with no buzzer."""
    return types.SimpleNamespace(start_stream=hooks.start_stream, stop_stream=hooks.stop_stream,
                                 speed_of_sound=hooks.speed_of_sound, bearing=hooks.bearing, fs=hooks.fs,
                                 emitter_offset_m=hooks.emitter_offset_m, forward_ccw_deg=hooks.forward_ccw_deg)


def hear_during_alarm(sensors, hooks, ids, wav):
    deadline = time.monotonic() + 30
    while not all(hooks[sid].emitted for sid in ids):
        if time.monotonic() > deadline:
            raise TimeoutError("no alarm started on " + ", ".join(s for s in ids if not hooks[s].emitted))
        time.sleep(0.01)
    frames, rate = read_wav(wav)
    started = min(hooks[sid].emitted[0][0] for sid in ids)
    left = DURATION_S - (time.time() - started) - 0.1  # stop before the alarm does
    n = max(0, min(len(frames), int(left * rate)))
    hear_frames(sensors, ids, frames[:n], rate)


def hear_frames(sensors, ids, frames, rate, packet_s=0.02):
    """Like calibration_sensors.hear, for audio already read, without changing any angle."""
    n = int(packet_s * rate)
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
    url, state = sys.argv[1:3]
    key = os.environ["FP_SENSOR_KEY"]
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(threadName)s %(message)s")
    model = Model()
    room = Room()
    boards, sensors, hooks = {}, {}, {}
    try:
        for line in sys.stdin:
            answer = None
            try:
                cmd = json.loads(line)
                if "add" in cmd:
                    spec = cmd["add"]
                    sid = spec["id"]
                    board = Board(float(spec.get("x_m", 0.0)), 0.0, facing_deg=90.0)
                    h = room.add(board)
                    sensor = Sensor(url, key, sensor_id=sid, state_dir=os.path.join(state, sid), model=model,
                                    checkin_interval=1.0, clock=h.clock,
                                    calibration=h if spec.get("buzzer", True) else without_buzzer(h))
                    h.connect(sensor.feed)
                    boards[sid], sensors[sid], hooks[sid] = board, sensor.start(), h
                elif "hear" in cmd:
                    spec = cmd["hear"]
                    hear(boards, sensors, spec["ids"], spec["wav"], 0.0, 10.0)
                elif "hear_during_alarm" in cmd:
                    spec = cmd["hear_during_alarm"]
                    hear_during_alarm(sensors, hooks, spec["ids"], spec["wav"])
                elif "tones" in cmd:
                    emitted = hooks[cmd["tones"]["id"]].emitted
                    t0 = emitted[0][0] if emitted else 0.0
                    answer = [[round(t - t0, 4), p.f_start_hz, p.f_mid_hz, p.f_end_hz, p.duration_ms]
                              for t, p in emitted]
                elif "power_off" in cmd:
                    sensors.pop(cmd["power_off"]["id"]).stop(flush_timeout=0)
                elif cmd.get("stop"):
                    break
                else:
                    raise ValueError("unknown command")
                print("ok" if answer is None else "ok " + json.dumps(answer), flush=True)
            except Exception as e:  # report and keep serving; the journey fails on the answer
                print(f"error {type(e).__name__}: {e}", flush=True)
    finally:
        for sensor in sensors.values():
            sensor.stop(flush_timeout=0)
    print("ok", flush=True)


if __name__ == "__main__":
    main()
