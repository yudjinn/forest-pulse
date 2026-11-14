"""Runtime ESP32 trigger thresholds: encoding, range checks, apply / re-apply after an ESP32 reset."""
import struct

import pytest

from trigger_settings import TriggerSettings, encode

INFO = ("INFO idf=v5.5.6 state=idle trig_snr_db={s:.2f} trig_ratio_db={r:.2f} trig_coherence={c:.2f} "
        "trig_default_snr_db=4.00 trig_default_ratio_db=0.00 trig_default_coherence=0.60")


def info(s=4.0, r=0.0, c=0.6):
    return INFO.format(s=s, r=r, c=c)


class Link:
    def __init__(self, connected=True):
        self.sent, self.connected = [], connected

    def __call__(self, b):
        self.sent.append(b)
        return self.connected


def decode(b):
    assert b[:1] == b"G" and len(b) == 4
    return b[1:2].decode(), struct.unpack("<h", b[2:])[0] / 100


def make(initial=None, connected=True):
    link = Link(connected)
    return TriggerSettings(link, initial, log=lambda s: None), link


def test_encode_matches_firmware_format():
    assert encode("snr_db", 3) == b"GS" + struct.pack("<h", 300)
    assert encode("ratio_db", -2.5) == b"GR" + struct.pack("<h", -250)
    assert encode("coherence", 0.45) == b"GC" + struct.pack("<h", 45)
    for name, bad in (("snr_db", -1), ("snr_db", 41), ("ratio_db", 31), ("coherence", 1.0)):
        with pytest.raises(ValueError):
            encode(name, bad)


def test_config_values_applied_on_first_info():
    t, link = make({"snr_db": 3.0, "ratio_db": None, "coherence": None})
    assert link.sent == []                      # nothing sent before the ESP32 reports
    t.on_text(info())
    assert [decode(b) for b in link.sent] == [("S", 3.0)]
    t.on_text("SET ok id=S value=3.00 snr_db=3.00 ratio_db=0.00 coherence=0.60")
    assert t.current() == {"snr_db": 3.0, "ratio_db": 0.0, "coherence": 0.6}


def test_server_update_sends_only_changes():
    t, link = make()
    t.on_text(info())
    assert link.sent == []                      # defaults already in place
    t.update({"snr_db": 3, "coherence": 0.45, "unknown": 1})
    assert sorted(decode(b) for b in link.sent) == [("C", 0.45), ("S", 3.0)]


def test_invalid_server_value_ignored():
    t, link = make()
    t.on_text(info())
    t.update({"snr_db": 99, "coherence": "x"})
    assert link.sent == [] and t.desired() == {}


def test_reapplied_after_esp32_reset():
    t, link = make({"snr_db": 3.0})
    t.on_text(info())
    t.on_text("SET ok id=S value=3.00 snr_db=3.00 ratio_db=0.00 coherence=0.60")
    link.sent.clear()
    t.on_text(info())                           # ESP32 reset: back to its defaults
    assert [decode(b) for b in link.sent] == [("S", 3.0)]
    link.sent.clear()
    t.on_text(info(s=3.0))                      # already right: nothing to send
    assert link.sent == []


def test_none_restores_firmware_default():
    t, link = make({"snr_db": 3.0})
    t.on_text(info())
    t.on_text("SET ok id=S value=3.00 snr_db=3.00 ratio_db=0.00 coherence=0.60")
    link.sent.clear()
    t.update({"snr_db": None})
    assert [decode(b) for b in link.sent] == [("S", 4.0)]   # the default from INFO


def test_rejection_logged_and_device_state_tracked():
    logs = []
    t = TriggerSettings(Link(), {}, log=logs.append)
    t.on_text("SET err id=S value=50.00 snr_db=4.00 ratio_db=0.00 coherence=0.60")
    assert any("rejected" in s for s in logs)
    assert t.current() == {"snr_db": 4.0, "ratio_db": 0.0, "coherence": 0.6}


def test_old_firmware_info_is_ignored():
    t, link = make({"snr_db": 3.0})
    t.on_text("INFO idf=v5.5.6 state=idle rms_dbfs=-50.0")
    assert link.sent == [] and t.current() is None
