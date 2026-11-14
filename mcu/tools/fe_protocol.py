"""Packet parser and event assembler for the front-end USB stream.

Wire format (little-endian): magic AA 55 | type u8 | flags u8 | sample_rate u32 |
seq u32 | frame_count u16 | pcm int16[3*N] | crc32 u32 (over header + pcm).
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field

import numpy as np

MAGIC = b"\xaa\x55"
HEADER = struct.Struct("<2sBBIIH")
HEADER_BYTES = HEADER.size  # 14
CRC_BYTES = 4
MAX_FRAMES = 679

PRE, LIVE, END = 0x01, 0x02, 0x03
FLAG_OVERRUN = 0x01


@dataclass
class Packet:
    msg_type: int
    flags: int
    sample_rate: int
    seq: int
    pcm: np.ndarray  # (N, 3) int16


@dataclass
class Event:
    sample_rate: int = 0
    pre: list[np.ndarray] = field(default_factory=list)
    live: list[np.ndarray] = field(default_factory=list)
    seqs: list[int] = field(default_factory=list)
    flags: list[int] = field(default_factory=list)
    ended: bool = False

    @property
    def pre_frames(self) -> int:
        return sum(len(p) for p in self.pre)

    @property
    def live_frames(self) -> int:
        return sum(len(p) for p in self.live)

    @property
    def overrun(self) -> bool:
        return any(f & FLAG_OVERRUN for f in self.flags)

    def audio(self) -> np.ndarray:
        parts = self.pre + self.live
        return np.concatenate(parts) if parts else np.zeros((0, 3), np.int16)


class Parser:
    """Incremental parser: feed() raw bytes, get complete valid packets.

    Resynchronises on the magic word; bytes that are not part of a valid
    packet (boot text, INFO lines, truncated packets) are counted and skipped.
    """

    def __init__(self) -> None:
        self.buf = bytearray()
        self.crc_errors = 0
        self.junk_bytes = 0
        self._text = bytearray()
        self.lines: list[str] = []  # ASCII replies (INFO/RAW) found between packets

    def _skip(self, n: int) -> None:
        """Drop n leading bytes that are not packet data; keep any ASCII text."""
        self.junk_bytes += n
        self._text += self.buf[:n]
        del self.buf[:n]
        while (j := self._text.find(b"\n")) >= 0:
            line = self._text[:j].decode(errors="replace").strip()
            del self._text[: j + 1]
            k = max(line.find("INFO "), line.find("RAW "))
            if k >= 0:
                self.lines.append(line[k:])
        if len(self._text) > 4096:
            del self._text[:-1024]

    def feed(self, data: bytes) -> list[Packet]:
        self.buf += data
        out: list[Packet] = []
        while True:
            i = self.buf.find(MAGIC)
            if i < 0:
                keep = 1 if self.buf.endswith(MAGIC[:1]) else 0
                self._skip(len(self.buf) - keep)
                return out
            if i:
                self._skip(i)
            if len(self.buf) < HEADER_BYTES:
                return out
            _, mtype, flags, rate, seq, n = HEADER.unpack_from(self.buf)
            if mtype not in (PRE, LIVE, END) or n > MAX_FRAMES:
                self.junk_bytes += 1
                del self.buf[:1]
                continue
            total = HEADER_BYTES + 6 * n + CRC_BYTES
            if len(self.buf) < total:
                return out
            body = bytes(self.buf[: total - CRC_BYTES])
            (crc,) = struct.unpack_from("<I", self.buf, total - CRC_BYTES)
            if zlib.crc32(body) != crc:
                self.crc_errors += 1
                del self.buf[:1]
                continue
            pcm = np.frombuffer(body[HEADER_BYTES:], dtype="<i2").reshape(-1, 3)
            out.append(Packet(mtype, flags, rate, seq, pcm))
            del self.buf[:total]


class Assembler:
    """Groups packets into events: PRE* LIVE* END."""

    def __init__(self) -> None:
        self.current: Event | None = None
        self.done: list[Event] = []
        self.all_seqs: list[int] = []

    def add(self, p: Packet) -> Event | None:
        self.all_seqs.append(p.seq)
        if self.current is None:
            self.current = Event(sample_rate=p.sample_rate)
        ev = self.current
        ev.seqs.append(p.seq)
        ev.flags.append(p.flags)
        if p.msg_type == PRE:
            ev.pre.append(p.pcm)
        elif p.msg_type == LIVE:
            ev.live.append(p.pcm)
        else:
            ev.ended = True
            self.done.append(ev)
            self.current = None
            return ev
        return None


def seq_gaps(seqs: list[int]) -> int:
    return sum(1 for a, b in zip(seqs, seqs[1:]) if (b - a) & 0xFFFFFFFF != 1)


def synth_frame_index(audio: np.ndarray) -> np.ndarray:
    """Recover the frame index the synthetic source embeds in channels 1/2."""
    lo = audio[:, 1].astype(np.uint16).astype(np.uint32)
    hi = audio[:, 2].astype(np.uint16).astype(np.uint32)
    return lo | (hi << 16)


def write_wav(path: str, ev: Event) -> None:
    import wave

    with wave.open(path, "wb") as w:
        w.setnchannels(3)
        w.setsampwidth(2)
        w.setframerate(ev.sample_rate)
        w.writeframes(ev.audio().astype("<i2").tobytes())
