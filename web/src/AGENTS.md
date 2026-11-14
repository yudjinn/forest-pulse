# Worker invariants

- Dashboard files are private only because wrangler.jsonc's `assets.run_worker_first` covers `/dashboard` and `/dashboard/*`: those requests reach `router.ts`, which checks the session before serving a file. Drop or narrow that list and every dashboard page is served to anyone straight from the files.
- A dashboard file the sign-in page needs (today only `/dashboard/shell.css`) must be listed in `PUBLIC_DASHBOARD_FILES` in `router.ts`; anything else under `/dashboard/` redirects a signed-out browser to sign-in, so an unlisted stylesheet silently breaks the sign-in page.
- D1 refuses a query with more than 100 bound parameters. Pass a list of ids as one JSON parameter and expand it with `json_each` (as `api/events.ts` does), never one `?` per id: a 100-event batch plus the sensor id is 101.
- The served sound list is the enabled rows of `sounds` in `rowid` order, at the version in `sound_list`. Any change to a sound (switch, teach, delete) must also run `UPDATE sound_list SET version = version + 1` in the same batch, or sensors never fetch the change.
- Logs never carry the password, the sensor key or the cookie: `logLine` takes explicit fields, and request headers or bodies are never logged whole.
- Activities are grouped from the stored events on every read; directions and locations are computed once at arrival and stored on the event (see ADR-20261114163418117). Never add an activity table, and never recompute a line or point from the current plan on read.
- Clear events (`clearEvents` in `activities/activities.ts`) is one batch that deletes every per-event row. A capability that keeps per-event rows in a table of its own adds that table's DELETE to the batch, or a cleared rehearsal leaves its rows behind.
