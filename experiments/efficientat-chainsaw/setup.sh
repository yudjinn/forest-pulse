#!/usr/bin/env bash
# One-time setup: Python env, EfficientAT source (pinned), ESC-50 test clips. Weights download on first run.
set -euo pipefail
cd "$(dirname "$0")"
uv sync --python 3.12
if [ ! -d vendor/EfficientAT ]; then
  git clone https://github.com/fschmid56/EfficientAT.git vendor/EfficientAT
  git -C vendor/EfficientAT checkout -q a425fdce92572e602a1d5634799bd9f1f2efa806
fi
./fetch_samples.sh
