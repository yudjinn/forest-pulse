# Architecture decisions

One line per ADR, grouped by the code area it mainly governs. Per-folder AGENTS.md files reference ADRs by id (`ADR-<id>`) so the reasoning can be read on demand. Maintenance: append a one-line entry below when a new ADR lands; the `archive` and `grill` skills do this automatically.

## System-wide

- 20261114110501489 - EfficientAT mn10 as the fixed sound model, with small trained detectors on top
- 20261114110501527 - Server and dashboard on Cloudflare; teaching computes embeddings in the browser
- 20261114112557541 - Sensors send a label and a direction angle, never audio
- 20261114163418130 - Every stored record stays in the EU jurisdiction
- 20261114171057932 - Sensor layout is measured acoustically and is relative to the sensors

## Service (web/src)

- 20261114163418117 - Activities are derived on read; directions and locations are fixed at arrival
