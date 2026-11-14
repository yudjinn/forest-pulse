# EfficientAT chainsaw experiment

Throwaway check that EfficientAT's pretrained AudioSet models recognise chainsaws, plus a live page that
listens through the laptop mic. The real model will run on the device; nothing here ships.

```
./setup.sh                          # uv env, EfficientAT source, ESC-50 clips
uv run python evaluate.py           # batch run: 40 chainsaw clips + 36 forest negatives
uv run python server.py             # live page at http://localhost:8765
```

On the page: Start listening, then play a clip (or a chainsaw video on your phone) near the mic.
Use speakers, not headphones. Browser echo cancellation is disabled so the page can hear its own playback.

## Results (ESC-50, 5 s clips, Mac CPU)

| Model | Params | Chainsaw top-1 | Chainsaw top-5 | Chainsaw score >= 0.2 | Negatives >= 0.2 | ms / clip |
|---|---|---|---|---|---|---|
| mn04_as | 0.98M | 24/40 | 27/40 | 24/40 | 0/36 | 19 |
| mn10_as | 4.88M | 29/40 | 35/40 | 31/40 | 0/36 | 39 |
| dymn10_as | 10.57M | 30/40 | 35/40 | 31/40 | 0/36 | 44 |

Negatives: 6 clips each of birds, rain, wind, crackling fire, engine, hand saw. Full output in `results.txt`.

Findings:
- Zero false positives: the chainsaw score never passes 0.01 on any negative, including engines and hand saws.
- Misses are mostly idling or distant saws that the model calls "Vehicle" with a low chainsaw score.
- The models only behave on 10 s input (their AudioSet training length). A raw 3 s window scores ~1.0 on
  random classes. `classifier.py` tiles shorter windows up to 10 s, which also lifted mn10_as from 26 to
  29 top-1 on the 5 s clips. The device must do the same, or feed 10 s windows (the ESP32 pre-trigger buffer is 10 s).
