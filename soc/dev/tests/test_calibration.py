"""Location calibration, node side: CalibrationHooks (stream C/X, emit, bearing of one
short arrival) and the SensorTee pipeline bypass. The SDK side is faked."""
import queue

import numpy as np
import pytest

import sdk_glue
from bearing import NOMINAL, SPEED_OF_SOUND
from climate import Climate
from events import AudioBlock, EventEnd, EventStart, PipelineReset
from harness import config

FS = 48000


def stepped_sweep(f0, f1, f2, ms, step_ms=1.0, fs=FS):
    """What the sketch plays: piecewise-linear frequency steps, phase continuous."""
    n = int(ms * fs / 1000)
    steps = max(2, int(ms / step_ms))
    half = steps // 2
    f = np.empty(n)
    for i in range(steps):
        fi = f0 + (f1 - f0) * i / half if i < half else f1 + (f2 - f1) * (i - half) / max(1, steps - 1 - half)
        f[int(i * n / steps):int((i + 1) * n / steps)] = fi
    return np.sin(2 * np.pi * np.cumsum(f) / fs)


def plane_wave(mono, theta_deg, noise=0.0, seed=0, amp=8000.0):
    n = len(mono)
    fr = np.fft.rfftfreq(n, 1 / FS)
    S = np.fft.rfft(mono * amp)
    u = np.array([np.cos(np.deg2rad(theta_deg)), np.sin(np.deg2rad(theta_deg))])
    t = -(NOMINAL.positions @ u) / SPEED_OF_SOUND
    x = np.stack([np.fft.irfft(S * np.exp(-2j * np.pi * fr * ti), n) for ti in t], axis=1)
    x += np.random.default_rng(seed).standard_normal(x.shape) * noise
    return x.clip(-32768, 32767).astype(np.int16)


def arrival_window(theta_deg, sweep=(1500, 2500, 3500, 30), noise=200.0, seed=0):
    """~60 ms slice around one arrival, as the SDK would cut it."""
    burst = stepped_sweep(*sweep)
    pad = int(0.015 * FS)
    mono = np.concatenate([np.zeros(pad), burst, np.zeros(pad)])
    return plane_wave(mono, theta_deg, noise=noise, seed=seed)


class Fake:
    def __init__(self, connected=True):
        self.sent, self.notes, self.connected = [], [], connected

    def send(self, c):
        self.sent.append(c)
        return self.connected

    def notify(self, name, *args):
        self.notes.append((name, args))


def make(connected=True, buzzer=None):
    q = queue.Queue()
    tee = sdk_glue.SensorTee(q, None, log=lambda s: None)
    f = Fake(connected)
    hooks = sdk_glue.CalibrationHooks(config.load(), Climate(), send_command=f.send, notify=f.notify, tee=tee,
                                      log=lambda s: None, buzzer_ok=lambda: buzzer, sleep=lambda s: None)
    return hooks, tee, q, f


def drain(q):
    out = []
    while True:
        try:
            out.append(q.get_nowait())
        except queue.Empty:
            return out


def block(n=960, off=0):
    return AudioBlock(np.zeros((n, 3), np.int16), off, True, False)


def test_static_facts():
    hooks, *_ = make()
    assert hooks.fs == 48000
    assert hooks.emitter_offset_m == pytest.approx(0.03)
    assert np.allclose(hooks.mic_positions_m, [(-0.04, 0.0), (0.0, 0.0), (0.0, -0.08)])  # board frame
    assert hooks.forward_ccw_deg == 90.0
    assert hooks.speed_of_sound() == pytest.approx(343.0)


def test_stream_control_bypasses_pipeline_until_stream_end():
    hooks, tee, q, f = make()
    tee.put(EventStart(1, 0.0, False))           # a normal event in progress
    tee.put(block())
    assert hooks.start_stream() is True and f.sent == ["X", "C"]   # end any recording, then stream
    tee.put(block())                             # calibration audio: not for the pipeline
    hooks.stop_stream()
    assert f.sent == ["X", "C", "X"]
    tee.put(block())                             # tail of the stream after X
    tee.put(EventEnd(9, 0.0, 0))                 # the stream's end: swallowed
    tee.put(EventStart(10, 0.0, False))          # next normal event goes through again
    msgs = drain(q)
    kinds = [type(m).__name__ for m in msgs]
    assert kinds == ["EventStart", "AudioBlock", "PipelineReset", "EventStart"]
    assert not tee.bypassing


