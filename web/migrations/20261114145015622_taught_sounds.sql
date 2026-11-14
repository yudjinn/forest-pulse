-- Teaching: a researcher's taught sounds sit in the same sounds table as the seeded ones.
-- When a sound was taught, in ms since the epoch; null for a seeded sound. Reteach and delete apply to taught sounds only.
ALTER TABLE sounds ADD COLUMN taught_at INTEGER;
-- One sound per name, ignoring case, so a sound list never shows two sounds a researcher cannot tell apart.
CREATE UNIQUE INDEX sounds_by_name ON sounds (name COLLATE NOCASE);
