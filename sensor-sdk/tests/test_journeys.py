"""End-to-end journeys: real model, real HTTP, the dev server standing in for the Cloudflare one."""
import json
import logging
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


def test_events_survive_outage_wrong_key_and_restart(tmp_path, model, monkeypatch):
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

        # venue Wi-Fi cuts every reply short for a while: the sensor keeps trying, and once replies get through
        # again it delivers what it heard meanwhile at once, not when the backoff of its failed deliveries ends
        import http.client
        from forestpulse_sensor import api as api_module

        real_urlopen, cut = api_module.urllib.request.urlopen, {"on": True, "n": 0}

        def cut_short(*args, **kwargs):
            if cut["on"]:
                cut["n"] += 1
                raise http.client.IncompleteRead(b"{")
            return real_urlopen(*args, **kwargs)

        monkeypatch.setattr(api_module.urllib.request, "urlopen", cut_short)
        time.sleep(5.1)  # past the 5 s repeat limit for the same sound
        play(sensor, "chainsaw.wav")
        assert wait_for(lambda: sensor.status["queued_events"] == 1)
        time.sleep(6.5)  # failed deliveries back off to 8 s
        cut["on"] = False
        back = time.monotonic()
        assert wait_for(lambda: len(state.events) == 2, timeout=10)
        assert time.monotonic() - back < 2.0, "delivery waited for the outage's backoff"
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
        assert state.sensors["node-e"]["sdk_version"] == "0.7.0"
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


class TeammateSettings:
    """Shaped like the device team's trigger settings object: current() and update(), nothing else."""

    def __init__(self):
        self.updates = []

    def current(self):
        return {"snr_db": 4.0, "ratio_db": 0, "coherence": 0.6, "trig_default_snr_db": 6.0}

    def update(self, settings, **kw):
        self.updates.append(settings)


class FlakyHook:
    """A trigger health hook whose answers the test changes between check-ins."""

    def __init__(self):
        self.trigger = {"snr_db": 8.5}
        self.floor = -52.0

    def current(self):
        if isinstance(self.trigger, Exception):
            raise self.trigger
        return self.trigger

    def noise_floor_dbfs(self):
        if isinstance(self.floor, Exception):
            raise self.floor
        return self.floor


def test_reports_trigger_health_and_keeps_checking_in_when_the_hook_is_wrong(tmp_path, model, capsys, caplog):
    caplog.set_level(logging.INFO, logger="forestpulse_sensor")
    port = free_port()
    server, state = serve(port, key="k", quiet=False)
    url = f"http://127.0.0.1:{port}"
    teammate = TeammateSettings()
    board = Sensor(url, "k", sensor_id="node-t", state_dir=str(tmp_path / "t"), model=model, checkin_interval=0.2,
                   trigger_settings=teammate).start()
    hook = FlakyHook()
    flaky = Sensor(url, "k", sensor_id="node-f", state_dir=str(tmp_path / "f"), model=model, checkin_interval=0.2,
                   trigger_settings=hook).start()

    def checkin(sensor_id):
        return state.sensors.get(sensor_id, {})

    def checked_in_again(sensor_id, cond):
        """A fresh check-in from the sensor satisfies cond: the sensor is still checking in."""
        since = checkin(sensor_id).get("last_checkin")
        return wait_for(lambda: checkin(sensor_id).get("last_checkin") != since and cond(checkin(sensor_id)))

    try:
        # three recordings, each a burst of packets: only the first packet of each starts one
        burst = np.zeros((PACKET, 3), np.int16)
        for _ in range(3):
            for i in range(4):
                board.feed(burst, break_before=(i == 0))
            board.end_of_audio()

        # the teammate's object, unchanged: its values are reported, its update() never called, no noise floor
        assert checked_in_again("node-t", lambda c: c.get("recordings_per_min") == 3)
        body = checkin("node-t")
        assert body["trigger"] == {"snr_db": 4.0, "ratio_db": 0.0, "coherence": 0.6}
        assert "noise_floor_dbfs" not in body
        assert "node-t: check-in, 3 recordings/min, trigger snr_db 4.0 ratio_db 0.0 coherence 0.6, noise floor " \
               "missing" in capsys.readouterr().out

        # a hook that gives everything; a sensor that has had no recording reports 0, not missing
        assert checked_in_again("node-f", lambda c: c.get("noise_floor_dbfs") == -52.0)
        assert checkin("node-f")["trigger"] == {"snr_db": 8.5} and checkin("node-f")["recordings_per_min"] == 0
        assert "node-f: check-in, 0 recordings/min, trigger snr_db 8.5, noise floor -52.0 dBFS" in \
               capsys.readouterr().out

        # each wrong answer leaves its field out and the sensor keeps checking in
        for trigger, floor in ((None, None), (["snr_db", 4.0], RuntimeError("i2c gone")),
                               ({"snr_db": "loud", "coherence": float("nan"), "ratio_db": True}, "quiet")):
            hook.trigger, hook.floor = trigger, floor
            assert checked_in_again("node-f", lambda c: "trigger" not in c and "noise_floor_dbfs" not in c)
            assert checked_in_again("node-f", lambda c: "trigger" not in c and "noise_floor_dbfs" not in c)
            assert "node-f: check-in, 0 recordings/min, trigger missing, noise floor missing" in capsys.readouterr().out
        hook.trigger = RuntimeError("bridge down")
        assert checked_in_again("node-f", lambda c: "trigger" not in c)
        assert checked_in_again("node-f", lambda c: "trigger" not in c)

        # after many check-ins, each reason was logged exactly once
        reasons = ["has no noise_floor_dbfs()", "current() returned None", "current() returned list",
                   "noise_floor_dbfs() raised", "gave snr_db='loud'", "noise_floor_dbfs() returned 'quiet'",
                   "current() raised"]
        messages = [r.getMessage() for r in caplog.records]
        for reason in reasons:
            assert len([m for m in messages if reason in m]) == 1, (reason, messages)
        assert teammate.updates == []
    finally:
        board.stop()
        flaky.stop()
        server.shutdown()