def test_stream_not_started_releases_bypass():
    hooks, tee, q, f = make(connected=False)
    assert hooks.start_stream() is False
    tee.put(EventStart(1, 0.0, False))           # no stream ever came; a normal event passes
    assert [type(m).__name__ for m in drain(q)] == ["PipelineReset", "EventStart"]


def test_pipeline_reset_drops_event_in_progress(tmp_path):
    from harness import make_pipeline
    p = make_pipeline(str(tmp_path), classifier=False, log=lambda s: None)
    p.queue.put(EventStart(1, 0.0, False))
    p.queue.put(block())
    p.queue.put(PipelineReset("test"))
    p.queue.put(EventEnd(2, 0.0, 960))           # orphaned end: ignored, no record
    p.drain()
    assert p.ev is None and p.records == []


def test_sdk_keeps_getting_audio_while_calibrating():
    hooks, tee, q, f = make()

    class S:
        fed, ends = [], 0

        def feed(self, pcm, break_before=False):
            self.fed.append(len(pcm))

        def end_of_audio(self):
            self.ends += 1
    tee.sensor = s = S()
    hooks.start_stream()
    for k in range(3):
        tee.put(block(off=k * 960))
    hooks.stop_stream()
    tee.put(EventEnd(1, 0.0, 2880))
    assert s.fed == [960, 960, 960] and s.ends == 1


def test_emit_sends_sweep_to_sketch():
    hooks, _, _, f = make()
    assert hooks.emit(1500.0, 2500, 3500, 120) is True   # the service may send floats
    assert f.notes == [("emit", (1500, 2500, 3500, 120))]
    with pytest.raises(ValueError):
        hooks.emit(1500, 2500, 3500, 0)


def test_emit_fails_without_buzzer():
    hooks, _, _, f = make(buzzer=False)
    assert hooks.emit(1500, 2500, 3500, 120) is False and f.notes == []


def test_emit_on_the_speaker_sends_the_sweep_to_the_esp32():
    import struct
    hooks, _, _, f = make(buzzer=False)              # no Modulino Buzzer needed
    hooks.c["emitter"], hooks.c["speaker_volume"] = "speaker", 300   # volume clamps to 255
    assert hooks.emit(3000.0, 4000, 5000, 300) is True
    assert f.sent == [b"P" + struct.pack("<HHHHB", 3000, 4000, 5000, 300, 255)] and f.notes == []
    f.sent.clear()
    assert hooks.emit(3000, 4000, 5000, 300, volume=0.125) is True   # the run's level wins over the config
    assert f.sent == [b"P" + struct.pack("<HHHHB", 3000, 4000, 5000, 300, 32)]
    hooks2, _, _, f2 = make(connected=False)
    hooks2.c["emitter"] = "speaker"
    assert hooks2.emit(3000, 4000, 5000, 300) is False


def test_hooks_pass_the_sdk_self_check():
    from forestpulse_sensor.calibration.hooks import self_check
    hooks, *_ = make()
    assert self_check(hooks) == []


@pytest.mark.parametrize("theta", [0, 45, 90, 135, 200, 270, 330])
def test_bearing_of_one_short_sweep(theta):
    hooks, *_ = make()
    angle, q = hooks.bearing(arrival_window(theta), band_hz=(1000, 4000))
    expected = sdk_glue.board_to_angle(theta, 90.0)
    assert abs((angle - expected + 180) % 360 - 180) <= 5
    assert 0 < q <= 1


