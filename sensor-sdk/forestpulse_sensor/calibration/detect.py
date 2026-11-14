"""Finds calibration beeps in a 3-mic recording: which role's sweep, where its first path starts, and how clearly.

Per mic, the recording is matched against each role's sweep with a phase-weighted (PHAT-style) matched filter:
the sweep's own magnitude spectrum is flattened, so only its phase is matched, over its band with a tapered edge.
The output's envelope peaks where a copy of the sweep starts. Echoes come later than the direct sound, so the
arrival is the first path: the earliest point within 15 ms before the main peak where the envelope reaches 0.3 of
the peak and stands 10 dB above the noise, timed to a fraction of a sample on the output's carrier. A beep's
position is the mean of the mics' arrivals, in the caller's stream coordinates.

The recording itself is not whitened. Whitening it by its own spectrum (classic PHAT) turns a wall echo on a
loud beep into a false lobe one echo delay before the direct path, taken for the first path; whitening by the
noise's spectrum bends the arrival by a fifth of a sample. Talk is rejected instead by its shape: it matches a
sweep loosely over tens of milliseconds, while a beep's first path rises out of quiet.
"""
import math
from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from .patterns import Pattern, parse_patterns, sweep

# The receiver board's nominal mic positions in its own frame, metres (soc/README.md, "Array geometry").
BOARD_MICS_M = ((-0.04, 0.0), (0.0, 0.0), (0.0, -0.06))
DEFAULT_SPEED_OF_SOUND = 343.0
DEFAULT_MIN_SNR_DB = 12.0       # a mic counts a beep as found from this matched signal-to-noise
FIRST_PATH_WINDOW_MS = 15.0     # how far before the main peak the first path is looked for
FIRST_PATH_FRACTION = 0.3       # of the main peak
FIRST_PATH_ABOVE_NOISE_DB = 10.0
SPACING_SLACK_SAMPLES = 3.0     # mic-to-mic differences beyond the array's spacing by more than this are weak
SMOOTH_HZ = 50.0                # spectral smoothing of the sweep's magnitude
QUIET_BEFORE_MS = 10.0          # a first path rises out of quiet: no crossing this long before it


@dataclass(frozen=True)
class Detection:
    """One beep heard by the array.

    position: where the sweep's first path starts, in samples of the caller's stream (offset + index), the mean of
        the mics that found it, with a fraction of a sample.
    arrivals: the same per mic, None where that mic did not find the beep.
    snr_db: matched signal-to-noise, the mean over the mics that found it.
    weak: a mic missed it, or the mics disagree by more than the array's spacing allows; never range on it.
        A sound only one mic matched is not reported at all.
    weak_reason: "mic_missed", "spacing" or None.
    """
    role: str
    position: float
    snr_db: float
    weak: bool
    arrivals: tuple
    weak_reason: str | None = None


def max_offset_samples(mic_positions_m, fs: float, speed_of_sound: float = DEFAULT_SPEED_OF_SOUND) -> float:
    """The largest mic-to-mic arrival difference the array's geometry allows, in samples."""
    mics = np.asarray(mic_positions_m, float)
    spacing = max(float(np.linalg.norm(a - b)) for a in mics for b in mics)
    return spacing / speed_of_sound * fs


def detect(audio, patterns: Mapping, fs: int, *, mic_positions_m=BOARD_MICS_M,
           speed_of_sound: float = DEFAULT_SPEED_OF_SOUND, offset: float = 0, min_snr_db: float = DEFAULT_MIN_SNR_DB,
           min_separation_ms: float = 250.0) -> list[Detection]:
    """Every beep of every role in a 3-channel recording, sorted by position.

    audio: (N, 3) int16 or float, one column per mic, in the order of mic_positions_m.
    patterns: role -> Pattern (or anything Pattern.of() accepts), e.g. DEFAULT_PATTERNS or the run's patterns.
    offset: the stream position of audio[0]; positions are reported as offset + index.
    min_separation_ms: beeps of one role closer than this are taken as one (the strongest).
    Raises ValueError when the audio is not 3-channel.
    """
    x = np.asarray(audio)
    if x.ndim != 2 or x.shape[1] != 3:
        raise ValueError(f"needs 3 channels, got {1 if x.ndim == 1 else x.shape[-1]}")
    x = x.astype(np.float64)
    patterns = parse_patterns(patterns)
    n = len(x)
    if n == 0:
        return []
    longest = max(len(sweep(p, fs)) for p in patterns.values())
    nfft = _fast_len(n + longest)
    spectrum = np.fft.rfft(x, nfft, axis=0)
    width = max(1, int(round(SMOOTH_HZ * nfft / fs)))
    allowance = max_offset_samples(mic_positions_m, fs, speed_of_sound) + SPACING_SLACK_SAMPLES

    found = []
    for role, pattern in patterns.items():
        out = _matched(spectrum, pattern, fs, nfft, n, width)
        found += _beeps(out, role, pattern, fs, min_snr_db, min_separation_ms, allowance, offset)

    # one beep can show faintly in another role's filter: where two overlap, keep the whole one, then the stronger
    found.sort(key=lambda d: (d.weak, -d.snr_db))
    span = max(p.duration_ms for p in patterns.values()) * fs / 1000
    keep = []
    for d in found:
        if all(abs(d.position - k.position) > span for k in keep):
            keep.append(d)
    return sorted(keep, key=lambda d: d.position)


