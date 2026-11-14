-- Where each event's sound came from, fixed when the event arrived (web/src/location/location.ts). Plan metres,
-- x to the right, y up; directions in degrees clockwise from the plan's up, 0 to under 360.

-- The direction line: the sensor's plan position at arrival and its facing plus the event's angle. NULL when the
-- event has no angle or its sensor was not on the plan.
ALTER TABLE events ADD COLUMN line_x_m REAL;
ALTER TABLE events ADD COLUMN line_y_m REAL;
ALTER TABLE events ADD COLUMN line_deg REAL;

-- The crossing with its partner's line (an event of the same sound from another online sensor within 3 s), with
-- the distance from this event's sensor and from the partner's. NULL when unpaired or the lines did not cross in
-- front of both sensors.
ALTER TABLE events ADD COLUMN location_x_m REAL;
ALTER TABLE events ADD COLUMN location_y_m REAL;
ALTER TABLE events ADD COLUMN location_partner_id INTEGER;
ALTER TABLE events ADD COLUMN location_partner_sensor TEXT;
ALTER TABLE events ADD COLUMN location_distance_m REAL;
ALTER TABLE events ADD COLUMN location_partner_distance_m REAL;

-- Pairing looks up recent events of one sound by corrected time; the plan reads the lines of the last 15 s.
CREATE INDEX events_sound_time ON events (sound_id, occurred_at);
CREATE INDEX events_line_time ON events (occurred_at) WHERE line_deg IS NOT NULL;
