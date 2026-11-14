# Forest Pulse web

The Forest Pulse service at https://forestpulse.paxid.com/ on Cloudflare
Workers, using the existing paid paxID account: the static landing page, the
researchers' dashboard under `/dashboard/` (one shared password, a 7-day
session) and the sensor API under `/api/v1/` ([../docs/device-api.md](../docs/device-api.md)).
Python 3 and Wrangler 4 are the only build and deployment tools required.

## Layout

- `src/` the Worker (TypeScript). `src/routes.ts` is the route table and the
  sensor intake hooks; `src/router.ts` enforces each route's access and serves
  the files.
- `dashboard/` the researchers' pages: plain HTML, CSS and JavaScript modules,
  served only to a signed-in researcher (the sign-in page and its stylesheet
  excepted). `dashboard/shell.js` holds the header navigation and the 2 s live
  polling with the connection-lost banner.
- `migrations/` the D1 schema and the seeded sound list.
- `tests/` the journey harness and journeys.

Secrets the Worker reads: `DASHBOARD_PASSWORD`, `DEVICE_KEY` and
`SESSION_SECRET`, set on the live Worker. Locally they come from the untracked
`.dev.vars`, which `npm run serve` writes with dev values when it is missing
(password `dev-password`, sensor key `dev-key`).

From this directory:

```sh
npm ci
FP_E2E_PORT_BASE=8800 npm run serve
```

`npm run serve` builds the site and runs the Worker on 127.0.0.1 at the port
base with fresh local D1 and R2 state (migrations applied). Open
`/dashboard/` there, and point a sensor at it with the sensor library's replay
command and a config whose `server_url` is that address and `sensor_key` the
local one. Use the project's pinned Wrangler
(`npx wrangler`): an older global install cannot run this compatibility date.

Deploy an update:

```sh
python3 build.py
npx wrangler deploy
```

The build copies brand assets from `../shared/assets/forest-pulse/`; generated
files in `dist/` are not tracked. Edit the shared masters and run their generator
when changing the logo.

## Storage and location

Records live in the D1 database `forest-pulse`, binding `DB`; wrangler.jsonc
names it without an id, and Wrangler's automatic provisioning (on by default
in the pinned Wrangler) sets up the live database on the first deploy.
The private R2 bucket `forest-pulse` belongs to the same paxID account and uses
the EU jurisdiction, with Cloudflare reporting location `EEUR`. Its binding is
`STORAGE`. Public bucket access is not needed.

R2 supports an EU storage jurisdiction but no selectable Finland-only location.
The landing page is served through Cloudflare's global edge network.

The custom domain is declared in `wrangler.jsonc`; Wrangler manages the domain
attachment and certificate. Both `workers.dev` and version preview URLs are
disabled.

## Tests

From the repository root, once per checkout: `scripts/worktree-setup.sh`. Then
`FP_E2E_PORT_BASE=8810 scripts/test-all.sh` runs the typecheck, the browser
journeys in `tests/e2e/` against the local Worker, and the sensor library's
tests. Every port and local state path derives from `FP_E2E_PORT_BASE` in
`tests/ports.ts`, so runs in different worktrees never collide. D1 migrations
live in `migrations/`, named `<UTC timestamp>_<what>.sql`; the harness applies
them to fresh local state on every run against the D1 binding `DB`.
