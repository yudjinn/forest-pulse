-- How loud a sensor heard each event (dBFS, the loudest 100 ms on its loudest mic; library 0.7.1 and later). When
-- only one sensor of a pair can tell direction, the two levels place the sound along that sensor's line.
ALTER TABLE events ADD COLUMN level_dbfs REAL;
