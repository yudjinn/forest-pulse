"""A calibration run end to end against the stand-in server: simulated boards with their own clocks, drift, emitter
offsets, a wall echo and talk take part through the library, and their reports range to the true distance."""
import json
import tempfile
import urllib.request

import pytest
from forestpulse_sensor import Model, Sensor
from forestpulse_sensor.calibration.simulate import Board, Room
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
        "a": Board(0, 0, facing_deg=90, clock_offset_s=2.5, drift_ppm=40, emitter_offset_m=0.05),
        # b's thermometer is broken: it assumes 343 m/s and says so
        "b": Board(3, 0, facing_deg=270, clock_offset_s=-1.7, drift_ppm=-25, emitter_offset_m=0.08,
                   thermometer="fail"),
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

        # the run over, the sensors are back to listening
        assert wait_for(lambda: not sensors["a"].status["calibrating"] and not sensors["b"].status["calibrating"])
    finally:
        for s in sensors.values():
            s.stop(flush_timeout=0)
        server.shutdown()
