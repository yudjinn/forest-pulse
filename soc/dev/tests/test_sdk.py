"""Integration with the Forest Pulse sensor SDK: angle_fn, the tee, and an
end-to-end run with the real model against the SDK's dev server."""
import json
import socket
import time
from importlib import resources

import numpy as np
import pytest
from forestpulse_sensor import Model, Sensor, board_to_angle
from forestpulse_sensor.devserver import serve
from forestpulse_sensor.selftest import read_wav

import sdk_glue
from bearing import NOMINAL, SPEED_OF_SOUND
from climate import Climate
from events import AudioBlock, EventEnd
from harness import config, encode_event, led_arrow, make_pipeline
from receiver import Receiver
from test_bearing import plane_wave

FS = 48000
REF = resources.files("forestpulse_sensor").joinpath("data/reference")
SEED = json.loads(resources.files("forestpulse_sensor").joinpath("data/seed_sounds.json").read_text())


def as_plane_wave(mono: np.ndarray, theta_deg: float, noise: float = 20.0, seed: int = 0) -> np.ndarray:
    """Turn a mono recording into a far-field 3-mic capture from theta (exact fractional delays)."""
    n = len(mono)
    f = np.fft.rfftfreq(n, 1 / FS)
    S = np.fft.rfft(mono.astype(np.float64))
    u = np.array([np.cos(np.deg2rad(theta_deg)), np.sin(np.deg2rad(theta_deg))])
    t = -(NOMINAL.positions @ u) / SPEED_OF_SOUND
    x = np.stack([np.fft.irfft(S * np.exp(-2j * np.pi * f * ti), n) for ti in t], axis=1)
    x += np.random.default_rng(seed).standard_normal(x.shape) * noise
    return x.clip(-32768, 32767).astype(np.int16)


def test_board_to_angle_matches_sdk():
    for th in (0, 37.5, 90, 200, 359):
        for fwd in (90.0, 0.0):
            assert sdk_glue.board_to_angle(th, fwd) == pytest.approx(board_to_angle(th, fwd))


def test_detection_bearing_returns_api_angle_and_drives_led():
    cfg = config.load()
    seen = []
    fn = sdk_glue.DetectionBearing(cfg, Climate(), on_bearing=seen.append, log=lambda s: None)
    window = plane_wave(150, seconds=4.0, snr_db=15).astype(np.int16)
    angle, conf = fn(window)
    assert angle == pytest.approx(board_to_angle(150), abs=3)   # clockwise from forward (top edge)
    assert conf > 0.5 and seen and abs(seen[0] - 150) <= 3


def test_detection_bearing_none_for_diffuse_noise():
    fn = sdk_glue.DetectionBearing(config.load(), Climate(), log=lambda s: None)
    assert fn((np.random.default_rng(2).standard_normal((4 * FS, 3)) * 500).astype(np.int16)) is None


def test_tee_feeds_sdk_and_pipeline():
    class FakeSensor:
        def __init__(self):
            self.calls = []

        def feed(self, pcm, break_before=False):
            self.calls.append(("feed", len(pcm), break_before))

        def end_of_audio(self):
            self.calls.append(("end",))

    import queue
    q, fs = queue.Queue(), FakeSensor()
    tee = sdk_glue.SensorTee(q, fs)
    pcm = np.zeros((679, 3), np.int16)
    tee.put(AudioBlock(pcm, 0, False, False))
    tee.put(AudioBlock(pcm, 679, False, False))
    tee.put(EventEnd(5, 0.0, 1358))
    assert fs.calls == [("feed", 679, True), ("feed", 679, False), ("end",)]  # new event = new burst
    assert q.qsize() == 3


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_end_to_end_chainsaw_with_angle(tmp_path):
    """Reference chainsaw as a 3-mic plane wave from 120 deg -> our receiver -> tee
    -> real SDK model -> dev server: a chainsaw event with our angle, and the LED arrow."""
    port = free_port()
    server, state = serve(port, key="k", sounds=json.loads(json.dumps(SEED)), quiet=True)
    frames = []
    pipe = make_pipeline(str(tmp_path / "node"), classifier=False, display=frames.append, log=lambda s: None)
    angle_fn = sdk_glue.DetectionBearing(pipe.cfg, Climate(), on_bearing=pipe.show_detection, log=lambda s: None)
    sensor = Sensor(f"http://127.0.0.1:{port}", "k", sensor_id="fp-test", state_dir=str(tmp_path / "sdk"),
                    model=Model(), checkin_interval=0.2, angle_fn=angle_fn).start()
    try:
        clip, _ = read_wav(REF.joinpath("chainsaw.wav"))
        audio = as_plane_wave(clip.astype(np.float64).mean(axis=1), 120.0)
        rx = Receiver(sdk_glue.SensorTee(pipe.queue, sensor), log=lambda s: None)
        rx.feed(encode_event(audio))
        pipe.drain()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not [e for e in state.events if e["sound_id"] == "chainsaw"]:
            time.sleep(0.1)
        saws = [e for e in state.events if e["sound_id"] == "chainsaw"]
        assert saws, state.events
        assert saws[0]["angle_deg"] == pytest.approx(board_to_angle(120.0), abs=3)
        assert saws[0]["sensor_id"] == "fp-test"
        lit = [f for f in frames if f]
        assert lit and lit[-1] == led_arrow.to_wire(led_arrow.arrow(pipe.led_deg))
        assert abs(pipe.led_deg - 120.0) <= 3
    finally:
        sensor.stop(flush_timeout=1)
        server.shutdown()
