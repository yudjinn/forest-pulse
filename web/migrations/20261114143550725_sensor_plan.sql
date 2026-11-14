-- Sensors on the plan: where each one stands and faces, and which running devices check in under each name.
-- Times are milliseconds since the epoch on the service's clock.

-- One row per sensor that has checked in since the plan existed. Plan metres, x to the right, y up; facing in
-- degrees clockwise from the plan's up. Removing a sensor keeps its placement for when it checks in again.
CREATE TABLE sensor_placements (
  seq INTEGER PRIMARY KEY,                     -- the order sensors were added to the plan
  sensor_id TEXT NOT NULL UNIQUE,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  facing_deg REAL NOT NULL CHECK (facing_deg >= 0 AND facing_deg < 360),
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1))
);

-- The process identities (instance_id) recently checking in under each sensor name; rows older than the
-- shared-name window are pruned at that sensor's next check-in.
CREATE TABLE sensor_instances (
  sensor_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  last_checkin_at INTEGER NOT NULL,
  PRIMARY KEY (sensor_id, instance_id)
) WITHOUT ROWID;