def test_bearing_on_the_sdks_windows_and_patterns():
    """What the SDK gives bearing(): 40 ms from 5 ms before the first path, each role's sweep and band.
    Accept most, and never far off (the SDK's solver assumes ~12 deg per bearing)."""
    from forestpulse_sensor.calibration.patterns import DEFAULT_PATTERNS
    hooks, *_ = make()
    got = errs = 0
    total = 0
    worst = 0.0
    for role, p in DEFAULT_PATTERNS.items():
        for theta in range(0, 360, 30):
            burst = stepped_sweep(*p.emit_args())
            x = plane_wave(np.concatenate([np.zeros(int(0.005 * FS)), burst]), theta, noise=200)[: int(0.040 * FS)]
            r = hooks.bearing(x, p.band_hz)
            total += 1
            if r is not None:
                got += 1
                worst = max(worst, abs((r[0] - sdk_glue.board_to_angle(theta, 90.0) + 180) % 360 - 180))
    assert got / total >= 0.85 and worst <= 15


def test_bearing_none_for_noise_and_bad_input():
    hooks, *_ = make()
    noise = (np.random.default_rng(3).standard_normal((2880, 3)) * 500).astype(np.int16)
    assert hooks.bearing(noise) is None
    assert hooks.bearing(np.zeros((10, 3), np.int16)) is None
    assert hooks.bearing(np.zeros((2880, 2), np.int16)) is None


def test_server_ok_from_sdk_status():
    now = 1000.0
    assert sdk_glue.server_ok({"last_checkin_ok": now - 5, "key_rejected": False}, now)
    assert not sdk_glue.server_ok({"last_checkin_ok": now - 31, "key_rejected": False}, now)  # stale
    assert not sdk_glue.server_ok({"last_checkin_ok": None, "key_rejected": False}, now)      # never
    assert not sdk_glue.server_ok({"last_checkin_ok": now, "key_rejected": True}, now)        # bad key
    assert not sdk_glue.server_ok(None, now)                                                  # no SDK


def test_sdk_sensor_accepts_our_hooks(tmp_path):
    """The real SDK Sensor takes the hooks and reports that this node can calibrate."""
    from forestpulse_sensor import Sensor
    hooks, *_ = make()
    s = Sensor("http://127.0.0.1:9", "key", "fp-test", state_dir=str(tmp_path), calibration=hooks)
    assert s.status["calibration_capable"] is True and s.status["calibrating"] is False


def test_config_local_overrides(tmp_path, monkeypatch):
    import json as _json
    import config as cfgmod
    local = tmp_path / "config.local.json"
    local.write_text(_json.dumps({"calibration": {"test_fake_bearing_deg": 0, "test_mono_mic": 2}}))
    monkeypatch.setenv("ATECH_CONFIG_LOCAL", str(local))
    c = cfgmod.load()
    assert c["calibration"]["test_fake_bearing_deg"] == 0 and c["calibration"]["test_mono_mic"] == 2
    assert c["calibration"]["emitter_offset_cm"] == 3.0          # the rest still from config.json
    monkeypatch.setenv("ATECH_CONFIG_LOCAL", str(tmp_path / "missing.json"))
    assert cfgmod.load()["calibration"]["test_fake_bearing_deg"] is None


def test_fake_bearing():
    cfg = config.load()
    cfg["calibration"]["test_fake_bearing_deg"] = 0
    hooks = sdk_glue.CalibrationHooks(cfg, Climate(), send_command=lambda c: True, notify=lambda *a: None,
                                      log=lambda s: None)
    noise = (np.random.default_rng(3).standard_normal((1920, 3)) * 500).astype(np.int16)
    assert hooks.bearing(noise, (1500, 3500)) == (0.0, 1.0)


def test_mono_mic_feeds_one_mic_only_while_calibrating():
    hooks, tee, q, f = make()

    class S:
        fed = []

        def feed(self, pcm, break_before=False):
            self.fed.append(pcm.copy())

        def end_of_audio(self):
            pass
    tee.sensor = s = S()
    tee.mono_mic = 1                                  # mic2
    pcm = np.tile(np.array([[1, 2, 3]], np.int16), (4, 1))
    tee.put(AudioBlock(pcm, 0, True, False))          # normal event: all 3 mics
    hooks.start_stream()
    tee.put(AudioBlock(pcm, 4, True, False))          # calibration: mic2 in every column
    assert s.fed[0].tolist()[0] == [1, 2, 3] and s.fed[1].tolist()[0] == [2, 2, 2]
