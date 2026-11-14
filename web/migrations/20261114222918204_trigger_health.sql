-- Each sensor's trigger health as its latest check-in reported it (docs/device-api.md, "Trigger health"): bursts in
-- the last minute, the front-end's trigger values and its noise floor. Each check-in replaces all five, so a value
-- the board stopped reporting is null; event deliveries never touch them (web/src/sensors/plan.ts). Null on every
-- existing sensor and on boards older than library 0.5.0.

ALTER TABLE sensors ADD COLUMN recordings_per_min INTEGER;
ALTER TABLE sensors ADD COLUMN trigger_snr_db REAL;
ALTER TABLE sensors ADD COLUMN trigger_ratio_db REAL;
ALTER TABLE sensors ADD COLUMN trigger_coherence REAL;
ALTER TABLE sensors ADD COLUMN noise_floor_dbfs REAL;
