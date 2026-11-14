#!/usr/bin/env bash
# Makes a fresh checkout or worktree ready to build and test. Idempotent.
#   scripts/worktree-setup.sh
# - Python env at .venv (3.13: onnxruntime ships no wheels for 3.15) with the sensor library.
# - web/ dependencies and the Playwright browser.
# - Links .dev-secrets.local from the primary checkout, for live proofs only.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"

if [[ ! -x .venv/bin/python ]]; then
  uv venv -q --python 3.13 .venv
fi
uv pip install -q --python .venv/bin/python -e "./sensor-sdk[dev]"
echo "python: .venv ($(.venv/bin/python --version)) with the sensor library"

(cd web && npm ci --no-audit --no-fund --silent && npx playwright install chromium >/dev/null)
echo "web: dependencies and chromium installed"

primary=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
if [[ ! -e .dev-secrets.local ]]; then
  if [[ -f $primary/.dev-secrets.local && $primary != "$root" ]]; then
    ln -s "$primary/.dev-secrets.local" .dev-secrets.local
    echo "secrets: linked .dev-secrets.local from the primary checkout"
  else
    echo "secrets: skipped, no .dev-secrets.local in the primary checkout (only live proofs need it)"
  fi
fi
