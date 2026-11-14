#!/usr/bin/env bash
# The full suite: web journeys on this run's port base, then the sensor library.
#   FP_E2E_PORT_BASE=8810 scripts/test-all.sh
set -euo pipefail
root=$(git rev-parse --show-toplevel)
: "${FP_E2E_PORT_BASE:?set FP_E2E_PORT_BASE (see docs/agents/orchestration-readiness.md)}"
(cd "$root/web" && npm run -s typecheck && FP_E2E_WORKERS="${FP_E2E_WORKERS:-2}" npx playwright test)
"$root/.venv/bin/pytest" -q "$root/sensor-sdk/tests"
