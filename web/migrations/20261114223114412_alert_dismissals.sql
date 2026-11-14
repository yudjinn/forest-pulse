-- Alert dismissals: a researcher dismisses the logging banner about an activity, and it is gone for every
-- researcher. Like a warning, a dismissal stores its activity's newest event id at dismissing and belongs to
-- whichever activity holds that event when read. Clear events deletes them with the events.
CREATE TABLE alert_dismissals (
  event_id INTEGER PRIMARY KEY,
  dismissed_at INTEGER NOT NULL  -- milliseconds since the epoch on the service's clock
);
