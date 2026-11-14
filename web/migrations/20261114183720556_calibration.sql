-- Calibration: which sensors can take part, the runs and each participant's report, and which sensors the last
-- applied run placed (the measured layout). Times are milliseconds since the epoch on the service's clock.
-- Runs are not per-event rows: Clear events leaves them.

-- Set at every check-in from the sensor's calibration_capable; sensors that never send it are not capable.
ALTER TABLE sensors ADD COLUMN calibration_capable INTEGER NOT NULL DEFAULT 0 CHECK (calibration_capable IN (0, 1));

-- One row per pressed Calibrate, the latest 20 kept (and the applied one). status: waiting (for ready
-- confirmations), scheduled (start_at set: beeping from then), calibrated or failed.
CREATE TABLE calibration_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'scheduled', 'calibrated', 'failed')),
  created_at INTEGER NOT NULL,
  ready_deadline_at INTEGER NOT NULL,   -- without every ready confirmation by then, run with 2 or more or fail
  schedule TEXT NOT NULL,               -- JSON: slot_ms, round_gap_ms, rounds and the patterns by role
  start_at INTEGER,                     -- the first slot
  ends_at INTEGER,                      -- the end of the last slot
  report_deadline_at INTEGER,           -- a report missing by then fails the run
  finished_at INTEGER,
  result TEXT,                          -- JSON when calibrated: distances, positions, speed_of_sound_assumed
  failure TEXT                          -- JSON when failed: the sensors it names and the reason
);

CREATE INDEX calibration_runs_by_created_at ON calibration_runs (created_at);

-- The participants of a run, in plan order (seq) with their roles, and each one's report as it arrived. dropped: not
-- ready by the deadline while the run went ahead without it.
CREATE TABLE calibration_participants (
  run_id TEXT NOT NULL,
  sensor_id TEXT NOT NULL,
  role TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ready_at INTEGER,
  dropped INTEGER NOT NULL DEFAULT 0 CHECK (dropped IN (0, 1)),
  report TEXT,                          -- JSON, as validated
  reported_at INTEGER,
  PRIMARY KEY (run_id, sensor_id)
) WITHOUT ROWID;

-- The sensors the applied run placed, while the layout is measured. Empty when it is manual: a researcher moving,
-- turning or removing one of them empties it.
CREATE TABLE measured_layout (
  sensor_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL
) WITHOUT ROWID;
