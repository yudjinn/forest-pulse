"""Linux (SoC) side: listen to the atech ESP32 over USB serial.

The TTY is opened by the `serial-bridge` container (see
bricks/serial_bridge/brick_compose.yaml). This script connects to it over TCP,
parses the ESP32's binary audio packets (atech_protocol.py), tracks events and
prints a readable summary to the console. Reply lines (INFO ..., RAW ...) are
printed as they come. It reconnects if the bridge restarts or the cable is
pulled.

Commands to the ESP32 are single bytes: I (info), T (force event),
C / X (start / stop continuous event). Use send_command("I") etc.
"""

import math
import os
import socket
import threading
import time

from arduino.app_utils import App, Bridge

from atech_protocol import (
    EVENT_END,
    FLAG_RING_OVERRUN,
    FLAG_SYNC_LOSS,
    LIVE,
    PRE_TRIGGER,
    StreamParser,
)

BRIDGE_HOST = os.environ.get("SERIAL_BRIDGE_HOST", "serial-bridge")
BRIDGE_PORT = int(os.environ.get("SERIAL_BRIDGE_PORT", "5000"))
FORWARD_TO_MCU = True      # send event start/end and INFO lines to the sketch
RETRY_SECONDS = 2
RECV_BYTES = 65536         # protocol asks for reads of 64 KB or more
INFO_RETRY_SECONDS = 1.0   # after connecting, send I until an INFO line arrives
INFO_MAX_TRIES = 15
PRE_TRIGGER_FRAMES = 192_000  # trigger is at this frame of every event

_sock = None
_sock_lock = threading.Lock()

# ESP32 trigger line on header pin D7, reported by the sketch on every edge.
_trigger_lock = threading.Lock()
_trigger_state = None     # last reported level (0/1), None until first report
_trigger_rise = None      # monotonic time of the last rising edge
_trigger_rise_unused = False  # rise not yet matched to an event start


def dbfs(peak: int) -> str:
    if peak <= 0:
        return "  -inf"
    return f"{20 * math.log10(peak / 32768):6.1f}"


def notify_mcu(text: str) -> None:
    if not FORWARD_TO_MCU:
        return
    try:
        Bridge.notify("serial_event", text)
    except Exception as e:  # MCU not ready yet, router busy, etc.
        print(f"[bridge] notify failed: {e}", flush=True)


def on_audio(packet, mics, break_before: bool, frame_offset: int) -> None:
    """Called for every audio packet (pre-trigger and live).

    mics: (mic1, mic2, mic3) as array('h'); frame_offset: index of this
    packet's first frame within the event (trigger is at 192000).
    break_before: True if audio before this packet is not contiguous with it
    (seq gap or overrun/sync-loss flag) - don't run bearing estimation across
    it. Put your processing here.
    """


class EventTracker:
    """Follows the pre-trigger / live / end sequence and prints summaries."""

    def __init__(self):
        self.last_seq = None
        self.in_event = False
        self._reset()

    def _reset(self):
        self.frames = 0
        self.packets = 0
        self.breaks = 0
        self.peaks = [0, 0, 0]       # whole event
        self.win_peaks = [0, 0, 0]   # current 1-second window
        self.win_start = 0
        self.rate = 48000
        self.last_type = None

    def on_packet(self, p) -> None:
        brk = False
        if self.last_seq is not None and p.seq_num != (self.last_seq + 1) & 0xFFFFFFFF:
            brk = True
            missing = (p.seq_num - self.last_seq - 1) & 0xFFFFFFFF
            if self.in_event:
                print(f"[atech] seq gap: {missing} packet(s) missing before #{p.seq_num}", flush=True)
        if p.flags:
            brk = True
            what = []
            if p.flags & FLAG_RING_OVERRUN:
                what.append("ring overrun")
            if p.flags & FLAG_SYNC_LOSS:
                what.append("capture sync loss")
            print(f"[atech] packet #{p.seq_num}: {', '.join(what) or hex(p.flags)}", flush=True)
        self.last_seq = p.seq_num

        if p.msg_type == EVENT_END:
            if self.in_event:
                self._end(p)
            return

        if not self.in_event:
            self._start(p)
        elif brk:
            self.breaks += 1
        if p.msg_type == LIVE and self.last_type == PRE_TRIGGER and self.frames > self.win_start:
            self._print_window()  # close the pre-trigger window at the trigger
        self.last_type = p.msg_type

        mics = p.channels()
        on_audio(p, mics, brk, self.frames)
        for i, m in enumerate(mics):
            if len(m):
                pk = max(max(m), -min(m))
                if pk > self.win_peaks[i]:
                    self.win_peaks[i] = pk
                if pk > self.peaks[i]:
                    self.peaks[i] = pk
        self.frames += p.frame_count
        self.packets += 1
        self.rate = p.sample_rate or self.rate
        if self.frames - self.win_start >= self.rate:
            self._print_window()

    def _t(self, frame: int) -> float:
        return (frame - PRE_TRIGGER_FRAMES) / self.rate

    def _print_window(self):
        phase = "pre " if self.last_type == PRE_TRIGGER else "live"
        a, b, c = (dbfs(x) for x in self.win_peaks)
        print(
            f"[atech] {phase} t={self._t(self.win_start):+6.2f}..{self._t(self.frames):+6.2f}s "
            f"peak dBFS mic1 {a} mic2 {b} mic3 {c}",
            flush=True,
        )
        self.win_peaks = [0, 0, 0]
        self.win_start = self.frames

    def _start(self, p):
        global _trigger_rise_unused
        self._reset()
        self.in_event = True
        joined = "" if p.msg_type == PRE_TRIGGER else " (joined mid-event, live audio only)"
        with _trigger_lock:
            if _trigger_rise_unused:
                pin = f", D7 rose {time.monotonic() - _trigger_rise:.3f}s before first packet"
                _trigger_rise_unused = False
            elif _trigger_state is None:
                pin = ", D7 state unknown yet"
            else:
                pin = f", no D7 rise before it (D7 is {'HIGH' if _trigger_state else 'LOW'})"
        print(f"[atech] === event start, packet #{p.seq_num}{joined}{pin}", flush=True)
        notify_mcu(f"EVENT_START seq={p.seq_num}")

    def _end(self, p):
        if self.frames > self.win_start:
            self._print_window()
        live_s = max(0, self.frames - PRE_TRIGGER_FRAMES) / self.rate
        a, b, c = (dbfs(x) for x in self.peaks)
        print(
            f"[atech] === event end, packet #{p.seq_num}: {self.packets} packets, "
            f"{self.frames} frames ({self.frames / self.rate:.2f}s, {live_s:.2f}s after trigger), "
            f"{self.breaks} break(s), peak dBFS mic1 {a} mic2 {b} mic3 {c}",
            flush=True,
        )
        notify_mcu(f"EVENT_END seq={p.seq_num} live_s={live_s:.2f} breaks={self.breaks}")
        self.in_event = False


