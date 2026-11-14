"""Stream parser for the atech ESP32 serial protocol.

The ESP32 sends binary audio packets over USB CDC, with occasional ASCII reply
lines (INFO ..., RAW ...) between them. Packet layout, all little-endian:

    off  size  field
    0    2     magic 0xAA 0x55
    2    1     msg_type   1 pre-trigger, 2 live, 3 event end
    3    1     flags      bit0 ring overrun, bit1 capture sync loss
    4    4     sample_rate (48000)
    8    4     seq_num    +1 per packet, wraps at 2**32
    12   2     frame_count N (0..679)
    14   6N    pcm        int16[N][3], interleaved mic1, mic2, mic3
    14+6N 4    crc32      zlib.crc32 over bytes 0 .. 13+6N

This module does no I/O, so it can be tested on any machine.
"""

import struct
import sys
import zlib
from array import array
from dataclasses import dataclass

MAGIC = b"\xaa\x55"
HEADER = struct.Struct("<2sBBIIH")  # magic, msg_type, flags, rate, seq, N
HEADER_LEN = HEADER.size            # 14
CRC_LEN = 4
MAX_FRAMES = 679
CHANNELS = 3

PRE_TRIGGER = 0x01
LIVE = 0x02
EVENT_END = 0x03

FLAG_RING_OVERRUN = 0x01
FLAG_SYNC_LOSS = 0x02

MAX_TEXT_BYTES = 4096  # cap on a pending text line (boot noise, junk)


@dataclass
class Packet:
    msg_type: int
    flags: int
    sample_rate: int
    seq_num: int
    frame_count: int
    pcm: bytes  # interleaved int16 LE, frame_count * 3 values

    def channels(self):
        """Return (mic1, mic2, mic3) as array('h') each."""
        a = array("h")
        a.frombytes(self.pcm)
        if sys.byteorder == "big":
            a.byteswap()
        return a[0::3], a[1::3], a[2::3]


def build_packet(msg_type, seq_num, pcm=b"", flags=0, sample_rate=48000):
    """Build a valid packet (for tests)."""
    n = len(pcm) // (2 * CHANNELS)
    body = HEADER.pack(MAGIC, msg_type, flags, sample_rate, seq_num, n) + pcm
    return body + struct.pack("<I", zlib.crc32(body))


class StreamParser:
    """Feed raw bytes in, get ("packet", Packet) and ("text", str) items out."""

    def __init__(self):
        self._buf = bytearray()
        self._line = bytearray()
        self.packets = 0
        self.crc_errors = 0
        self.skipped_bytes = 0

    def feed(self, data):
        self._buf += data
        out = []
        buf = self._buf
        while True:
            i = buf.find(MAGIC)
            if i < 0:
                # No packet start. Keep a trailing 0xAA: it may be half a magic.
                keep = 1 if buf.endswith(b"\xaa") else 0
                self._take_text(len(buf) - keep, out)
                break
            if i > 0:
                self._take_text(i, out)
                continue
            if len(buf) < HEADER_LEN:
                break
            _, msg_type, flags, rate, seq, n = HEADER.unpack_from(buf)
            if not (PRE_TRIGGER <= msg_type <= EVENT_END) or n > MAX_FRAMES:
                self._skip(1)
                continue
            body_end = HEADER_LEN + 6 * n
            total = body_end + CRC_LEN
            if len(buf) < total:
                break
            (crc,) = struct.unpack_from("<I", buf, body_end)
            if zlib.crc32(memoryview(buf)[:body_end]) != crc:
                self.crc_errors += 1
                self._skip(1)
                continue
            pkt = Packet(msg_type, flags, rate, seq, n, bytes(buf[HEADER_LEN:body_end]))
            del buf[:total]
            # Text lines are always complete before a packet; anything left
            # over is resync junk.
            if self._line:
                self.skipped_bytes += len(self._line)
                self._line.clear()
            self.packets += 1
            out.append(("packet", pkt))
        return out

    def _skip(self, k):
        self.skipped_bytes += k
        del self._buf[:k]

    def _take_text(self, k, out):
        if k <= 0:
            return
        self._line += self._buf[:k]
        del self._buf[:k]
        while True:
            j = self._line.find(b"\n")
            if j < 0:
                break
            raw = bytes(self._line[:j]).rstrip(b"\r")
            del self._line[: j + 1]
            # Keep the printable tail: junk can precede a real line (e.g. boot).
            start = 0
            for idx, b in enumerate(raw):
                if not (32 <= b < 127 or b == 9):
                    start = idx + 1
            self.skipped_bytes += start
            if raw[start:]:
                out.append(("text", raw[start:].decode("ascii")))
        if len(self._line) > MAX_TEXT_BYTES:
            self.skipped_bytes += len(self._line)
            self._line.clear()
