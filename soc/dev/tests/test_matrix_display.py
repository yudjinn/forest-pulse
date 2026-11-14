"""LED matrix: font, scrolling ticker, meter, and priority (arrow > CAL > ticker)."""
import led_arrow
import matrix_display as md


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def make(status=None, **cfg):
    sent, clock = [], Clock()
    st = {"temp_c": 25.7, "rh": 45.2, "server_ok": True, "level_db": 6.0}
    st.update(status or {})
    d = md.MatrixDisplay(sent.append, lambda: st, {"scroll_ms": 120, "meter_s": 6.0, **cfg},
                         log=lambda s: None, clock=clock)
    return d, sent, clock, st


def run_scroll(d, clock):
    """Step until the scroll is done (meter starts). Returns the frames."""
    frames = []
    for _ in range(500):
        frames.append(d.step())
        clock.t += 0.12
        if d._meter_until is not None:
            return frames
    raise AssertionError("scroll never finished")


def test_every_ticker_character_has_a_glyph():
    for ch in "0123456789.-%° CAL" + md.ICON_OK + md.ICON_DOWN:
        assert ch in md.GLYPHS, repr(ch)
    for g in md.GLYPHS.values():
        assert all(len(col) == md.ROWS for col in g)


def test_render_text_width_and_spacing():
    assert len(md.render_text("1")) == 3
    assert len(md.render_text("12")) == 3 + 1 + 3
    assert len(md.render_text("CAL")) == 11            # fits in 13 columns
    assert md.render_text("?") == []                     # unknown chars skipped


def test_ticker_text_parts():
    assert md.ticker_text({"temp_c": 25.66, "rh": 45.2, "server_ok": True}) == "25.7°C 45% " + md.ICON_OK
    assert md.ticker_text({"temp_c": None, "rh": None, "server_ok": False}) == md.ICON_DOWN


def test_scroll_passes_the_whole_line():
    text = "25.7°C"
    frames = md.scroll_frames(text)
    assert len(frames) == len(md.render_text(text)) + md.COLS + 1
    assert not any(any(r) for r in frames[0]) and not any(any(r) for r in frames[-1])  # starts / ends blank
    # the text's first column enters at the right edge
    first = md.render_text(text)[0]
    assert [row[-1] for row in frames[1]] == first


def test_meter_heights():
    assert [md.meter_height(v) for v in (None, -5, 0, 12, 24, 40)] == [0, 0, 0, 4, 8, 8]
    f = md.meter_frame([12])
    assert [row[-1] for row in f] == [0, 0, 0, 0, 1, 1, 1, 1]


def test_cycle_scroll_then_meter_then_scroll():
    d, sent, clock, st = make()
    frames = run_scroll(d, clock)
    assert len(frames) == len(md.scroll_frames(md.ticker_text(st)))
    meter = d.step()                                     # meter phase
    assert meter == md.to_wire(md.meter_frame([6.0]))
    clock.t += 6.1
    d.step()                                             # meter over -> new scroll started
    assert d._frames is not None and d._idx == 1


def test_arrow_overrides_and_clear_resumes():
    d, sent, clock, st = make()
    d.step()
    arrow = led_arrow.to_wire(led_arrow.arrow(90))
    d.set_arrow(arrow)
    assert sent[-1] == arrow                             # shown immediately
    for _ in range(5):
        d.step()
        clock.t += 0.12
    assert sent[-1] == arrow and sent.count(arrow) == 1  # held, not re-sent
    d.set_arrow("")
    d.step()
    assert sent[-1] != arrow and d._frames is not None   # ticker restarted


def test_calibration_shows_cal_below_arrow():
    d, sent, clock, st = make()
    cal = md.to_wire(md.frame_from_cols([md.BLANK] + md.render_text("CAL")))
    d.set_calibrating(True)
    assert sent[-1] == cal
    d.set_arrow(led_arrow.to_wire(led_arrow.arrow(0)))
    assert sent[-1] != cal                               # arrow wins
    d.set_arrow("")
    assert sent[-1] == cal
    d.set_calibrating(False)
    d.step()
    assert sent[-1] != cal


def test_ticker_off_is_blank_between_arrows():
    d, sent, clock, st = make(ticker=False)
    d.step()
    assert sent == [""]
    d.set_arrow(led_arrow.to_wire(led_arrow.arrow(0)))
    d.set_arrow("")
    assert sent[-1] == ""


def test_server_icon_follows_status():
    d, sent, clock, st = make({"temp_c": None, "rh": None, "server_ok": False})
    frames = run_scroll(d, clock)
    down = md.render_text(md.ICON_DOWN)
    strip_cols = [[int(f[r * md.COLS + 12]) for r in range(md.ROWS)] for f in frames]  # right edge over time
    assert down[0] in strip_cols


def test_status_failure_does_not_break_display():
    sent = []
    d = md.MatrixDisplay(sent.append, lambda: 1 / 0, {}, log=lambda s: None, clock=Clock())
    d.step()
    assert sent  # still drew something (icon-only ticker)
