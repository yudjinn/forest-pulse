# Migration invariants

- Name a new file `<YYYYMMDDHHMMSSmmm>_<what>.sql` (UTC) by hand; never use `wrangler d1 migrations create`, which numbers by index, so parallel branches collide. Never edit or rename a landed file: the migrator applies by recorded name, so an edit never reaches a database that already ran the file and a renamed file runs a second time.
- A migration that changes a seeded sound bumps `sound_list.version` in the same file (see web/src/AGENTS.md) and changes the sensor library's built-in list with it (see sensor-sdk/AGENTS.md). Rollback rules for migrations are in web/AGENTS.md.
