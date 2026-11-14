# EfficientAT chainsaw experiment

Throwaway check that EfficientAT's pretrained AudioSet models recognise chainsaws, plus a live page that
listens through the laptop mic. The real model will run on the device; nothing here ships.

```
XC_KEY=<xeno-canto key> ./setup.sh  # uv env, EfficientAT source, ESC-50 clips, babble, owl recordings
uv run python evaluate.py           # stock labels on ESC-50 chainsaw clips
uv run python probe.py              # trained detectors vs stock labels, clean and in crowd babble (~12 min)
uv run python train_heads.py        # train the detectors the page uses -> heads/ (~5 min)
uv run python server.py             # live page at http://localhost:8765
```

To make the detectors ignore a specific room, record a minute or two of it as a wav into `samples/noise/`
and re-run `train_heads.py`.

On the page: Start listening, then play a clip (or a chainsaw video on your phone) near the mic.
Use speakers, not headphones. Browser echo cancellation is disabled so the page can hear its own playback.

## Trained detectors (probe.py)

A logistic regression on frozen mn10_as embeddings (960 weights + bias, 3.8 KB), the same mechanism as the
"teach the sensor a new sound" update. Tested on recordings it never saw, grouped by source recording or recordist,
clean and mixed with synthetic crowd babble (10 macOS voices; training and test babble are different halves).
"aug" means babble was mixed into the training data too. dB is how much louder the target is than the crowd.

Chainsaw: 40 ESC-50 chainsaw clips (22 source recordings) vs 144 negatives (engine, helicopter, airplane, train,
vacuum, hand saw, birds, crow, insects, rain, wind, fire).

| Condition | Stock "Chainsaw" label | Detector | Detector + aug | False alarms (aug) |
|---|---|---|---|---|
| Clean | 31/40 | 39/40 | 40/40 | 0/144 |
| Crowd, +10 dB | 18/40 | 39/40 | 40/40 | 0/144 |
| Crowd, +5 dB | 8/40 | 37/40 | 39/40 | 0/144 |
| Crowd, 0 dB | 4/40 | 25/40 | 37/40 | 1/144 |

Boreal owl: 40 xeno-canto recordings vs 115 of pygmy, tawny, Ural, long-eared and eagle owls and cuckoo.
The stock model has no species labels; it puts "Owl" in its top 5 for 28/40 boreal owl recordings.

| Condition | Detector | Detector + aug | False alarms (aug) | AUC (aug) |
|---|---|---|---|---|
| Clean | 30/40 | 32/40 | 15/115 | 0.92 |
| Crowd, +10 dB | 5/40 | 35/40 | 13/115 | 0.92 |
| Crowd, 0 dB | 0/40 | 35/40 | 16/115 | 0.91 |

Owl false alarms are counted if any 5 s window of a recording (up to 40 s) crosses 0.5; pygmy and eagle owl are the
worst. Training labels are noisy because every window of a recording is labelled with its species, including windows
where the bird is silent. Through the live page, the 17 held-out recordings (`heads/owl_holdout.json`) gave: 5/5
boreal owls detected (110185 only weakly), 0/12 other owls, no alarm on babble.

## Stock labels (ESC-50, 5 s clips, Mac CPU)

| Model | Params | Chainsaw top-1 | Chainsaw top-5 | Chainsaw score >= 0.2 | Negatives >= 0.2 | ms / clip |
|---|---|---|---|---|---|---|
| mn04_as | 0.98M | 24/40 | 27/40 | 24/40 | 0/36 | 19 |
| mn10_as | 4.88M | 29/40 | 35/40 | 31/40 | 0/36 | 39 |
| dymn10_as | 10.57M | 30/40 | 35/40 | 31/40 | 0/36 | 44 |

Negatives (when this table was made): 6 clips each of birds, rain, wind, crackling fire, engine, hand saw. Full output in `results.txt`.

Findings:
- Zero false positives: the chainsaw score never passes 0.01 on any negative, including engines and hand saws.
- Misses are mostly idling or distant saws that the model calls "Vehicle" with a low chainsaw score.
- The models only behave on 10 s input (their AudioSet training length). A raw 3 s window scores ~1.0 on
  random classes. `classifier.py` tiles shorter windows up to 10 s, which also lifted mn10_as from 26 to
  29 top-1 on the 5 s clips. The device must do the same, or feed 10 s windows (the ESP32 pre-trigger buffer is 10 s).
