"""A calibration run end to end against the stand-in server: simulated boards with their own clocks, drift, emitter
offsets, a wall echo and talk take part through the library, and their reports range to the true distance and carry
each other's true bearings. And the simulated bearing hook answers only for a window that covers the first path, so
the run's angles prove where the library places its window."""
import json
import tempfile
import time
import urllib.request

import numpy as np
import pytest
from forestpulse_sensor import Model, Sensor
from forestpulse_sensor.calibration import find_beeps
from forestpulse_sensor.calibration.patterns import DEFAULT_PATTERNS
from forestpulse_sensor.calibration.simulate import Board, Room, no_bearing
from forestpulse_sensor.devserver import serve

from test_journeys import free_port, wait_for


def two_way(a, b, r):
    """The two-way ranging distance of round r from two reports, metres (docs/device-api.md)."""
    def at(report, emitter):
        [d] = [d for d in report["rounds"][r]["detections"] if d["emitter"] == emitter and not d["weak"]]
        return d["position"] / report["fs"]
    c = (a["speed_of_sound"] + b["speed_of_sound"]) / 2
    return c / 2 * ((at(a, "B") - at(a, "A")) - (at(b, "B") - at(b, "A"))) \
        + (a["emitter_offset_m"] + b["emitter_offset_m"]) / 2


@pytest.fixture(scope="module")
def model():
    return Model()


def test_two_boards_take_part_in_a_run_and_their_reports_range_to_the_true_distance(model):
    port = free_port()
    server, state = serve(port, key="k", quiet=True)
    url = f"http://127.0.0.1:{port}"
    room = Room(speed_of_sound=346.0, speech_db=6.0)
    boards = {
        # turned 30 and 200 degrees, each buzzer beside its array square to the line between the boards (two-way
        # ranging measures from each buzzer to the other array, so a buzzer toward or away from the other board
        # shifts the distance by up to its offset)
        "a": Board(0, 0, facing_deg=30, clock_offset_s=2.5, drift_ppm=40, emitter_offset_m=0.05,
                   emitter_ccw_deg=-60),
        # b's thermometer is broken: it assumes 343 m/s and says so
        "b": Board(3, 0, facing_deg=200, clock_offset_s=-1.7, drift_ppm=-25, emitter_offset_m=0.08,
                   emitter_ccw_deg=110, thermometer="fail"),
    }
    sensors = {}
    try:
        for sid, board in boards.items():
            hooks = room.add(board)
            sensors[sid] = Sensor(url, "k", sensor_id=sid, state_dir=tempfile.mkdtemp(), model=model,
                                  checkin_interval=1.0, calibration=hooks, clock=hooks.clock)
            hooks.connect(sensors[sid].feed)
            sensors[sid].start()
        # hooks without a bearing fail the self-check: the sensor says it cannot take part
        partial = Sensor(url, "k", sensor_id="c", state_dir=tempfile.mkdtemp(), model=model, checkin_interval=1.0,
                         calibration=object()).start()
        sensors["c"] = partial
        assert wait_for(lambda: {"a", "b", "c"} <= set(state.sensors))
        assert state.sensors["a"]["calibration_capable"] is True
        assert state.sensors["c"]["calibration_capable"] is False and not partial.status["calibration_capable"]
        assert state.sensors["a"]["sdk_version"] == "0.3.0"

        req = urllib.request.Request(f"{url}/dev/calibration", data=json.dumps({"sensors": ["a", "b"]}).encode(),
                                     method="POST")
        urllib.request.urlopen(req).read()
        assert wait_for(lambda: state.sensors["a"].get("calibration_ack") == state.run["run_id"], timeout=10)
        assert wait_for(lambda: state.run["ended"], timeout=40), state.run
        a, b = state.run["reports"]["a"], state.run["reports"]["b"]

        assert (a["role"], b["role"]) == ("A", "B") and a["errors"] == b["errors"] == []
        assert (a["speed_of_sound"], a["speed_of_sound_fallback"]) == (346.0, False)
        assert (b["speed_of_sound"], b["speed_of_sound_fallback"]) == (343.0, True)
        assert (a["fs"], a["emitter_offset_m"], b["emitter_offset_m"]) == (48000, 0.05, 0.08)
        assert [r["valid"] for r in a["rounds"]] == [r["valid"] for r in b["rounds"]] == [True] * 4
        # forward rounds A then B, reverse rounds B then A, each heard whole by both boards, positions in each
        # board's own stream
        for report in (a, b):
            for r in report["rounds"]:
                assert [d["emitter"] for d in r["detections"]] == (["A", "B"] if r["round"] % 2 == 0 else ["B", "A"])
                assert all(not d["weak"] and d["snr_db"] > 20 for d in r["detections"])
                assert [d["own"] for d in r["detections"] if d["emitter"] == report["role"]] == [True]
        # the clocks are seconds apart; stream positions alone give the distance, to about a centimetre (the
        # assumed speed of sound on b costs half a centimetre)
        distances = [two_way(a, b, r) for r in range(4)]
        assert all(abs(d - 3.0) < 0.03 for d in distances), distances
        # each board asked its bearing hook about the other's beeps, never its own: b is 60 degrees clockwise of a's
        # forward (plan 90, a faces 30), a is 70 degrees clockwise of b's (plan 270, b faces 200)
        for report, truth in ((a, 60), (b, 70)):
            for r in report["rounds"]:
                [own] = [d for d in r["detections"] if d["own"]]
                [other] = [d for d in r["detections"] if not d["own"]]
                assert own["angle_deg"] is None and own["angle_quality"] is None
                assert abs((other["angle_deg"] - truth + 180) % 360 - 180) < 12, other
                assert other["angle_quality"] == 0.9

        # the run over, the sensors are back to listening
        assert wait_for(lambda: not sensors["a"].status["calibrating"] and not sensors["b"].status["calibrating"])
    finally:
        for s in sensors.values():
            s.stop(flush_timeout=0)
        server.shutdown()


def test_the_simulated_bearing_answers_only_for_a_window_that_covers_the_first_path():
    room = Room(level_db=30)
    listener_board = Board(0, 0, facing_deg=30, bearing_noise_deg=0)
    listener = room.add(listener_board)
    emitter = room.add(Board(2, 2, facing_deg=0))
    blocks = []
    listener.connect(lambda frames, break_before: blocks.append(frames))
    assert listener.start_stream()
    time.sleep(0.3)
    pattern = DEFAULT_PATTERNS["B"]
    emitter.emit(*pattern.emit_args())
    time.sleep(0.5)
    listener.stop_stream()
    audio = np.concatenate(blocks)
    [beep] = [d for d in find_beeps(audio, {"B": pattern}, room.fs) if not d.weak]
    fs = room.fs

    def window(start_s):
        lo = int(beep.position + start_s * fs)
        return audio[lo:lo + int(0.04 * fs)]

    # from 5 ms before the first path: the true direction (plan 45 degrees, 15 clockwise of a forward facing 30)
    angle, quality = listener.bearing(window(-0.005), pattern.band_hz)
    assert abs(angle - 15) < 1.5 and quality == 0.9
    # a window that starts after the first path, or ends before it, gets nothing
    assert listener.bearing(window(0.002), pattern.band_hz) is None
    assert listener.bearing(window(-0.05), pattern.band_hz) is None
    # audio this board never streamed gets nothing
    assert listener.bearing(np.zeros((1920, 3), np.int16), pattern.band_hz) is None
    # a board whose bearing code can never tell
    listener_board.bearing_fn = no_bearing
    assert listener.bearing(window(-0.005), pattern.band_hz) is None
