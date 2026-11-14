"""Offline replica of main/trigger.c for tuning thresholds on recorded WAVs.

Runs the same 20 ms blocks, Hann window, Goertzel bins (as DFT bins), 100 ms
spectral/level smoothing, 200 ms coherence averaging, noise-floor rules and
state machine as the firmware, and reports per-file feature statistics and
when (if ever) an event would start.

Usage:
  uv run trigger_sim.py events/background_hall.wav events/event_001.wav
  uv run trigger_sim.py --snr 6 --ratio 3 --coh 0.5 FILE...   # try thresholds
  uv run trigger_sim.py --trace FILE                          # per-block table
"""

from __future__ import annotations

import argparse
import math
import wave
from dataclasses import dataclass

import numpy as np

RATE = 48000
BLOCK_MS = 20
N = RATE * BLOCK_MS // 1000  # 960
LOW_HZ = [100, 150, 200, 250, 300, 350, 400]
HIGH_HZ = [1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000]
WIND_HZ = 50
PAIRS = [(0, 1), (0, 2), (1, 2)]


@dataclass
class Params:
    snr_db: float = 6.0
    ratio_db: float = 3.0
    coh_min: float = 0.5
    arm_blocks: int = 5
    cooldown_ms: int = 2000
    max_post_ms: int = 15000
    floor_tau_s: float = 20.0
    floor_long_tau_s: float = 45.0
    spectral_tau_ms: float = 100.0
    coh_tau_ms: float = 200.0
    warmup_ms: int = 2000


def alpha(tau_s: float) -> float:
    return 1.0 - math.exp(-(BLOCK_MS / 1000.0) / tau_s)


def load(path: str) -> np.ndarray:
    with wave.open(path) as w:
        assert w.getframerate() == RATE and w.getnchannels() == 3 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, 3)