def on_trigger_pin(state) -> None:
    """Called by the sketch (Bridge.notify("trigger_pin", 0/1)) on every D7 edge."""
    global _trigger_state, _trigger_rise, _trigger_rise_unused
    state = 1 if int(state) else 0
    now = time.monotonic()
    with _trigger_lock:
        prev = _trigger_state
        if state == prev:
            return  # periodic resend, no change
        _trigger_state = state
        if prev is None:
            # First report after startup: a level, not an edge.
            msg = f"{'HIGH' if state else 'LOW'} (initial level)"
        elif state:
            _trigger_rise = now
            _trigger_rise_unused = True
            msg = "HIGH (comms about to begin)"
        elif prev == 1 and _trigger_rise is not None:
            msg = f"LOW (was high {now - _trigger_rise:.2f}s)"
        else:
            msg = "LOW"
    print(f"[trigger] D7 {msg}", flush=True)


def send_command(cmd: str) -> bool:
    """Send a single-byte command (I, T, C, X) to the ESP32. False if not connected."""
    with _sock_lock:
        if _sock is None:
            return False
        try:
            _sock.sendall(cmd.encode("ascii"))
            return True
        except OSError:
            return False


def _reader() -> None:
    global _sock
    tracker = EventTracker()
    while True:
        try:
            s = socket.create_connection((BRIDGE_HOST, BRIDGE_PORT), timeout=5)
            s.settimeout(INFO_RETRY_SECONDS)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            with _sock_lock:
                _sock = s
            print(f"[serial] connected to {BRIDGE_HOST}:{BRIDGE_PORT}", flush=True)

            parser = StreamParser()
            got_info = False
            info_tries = 0
            last_info = 0.0
            while True:
                now = time.monotonic()
                if not got_info and info_tries < INFO_MAX_TRIES and now - last_info >= INFO_RETRY_SECONDS:
                    send_command("I")
                    info_tries += 1
                    last_info = now
                    if info_tries == INFO_MAX_TRIES:
                        print("[serial] no INFO reply from the ESP32 yet; still listening", flush=True)
                try:
                    chunk = s.recv(RECV_BYTES)
                except TimeoutError:
                    continue
                if not chunk:
                    raise ConnectionError("bridge closed the connection")
                for kind, item in parser.feed(chunk):
                    if kind == "packet":
                        tracker.on_packet(item)
                    else:
                        print(f"[atech] {item}", flush=True)
                        if item.startswith("INFO"):
                            got_info = True
                            notify_mcu(item[:200])
        except OSError as e:
            print(f"[serial] {e}; retrying in {RETRY_SECONDS}s", flush=True)
        finally:
            with _sock_lock:
                if _sock is not None:
                    try:
                        _sock.close()
                    except OSError:
                        pass
                    _sock = None
        time.sleep(RETRY_SECONDS)


# Let the MCU sketch send single-byte commands to the ESP32 through the SoC.
Bridge.provide("send_to_board", send_command)
# The sketch reports the ESP32 trigger line (D7) here.
Bridge.provide("trigger_pin", on_trigger_pin)

threading.Thread(target=_reader, name="serial-reader", daemon=True).start()
App.run()
