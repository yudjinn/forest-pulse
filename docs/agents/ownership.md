# Ownership

Two slices run in parallel only when their paths below are disjoint. Edits to the
additive-only hot files never count as overlap.

| Area | Paths |
|---|---|
| Service core: Worker entry, sign-in, sensor API intake, event log | web/src/* (top level), web/src/auth/**, web/src/api/**, web/dashboard/* (shell), web/dashboard/log/** |
| Sensors and plan | web/src/sensors/**, web/dashboard/plan/** |
| Activities | web/src/activities/**, web/dashboard/activities/**, web/dashboard/icons/** |
| Sounds list and switches | web/src/sounds/**, web/dashboard/sounds/** |
| Location | web/src/location/** (plus a layer on the plan and a line on activity cards, by claim) |
| Teaching | web/src/teach/**, web/dashboard/teach/**, web/public/model/**, web/bucket/teach/** |
| Player and demo kit | web/src/player/**, web/dashboard/player/**, web/bucket/player/**, demo-kit/** |
| Deploy | web/scripts/deploy*, web/bucket/README.md |
| Journey harness | web/tests/ports.ts, web/tests/serve.ts, web/playwright.config.ts, web/tests/fixtures/** |
| Journeys | web/tests/e2e/<area>* (one file group per area above) |
| Sensor library | sensor-sdk/** |
| Firmware and board | mcu/**, soc/** |
| Experiments and model tooling | experiments/** |
| Brand masters | shared/assets/**, design/** |

## Additive-only hot files

Every slice may add to these; nobody restructures them. Add a line, a route, an
entry or a new file; never reorder, rename or rewrite what is there. A slice that
must restructure one sends a CLAIM with `edit: restructuring`.

- The Worker's route table (the one module that maps paths to handlers)
- The dashboard shell's navigation and layout
- web/migrations/: new timestamp-named files only, never edits to existing ones
- web/wrangler.jsonc (bindings), web/package.json (dependencies and scripts)
- web/build.py (copy steps), web/_headers
- web/tests/serve.ts (seed steps), web/README.md, README.md
- sensor-sdk/forestpulse_sensor/data/seed_sounds.json
