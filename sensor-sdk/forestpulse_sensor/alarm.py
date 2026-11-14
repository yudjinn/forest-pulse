"""The warning alarm: a harsh two-tone pattern played on the board's buzzer through the calibration emit hook.

usage, from the device app: play_alarm(hooks.emit)

The pattern's numbers live here and only here, so the sensor's warning handling and anything that waits on the
alarm use the same ones.
"""
import logging
import time

log = logging.getLogger("forestpulse_sensor")

TONES_HZ = (3500, 2500)  # alternating, starting with the first
TONE_MS = 120
INTERVAL_S = 0.150  # one tone starts every 150 ms: a 30 ms gap
TONE_COUNT = 33
DURATION_S = (TONE_COUNT - 1) * INTERVAL_S + TONE_MS / 1000  # first tone's start to last tone's end, 4.92 s


def play_alarm(emit, *, clock=time.monotonic, sleep=time.sleep) -> bool:
    """Plays the alarm through the buzzer hook; True when every tone played.

    emit: the hook, called as emit(f, f, f, TONE_MS) once per tone (a constant tone). Tones start on the clock,
    INTERVAL_S apart from the first, however long the hook takes. If the hook raises or returns False the alarm stops
    at once, the reason is logged and the result is False.
    """
    start = clock()
    for i in range(TONE_COUNT):
        wait = start + i * INTERVAL_S - clock()
        if wait > 0:
            sleep(wait)
        f = TONES_HZ[i % len(TONES_HZ)]
        try:
            ok = emit(f, f, f, TONE_MS)
        except Exception:  # the device app's code: any failure ends the alarm
            log.exception("alarm stopped: emit() failed on tone %d of %d", i + 1, TONE_COUNT)
            return False
        if ok is False:
            log.error("alarm stopped: emit() returned False on tone %d of %d", i + 1, TONE_COUNT)
            return False
    return True
