"""End-to-end journeys: real model, real HTTP, the dev server standing in for the Cloudflare one."""
import json
import socket
import time
import urllib.request
from importlib import resources

import numpy as np
import pytest
from forestpulse_sensor import Model, Sensor
from forestpulse_sensor.devserver import serve
from forestpulse_sensor.selftest import read_wav

REF = resources.files("forestpulse_sensor").joinpath("data/reference")
SEED = json.loads(resources.files("forestpulse_sensor").joinpath("data/seed_sounds.json").read_text())
PACKET = 679  # frames per front-end packet


@pytest.fixture(scope="module")
def model():
    return Model()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def play(sensor, name):
    """Feed a reference clip the way the front-end delivers an audio burst: packets, then END."""
    frames, _ = read_wav(REF.joinpath(name))
    for i in range(0, len(frames), PACKET):
        sensor.feed(frames[i:i + PACKET], break_before=(i == 0))
    sensor.end_of_audio()


def wait_for(cond, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.05)
    return False


def put_sounds(port, doc):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/dev/sounds", data=json.dumps(doc).encode(), method="PUT")
    return json.loads(urllib.request.urlopen(req).read())["version"]


def test_detects_reports_angle_and_follows_the_server_sound_list(tmp_path, model):
    port = free_port()
    server, state = serve(port, key="k", sounds=json.loads(json.dumps(SEED)), quiet=True)
    angles = []
    sensor = Sensor(f"http://127.0.0.1:{port}", "k", sensor_id="node-a", state_dir=str(tmp_path), model=model,
                    checkin_interval=0.2, angle_fn=lambda w: angles.append(w.shape) or (37.0, 0.8)).start()
    try:
        assert wait_for(lambda: "node-a" in state.sensors)
        assert wait_for(lambda: sensor.status["sound_list_version"] == SEED["version"])

        # a chainsaw is reported once (repeats within 5 s suppressed), with the angle; rain and the hall are not
        play(sensor, "chainsaw.wav")
        play(sensor, "rain.wav")
        play(sensor, "hall.wav")
        assert wait_for(lambda: len(state.events) >= 1)
        time.sleep(1.0)
        chainsaw = [e for e in state.events if e["sound_id"] == "chainsaw"]
        assert len(chainsaw) == 1, state.events
        assert chainsaw[0]["angle_deg"] == 37.0 and chainsaw[0]["angle_confidence"] == 0.8
        assert chainsaw[0]["confidence"] >= 0.5
        assert all(e["sound_id"] in {"chainsaw", "vehicle", "engine"} for e in state.events), state.events
        assert angles[0][1] == 3  # angle_fn got the 3-mic window that was classified

        # an invalid list from the server is refused; the sensor keeps reporting with the previous one
        broken = json.loads(json.dumps(SEED))
        broken["sounds"][0]["weights"] = [0.0] * 10
        put_sounds(port, broken)
        time.sleep(1.0)
        assert sensor.status["sound_list_version"] == SEED["version"]

        # switching chainsaw off on the server reaches the sensor at its next check-in
        no_chainsaw = {**SEED, "sounds": [s for s in SEED["sounds"] if s["id"] != "chainsaw"]}
        version = put_sounds(port, no_chainsaw)
        assert wait_for(lambda: sensor.status["sound_list_version"] == version)
        before = len(state.events)
        sensor._last_reported.clear()
        play(sensor, "chainsaw.wav")
        time.sleep(2.0)
        assert not [e for e in state.events[before:] if e["sound_id"] == "chainsaw"]
    finally:
        sensor.stop()
        server.shutdown()


def test_events_survive_outage_wrong_key_and_restart(tmp_path, model):
    port = free_port()
    url = f"http://127.0.0.1:{port}"

    # server down: the sensor keeps detecting from its built-in sound list and queues on disk
    sensor = Sensor(url, "wrong", sensor_id="node-b", state_dir=str(tmp_path), model=model,
                    checkin_interval=0.2).start()
    play(sensor, "chainsaw.wav")
    assert wait_for(lambda: sensor.status["queued_events"] >= 1)
    sensor.stop(flush_timeout=0)

    # server up but the key is wrong: nothing is lost, the error is visible
    server, state = serve(port, key="right", quiet=True)
    try:
        sensor = Sensor(url, "wrong", sensor_id="node-b", state_dir=str(tmp_path), model=model,
                        checkin_interval=0.2).start()
        assert wait_for(lambda: sensor.status["key_rejected"])
        assert sensor.status["queued_events"] >= 1 and not state.events
        sensor.stop(flush_timeout=0)

        # key fixed after a restart: the backlog is delivered exactly once
        sensor = Sensor(url, "right", sensor_id="node-b", state_dir=str(tmp_path), model=model,
                        checkin_interval=0.2).start()
        assert wait_for(lambda: sensor.status["queued_events"] == 0)
        assert [e["sound_id"] for e in state.events] == ["chainsaw"]
        sensor.stop()
    finally:
        server.shutdown()


def test_checks_in_every_3_s_unless_the_config_file_says_otherwise_and_reports_its_version(tmp_path, model):
    # the server shows a board offline after 10 s without a check-in, so the default leaves room for two misses
    assert Sensor("http://127.0.0.1:9", "k", sensor_id="node-d", state_dir=str(tmp_path / "default")).checkin_interval == 3

    port = free_port()
    server, state = serve(port, key="k", quiet=True)
    config = tmp_path / "forestpulse.toml"
    config.write_text(f'server_url = "http://127.0.0.1:{port}"\nsensor_key = "k"\nsensor_id = "node-e"\n'
                      "checkin_interval = 1\n")
    sensor = Sensor.from_file(config, model=model)
    try:
        assert sensor.checkin_interval == 1
        sensor.start()
        assert wait_for(lambda: "node-e" in state.sensors)
        assert state.sensors["node-e"]["sdk_version"] == "0.4.0"
    finally:
        sensor.stop()
        server.shutdown()


def test_report_path_for_callers_running_their_own_model(tmp_path, model):
    frames, rate = read_wav(REF.joinpath("chainsaw.wav"))
    from forestpulse_sensor import to_model_audio

    scores, emb = model.run(to_model_audio(frames, rate))
    sensor = Sensor("http://127.0.0.1:9", "k", sensor_id="node-c", state_dir=str(tmp_path), model=model)
    events = sensor.report(scores, emb, angle_deg=370.0)
    assert [e["sound_id"] for e in events] == ["chainsaw"] and events[0]["angle_deg"] == 10.0
    assert sensor.report(scores, emb) == []  # same sound within 5 s
    assert np.isfinite(emb).all()
