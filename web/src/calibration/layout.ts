// The measured layout's mark: the sensors the applied calibration run placed (table measured_layout). The plan is a
// measured layout while it lists any; calibration.ts sets it when a run is applied.

// The statement a manual edit of a sensor (move, nudge, facing, removal) runs in the same batch: if the sensor is one
// the measured layout placed, the layout is manual again. Edits to other sensors leave it measured.
export function clearMeasuredMark(db: D1Database, sensorId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM measured_layout WHERE EXISTS (SELECT 1 FROM measured_layout WHERE sensor_id = ?1)")
    .bind(sensorId);
}
