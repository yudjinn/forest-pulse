"""A minimal acoustic renderer for the calibration tests: what one board's 3 mics record while one emitter beeps.

The emitter is a point source at a given distance and bearing from the array. Each mic hears its direct path
(1/r, delayed by a fraction of a sample) and one image-source wall echo, over a noise bed of the committed hall
recording plus synthetic speech. Everything is deterministic for a given seed.

level_db is the direct path's signal-to-noise at 1 m, measured in the sweep's band against the whole noise bed;
at distance d the recording's signal-to-noise is level_db - 20 log10(d).
"""
import math
import wave
from dataclasses import dataclass
from importlib import resources

import numpy as np

from .detect import BOARD_MICS_M, DEFAULT_SPEED_OF_SOUND
from .patterns import Pattern, sweep

HALL = resources.files("forestpulse_sensor").joinpath("data/reference/hall.wav")
VOWELS = ((730, 1090, 2440), (270, 2290, 3010), (300, 870, 2240), (530, 1840, 2480), (570, 840, 2410),
          (660, 1720, 2410), (440, 1020, 2240))  # formants of a, i, u, e, o, ae, uh (Hz)


@dataclass
class Rendering:
    audio: np.ndarray      # (N, 3) int16
    fs: int
    arrivals: np.ndarray   # (beeps, 3): where each beep's direct path starts at each mic, samples
    snr_db: float          # the direct path's in-band signal-to-noise at the array

    @property
    def positions(self) -> np.ndarray:
        """Each beep's true position as detection reports it: the mean over the mics."""
        return self.arrivals.mean(axis=1)

    def write(self, path, channels: int = 3) -> None:
        write_wav(path, self.audio[:, :channels], self.fs)


