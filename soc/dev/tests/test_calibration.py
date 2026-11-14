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


def make(connected=True):
    q = queue.Queue()
    tee = sdk_glue.SensorTee(q, None, log=lambda s: None)
    f = Fake(connected)
    hooks = sdk_glue.CalibrationHooks(config.load(), Climate(), send_command=f.send, notify=f.notify, tee=tee,
                                      log=lambda s: None)
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
    assert hooks.mic_positions_m[2] == pytest.approx([0.0, -0.06])
    assert hooks.forward_ccw_deg == 90.0
    assert hooks.speed_of_sound() == pytest.approx(343.0)


def test_stream_control_bypasses_pipeline_until_stream_end():
    hooks, tee, q, f = make()
    tee.put(EventStart(1, 0.0, False))           # a normal event in progress
    tee.put(block())
    assert hooks.start_stream() is True and f.sent == ["C"]
    tee.put(block())                             # calibration audio: not for the pipeline
    hooks.stop_stream()
    assert f.sent == ["C", "X"]
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
    hooks.emit(1500, 2500, 3500, 30)
    assert f.notes == [("emit", (1500, 2500, 3500, 30))]
    with pytest.raises(ValueError):
        hooks.emit(1500, 2500, 3500, 0)


@pytest.mark.parametrize("theta", [0, 45, 90, 135, 200, 270, 330])
def test_bearing_of_one_short_sweep(theta):
    hooks, *_ = make()
    angle, q = hooks.bearing(arrival_window(theta), band_hz=(1000, 4000))
    expected = sdk_glue.board_to_angle(theta, 90.0)
    assert abs((angle - expected + 180) % 360 - 180) <= 5
    assert 0 < q <= 1


@pytest.mark.parametrize("theta", [30, 120, 250])
def test_bearing_of_the_shared_sweep(theta):
    """The shared 300 ms rising sweep (config calibration.sweep), first 50 ms and the whole beep."""
    hooks, *_ = make()
    sweep = tuple(config.load()["calibration"]["sweep"])
    assert sweep == (1500, 2500, 3500, 300)
    full = arrival_window(theta, sweep=sweep)
    expected = sdk_glue.board_to_angle(theta, 90.0)
    for window in (full[: int(0.065 * FS)], full):          # early part (before echoes) / whole beep
        angle, _ = hooks.bearing(window)                     # default band from config
        assert abs((angle - expected + 180) % 360 - 180) <= 5


def test_bearing_none_for_noise_and_bad_input():
    hooks, *_ = make()
    noise = (np.random.default_rng(3).standard_normal((2880, 3)) * 500).astype(np.int16)
    assert hooks.bearing(noise) is None
    assert hooks.bearing(np.zeros((10, 3), np.int16)) is None
    assert hooks.bearing(np.zeros((2880, 2), np.int16)) is None
