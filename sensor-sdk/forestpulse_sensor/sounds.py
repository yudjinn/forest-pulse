"""The server's list of sounds to report, validated as a whole before it replaces the previous one."""
import math
from dataclasses import dataclass

import numpy as np

from .model import EMBEDDING_DIM, LABELS, MODEL_ID

CATEGORIES = {"logging", "vehicle", "poaching", "wildlife"}


class InvalidSoundList(ValueError):
    pass


@dataclass(frozen=True)
class Sound:
    id: str
    name: str
    category: str
    threshold: float
    label_index: int = -1        # kind "label"
    weights: np.ndarray = None   # kind "detector"
    bias: float = 0.0

    def confidence(self, scores: np.ndarray, embedding: np.ndarray) -> float:
        if self.weights is not None:
            z = float(np.dot(self.weights, embedding) + self.bias)
            return 1.0 / (1.0 + math.exp(-max(min(z, 60.0), -60.0)))
        return float(scores[self.label_index])


@dataclass(frozen=True)
class SoundList:
    version: int
    sounds: tuple

    @staticmethod
    def parse(doc: dict) -> "SoundList":
        try:
            if doc.get("model") != MODEL_ID:
                raise InvalidSoundList(f"sound list is for model {doc.get('model')!r}, this sensor runs {MODEL_ID}")
            version = doc["version"]
            if not isinstance(version, int):
                raise InvalidSoundList("version must be an integer")
            out = []
            for s in doc["sounds"]:
                threshold = float(s["threshold"])
                if not 0.0 <= threshold <= 1.0:
                    raise InvalidSoundList(f"{s['id']}: threshold out of range")
                if s.get("category") not in CATEGORIES:
                    raise InvalidSoundList(f"{s['id']}: unknown category {s.get('category')!r}")
                common = {"id": str(s["id"]), "name": str(s["name"]), "category": s["category"], "threshold": threshold}
                if s["kind"] == "detector":
                    w = np.asarray(s["weights"], dtype=np.float32)
                    if w.shape != (EMBEDDING_DIM,) or not np.isfinite(w).all() or not math.isfinite(float(s["bias"])):
                        raise InvalidSoundList(f"{s['id']}: detector needs {EMBEDDING_DIM} finite weights and a bias")
                    out.append(Sound(**common, weights=w, bias=float(s["bias"])))
                elif s["kind"] == "label":
                    if s["label"] not in LABELS:
                        raise InvalidSoundList(f"{s['id']}: unknown built-in label {s['label']!r}")
                    out.append(Sound(**common, label_index=LABELS.index(s["label"])))
                else:
                    raise InvalidSoundList(f"{s['id']}: unknown kind {s['kind']!r}")
            return SoundList(version, tuple(out))
        except InvalidSoundList:
            raise
        except (KeyError, TypeError, ValueError) as e:
            raise InvalidSoundList(f"malformed sound list: {e!r}") from e

    def matches(self, scores: np.ndarray, embedding: np.ndarray):
        """[(sound, confidence)] for every sound at or above its threshold."""
        hits = []
        for s in self.sounds:
            c = s.confidence(scores, embedding)
            if c >= s.threshold:
                hits.append((s, c))
        return hits
