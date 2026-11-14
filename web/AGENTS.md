# Web service invariants

- Deploy only with `npm run deploy` (`scripts/deploy.ts`). Plain `npx wrangler deploy` skips the migrations and the bucket upload, so the new Worker runs against old tables and missing files.
- The deploy creates the live D1 itself, in the jurisdiction `wrangler.jsonc` names, before migrating (agent-made). Wrangler's automatic provisioning would create it only as the Worker goes live, serving before any table exists. `wrangler.jsonc` has no `database_id` on purpose: Wrangler finds the database by name. See ADR-20261114163418130.
- A rollback restores the Worker's code and files, never migrations or bucket uploads. Migrations only add tables and columns, never drop or rename what the previous version reads; a bucket file whose format changes gets a new name. Uploads overwrite by name and never delete, because the service writes its own objects to the same bucket (agent-made).
- Read `.dev-secrets.local` (repository root) as plain `NAME=value` lines, never by sourcing it in a shell: the shell changes the live password and the live sign-in is refused.