def simulate(audio: np.ndarray, p: Params) -> tuple[list[dict], list[float]]:
    win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N)
    bins_low = [f * N // RATE for f in LOW_HZ]
    bins_high = [f * N // RATE for f in HIGH_HZ]
    bin_wind = WIND_HZ * N // RATE
    a_spec = 1 - math.exp(-BLOCK_MS / p.spectral_tau_ms)
    a_coh = 1 - math.exp(-BLOCK_MS / p.coh_tau_ms)
    a_up, a_long, a_down = alpha(p.floor_tau_s), alpha(p.floor_long_tau_s), 0.1
    warmup_blocks = p.warmup_ms // BLOCK_MS
    cooldown_blocks = p.cooldown_ms // BLOCK_MS
    max_post_blocks = p.max_post_ms // BLOCK_MS

    band_s = wind_s = power_s = 0.0
    auto = np.zeros((3, len(bins_high)))
    cross = np.zeros((3, len(bins_high)), dtype=complex)
    floor = 0.0
    state, warm, arm, quiet, since_trig = "warmup", 0, 0, 0, 0
    rows, events = [], []

    for b in range(len(audio) // N):
        blk = audio[b * N : (b + 1) * N].astype(np.float64) / 32768.0
        blk -= blk.mean(axis=0)
        rms = math.sqrt(float(np.mean(blk[:, 0] ** 2)))
        X = np.fft.rfft(blk * win[:, None], axis=0)  # (bins, 3)

        p_low = np.abs(X[bins_low, 0]) ** 2
        p_high = np.abs(X[bins_high, 0]) ** 2
        band = (p_low.sum() + p_high.sum()) / (len(bins_low) + len(bins_high))
        wind = abs(X[bin_wind, 0]) ** 2
        band_s += a_spec * (band - band_s)
        wind_s += a_spec * (wind - wind_s)
        ratio_db = 10 * math.log10((band_s + 1e-12) / (wind_s + 1e-12))

        Xh = X[bins_high, :]  # (9, 3)
        auto += a_coh * (np.abs(Xh.T) ** 2 - auto)
        msc = 0.0
        for i, (a_, b_) in enumerate(PAIRS):
            cross[i] += a_coh * (Xh[:, a_] * np.conj(Xh[:, b_]) - cross[i])
            msc += float(np.mean(np.abs(cross[i]) ** 2 / (auto[a_] * auto[b_] + 1e-30)))
        coh = msc / 3

        power_s += a_spec * (rms * rms - power_s)
        level = math.sqrt(power_s)
        db = lambda v: 20 * math.log10(max(v, 1e-9))  # noqa: E731

        positive = False
        if state == "warmup":
            floor += (rms - floor) / (warm + 1)
        else:
            gate = db(level) > db(floor) + p.snr_db
            spectral = ratio_db > p.ratio_db
            coherent = coh > p.coh_min
            positive = gate and spectral and coherent
            if state != "active":
                a = 0.0
                if not positive:
                    if rms < floor:
                        a = a_down
                    elif not coherent:
                        a = a_up
                elif state == "rearm":
                    a = a_long
                floor += a * (rms - floor)

        # state machine (mirrors trigger_process)
        if state == "warmup":
            warm += 1
            if warm >= warmup_blocks:
                state = "idle"
        elif state in ("idle", "arming"):
            if positive:
                arm += 1
                if arm >= p.arm_blocks:
                    arm, state, quiet, since_trig = 0, "active", 0, 0
                    events.append((b + 1) * BLOCK_MS / 1000)
                else:
                    state = "arming"
            else:
                arm, state = 0, "idle"
        elif state == "active":
            since_trig += 1
            quiet = 0 if positive else quiet + 1
            if quiet >= cooldown_blocks or since_trig >= max_post_blocks:
                state, quiet = "rearm", 0
        elif state == "rearm":
            quiet = 0 if positive else quiet + 1
            if quiet >= cooldown_blocks:
                state = "idle"

        rows.append(
            dict(t=(b + 1) * BLOCK_MS / 1000, level_db=db(level), floor_db=db(floor),
                 margin=db(level) - db(floor), ratio=ratio_db, coh=coh, pos=positive, state=state)
        )
    return rows, events


def summarize(name: str, rows: list[dict], events: list[float], skip_s: float = 2.0) -> None:
    r = [x for x in rows if x["t"] > skip_s]
    arr = lambda k: np.array([x[k] for x in r])  # noqa: E731
    print(f"\n== {name}  ({rows[-1]['t']:.1f} s)")
    for k, label in (("margin", "level-floor dB"), ("ratio", "band ratio dB"), ("coh", "coherence")):
        v = arr(k)
        print(f"  {label:>15}: p5 {np.percentile(v, 5):6.2f}  median {np.median(v):6.2f}  "
              f"p95 {np.percentile(v, 95):6.2f}  max {v.max():6.2f}")
    print(f"  positive blocks: {int(arr('pos').sum())}/{len(r)}   events at: {events or 'none'}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--snr", type=float, default=Params.snr_db)
    ap.add_argument("--ratio", type=float, default=Params.ratio_db)
    ap.add_argument("--coh", type=float, default=Params.coh_min)
    ap.add_argument("--arm", type=int, default=Params.arm_blocks)
    ap.add_argument("--trace", action="store_true", help="print every 5th block")
    args = ap.parse_args()
    p = Params(snr_db=args.snr, ratio_db=args.ratio, coh_min=args.coh, arm_blocks=args.arm)
    print(f"params: snr {p.snr_db} dB, ratio {p.ratio_db} dB, coherence > {p.coh_min}, arm {p.arm_blocks} blocks")
    for f in args.files:
        rows, events = simulate(load(f), p)
        summarize(f, rows, events)
        if args.trace:
            for x in rows[::5]:
                print(f"  {x['t']:6.2f} {x['state']:>7} lvl {x['level_db']:6.1f} floor {x['floor_db']:6.1f} "
                      f"m {x['margin']:5.1f} ratio {x['ratio']:5.1f} coh {x['coh']:.2f} {'+' if x['pos'] else ''}")


if __name__ == "__main__":
    main()
