"""End-to-end: protocol packets -> Receiver -> Pipeline -> record/storage/LED."""
import json
import os

import numpy as np
import pytest

from harness import Climate, encode_event, led_arrow, make_pipeline, replay
from climate import speed_of_sound
from test_bearing import plane_wave

FS = 48000


def synthetic_event(theta, live_s=3.0, seed=0):
    """4 s of quiet diffuse noise, then a source from theta (loud, coherent)."""
    rng = np.random.default_rng(seed)
    bg = rng.standard_normal((4 * FS, 3)) * 30
    src = plane_wave(theta, seconds=live_s, snr_db=20, seed=seed) + rng.standard_normal((int(live_s * FS), 3)) * 30
    return np.concatenate([bg, src]).clip(-32768, 32767).astype(np.int16)


def test_event_record_and_storage(tmp_path):
    frames = []
    pipe = make_pipeline(str(tmp_path), {"led": {"source": "bearing", "require_chainsaw": False}},
                         classifier=False, display=frames.append, log=lambda s: None)
    rec = replay(synthetic_event(120), pipe, log=lambda s: None)
    err = (rec["bearing"]["deg"] - 120 + 180) % 360 - 180
    assert abs(err) <= 3
    assert rec["bearing"]["confidence"] > 0.8
    assert rec["pre_trigger_s"] == 4.0 and rec["duration_s"] == 7.0
    assert rec["t_trigger_source"] == "first_packet"  # no D7 wire: the first pre-trigger packet's arrival
    assert rec["integrity"] == {"seq_gaps": 0, "breaks": 0, "overrun": False, "sync_loss": False,
                                "joined_mid_event": False}
    assert rec["bearing"]["speed_of_sound"]["source"] == "default"
    files = os.listdir(tmp_path / "events")
    assert f"{rec['event_id']}.wav" in files and f"{rec['event_id']}.json" in files
    assert json.load(open(tmp_path / "outbox" / f"{rec['event_id']}.json"))["record"]["event_id"] == rec["event_id"]
    assert frames and frames[-1] == led_arrow.to_wire(led_arrow.arrow(rec["bearing"]["deg"]))


def test_background_only_has_no_bearing(tmp_path):
    rng = np.random.default_rng(3)
    audio = (rng.standard_normal((7 * FS, 3)) * 300).astype(np.int16)  # diffuse: independent mics
    pipe = make_pipeline(str(tmp_path), {"led": {"require_chainsaw": False}}, classifier=False, log=lambda s: None)
    rec = replay(audio, pipe, log=lambda s: None)
    assert rec["bearing"]["deg"] is None and rec["bearing"]["confidence"] == 0.0


def test_led_requires_chainsaw(tmp_path):
    frames = []
    pipe = make_pipeline(str(tmp_path), {"led": {"source": "bearing", "require_chainsaw": True}},
                         classifier=False, display=frames.append, log=lambda s: None)
    replay(synthetic_event(45), pipe, log=lambda s: None)
    assert not [f for f in frames if f]  # gate on: no classifier -> never "chainsaw" -> no arrow


def test_default_led_waits_for_sdk_detections(tmp_path):
    frames = []  # led.source "detections": only the SDK's detections (show_detection) light the arrow
    pipe = make_pipeline(str(tmp_path), classifier=False, display=frames.append, log=lambda s: None)
    rec = replay(synthetic_event(45), pipe, log=lambda s: None)
    assert rec["classification"] is None and rec["bearing"]["deg"] is not None
    assert not [f for f in frames if f]
    pipe.show_detection(rec["bearing"]["deg"])
    assert frames[-1] == led_arrow.to_wire(led_arrow.arrow(rec["bearing"]["deg"]))


def test_location_only_mode_shows_any_located_source(tmp_path):
    frames = []  # led.source "bearing": arrow for every event with a reliable bearing
    pipe = make_pipeline(str(tmp_path), {"led": {"source": "bearing"}}, classifier=False,
                         display=frames.append, log=lambda s: None)
    rec = replay(synthetic_event(45), pipe, log=lambda s: None)
    assert frames and frames[-1] == led_arrow.to_wire(led_arrow.arrow(rec["bearing"]["deg"]))


def test_modulino_speed_of_sound_used(tmp_path):
    clim = Climate()
    clim.update(35.0, 60.0)
    pipe = make_pipeline(str(tmp_path), {"led": {"require_chainsaw": False}}, classifier=False,
                         log=lambda s: None, climate=clim)
    rec = replay(synthetic_event(200), pipe, log=lambda s: None)
    sos = rec["bearing"]["speed_of_sound"]
    assert sos["source"] == "modulino" and sos["mps"] == round(speed_of_sound(35.0, 60.0), 2)
    assert pipe.est.c == sos["mps"]


def test_climate_fallbacks():
    now = [0.0]
    c = Climate(clock=lambda: now[0])
    assert c.current()["mps"] == 343.0 and c.current()["source"] == "default"
    c.update(20.0, 50.0)
    assert c.current()["source"] == "modulino"
    c.update(500.0, 50.0)            # implausible -> ignored, previous kept
    assert c.current()["temp_c"] == 20.0
    now[0] = 61.0                    # stale -> default
    assert c.current()["source"] == "default"


def test_arrow_points_the_right_way():
    def lit(frame):
        return [(r, c) for r in range(8) for c in range(13) if frame[r][c]]
    right = lit(led_arrow.arrow(0))
    assert max(c for _, c in right) == 12 and min(c for _, c in right) >= 3  # tip at right edge
    up = lit(led_arrow.arrow(90))
    assert min(r for r, _ in up) == 0                                        # tip at top row
    rot = led_arrow.arrow(0, rotation_deg=180)                               # mounted rotated
    assert min(c for _, c in lit(rot)) == 0


def tone_event(theta, hz=2000.0, live_s=2.0, seed=0):
    """4 s quiet, then a pure tone from theta (far field, exact delays) plus sensor noise."""
    from bearing import NOMINAL, SPEED_OF_SOUND
    rng = np.random.default_rng(seed)
    t = np.arange(int(live_s * FS)) / FS
    u = np.array([np.cos(np.deg2rad(theta)), np.sin(np.deg2rad(theta))])
    delays = -(NOMINAL.positions @ u) / SPEED_OF_SOUND
    tone = np.stack([3000 * np.sin(2 * np.pi * hz * (t - d)) for d in delays], axis=1)
    bg = rng.standard_normal((4 * FS, 3)) * 30
    return np.concatenate([bg, tone + rng.standard_normal(tone.shape) * 30]).astype(np.int16)


@pytest.mark.parametrize("theta", [0, 45, 100, 170, 230, 300])
def test_test_tone_points_led(tmp_path, theta):
    frames = []
    pipe = make_pipeline(str(tmp_path), {"test_tone_hz": 2000}, classifier=False,
                         display=frames.append, log=lambda s: None)
    replay(tone_event(theta), pipe, log=lambda s: None)
    assert frames, "no arrow for the test tone"
    err = (pipe.led_deg - theta + 180) % 360 - 180
    assert abs(err) <= 5, f"tone from {theta}: arrow at {pipe.led_deg}"


def test_test_tone_off_by_default(tmp_path):
    frames = []
    pipe = make_pipeline(str(tmp_path), classifier=False, display=frames.append, log=lambda s: None)
    replay(tone_event(90), pipe, log=lambda s: None)
    assert not [f for f in frames if f]
