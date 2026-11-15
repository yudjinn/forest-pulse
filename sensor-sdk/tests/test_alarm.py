"""The warning alarm through a buzzer hook: the published pattern, timed by the clock, and stopping on a failed tone."""
import logging

import pytest
from forestpulse_sensor.alarm import play_alarm


class Buzzer:
    """A recording emit hook on a fake clock. Each tone holds the hook for its whole duration, as a blocking buzzer
    driver does, and every sleep wakes 4 ms late, as a loaded board's does."""

    def __init__(self, fail_on=None, fail_how=None):
        self.t, self.tones, self.fail_on, self.fail_how = 50.0, [], fail_on, fail_how

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds + 0.004

    def emit(self, f_start_hz, f_mid_hz, f_end_hz, duration_ms):
        self.tones.append((self.t, (f_start_hz, f_mid_hz, f_end_hz, duration_ms)))
        self.t += duration_ms / 1000
        if len(self.tones) == self.fail_on:
            if self.fail_how == "raise":
                raise OSError("buzzer driver gone")
            return False
        return None  # a hook that returns nothing played its tone

    def play(self):
        return play_alarm(self.emit, clock=self.now, sleep=self.sleep)


def test_the_alarm_plays_the_published_pattern_and_stops_on_a_failed_tone(caplog):
    buzzer = Buzzer()
    assert buzzer.play() is True

    assert [args for _, args in buzzer.tones] == [(3500, 3500, 3500, 120), (2500, 2500, 2500, 120)] * 16 + [
        (3500, 3500, 3500, 120)]
    starts = [t for t, _ in buzzer.tones]
    # on the clock: each tone starts 150 ms after the one before, however long the hook held it, with no drift
    assert all(abs(t - (starts[0] + 0.150 * i)) <= 0.010 for i, t in enumerate(starts)), starts
    assert all(abs(b - a - 0.150) <= 0.010 for a, b in zip(starts, starts[1:]))
    assert buzzer.t - starts[0] == pytest.approx(5.0, abs=0.1)  # about 5 s, to the last tone's end

    for how, reason in (("raise", "emit() failed on tone 5 of 33"), ("false", "emit() returned False on tone 5")):
        buzzer = Buzzer(fail_on=5, fail_how=how)
        caplog.clear()
        with caplog.at_level(logging.ERROR, logger="forestpulse_sensor"):
            assert buzzer.play() is False
        assert len(buzzer.tones) == 5, how  # stopped at once: no tone after the failed one
        assert reason in caplog.text, caplog.text

    # a hook that takes a volume gets the alarm's, every tone
    heard = []

    def loud(f_start_hz, f_mid_hz, f_end_hz, duration_ms, volume=None):
        heard.append(volume)

    assert play_alarm(loud, clock=lambda: 0.0, sleep=lambda s: None) is True
    assert heard == [0.6] * 33
