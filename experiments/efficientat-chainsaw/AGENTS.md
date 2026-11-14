# Model experiment invariants

- The demo detects and ignores only recordings the detectors never trained on. `build_negative_library.py` keeps every held-out owl (the player's tawny owl included) out of the other-sounds library, and `train_heads.py` keeps the player chainsaws' source recordings out of the chainsaw detector (`heads/chainsaw.json` lists its positives; `demo-kit/player_samples.py` checks them). Loosening either check makes the stage detection prove nothing.
