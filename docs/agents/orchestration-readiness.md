# Orchestration readiness

Checked: 2026-11-14  Scope: web sensor-sdk

## Suite concurrency
Capacity: 3 concurrent full suites.
Basis: each worktree builds its own web/dist, runs its own local Worker on ports derived from FP_E2E_PORT_BASE, keeps local D1 and R2 state in web/.wrangler/e2e-<base> (wiped at start), and the sensor library's replay and journeys use ephemeral ports and temp state dirs. No shared local service. A later change that introduces one (a fixed port, a shared state dir, a singleton fixture server) falsifies this.
Lock: ~/.agents/skills/_workflow-shared/scripts/e2e-lock.sh --capacity 3 -- scripts/test-all.sh. Two runs in one worktree are not supported: they share web/dist.

## Verification cost
Full suite: about 3 min 45 s wall clock (typecheck, 3.3 min for the 35 web journeys and focused tests, 23 s sensor library), measured on 2026-11-14 at a load average near 10, with the teaching pack present so the rehearsal journey ran; 3.8 min at the wave 4 gate. The longest journeys run their own service and wait real time (plan: the 10 s offline rule; location: two 15 s line expiries; rehearsal: about 45 s for the stage script, teaching the 15-clip pack in the browser; calibration: serial runs in one file, each waiting on the boards' slots). The rehearsal journey runs only where the teaching pack folder exists ($FP_TEACHING_PACK, else ~/Desktop/Boreal owl teaching pack, built by demo-kit/teaching_pack.py); elsewhere it is skipped. The calibration rehearsal runs only against the live site (FP_REHEARSAL_ORIGIN) and is always skipped in the suite, so a run with the pack reports 34 passed, 1 skipped. Well under the host's 10 min per-call cap, so it runs as one call, no pieces. Budget 6 min. Re-measure when the journeys grow; no affected-only mode, run one spec instead.
Workers per run: 2. Worker budget: 6 browser workers across all concurrent heavy runs. Heavy-job capacity on this machine: 3 at once (10 cores, 64 GB). Basis: 3 full suites on separate worktrees and bases ran concurrently, all green, 2026-11-14.
Fast typecheck: cd web && npm run typecheck. Lint changed files: no linter is configured; typecheck is the gate.
Fast development loop: FP_E2E_PORT_BASE=<base> npm run serve in web/, then reload the browser.

## Ports
FP_E2E_PORT_BASE=8800; app = base, inspector = base+1, base+2 to base+9 reserved. A second block, base+50 to base+59 (five pairs), serves journeys that need their own fresh service, one pair each; the activities journey takes base+50/+51, the location journey base+52/+53, the rehearsal journey base+54/+55, the calibration journeys base+56/+57 (one at a time, serial in one spec file). Overrides: FP_E2E_APP_PORT, FP_E2E_INSPECTOR_PORT. Derived only in web/tests/ports.ts.
Orchestrator allocation: wave gate uses base 8800; implementers take base 8810, 8820, 8830.

## Running one spec
cd web && FP_E2E_PORT_BASE=<base> npx playwright test tests/e2e/<file>.spec.ts
Full suite: FP_E2E_PORT_BASE=<base> scripts/test-all.sh (typecheck, web journeys, sensor library).

## Migrations
D1 migrations in web/migrations/ are named <YYYYMMDDHHMMSSmmm>_<what>.sql (UTC, the same stamp form as docs/adr), written by hand; never use `wrangler d1 migrations create`, which numbers by index. Never edit or renumber a landed file. After merging in a main that added a migration, no action is needed unless two files change the same table incompatibly; then fix your own file. Wrangler's migrator applies by recorded name set (verified: a file sorting before an applied one is still applied). The harness applies all migrations to fresh local state on every run, against the D1 binding named DB.

## Worktree setup
scripts/worktree-setup.sh (Python 3.13 venv at .venv with the sensor library, web dependencies, chromium, and a link to the primary checkout's .dev-secrets.local). Use web/node_modules/.bin/wrangler, never a global wrangler: an older global build cannot run the project's compatibility date locally.

## Ship check
From a clean install (scripts/worktree-setup.sh in a fresh worktree): the full suite on a fresh base with FP_REQUIRE_TEACHING_PACK=1 (a missing teaching pack fails the rehearsal journey instead of skipping it), then the deploy command in web/README.md, then the rehearsal journey against the live site: cd web && FP_E2E_PORT_BASE=<base> FP_REHEARSAL_ORIGIN=https://forestpulse.paxid.com npx playwright test tests/e2e/rehearsal.spec.ts (one call, a few minutes; it clears every live event at its end, see demo-kit/README.md), and the live calibration rehearsal before it: cd web && FP_E2E_PORT_BASE=<base> FP_REHEARSAL_ORIGIN=https://forestpulse.paxid.com npx playwright test tests/e2e/rehearsal-calibration.spec.ts (one call, about a minute; it refuses to start while a calibration-capable board is online or the plan is a measured layout, and clears no events). Once a deploy command exists it is the only way to deploy. Only a human can observe: phone playback over the Bluetooth speaker with the screen locked, live detection by the board in the hall, and calibration of the real boards on the stage (stage check, Calibrate, tape measure; demo-kit/README.md, Presenter checklist).

## Hand checks
cd web && FP_E2E_PORT_BASE=<your base> npm run serve: fresh local D1 and R2 under web/.wrangler/e2e-<base>, dev secrets from web/.dev.vars (written with dev values when missing). Drive it with Playwright or the sensor library's replay command from .venv.

## External resources
- Live Cloudflare account (Worker forest-pulse, its D1 database, the R2 bucket forest-pulse): deploy only through the deploy command; never set, rotate or delete live secrets; live checks one at a time, by the deploy and rehearsal slices and the ship check only.
- Live sensor API at forestpulse.paxid.com: the live sensor key and password come from .dev-secrets.local; live replays one at a time, a few minutes at most, and clear events afterwards.
- xeno-canto API (XC_KEY): only for rebuilding the other-sounds library; one rebuild at a time, never in a journey.

## Known limitations
Hardware (mcu, soc) has no automated tests and is outside this scope.
