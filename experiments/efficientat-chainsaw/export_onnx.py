"""Exports mn10_as with its preprocessing to one ONNX file and checks it against PyTorch.

The same file runs on the sensor (onnxruntime) and in the browser (onnxruntime-web, WebAssembly), so a detector
trained in the browser sees exactly the embedding the sensor computes.

usage: uv run python export_onnx.py mn10_as_pipeline.onnx
"""
import sys, time, glob, numpy as np, torch, librosa
sys.path.insert(0, ".")
from classifier import Tagger, TRAIN_LEN
t = Tagger("mn10_as")

class Pipeline(torch.nn.Module):
    """10 s of 32 kHz mono audio -> (527 scores, 960 embedding), preprocessing included."""
    def __init__(self, mel, model):
        super().__init__(); self.mel, self.model = mel, model
        import torchaudio
        mb, _ = torchaudio.compliance.kaldi.get_mel_banks(mel.n_mels, mel.n_fft, mel.sr, mel.fmin, mel.fmax,
                                                          vtln_low=100.0, vtln_high=-500., vtln_warp_factor=1.0)
        self.register_buffer("mel_basis", torch.nn.functional.pad(mb, (0, 1)))
    def forward(self, wav):  # (B, 320000)
        m = self.mel
        x = torch.nn.functional.conv1d(wav.unsqueeze(1), m.preemphasis_coefficient).squeeze(1)
        X = torch.stft(x, m.n_fft, hop_length=m.hopsize, win_length=m.win_length, center=True,
                       normalized=False, window=m.window, return_complex=False)
        p = (X ** 2).sum(-1)
        mel = ((torch.matmul(self.mel_basis, p) + 1e-5).log() + 4.5) / 5.0
        logits, emb = self.model(mel.unsqueeze(1))
        return torch.sigmoid(logits), emb

pipe = Pipeline(t.mel, t.model).eval()
dummy = torch.zeros(1, TRAIN_LEN)
torch.onnx.export(pipe, (dummy,), sys.argv[1], input_names=["audio"], output_names=["scores", "embedding"],
                  dynamic_axes={"audio": {0: "batch"}, "scores": {0: "batch"}, "embedding": {0: "batch"}}, opset_version=18, dynamo=False)
import onnxruntime as ort, os
print("onnx size MB", round(os.path.getsize(sys.argv[1]) / 1e6, 1))
so = ort.SessionOptions(); so.intra_op_num_threads = 1
sess = ort.InferenceSession(sys.argv[1], so, providers=["CPUExecutionProvider"])
clips = [librosa.load(p, sr=32000)[0] for p in sorted(glob.glob("samples/chainsaw/*.wav"))[:8]]
diffs = []
for c in clips:
    w = np.tile(c, -(-TRAIN_LEN // len(c)))[:TRAIN_LEN].astype(np.float32)
    s_ref, e_ref = t.analyse(w)
    s, e = sess.run(None, {"audio": w[None]})
    diffs.append((np.abs(s[0] - s_ref).max(), np.abs(e[0] - e_ref).max() / (np.abs(e_ref).max())))
print("max score diff %.2e, max rel embedding diff %.2e" % (max(d[0] for d in diffs), max(d[1] for d in diffs)))
t0 = time.perf_counter(); [sess.run(None, {"audio": np.zeros((1, TRAIN_LEN), np.float32)}) for _ in range(5)]
print("onnxruntime 1 thread: %.0f ms per 10 s window" % ((time.perf_counter() - t0) / 5 * 1000))