def _matched(spectrum, pattern: Pattern, fs, nfft, n, width):
    """The phase-weighted matched filter's analytic output per mic, (n, 3) complex; index = where the sweep would
    start. Its magnitude is the envelope, its real part the carrier, both peaking where a copy of the sweep starts."""
    template = np.fft.rfft(sweep(pattern, fs), nfft)
    t_weight = 1.0 / (_smooth(np.abs(template), width) + 1e-12)
    freqs = np.fft.rfftfreq(nfft, 1 / fs)
    lo, hi = pattern.band_hz
    band = np.zeros(len(freqs))
    inside = (freqs >= lo) & (freqs <= hi)
    band[inside] = np.hanning(inside.sum() + 2)[1:-1]  # tapered, so an echo's skirt does not bend the direct peak
    cross = spectrum * (np.conj(template) * t_weight * band)[:, None]
    analytic = np.zeros((nfft, 3), complex)
    analytic[:len(freqs)] = 2 * cross
    return np.fft.ifft(analytic, axis=0)[:n]


def _beeps(out, role, pattern, fs, min_snr_db, min_separation_ms, allowance, offset):
    env = np.abs(out)
    n = len(env)
    period = fs / (sum(pattern.band_hz) / 2)
    dur = len(sweep(pattern, fs))
    first_window = int(round(FIRST_PATH_WINDOW_MS * fs / 1000))
    quiet_before = int(round(QUIET_BEFORE_MS * fs / 1000))
    noise = np.median(env, axis=0)
    combined = (env / noise).mean(axis=1)
    peaks = _peaks(combined, 10 ** (min_snr_db / 20), int(round(min_separation_ms * fs / 1000)))
    if not peaks:
        return []
    # the noise floor outside the beeps
    quiet = np.ones(n, bool)
    for k in peaks:
        quiet[max(0, k - dur - first_window):k + dur] = False
    if quiet.sum() > n // 10:
        noise = np.median(env[quiet], axis=0)

    reach = int(math.ceil(allowance)) + int(round(0.002 * fs))
    found = []
    for k in peaks:
        arrivals, snrs = [], []
        for m in range(3):
            e = env[:, m]
            lo, hi = max(0, k - reach), min(n, k + reach + 1)
            main = lo + int(np.argmax(e[lo:hi]))
            snr = 20 * math.log10(e[main] / noise[m])
            arrival = _first_path(out[:, m], main, noise[m], first_window, quiet_before, period) \
                if snr >= min_snr_db else None
            arrivals.append(None if arrival is None else offset + arrival)
            if arrival is not None:
                snrs.append(snr)
        heard = [a for a in arrivals if a is not None]
        if len(heard) < 2:  # one mic alone is a click or a bump, not a beep
            continue
        reason = None
        if len(heard) < 3:
            reason = "mic_missed"
        elif max(heard) - min(heard) > allowance:
            reason = "spacing"
        found.append(Detection(role=role, position=float(np.mean(heard)), snr_db=float(np.mean(snrs)),
                             weak=reason is not None, arrivals=tuple(arrivals), weak_reason=reason))
    return found


def _first_path(out, main, noise, window, quiet_before, period):
    """Sub-sample start of the first path at or before the main peak at index `main`, or None when the envelope
    does not rise out of quiet (it already crossed the level within quiet_before samples of that point), which is
    how talk and other tonal sound looks: it matches a sweep loosely, over tens of milliseconds.

    The envelope finds the first path's lobe; the carrier's crest nearest the lobe's top gives its time. The
    envelope's own top is broad (the band is narrow next to its frequency), so a later echo's skirt would bend it
    by a sample or more; the carrier's crest is several times sharper."""
    e = np.abs(out)
    start = max(0, main - window)
    level = max(FIRST_PATH_FRACTION * e[main], noise * 10 ** (FIRST_PATH_ABOVE_NOISE_DB / 20))
    j = start + int(np.argmax(e[start:main + 1] >= level))
    if (e[max(0, j - quiet_before):j] >= level).any() or j - quiet_before < 0:
        return None
    while j < main and e[j + 1] >= e[j]:  # climb to the top of that lobe
        j += 1
    half = int(period // 2)
    lo, hi = max(1, j - half), min(len(out) - 1, j + half + 1)
    if lo >= hi:
        return float(j)
    carrier = out.real
    k = lo + int(np.argmax(carrier[lo:hi]))
    if 0 < k < len(out) - 1:
        a, b, c = carrier[k - 1], carrier[k], carrier[k + 1]
        denom = a - 2 * b + c
        if denom < 0:
            return k + 0.5 * (a - c) / denom
    return float(k)


def _peaks(s, threshold, separation):
    """Indices of the strongest local maxima above threshold, no two closer than separation."""
    if len(s) < 3:
        return []
    inner = s[1:-1]
    cand = np.flatnonzero((inner > s[:-2]) & (inner >= s[2:]) & (inner >= threshold)) + 1
    chosen = []
    for k in cand[np.argsort(-s[cand])]:
        if all(abs(int(k) - c) >= separation for c in chosen):
            chosen.append(int(k))
    return sorted(chosen)


def _smooth(a, width):
    """Moving average along axis 0 over `width` bins."""
    pad = width // 2
    padded = np.concatenate([np.repeat(a[:1], pad, axis=0), a, np.repeat(a[-1:], width - pad, axis=0)])
    c = np.cumsum(padded, axis=0)
    return (c[width:width + len(a)] - c[:len(a)]) / width


def _fast_len(n):
    """The smallest 2^a 3^b 5^c at least n, which numpy's FFT handles quickly."""
    best = 1 << max(0, (n - 1).bit_length())
    p5 = 1
    while p5 < best:
        p35 = p5
        while p35 < best:
            p = p35
            while p < n:
                p *= 2
            best = min(best, p)
            p35 *= 3
        p5 *= 5
    return best
