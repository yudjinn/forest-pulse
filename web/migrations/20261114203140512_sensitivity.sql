-- One detection sensitivity for every sound, set on the Sounds page and served as every sound's threshold
-- (web/src/sounds/AGENTS.md). It lives on the sound list's own row so a change and its version bump are one
-- statement. 0.5 is the threshold every sound was served with until now, so the served list is unchanged and the
-- version stays where it is.

ALTER TABLE sound_list ADD COLUMN sensitivity REAL NOT NULL DEFAULT 0.5 CHECK (sensitivity BETWEEN 0.2 AND 0.9);
