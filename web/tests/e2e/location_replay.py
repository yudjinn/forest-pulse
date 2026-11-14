"""Runs the sensor library's replay command as one of several sensors hearing a sound at the same moment, for the
location journey. The replay feeds audio faster than real time, so two replays started together stamp their
detections up to seconds apart; here each sensor's first detection waits until every sensor in the group has one,
and every detection is stamped with the sensor's clock when it is queued.

usage: python location_replay.py <barrier dir> <name> <replay arguments...>
Writes <barrier dir>/<name>.ready at its first detection and waits (60 s at most) for <barrier dir>/go.
"""
import os
import runpy
import sys
import time

import forestpulse_sensor.outbox as outbox
from forestpulse_sensor.api import iso

barrier, name = sys.argv[1], sys.argv[2]
_add = outbox.Outbox.add
released = False


def add(self, event):
    global released
    if not released:
        open(os.path.join(barrier, f"{name}.ready"), "w").close()
        deadline = time.monotonic() + 60
        while not os.path.exists(os.path.join(barrier, "go")):
            if time.monotonic() > deadline:
                raise SystemExit("the other sensors never heard the sound")
            time.sleep(0.02)
        released = True
    _add(self, {**event, "detected_at": iso(time.time())})


outbox.Outbox.add = add
sys.argv = ["forestpulse_sensor.replay", *sys.argv[3:]]
runpy.run_module("forestpulse_sensor.replay", run_name="__main__")