def write_wav(path, audio, fs: int) -> None:
    audio = np.asarray(audio, np.int16).reshape(len(audio), -1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(audio.shape[1])
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(audio.tobytes())


def render(beeps, distance_m: float, level_db: float, *, fs: int = 48000, duration_s: float | None = None,
           bearing_deg: float = 30.0, echo_delay_ms: float = 2.0, echo_gain: float = 0.7,
           echo_bearing_deg: float | None = None, speech_db: float = 0.0, mic_positions_m=BOARD_MICS_M,
           speed_of_sound: float = DEFAULT_SPEED_OF_SOUND, seed: int = 0) -> Rendering:
    """beeps: (emit_at_s, Pattern) pairs, the times the emitter starts each sweep.

    bearing_deg: the emitter's direction from the array, counter-clockwise from the board's +x (soc/README.md).
    echo_delay_ms, echo_gain, echo_bearing_deg: the wall echo's delay after the direct path, its amplitude relative
        to the direct path, and the direction it arrives from (default: 90 degrees off the emitter).
    speech_db: the speech's in-band power relative to the hall recording's.
    """
    beeps = [(float(t), Pattern.of(p)) for t, p in beeps]
    if not beeps:
        raise ValueError("render needs at least one beep")
    rng = np.random.default_rng(seed)
    end = max(t + p.duration_ms / 1000 for t, p in beeps) + 0.5
    n = int(round((duration_s or end) * fs))
    mics = np.asarray(mic_positions_m, float)[:, :2]
    mics = mics - mics.mean(axis=0)
    lo = min(p.band_hz[0] for _, p in beeps)
    hi = max(p.band_hz[1] for _, p in beeps)

    hall = _hall(n, fs, rng)
    speech = _speech(n, fs, rng)
    hall_power = _band_power(hall, fs, lo, hi).mean()
    speech_power = _band_power(speech[:, None], fs, lo, hi).mean()
    speech *= math.sqrt(hall_power / speech_power * 10 ** (speech_db / 10))
    noise = hall + _plane_wave(speech, mics, rng.uniform(0, 360), fs, speed_of_sound)
    noise_power = _band_power(noise, fs, lo, hi).mean()

    source = distance_m * _unit(bearing_deg)
    image_bearing = bearing_deg + 90 if echo_bearing_deg is None else echo_bearing_deg
    image = (distance_m + speed_of_sound * echo_delay_ms / 1000) * _unit(image_bearing)
    signal = np.zeros((n, 3))
    arrivals = np.zeros((len(beeps), 3))
    for b, (t, pattern) in enumerate(beeps):
        s = sweep(pattern, fs)
        amp_1m = math.sqrt(noise_power / _band_power(s[:, None], fs, *pattern.band_hz)[0]) * 10 ** (level_db / 20)
        for m in range(3):
            r = float(np.linalg.norm(source - mics[m]))
            r_echo = float(np.linalg.norm(image - mics[m]))
            arrivals[b, m] = t * fs + r / speed_of_sound * fs
            _add_delayed(signal[:, m], s, arrivals[b, m], amp_1m / r)
            _add_delayed(signal[:, m], s, t * fs + r_echo / speed_of_sound * fs, echo_gain * amp_1m / distance_m)

    mix = noise + signal
    peak = np.abs(mix).max()
    if peak > 32000:  # scale the whole mix, keeping every ratio
        mix *= 32000 / peak
    return Rendering(audio=np.round(mix).astype(np.int16), fs=fs, arrivals=arrivals,
                     snr_db=level_db - 20 * math.log10(distance_m))


def _unit(deg):
    return np.array([math.cos(math.radians(deg)), math.sin(math.radians(deg))])


def _hall(n, fs, rng):
    with wave.open(str(HALL)) as w:
        if w.getframerate() != fs:
            raise ValueError(f"the hall recording is {w.getframerate()} Hz; render at that rate")
        hall = np.frombuffer(w.readframes(w.getnframes()), np.int16).reshape(-1, w.getnchannels()).astype(float)
    loop = np.concatenate([hall, hall[::-1]])  # mirrored, so the loop has no jump
    start = int(rng.integers(len(loop)))
    return np.resize(np.roll(loop, -start, axis=0), (n, hall.shape[1]))


def _speech(n, fs, rng):
    """Talker-like noise: voiced syllables (pitch pulses through vowel formants), fricatives and pauses."""
    out = np.zeros(n)
    f0 = rng.uniform(100, 200)
    i = 0
    while i < n:
        if rng.random() < 0.2:
            i += int(rng.uniform(0.1, 0.4) * fs)
            continue
        if rng.random() < 0.35:  # a fricative onset, broadband hiss shaped by its band
            length = int(rng.uniform(0.05, 0.12) * fs)
            band = (2000, 5000) if rng.random() < 0.5 else (4000, 9000)
            hiss = _band_limit(rng.standard_normal(length), fs, *band) * np.hanning(length)
            seg = out[i:i + length]
            seg += 0.3 * hiss[:len(seg)]
            i += length
        length = int(rng.uniform(0.12, 0.3) * fs)
        pitch = f0 * rng.uniform(0.85, 1.15) * np.linspace(1, rng.uniform(0.85, 1.15), length)
        phase = np.cumsum(pitch) / fs
        pulses = np.diff(np.floor(phase), prepend=0.0)
        spec = np.fft.rfft(pulses)
        f = np.fft.rfftfreq(length, 1 / fs)
        shape = np.ones(len(f))
        for formant, bw in zip(VOWELS[rng.integers(len(VOWELS))], (80, 100, 120)):
            shape *= formant ** 2 / np.sqrt((formant ** 2 - f ** 2) ** 2 + (f * bw) ** 2)
        shape /= np.maximum(1.0, f / 500)  # glottal roll-off
        voiced = np.fft.irfft(spec * shape, length) * np.hanning(length) * rng.uniform(0.5, 1.0)
        seg = out[i:i + length]
        seg += voiced[:len(seg)]
        i += length
    return out


def _plane_wave(mono, mics, bearing_deg, fs, c):
    """A far source: each mic hears `mono` shifted by its own fraction of a sample."""
    spec = np.fft.rfft(mono)
    f = np.fft.rfftfreq(len(mono), 1 / fs)
    u = _unit(bearing_deg)
    return np.stack([np.fft.irfft(spec * np.exp(2j * np.pi * f * (mic @ u) / c), len(mono)) for mic in mics], axis=1)


def _add_delayed(track, s, start, gain, pad=64):
    """Adds gain * s to track, starting at the fractional sample `start`."""
    i0 = int(math.floor(start)) - pad
    length = len(s) + 2 * pad
    spec = np.fft.rfft(s, length)
    f = np.fft.rfftfreq(length)
    shifted = np.fft.irfft(spec * np.exp(-2j * np.pi * f * (start - i0)), length) * gain
    lo, hi = max(0, i0), min(len(track), i0 + length)
    if lo < hi:
        track[lo:hi] += shifted[lo - i0:hi - i0]


def _band_limit(x, fs, lo, hi):
    spec = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(len(x), 1 / fs)
    spec[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(spec, len(x), axis=0)


def _band_power(x, fs, lo, hi):
    """Mean power per column within [lo, hi] Hz."""
    return (_band_limit(x, fs, lo, hi) ** 2).mean(axis=0)
