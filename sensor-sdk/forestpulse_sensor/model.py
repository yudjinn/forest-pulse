"""The sound model: EfficientAT mn10_as with its preprocessing, as one ONNX file.

Input is 10 s of 32 kHz mono audio. The same file runs in the researcher's browser when a sound is taught, so a
detector trained there sees exactly the embedding computed here.
"""
import json
from importlib import resources

import numpy as np

MODEL_ID = "mn10_as"
MODEL_RATE = 32000
MODEL_LEN = 10 * MODEL_RATE  # trained on 10 s clips; shorter audio is repeated to fill 10 s
EMBEDDING_DIM = 960

LABELS = json.loads(resources.files(__package__).joinpath("data/audioset_labels.json").read_text())


def to_model_audio(frames: np.ndarray, sample_rate: int) -> np.ndarray:
    """(N, channels) int16 or float -> float32 mono at 32 kHz, channels averaged."""
    x = np.asarray(frames)
    if x.ndim == 2:
        x = x.mean(axis=1, dtype=np.float32) if x.shape[1] > 1 else x[:, 0].astype(np.float32)
    else:
        x = x.astype(np.float32)
    if np.issubdtype(np.asarray(frames).dtype, np.integer):
        x = x / 32768.0
    if sample_rate != MODEL_RATE:
        x = _resample(x, sample_rate, MODEL_RATE)
    return x.astype(np.float32)


def _resample(x: np.ndarray, rate_in: int, rate_out: int) -> np.ndarray:
    """Band-limited resampling through the spectrum. Exact for whole windows, which is how it is used."""
    n_out = round(len(x) * rate_out / rate_in)
    if n_out == 0:
        return np.zeros(0, np.float32)
    spec = np.fft.rfft(x)
    keep = n_out // 2 + 1
    if keep <= len(spec):
        spec = spec[:keep]
    else:
        spec = np.concatenate([spec, np.zeros(keep - len(spec), spec.dtype)])
    return (np.fft.irfft(spec, n=n_out) * (n_out / len(x))).astype(np.float32)


def fill_window(x: np.ndarray) -> np.ndarray:
    """Repeat or trim to exactly 10 s. Without this the model returns nonsense for short windows."""
    if len(x) >= MODEL_LEN:
        return x[-MODEL_LEN:]
    return np.tile(x, -(-MODEL_LEN // len(x)))[:MODEL_LEN]


class Model:
    def __init__(self, path=None, threads: int = 2):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        model_path = path or str(resources.files(__package__).joinpath(f"data/{MODEL_ID}.onnx"))
        self._session = ort.InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])

    def run(self, audio_32k: np.ndarray):
        """Mono 32 kHz float audio of any length > 0 -> (527 built-in label scores, 960-number embedding)."""
        window = fill_window(np.asarray(audio_32k, np.float32))[None, :]
        scores, embedding = self._session.run(None, {"audio": window})
        return scores[0], embedding[0]
