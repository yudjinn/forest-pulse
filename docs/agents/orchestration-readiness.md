# Orchestration readiness

Checked: 2026-11-14  Scope: web sensor-sdk

## Suite concurrency
Capacity: 3 concurrent full suites.
Basis: each worktree builds its own web/dist, runs its own local Worker on ports derived from FP_E2E_PORT_BASE, keeps local D1 and R2 state in web/.wrangler/e2e-<base> (wiped at start), and the sensor library's replay and journeys use ephemeral ports and temp state dirs. No shared local service. A later change that introduces one (a fixed port, a shared state dir, a singleton fixture server) falsifies this.
Lock: ~/.agents/skills/_workflow-shared/scripts/e2e-lock.sh --capacity 3 -- scripts/test-all.sh. Two runs in one worktree are not supported: they share web/dist.

## Verification cost
Full suite: about 2 min 5 s wall clock (typecheck, 2.0 min for the 23 web journeys and focused tests, 6 s sensor library), measured on 2026-11-14 after wave 4 (reteach and delete, teaching pack) at a load average near 7, with the rehearsal journey running; the longest journeys run their own service and wait real time (plan: the 30 s offline rule; location: two 15 s line expiries; rehearsal: about 30 s teaching the 10-clip pack in the browser). The rehearsal journey runs only where the teaching pack folder exists ($FP_TEACHING_PACK, else ~/Desktop/Boreal owl teaching pack, built by demo-kit/teaching_pack.py); elsewhere it is skipped and the suite reports 22 passed, 1 skipped. Well under the host's 10 min per-call cap, so it runs as one call, no pieces. Budget 6 min. Re-measure when the journeys grow; no affected-only mode, run one spec instead.
Workers per run: 2. Worker budget: 6 browser workers across all concurrent heavy runs. Heavy-job capacity on this machine: 3 at once (10 cores, 64 GB). Basis: 3 full suites on separate worktrees and bases ran concurrently, all green, 2026-11-14.
Fast typecheck: cd web && npm run typecheck. Lint changed files: no linter is configured; typecheck is the gate.
Fast development loop: FP_E2E_PORT_BASE=<base> npm run serve in web/, then reload the browser.

## Ports
FP_E2E_PORT_BASE=8800; app = base, inspector = base+1, base+2 to base+9 reserved. A second block, base+50 to base+59 (five pairs), serves journeys that need their own fresh service, one pair each; the activities journey takes base+50/+51, the location journey base+52/+53, the rehearsal journey base+54/+55. Overrides: FP_E2E_APP_PORT, FP_E2E_INSPECTOR_PORT. Derived only in web/tests/ports.ts.
Orchestrator allocation: wave gate uses base 8800; implementers take base 8810, 8820, 8830.

## Running one spec
cd web && FP_E2E_PORT_BASE=<base> npx playwright test tests/e2e/<file>.spec.ts
Full suite: FP_E2E_PORT_BASE=<base> scripts/test-all.sh (typecheck, web journeys, sensor library).

## Migrations
D1 migrations in web/migrations/ are named <YYYYMMDDHHMMSSmmm>_<what>.sql (UTC, the same stamp form as docs/adr), written by hand; never use `wrangler d1 migrations create`, which numbers by index. Never edit or renumber a landed file. After merging in a main that added a migration, no action is needed unless two files change the same table incompatibly; then fix your own file. Wrangler's migrator applies by recorded name set (verified: a file sorting before an applied one is still applied). The harness applies all migrations to fresh local state on every run, against the D1 binding named DB.

## Worktree setup
scripts/worktree-setup.sh (Python 3.13 venv at .venv with the sensor library, web dependencies, chromium, and a link to the primary checkout's .dev-secrets.local). Use web/node_modules/.bin/wrangler, never a global wrangler: an older global build cannot run the project's compatibility date locally.

## Ship check
From a clean install (scripts/worktree-setup.sh in a fresh worktree): the full suite on a fresh base, then the deploy command in web/README.md, then the rehearsal journey against the live site. Once a deploy command exists it is the only way to deploy. Only a human can observe: phone playback over the Bluetooth speaker with the screen locked, and live detection by the board in the hall.

## Hand checks
cd web && FP_E2E_PORT_BASE=<your base> npm run serve: fresh local D1 and R2 under web/.wrangler/e2e-<base>, dev secrets from web/.dev.vars (written with dev values when missing). Drive it with Playwright or the sensor library's replay command from .venv.

## External resources
- Live Cloudflare account (Worker forest-pulse, its D1 database, the R2 bucket forest-pulse): deploy only through the deploy command; never set, rotate or delete live secrets; live checks one at a time, by the deploy and rehearsal slices and the ship check only.
- Live sensor API at forestpulse.paxid.com: the live sensor key and password come from .dev-secrets.local; live replays one at a time, a few minutes at most, and clear events afterwards.
- xeno-canto API (XC_KEY): only for rebuilding the other-sounds library; one rebuild at a time, never in a journey.

## Known limitations
Hardware (mcu, soc) has no automated tests and is outside this scope.
