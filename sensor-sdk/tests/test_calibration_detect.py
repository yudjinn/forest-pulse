"""Calibration beeps: finding each role's first path under noise and an echo, and the stage check built on it."""
import subprocess
import sys

import numpy as np
import pytest
from forestpulse_sensor.calibration import DEFAULT_PATTERNS, detect
from forestpulse_sensor.calibration.render import render
from forestpulse_sensor.calibration.stagecheck import play_sweeps

FS = 48000
ECHO_SAMPLES = 2.0 / 1000 * FS  # the wall echo arrives 2 ms after the direct path


@pytest.mark.parametrize("snr_db, tolerance", [(30, 0.25), (10, 1.0)])
def test_each_roles_first_path_is_found_under_hall_noise_speech_and_an_echo(snr_db, tolerance):
    # One emitter beeps all three sweeps 1 m away. The wall echo is stronger than the direct path, as when the
    # buzzer faces the wall, so the strongest match is the echo and only the first-path rule finds the direct one.
    beeps = [(0.5, DEFAULT_PATTERNS["A"]), (1.3, DEFAULT_PATTERNS["B"]), (2.1, DEFAULT_PATTERNS["C"])]
    for seed in range(3):
        rec = render(beeps, distance_m=1.0, level_db=snr_db, echo_gain=1.2, seed=seed)
        assert rec.snr_db == pytest.approx(snr_db)

        found = [d for d in detect(rec.audio, DEFAULT_PATTERNS, FS) if not d.weak]

        assert [d.role for d in found] == ["A", "B", "C"], found
        for d, truth in zip(found, rec.positions):
            assert abs(d.position - truth) <= tolerance, (seed, d, truth)
            assert abs(d.position - (truth + ECHO_SAMPLES)) > ECHO_SAMPLES / 2
            assert d.snr_db > 15

    # positions are in the caller's stream: a slice starting at sample 1000 of a stream reports 1000 + index
    shifted = detect(rec.audio, DEFAULT_PATTERNS, FS, offset=1000)
    assert [round(d.position - 1000, 6) for d in shifted] == [round(d.position, 6) for d in detect(
        rec.audio, DEFAULT_PATTERNS, FS)]


class FakeClock:
    def __init__(self):
        self.t = 100.0

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


def stage_check(*paths):
    """Runs the stage check as the team does, as a command; returns its exit code and printed lines."""
    done = subprocess.run([sys.executable, "-m", "forestpulse_sensor.calibration.stagecheck", *map(str, paths)],
                          capture_output=True, text=True, timeout=120)
    return done.returncode, done.stdout.strip().splitlines()


def test_stage_check_passes_a_good_stage_and_fails_a_quiet_buzzer_or_a_wrong_file(tmp_path):
    # The sweep player drives the emit hook 10 times, 1 s apart; those emit times are what the board records.
    clock, emitted = FakeClock(), []
    times = play_sweeps(lambda *args: emitted.append((clock.now(), args)), "A", clock=clock.now, sleep=clock.sleep)
    assert [args for _, args in emitted] == [(1500, 2500, 3500, 120)] * 10
    assert np.allclose(np.diff(times), 1.0) and times == [t for t, _ in emitted]
    beeps = [(0.5 + t - times[0], DEFAULT_PATTERNS["A"]) for t in times]

    for name, level_db in (("good", 20), ("quiet", -5)):  # the quiet buzzer is 25 dB down
        (tmp_path / name).mkdir()
        for metres in (1, 3, 5):
            render(beeps, distance_m=metres, level_db=level_db, seed=metres).write(tmp_path / name / f"{metres}m.wav")

    code, lines = stage_check(*(tmp_path / "good" / f"{m}m.wav" for m in (5, 1, 3)))
    assert code == 0 and lines[-1] == "PASS", lines
    rows = lines[1:-1]
    assert [row.split()[:4] for row in rows] == [["1m.wav", "1", "m", "10/10"], ["3m.wav", "3", "m", "10/10"],
                                                 ["5m.wav", "5", "m", "10/10"]]
    assert all(row.endswith("ok") for row in rows)

    code, lines = stage_check(*(tmp_path / "quiet" / f"{m}m.wav" for m in (1, 3, 5)))
    assert code == 1 and lines[-1] == "FAIL", lines
    assert not lines[3].endswith("ok"), lines  # 5 m

    good = render(beeps, distance_m=3, level_db=20, seed=3)
    good.write(tmp_path / "3m-stereo.wav", channels=2)
    code, lines = stage_check(tmp_path / "good" / "1m.wav", tmp_path / "3m-stereo.wav")
    assert code == 1 and lines[-1] == "FAIL", lines
    assert any(row.startswith("3m-stereo.wav") and row.endswith("2 channels, needs 3") for row in lines), lines
