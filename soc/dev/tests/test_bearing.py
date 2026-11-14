"""Bearing estimator on synthetic far-field sources with known direction."""
import numpy as np
import pytest

from bearing import NOMINAL, SPEED_OF_SOUND, BearingEstimator

FS = 48000


def plane_wave(theta_deg, seconds=1.0, snr_db=10.0, seed=0, geom=NOMINAL):
    """Broadband source from theta, exact fractional delays per mic, plus
    independent sensor noise. Returns int16-scale float (n, 3)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * FS)
    src = rng.standard_normal(n)
    f = np.fft.rfftfreq(n, 1 / FS)
    S = np.fft.rfft(src)
    S[(f < 200) | (f > 8000)] = 0
    u = np.array([np.cos(np.deg2rad(theta_deg)), np.sin(np.deg2rad(theta_deg))])
    t = -(geom.positions @ u) / SPEED_OF_SOUND  # arrival time per mic
    chans = [np.fft.irfft(S * np.exp(-2j * np.pi * f * ti), n) for ti in t]
    x = np.stack(chans, axis=1)
    x *= 3000 / x.std()
    noise = rng.standard_normal(x.shape) * x.std() / 10 ** (snr_db / 20)
    return x + noise


@pytest.fixture(scope="module")
def est():
    return BearingEstimator()


@pytest.mark.parametrize("theta", list(range(0, 360, 15)))
def test_direction_recovered(est, theta):
    w = est.analyse_window(plane_wave(theta, seconds=0.5, seed=theta))
    err = (w.bearing_deg - theta + 180) % 360 - 180
    assert abs(err) <= 3, f"theta {theta}: got {w.bearing_deg} (err {err})"
    assert w.closure_samples <= 1.0
    assert w.peak_ratio > 3


def test_delays_match_geometry(est):
    # Source along +x: mic2 (x=0) hears it 4 cm / c before mic1 (x=-4 cm).
    w = est.analyse_window(plane_wave(0.0, seconds=0.5))
    expected_t1_minus_t2 = 0.04 / SPEED_OF_SOUND * FS  # mic1 later -> t1 - t2 > 0
    assert w.taus_samples[0] == pytest.approx(expected_t1_minus_t2, abs=0.2)


def test_diffuse_noise_rejected(est):
    rng = np.random.default_rng(1)
    w = est.analyse_window(rng.standard_normal((24000, 3)) * 3000)  # independent mics
    assert not BearingEstimator.accept(w, background_dbfs=None)


def test_summary_circular_mean(est):
    wins = [est.analyse_window(plane_wave(355 + d, seconds=0.5, seed=i), t_s=i) for i, d in enumerate((0, 5, 10))]
    s = BearingEstimator.summarize(wins, wins)
    err = (s.bearing_deg - 360) % 360
    assert min(err, 360 - err) <= 3  # wraps correctly around 0/360
    assert s.n_windows == 3 and s.confidence > 0.5
