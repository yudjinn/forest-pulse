-- The sound list holds trained detectors only: the model's built-in labels seeded at the start (Tools, Power tool,
-- Vehicle, Engine, Aircraft, Gunshot) are deleted, because they hear the hall poorly. A taught sound is never touched.
-- Bumping the version makes every sensor fetch the new list.

DELETE FROM sounds WHERE kind = 'label' AND taught_at IS NULL;
UPDATE sound_list SET version = version + 1 WHERE id = 1;
