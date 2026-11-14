# NOT USED: classification is done by the server SDK; the node only sends the
# audio file and the bearing. Kept (with models/ and the validation in
# experiments/efficientat-chainsaw/export_onnx.py) in case on-device
# classification is needed again: re-enable in main.py and requirements.txt.
#
"""Chainsaw / machinery classifier: EfficientAT mn10_as (AudioSet) on ONNX Runtime.

The reference model lives in experiments/efficientat-chainsaw/classifier.py
(Tagger). experiments/efficientat-chainsaw/export_onnx.py exports it to
models/ together with the exact mel filterbank, the labels and the class
definitions (classes.json), and validates this module against Tagger
(max score difference ~1e-6 on the ESC-50 samples). Runs on the Uno Q with
numpy + onnxruntime only: the mel frontend is a numpy port.

Input: event audio, (n, 3) int16 at 48 kHz. The 3 mics are averaged to mono
and resampled to 32 kHz. The model was trained on 10 s clips and gives
garbage on raw shorter input, so shorter windows are tiled up to 10 s
(as in experiments/efficientat-chainsaw).
"""

from __future__ import annotations

import json
import os

import numpy as np

SR = 32000
TRAIN_LEN = 10 * SR
N_FFT, HOP, WIN = 1024, 320, 800


# ---------------------------------------------------------------- resampling

def _kaiser_lowpass(numtaps: int, cutoff: float, beta: float = 8.6) -> np.ndarray:
    """cutoff as a fraction of Nyquist."""
    n = np.arange(numtaps) - (numtaps - 1) / 2
    h = cutoff * np.sinc(cutoff * n) * np.kaiser(numtaps, beta)
    return h / h.sum()


_H_48_TO_32 = _kaiser_lowpass(121, 0.95 / 3)  # at 96 kHz (after x2 upsample): cutoff ~15.2 kHz


def resample_48k_to_32k(x: np.ndarray) -> np.ndarray:
    """Polyphase-equivalent rational resampling by 2/3 (upsample 2, low-pass, take every 3rd)."""
    x = np.asarray(x, dtype=np.float32)
    up = np.zeros(2 * len(x), dtype=np.float32)
    up[::2] = x
    y = np.convolve(up, (2.0 * _H_48_TO_32).astype(np.float32), mode="same")
    return y[::3]


# ------------------------------------------------------------------ features

class MelFrontend:
    """numpy port of EfficientAT's AugmentMelSTFT in eval mode."""

    def __init__(self, mel_basis: np.ndarray):
        self.mel_basis = mel_basis.astype(np.float32)  # (128, 513)
        w = np.hanning(WIN).astype(np.float32)          # == torch.hann_window(800, periodic=False)
        pad = (N_FFT - WIN) // 2
        self.window = np.pad(w, (pad, N_FFT - WIN - pad))

    def __call__(self, wav: np.ndarray) -> np.ndarray:
        """wav: float32 mono at 32 kHz -> (128, T) normalised log-mel."""
        x = wav[1:] - 0.97 * wav[:-1]                               # pre-emphasis (conv1d [-0.97, 1])
        x = np.pad(x, (N_FFT // 2, N_FFT // 2), mode="reflect")      # torch.stft center=True
        n_frames = 1 + (len(x) - N_FFT) // HOP
        idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
        spec = np.fft.rfft(x[idx] * self.window, axis=1)            # (T, 513)
        power = (spec.real**2 + spec.imag**2).astype(np.float32).T  # (513, T)
        mel = np.log(self.mel_basis @ power + 1e-5)
        return (mel + 4.5) / 5.0


# ---------------------------------------------------------------- classifier

class Classifier:
    def __init__(self, model_dir: str, threads: int = 2):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads  # leave cores for the reader + bearing
        with open(os.path.join(model_dir, "classes.json")) as f:
            classes = json.load(f)  # written by export_onnx.py from the experiment's classifier.py
        self.sess = ort.InferenceSession(os.path.join(model_dir, f"{classes['model']}.onnx"), opts,
                                         providers=["CPUExecutionProvider"])
        self.input = self.sess.get_inputs()[0].name
        self.mel = MelFrontend(np.load(os.path.join(model_dir, "mel_basis.npy")))
        with open(os.path.join(model_dir, "labels.json")) as f:
            self.labels = json.load(f)
        self.i_chainsaw = self.labels.index(classes["chainsaw"])
        self.i_machinery = [self.labels.index(n) for n in classes["machinery"]]

    @classmethod
    def load(cls, model_path: str, log=print) -> "Classifier | None":
        """model_path: .../models/mn10_as.onnx. Returns None (and logs) if unavailable."""
        model_dir = os.path.dirname(model_path)
        try:
            return cls(model_dir)
        except Exception as e:  # missing files, onnxruntime not installed, ...
            log(f"[class] classifier disabled: {e}")
            return None

    def scores32(self, wav32: np.ndarray) -> np.ndarray:
        """float32 mono 32 kHz -> 527 sigmoid scores."""
        if len(wav32) < TRAIN_LEN:
            wav32 = np.tile(wav32, -(-TRAIN_LEN // max(1, len(wav32))))[:TRAIN_LEN]
        else:
            wav32 = wav32[:TRAIN_LEN]
        mel = self.mel(wav32.astype(np.float32))[None, None]  # (1, 1, 128, 1000)
        logits = self.sess.run(None, {self.input: mel})[0][0]
        return 1.0 / (1.0 + np.exp(-logits))

    def _summary(self, s: np.ndarray) -> dict:
        top = np.argsort(s)[::-1][:5]
        return {
            "chainsaw": float(s[self.i_chainsaw]),
            "machinery": float(s[self.i_machinery].max()),
            "top": [(self.labels[i], float(s[i])) for i in top],
        }

    @staticmethod
    def to_mono32(audio48: np.ndarray) -> np.ndarray:
        mono = audio48.astype(np.float32).mean(axis=1) / 32768.0
        return resample_48k_to_32k(mono)

    def classify(self, audio48: np.ndarray) -> dict:
        """One window (<= 10 s used): (n, 3) int16 at 48 kHz."""
        return self._summary(self.scores32(self.to_mono32(audio48[-10 * 48000:])))

    def classify_event(self, audio48: np.ndarray) -> dict:
        """Whole event: 10 s windows with 5 s hop; reports the window with the
        highest chainsaw score (a saw that runs for part of the event counts)."""
        wav = self.to_mono32(audio48)
        starts = list(range(0, max(1, len(wav) - TRAIN_LEN + 1), TRAIN_LEN // 2)) or [0]
        if len(wav) > TRAIN_LEN and starts[-1] + TRAIN_LEN < len(wav):
            starts.append(len(wav) - TRAIN_LEN)  # cover the tail
        best = None
        for st in starts:
            r = self._summary(self.scores32(wav[st:st + TRAIN_LEN]))
            r["window_s"] = [round(st / SR, 2), round(min(len(wav), st + TRAIN_LEN) / SR, 2)]
            if best is None or r["chainsaw"] > best["chainsaw"]:
                best = r
        best["n_windows"] = len(starts)
        return best