class Buzzer:
    """A board's hooks with only the buzzer: emit() records each tone and holds the call for the tone's length, as a
    blocking buzzer driver does. fail_on: the tone whose call raises."""

    def __init__(self, fail_on=None):
        self.tones, self.fail_on = [], fail_on

    def emit(self, f_start_hz, f_mid_hz, f_end_hz, duration_ms):
        self.tones.append((time.monotonic(), (f_start_hz, f_mid_hz, f_end_hz, duration_ms)))
        if len(self.tones) == self.fail_on:
            raise OSError("buzzer driver gone")
        time.sleep(duration_ms / 1000)


def dev(port, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/dev/{path}", data=data, method="GET" if data is None
                                 else "POST")
    return json.loads(urllib.request.urlopen(req).read())


def test_plays_a_warning_alarm_off_the_sync_loop_and_confirms_it(tmp_path, model, capsys):
    port = free_port()
    server, state = serve(port, key="k", quiet=False)
    url = f"http://127.0.0.1:{port}"
    buzzer, broken = Buzzer(), Buzzer(fail_on=3)
    board = Sensor(url, "k", sensor_id="node-w", state_dir=str(tmp_path / "w"), model=model, checkin_interval=0.2,
                   calibration=buzzer).start()
    failing = Sensor(url, "k", sensor_id="node-x", state_dir=str(tmp_path / "x"), model=model, checkin_interval=0.2,
                     calibration=broken).start()
    silent = Sensor(url, "k", sensor_id="node-n", state_dir=str(tmp_path / "n"), model=model, checkin_interval=0.2)
    silent.start()

    def checkin(sensor_id):
        return state.sensors.get(sensor_id, {})

    def result(warning, sensor_id):
        return dev(port, "warnings")[warning]["sensors"][sensor_id]["result"]

    try:
        # a board says it can warn when its hooks include the buzzer; one without hooks says it cannot
        assert wait_for(lambda: all(checkin(s) for s in ("node-w", "node-x", "node-n")))
        assert checkin("node-w")["can_warn"] is True and checkin("node-x")["can_warn"] is True
        assert checkin("node-n")["can_warn"] is False

        warning = dev(port, "warnings", {"sensors": ["node-w", "node-x"]})["id"]
        assert wait_for(lambda: buzzer.tones, timeout=5)
        # while it sounds the board keeps checking in, and a chainsaw it hears meanwhile is neither analysed nor
        # counted as a recording
        play(board, "chainsaw.wav")
        seen = set()
        while len(buzzer.tones) < 33 and time.monotonic() - buzzer.tones[0][0] < 10:
            seen.add(checkin("node-w")["last_checkin"])
            time.sleep(0.05)
        assert len(seen) >= 10, seen  # about 25 check-ins in 5 s at 0.2 s

        # confirmed at the first check-in after it ends: the published pattern, once, though every reply carried it
        assert wait_for(lambda: result(warning, "node-w") == "played", timeout=5)
        assert [args for _, args in buzzer.tones] == [(3500, 3500, 3500, 120), (2500, 2500, 2500, 120)] * 16 + [
            (3500, 3500, 3500, 120)]
        assert buzzer.tones[-1][0] - buzzer.tones[0][0] == pytest.approx(4.8, abs=0.1)
        # a buzzer that fails stops the alarm and the board confirms failed
        assert wait_for(lambda: result(warning, "node-x") == "failed", timeout=5)
        assert len(broken.tones) == 3
        out = capsys.readouterr().out
        assert f"node-w: alarm {warning} played" in out and f"node-x: alarm {warning} failed" in out

        time.sleep(2.0)  # what was fed during the alarm would have been analysed by now
        assert [e for e in state.events if e["sensor_id"] == "node-w"] == []
        assert wait_for(lambda: "alarm_done" not in checkin("node-w"))
        assert checkin("node-w")["recordings_per_min"] == 0
        time.sleep(1.0)
        assert len(buzzer.tones) == 33  # played once

        # then back to normal: the same chainsaw is heard and counted
        play(board, "chainsaw.wav")
        assert wait_for(lambda: any(e["sensor_id"] == "node-w" and e["sound_id"] == "chainsaw" for e in state.events))
        assert wait_for(lambda: checkin("node-w").get("recordings_per_min") == 1)
    finally:
        board.stop()
        failing.stop()
        silent.stop()
        server.shutdown()
