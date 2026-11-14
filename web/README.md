# Forest Pulse web

Minimal static landing page at https://forestpulse.paxid.com/ on Cloudflare
Workers, using the existing paid paxID account. Python 3 and Wrangler 4 are the
only build and deployment tools required.

From this directory:

```sh
npm ci
FP_E2E_PORT_BASE=8800 npm run serve
```

`npm run serve` builds the site and runs the Worker on 127.0.0.1 at the port
base with fresh local D1 and R2 state. Use the project's pinned Wrangler
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

The private R2 bucket `forest-pulse` belongs to the same paxID account and uses
the EU jurisdiction, with Cloudflare reporting location `EEUR`. Its binding is
`STORAGE`. The static landing page does not
read or write bucket objects. Public bucket access is not needed.

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
