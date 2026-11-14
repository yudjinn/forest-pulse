-- Service core: the sounds sensors report, the sensors that checked in, and their events.
-- Times are milliseconds since the epoch on the service's clock unless a column says otherwise.

-- Every sound a sensor may be told to report. Only enabled sounds are sent to sensors.
CREATE TABLE sounds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('logging', 'vehicle', 'poaching', 'wildlife')),
  kind TEXT NOT NULL CHECK (kind IN ('detector', 'label')),
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  label TEXT,    -- kind = label: the sound model's built-in class name
  weights TEXT,  -- kind = detector: JSON array of 960 numbers
  bias REAL      -- kind = detector
);

-- One global version of the sound list; any change to sounds increments it.
CREATE TABLE sound_list (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

CREATE TABLE sensors (
  id TEXT PRIMARY KEY,           -- chosen by the sensor
  instance_id TEXT,              -- random per sensor process start; null until its first check-in
  sdk_version TEXT,
  model TEXT,
  sound_list_version INTEGER,
  queued_events INTEGER,
  clock_offset_ms INTEGER NOT NULL DEFAULT 0,  -- service receive time minus the sensor's sent_at, last request
  first_seen_at INTEGER NOT NULL,
  last_checkin_at INTEGER NOT NULL
);

-- Accepted events. Sound name and category are copied at ingest so history survives a sound's deletion.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  sensor_id TEXT NOT NULL,
  event_id TEXT NOT NULL,        -- chosen by the sensor; unique per sensor
  sound_id TEXT NOT NULL,
  sound_name TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  angle_deg REAL,                -- 0 to 360, stored modulo 360
  angle_confidence REAL,
  detected_at TEXT NOT NULL,     -- as sent, on the sensor's clock
  occurred_at INTEGER NOT NULL,  -- detected_at corrected by the request's clock offset
  received_at INTEGER NOT NULL,
  UNIQUE (sensor_id, event_id)
);

CREATE INDEX events_by_occurred_at ON events (occurred_at);
