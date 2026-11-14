# Forest Pulse web

Minimal static landing page at https://forestpulse.paxid.com/ on Cloudflare
Workers, using the existing paid paxID account. Python 3 and Wrangler 4 are the
only build and deployment tools required.

From this directory:

```sh
python3 build.py
wrangler dev --port 8789
```

Deploy an update:

```sh
python3 build.py
wrangler deploy
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
