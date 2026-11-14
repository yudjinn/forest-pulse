-- Warnings: a researcher sends one about a logging activity and the boards that heard it play the alarm.
-- Times are milliseconds since the epoch on the service's clock. Warnings are tied to events: Clear events
-- deletes them with the events.

-- Set at every check-in from the sensor's can_warn (its hooks include the buzzer); sensors that never send it cannot.
ALTER TABLE sensors ADD COLUMN can_warn INTEGER NOT NULL DEFAULT 0 CHECK (can_warn IN (0, 1));

-- One row per sent warning. request_id: the dashboard's, so a retried Send finds the warning it already made.
-- event_id: the newest event of the activity at sending; the warning belongs to whichever activity holds that event.
CREATE TABLE warnings (
  id TEXT PRIMARY KEY,           -- sent to the sensors on the check-in reply
  request_id TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL
);

CREATE INDEX warnings_by_event ON warnings (event_id);

-- Each board the warning went to. status: pending (not picked up yet), delivered (on its reply, not confirmed yet),
-- played or failed (its confirmation), not_delivered (offline at sending), no_buzzer, calibrating. A pending row 15 s
-- after sending reads as not delivered, and a delivered one 15 s after delivery as no confirmation; neither is
-- rewritten.
CREATE TABLE warning_targets (
  warning_id TEXT NOT NULL,
  sensor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'delivered', 'played', 'failed', 'not_delivered', 'no_buzzer', 'calibrating')),
  delivered_at INTEGER,
  confirmed_at INTEGER,
  PRIMARY KEY (warning_id, sensor_id)
) WITHOUT ROWID;

CREATE INDEX warning_targets_by_sensor ON warning_targets (sensor_id, status);
