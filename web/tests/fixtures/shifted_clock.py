"""Runs the sensor library's replay command with the library's wall clock moved, for journeys: a sensor whose clock
is wrong. Only the wall clock moves (event times and sent_at); timers and waits are untouched.

usage: python shifted_clock.py <shift seconds, negative is behind> <replay arguments...>
"""
import runpy
import sys
import time
from datetime import datetime

import forestpulse_sensor.api as api

shift = float(sys.argv[1])
_real_time = time.time
time.time = lambda: _real_time() + shift


class ShiftedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime.fromtimestamp(time.time(), tz)


api.datetime = ShiftedDatetime
sys.argv = ["forestpulse_sensor.replay", *sys.argv[2:]]
runpy.run_module("forestpulse_sensor.replay", run_name="__main__")
