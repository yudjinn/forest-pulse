"""Direction of arrival (bearing) from the 3-mic array: GCC-PHAT + SRP-PHAT.

Board frame (see soc/README.md section 3): +x from mic1 toward mic2 along the
top of the board, +y toward the top edge. Bearing theta is measured in the
board plane, counter-clockwise from +x; u(theta) = (cos theta, sin theta)
points FROM the array TOWARD the source.

Model (far field): a source in direction u reaches mic i at
    t_i(theta) = -(r_i . u) / c       (mics closer to the source hear it first)
so mic spectra are X_i(f) = S(f) exp(-j 2 pi f t_i). The PHAT-weighted
cross-spectrum of pair (i, j) is G_ij = X_i X_j* / |X_i X_j*| = exp(-j 2 pi f
(t_i - t_j)). SRP-PHAT scores each candidate theta by re-aligning:
    P(theta) = sum_pairs sum_f Re{ G_ij(f) exp(+j 2 pi f (t_i - t_j)(theta)) }
which peaks at the true direction. Fractional delays are exact (frequency
domain), so no interpolation is needed.

numpy only - runs on the Uno Q and on a laptop.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

SPEED_OF_SOUND = 343.0  # m/s at ~20 C; c = 331.3 + 0.606 * T_celsius
PAIRS = ((0, 1), (0, 2), (1, 2))


@dataclass
class Geometry:
    """Mic positions in metres, board frame, rows = mic1..mic3."""

    positions: np.ndarray  # (3, 2)

    @classmethod
    def from_cm(cls, pts_cm) -> "Geometry":
        return cls(np.asarray(pts_cm, dtype=np.float64) / 100.0)

    def max_delay_s(self, i: int, j: int, c: float = SPEED_OF_SOUND) -> float:
        return float(np.linalg.norm(self.positions[i] - self.positions[j])) / c


# Nominal geometry (right triangle, right angle at mic2). Replace with
# caliper-measured sound-port positions (config.json "mic_positions_cm").
NOMINAL = Geometry.from_cm([[-4.0, 0.0], [0.0, 0.0], [0.0, -6.0]])


@dataclass
class WindowResult:
    t_s: float            # window centre, seconds from the start of the audio given
    bearing_deg: float    # board frame, 0..360
    peak_ratio: float     # SRP peak / median over all directions (>1; higher = sharper)
    closure_samples: float  # |tau12 + tau23 - tau13| in samples (single source -> ~0)
    taus_samples: tuple   # GCC-PHAT delays (tau12, tau13, tau23), samples
    level_dbfs: float     # window RMS (mean of mics)


@dataclass
class Summary:
    bearing_deg: float | None
    spread_deg: float | None
    confidence: float
    n_windows: int
    windows: list = field(default_factory=list)


class BearingEstimator:
    def __init__(
        self,
        geometry: Geometry = NOMINAL,
        fs: int = 48000,
        nfft: int = 4096,
        band_hz: tuple[float, float] = (200.0, 8000.0),
        grid_step_deg: float = 1.0,
        c: float = SPEED_OF_SOUND,
    ):
        self.g = geometry
        self.fs = fs
        self.nfft = nfft
        freqs = np.fft.rfftfreq(nfft, 1.0 / fs)
        self.band = (freqs >= band_hz[0]) & (freqs <= band_hz[1])
        self.f = freqs[self.band]
        self.window = np.hanning(nfft)
        self.grid_deg = np.arange(0.0, 360.0, grid_step_deg)
        self.c = None
        self.set_speed_of_sound(c)

    def set_speed_of_sound(self, c: float) -> None:
        """Rebuild the steering tables for speed of sound c (m/s). Cheap to
        skip when c barely changed: 0.2 m/s is ~0.06% of the delays."""
        if self.c is not None and abs(c - self.c) < 0.2:
            return
        self.c = c
        th = np.deg2rad(self.grid_deg)
        u = np.stack([np.cos(th), np.sin(th)], axis=1)        # (G, 2)
        t = -(u @ self.g.positions.T) / c                     # (G, 3) arrival time per mic
        # Steering for each pair: exp(+j 2 pi f (t_i - t_j)), shape (P, G, F)
        dt = np.stack([t[:, i] - t[:, j] for i, j in PAIRS])  # (P, G)
        self.steer = np.exp(2j * np.pi * dt[:, :, None] * self.f[None, None, :]).astype(np.complex64)
        self.max_lag = [self.g.max_delay_s(i, j, c) * self.fs for i, j in PAIRS]

    # ---- core ----------------------------------------------------------------

    def _phat_cross(self, x: np.ndarray) -> np.ndarray:
        """Welch-averaged PHAT cross-spectra over the window. x: (n, 3) float."""
        hop = self.nfft // 2
        frames = max(1, 1 + (len(x) - self.nfft) // hop)
        acc = np.zeros((len(PAIRS), int(self.band.sum())), dtype=np.complex128)
        for k in range(frames):
            seg = x[k * hop : k * hop + self.nfft]
            if len(seg) < self.nfft:
                seg = np.pad(seg, ((0, self.nfft - len(seg)), (0, 0)))
            X = np.fft.rfft(seg * self.window[:, None], axis=0)[self.band]  # (F, 3)
            for p, (i, j) in enumerate(PAIRS):
                acc[p] += X[:, i] * np.conj(X[:, j])
        return acc / (np.abs(acc) + 1e-20)  # PHAT on the averaged cross-spectrum

    def _gcc_taus(self, G: np.ndarray) -> tuple:
        """Per-pair delay (samples) from the PHAT cross-spectrum, fractional via
        a fine lag grid evaluated directly in the frequency domain."""
        taus = []
        for p in range(len(PAIRS)):
            m = self.max_lag[p] + 1.0
            lags = np.arange(-m, m + 1e-9, 0.05)  # 0.05-sample resolution
            # R(tau) = Re sum_f G(f) exp(+j 2 pi f tau / fs); G = exp(-j 2 pi f (t_i - t_j))
            R = np.real(np.exp(2j * np.pi * np.outer(lags / self.fs, self.f)) @ G[p])
            taus.append(float(lags[int(np.argmax(R))]))
        return tuple(taus)

    def analyse_window(self, x: np.ndarray, t_s: float = 0.0) -> WindowResult:
        x = np.asarray(x, dtype=np.float64)
        x = x - x.mean(axis=0)
        G = self._phat_cross(x)
        P = np.real(np.einsum("pgf,pf->g", self.steer, G.astype(np.complex64)))
        k = int(np.argmax(P))
        med = float(np.median(np.abs(P))) + 1e-12
        taus = self._gcc_taus(G)
        # Delays here are t_i - t_j: tau12 + tau23 = tau13 for a single source.
        closure = abs(taus[0] + taus[2] - taus[1])
        level = float(np.sqrt(np.mean(x**2))) / 32768.0
        return WindowResult(
            t_s=t_s,
            bearing_deg=float(self.grid_deg[k]),
            peak_ratio=float(P[k]) / med,
            closure_samples=closure,
            taus_samples=taus,
            level_dbfs=20 * math.log10(max(level, 1e-9)),
        )

    def series(self, audio: np.ndarray, win_s: float = 0.5, hop_s: float = 0.25, t0_s: float = 0.0) -> list:
        n, h = int(win_s * self.fs), int(hop_s * self.fs)
        out = []
        for start in range(0, max(1, len(audio) - n + 1), h):
            out.append(self.analyse_window(audio[start : start + n], t0_s + (start + n / 2) / self.fs))
        return out

    # ---- aggregation ---------------------------------------------------------

    @staticmethod
    def accept(w: WindowResult, background_dbfs: float | None, min_snr_db: float = 6.0,
               min_peak_ratio: float = 3.0, max_closure: float = 1.0) -> bool:
        """Quality gate for one window: loud enough above the event's own
        pre-trigger background, sharp SRP peak, consistent pair delays."""
        if background_dbfs is not None and w.level_dbfs < background_dbfs + min_snr_db:
            return False
        return w.peak_ratio >= min_peak_ratio and w.closure_samples <= max_closure

    @staticmethod
    def summarize(windows: list, accepted: list, min_windows: int = 1) -> Summary:
        """Weighted circular mean of accepted windows. Confidence combines
        how many windows passed and how tightly they agree. Fewer than
        `min_windows` accepted windows -> no bearing (a couple of lucky
        windows in diffuse noise must not produce a direction)."""
        if len(accepted) < max(1, min_windows):
            return Summary(None, None, 0.0, 0, windows)
        th = np.deg2rad([w.bearing_deg for w in accepted])
        wts = np.array([w.peak_ratio for w in accepted])
        C, S = np.sum(wts * np.cos(th)), np.sum(wts * np.sin(th))
        R = math.hypot(C, S) / wts.sum()  # mean resultant length, 0..1
        mean = math.degrees(math.atan2(S, C)) % 360.0
        spread = math.degrees(math.sqrt(max(0.0, -2.0 * math.log(max(R, 1e-9)))))  # circular std
        coverage = min(1.0, len(accepted) / 4.0)  # >= 4 good windows = full credit
        return Summary(mean, spread, round(R * coverage, 3), len(accepted), windows)
