"""Thin wrapper around EfficientAT (vendor/EfficientAT) for 32 kHz mono audio tagging."""
import os
import sys
from contextlib import redirect_stdout

import numpy as np
import torch

VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "EfficientAT")
sys.path.insert(0, VENDOR)
_cwd = os.getcwd()
os.chdir(VENDOR)  # helpers.utils reads metadata/ relative to cwd
from helpers.utils import NAME_TO_WIDTH, labels  # noqa: E402
from models.dymn.model import get_model as get_dymn  # noqa: E402
from models.mn.model import get_model as get_mn  # noqa: E402
from models.preprocess import AugmentMelSTFT  # noqa: E402
os.chdir(_cwd)

import models.dymn.model as _dymn_mod  # noqa: E402
import models.mn.model as _mn_mod  # noqa: E402

_WEIGHTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources")
_mn_mod.model_dir = _dymn_mod.model_dir = _WEIGHTS  # cache downloaded weights here, not in cwd

SAMPLE_RATE = 32000
# Models were trained on 10 s AudioSet clips. Shorter raw input gives garbage (a 3 s window scores
# ~1.0 on random classes), so shorter windows are tiled up to 10 s before inference.
TRAIN_LEN = 10 * SAMPLE_RATE
CHAINSAW = labels.index("Chainsaw")
# AudioSet classes we treat as "logging / machinery" evidence.
MACHINERY = [labels.index(n) for n in ("Chainsaw", "Power tool", "Engine", "Light engine (high frequency)",
                                        "Medium engine (mid frequency)", "Lawn mower", "Sawing")]


class Tagger:
    def __init__(self, model_name: str = "mn10_as"):
        with open(os.devnull, "w") as dn, redirect_stdout(dn):
            if model_name.startswith("dymn"):
                self.model = get_dymn(width_mult=NAME_TO_WIDTH(model_name), pretrained_name=model_name)
            else:
                self.model = get_mn(width_mult=NAME_TO_WIDTH(model_name), pretrained_name=model_name)
            self.mel = AugmentMelSTFT(n_mels=128, sr=SAMPLE_RATE, win_length=800, hopsize=320)
        self.model.eval()
        self.mel.eval()
        self.name = model_name

    def __call__(self, wav: np.ndarray) -> np.ndarray:
        """wav: float32 mono at 32 kHz. Returns 527 sigmoid scores."""
        return self.analyse(wav)[0]

    @torch.no_grad()
    def analyse(self, wav: np.ndarray):
        """Returns (527 sigmoid scores, embedding). The embedding is what a custom sound classifier trains on."""
        wav = np.asarray(wav, dtype=np.float32)
        if len(wav) < TRAIN_LEN:
            wav = np.tile(wav, -(-TRAIN_LEN // len(wav)))[:TRAIN_LEN]
        x = torch.from_numpy(np.ascontiguousarray(wav))[None, :]
        logits, emb = self.model(self.mel(x).unsqueeze(0))
        return torch.sigmoid(logits.float()).squeeze(0).numpy(), emb.squeeze(0).numpy()

    @torch.no_grad()
    def analyse_batch(self, wavs, batch: int = 32):
        """Same as analyse() for a list of equal-length windows. Returns (N x 527 scores, N x D embeddings)."""
        S, E = [], []
        for i in range(0, len(wavs), batch):
            chunk = []
            for w in wavs[i:i + batch]:
                w = np.asarray(w, dtype=np.float32)
                if len(w) < TRAIN_LEN:
                    w = np.tile(w, -(-TRAIN_LEN // len(w)))[:TRAIN_LEN]
                chunk.append(w)
            x = torch.from_numpy(np.stack(chunk))
            logits, emb = self.model(self.mel(x).unsqueeze(1))
            S.append(torch.sigmoid(logits.float()).numpy()); E.append(emb.numpy())
        return np.concatenate(S), np.concatenate(E)

    @staticmethod
    def top(scores: np.ndarray, k: int = 5):
        idx = np.argsort(scores)[::-1][:k]
        return [(labels[i], float(scores[i])) for i in idx]
