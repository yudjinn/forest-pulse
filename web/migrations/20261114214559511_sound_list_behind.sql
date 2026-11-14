-- How many check-ins in a row each sensor has reported a sound list other than the current one (never fetched
-- included), reset to 0 when it reports the current one. Only check-ins move it, never event deliveries, so the
-- plan's "Outdated sound list" threshold counts check-ins whatever a board's interval (web/src/sensors/plan.ts).
-- Existing sensors start at 0: one still on an older list shows "Updating" until its next check-ins settle it.

ALTER TABLE sensors ADD COLUMN sound_list_behind INTEGER NOT NULL DEFAULT 0;
