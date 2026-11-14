-- Sensor names: each sensor on the plan holds a number, shown as "Sensor N" (web/src/sensors/plan.ts). A sensor
-- gets the lowest number no other sensor on the plan holds when it joins or returns; a removed sensor keeps its
-- number so it can take it back if still free, so uniqueness holds among sensors on the plan only and there is no
-- unique index (a rolled-back Worker returning a removed sensor would trip it).

ALTER TABLE sensor_placements ADD COLUMN number INTEGER CHECK (number > 0);

-- The sensors on the plan now are numbered in the order they were added; removed ones get a number only when they
-- return.
UPDATE sensor_placements
SET number = (SELECT COUNT(*) FROM sensor_placements q WHERE q.removed = 0 AND q.seq <= sensor_placements.seq)
WHERE removed = 0;
