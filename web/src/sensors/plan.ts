// The sensors on the plan: where each stands and faces, its name, whether it is online, whether two running
// devices share its id, and whether it has the current sound list. A sensor joins the plan on check-in (the check-in hook), researchers move, turn and remove
// it, and everything that needs a sensor's placement or online state reads it through readPlan; everything that
// shows a sensor to researchers names it through sensorNames.
// Plan metres: x to the right, y up. Facing: degrees clockwise from the plan's up, 0 to under 360.
import type { Env } from "../env.ts";
import { type SensorCheckin, soundListVersion } from "../api/intake.ts";
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { clearMeasuredMark } from "../calibration/layout.ts";

// A sensor is offline once this long has passed without a check-in. The one place the rule lives. Boards check in
// every 3 s (the sensor library's default), so a board misses about three check-ins before it shows offline.
export const OFFLINE_AFTER_MS = 10_000;
// Two process identities checking in under one name within this window share the name.
export const SHARED_NAME_WINDOW_MS = 10_000;
// The default spot of each new sensor: this far to the right of the most recently added one on the plan, facing it.
const NEW_SENSOR_SPACING_M = 3;
// Positions beyond this many metres from the origin are refused.
const MAX_COORDINATE_M = 100_000;

export const isOnline = (lastCheckinAt: number, now: number) => now - lastCheckinAt < OFFLINE_AFTER_MS;

// A sensor behind on the sound list for this many check-ins in a row is outdated rather than updating. Counted in
// check-ins, not time, so it holds whatever a board's interval.
export const OUTDATED_AFTER_CHECKINS = 3;

// Whether a sensor has the current sound list. Behind means its last check-in reported any other version, or none
// (it never fetched one): "updating" while it is online and has been behind for fewer than 3 check-ins, "outdated"
// once it has been behind for 3 or more, or is offline. The one place the rule lives.
export type SoundListState = "current" | "updating" | "outdated";
export function soundListState(reported: number | null, current: number, behindCheckins: number, online: boolean):
  SoundListState {
  if (reported === current) return "current";
  return online && behindCheckins < OUTDATED_AFTER_CHECKINS ? "updating" : "outdated";
}

// Check-in only (never an event delivery): counts the check-in the sensor just stored as behind or resets the count
// when it reported the current version, and returns the current version for the reply, in one batch so the count
// and the reply judge the same version.
export async function noteSoundListCheckin(db: D1Database, id: string): Promise<number> {
  const [, list] = await db.batch([
    db.prepare(
      `UPDATE sensors SET sound_list_behind = CASE
         WHEN sound_list_version IS (SELECT version FROM sound_list WHERE id = 1) THEN 0 ELSE sound_list_behind + 1 END
       WHERE id = ?`,
    ).bind(id),
    db.prepare("SELECT version FROM sound_list WHERE id = 1"),
  ]);
  return (list.results[0] as { version: number } | undefined)?.version ?? 0;
}

// How far the current sound list has reached: the sensors on the plan, online or not, and how many of them last
// reported the current version. A statement, so a caller reads it in the same batch as the version it counts against.
export const soundListReach = (db: D1Database) => db.prepare(
  `SELECT COUNT(*) AS sensors,
     COALESCE(SUM(s.sound_list_version IS (SELECT version FROM sound_list WHERE id = 1)), 0) AS reached
   FROM sensor_placements p JOIN sensors s ON s.id = p.sensor_id WHERE p.removed = 0`,
);

export interface PlanSensor {
  id: string;
  // The lowest number not held by another sensor on the plan when it joined or returned; null only in the moment
  // between the numbering migration and this code going live, until its next check-in.
  number: number | null;
  // What researchers see: "Sensor N", or the id while it has no number.
  name: string;
  x_m: number;
  y_m: number;
  facing_deg: number;
  online: boolean;
  last_checkin_at: number;
  sdk_version: string | null;
  model: string | null;
  sound_list_version: number | null;
  // Two different running devices checked in under this id within the shared-name window.
  shared_name: boolean;
  // Whether it has the current sound list (soundListState).
  sound_list: SoundListState;
}

interface PlanRow extends Omit<PlanSensor, "name" | "online" | "shared_name" | "sound_list"> {
  instances: number;
  sound_list_behind: number;
  current_version: number;
}

// The sensors on the plan (removed ones excluded), by number, so "plan order" is Sensor 1 first; only those named
// when ids is given. Online, the shared-name warning and the sound-list state are judged at now.
export async function readPlan(db: D1Database, now: number, ids?: string[]): Promise<PlanSensor[]> {
  const rows = await db.prepare(
    `SELECT p.sensor_id AS id, p.number, p.x_m, p.y_m, p.facing_deg, s.last_checkin_at, s.sdk_version, s.model,
       s.sound_list_version, s.sound_list_behind, (SELECT version FROM sound_list WHERE id = 1) AS current_version,
       (SELECT COUNT(*) FROM sensor_instances i WHERE i.sensor_id = p.sensor_id AND i.last_checkin_at > ?1) AS instances
     FROM sensor_placements p JOIN sensors s ON s.id = p.sensor_id
     WHERE p.removed = 0 AND (?2 IS NULL OR p.sensor_id IN (SELECT value FROM json_each(?2)))
     ORDER BY p.number IS NULL, p.number, p.seq`,
  ).bind(now - SHARED_NAME_WINDOW_MS, ids ? JSON.stringify(ids) : null).all<PlanRow>();
  return rows.results.map(({ instances, sound_list_behind, current_version, ...r }) => {
    const online = isOnline(r.last_checkin_at, now);
    return {
      ...r,
      name: r.number === null ? r.id : sensorName(r.number),
      online,
      shared_name: instances >= 2,
      sound_list: soundListState(r.sound_list_version, current_version, sound_list_behind, online),
    };
  });
}

// The name researchers see for the sensor holding this number on the plan.
export const sensorName = (number: number) => `Sensor ${number}`;

// How each sensor is named right now: a sensor on the plan by its number ("Sensor N"), any other (removed, or never
// checked in) by its own id. Worked out on every read and never stored, so a removed sensor's past events show its
// id and show its name again once it returns.
export async function sensorNames(db: D1Database): Promise<(id: string) => string> {
  const rows = await db.prepare(
    "SELECT sensor_id, number FROM sensor_placements WHERE removed = 0 AND number IS NOT NULL",
  ).all<{ sensor_id: string; number: number }>();
  const names = new Map(rows.results.map((r) => [r.sensor_id, sensorName(r.number)]));
  return (id) => names.get(id) ?? id;
}

// Orders names for listing, alphabetically with numbers by value: Sensor 2 before Sensor 10.
export const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

// The lowest number no sensor on the plan holds.
const LOWEST_FREE_NUMBER = `(SELECT MIN(n) FROM
  (SELECT 1 AS n UNION ALL SELECT number + 1 FROM sensor_placements WHERE removed = 0 AND number IS NOT NULL)
  WHERE n NOT IN (SELECT number FROM sensor_placements WHERE removed = 0 AND number IS NOT NULL))`;

// Check-in hook: a sensor new to the plan gets its default spot (the first at the origin facing right, each later
// one 3 m to the right of the most recently added one still on the plan, facing it) and the lowest free number; a
// removed sensor comes back at its kept placement, with its old number when no sensor on the plan holds it and the
// lowest free one otherwise. A sensor already on the plan keeps its number.
// One statement, so two first check-ins at once still get different spots and numbers. Then records the device
// identity.
export async function placeOnCheckin(env: Env, { current, now }: SensorCheckin): Promise<void> {
  const db = env.DB;
  const statements = [
    db.prepare(
      `INSERT INTO sensor_placements (sensor_id, x_m, y_m, facing_deg, number)
       SELECT ?1,
         COALESCE((SELECT x_m + ?2 FROM sensor_placements WHERE removed = 0 ORDER BY seq DESC LIMIT 1), 0),
         COALESCE((SELECT y_m FROM sensor_placements WHERE removed = 0 ORDER BY seq DESC LIMIT 1), 0),
         CASE WHEN EXISTS (SELECT 1 FROM sensor_placements WHERE removed = 0) THEN 270 ELSE 90 END,
         ${LOWEST_FREE_NUMBER}
       WHERE true
       ON CONFLICT (sensor_id) DO UPDATE SET removed = 0,
         number = CASE WHEN number IS NOT NULL AND NOT EXISTS
             (SELECT 1 FROM sensor_placements o WHERE o.removed = 0 AND o.number = sensor_placements.number)
           THEN number ELSE excluded.number END
       WHERE removed = 1 OR number IS NULL`,
    ).bind(current.id, NEW_SENSOR_SPACING_M),
  ];
  if (current.instance_id) {
    statements.push(
      db.prepare(
        `INSERT INTO sensor_instances (sensor_id, instance_id, last_checkin_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (sensor_id, instance_id) DO UPDATE SET last_checkin_at = excluded.last_checkin_at`,
      ).bind(current.id, current.instance_id, now),
      db.prepare("DELETE FROM sensor_instances WHERE sensor_id = ?1 AND last_checkin_at <= ?2")
        .bind(current.id, now - SHARED_NAME_WINDOW_MS),
    );
  }
  await db.batch(statements);
}

// GET /dashboard/api/sensors: the plan as researchers see it, with the current sound-list version each sensor's
// sound_list state is judged against.
export async function listPlan(_request: Request, { env }: RouteContext): Promise<Response> {
  const [sensors, version] = await Promise.all([readPlan(env.DB, Date.now()), soundListVersion(env.DB)]);
  return json({ sound_list_version: version, sensors: sensors.map(toJson) });
}

// PATCH /dashboard/api/sensors/:sensor with {"x_m", "y_m"} (both together), {"facing_deg"}, or all three. Each field
// is saved on its own, so one researcher moving a sensor and another turning it both stand; the last write of a field
// wins. A facing outside 0 to 360 is normalised. Replies with the sensor.
export async function placeSensor(request: Request, { env, params }: RouteContext): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // not JSON: refused below
  }
  const hasPosition = "x_m" in body || "y_m" in body;
  const hasFacing = "facing_deg" in body;
  if (!hasPosition && !hasFacing) return json({ error: "nothing to change: send x_m and y_m, or facing_deg" }, 400);
  if (hasPosition && (!coordinate(body.x_m) || !coordinate(body.y_m))) {
    return json({ error: `x_m and y_m must both be numbers within ${MAX_COORDINATE_M} m` }, 400);
  }
  if (hasFacing && !finite(body.facing_deg)) return json({ error: "facing_deg must be a number" }, 400);

  const x = hasPosition ? round(body.x_m as number, 3) : null;
  const y = hasPosition ? round(body.y_m as number, 3) : null;
  const facing = hasFacing ? normaliseFacing(body.facing_deg as number) : null;
  // A manual edit of a sensor the measured layout placed makes the layout manual again, in the same batch.
  const [update] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE sensor_placements SET x_m = COALESCE(?2, x_m), y_m = COALESCE(?3, y_m),
         facing_deg = COALESCE(?4, facing_deg)
       WHERE sensor_id = ?1 AND removed = 0 RETURNING sensor_id`,
    ).bind(params.sensor, x, y, facing),
    clearMeasuredMark(env.DB, params.sensor),
  ]);
  const changed = update.results[0];
  if (!changed) return json({ error: "no such sensor on the plan" }, 404);
  logLine("sensor_placed", { sensor: params.sensor, x_m: x, y_m: y, facing_deg: facing });
  const [sensor] = await readPlan(env.DB, Date.now(), [params.sensor]);
  if (!sensor) return json({ error: "no such sensor on the plan" }, 404); // removed between the two statements
  return json({ sensor: toJson(sensor) });
}

// DELETE /dashboard/api/sensors/:sensor: takes the sensor off the plan until it checks in again.
export async function removeSensor(_request: Request, { env, params }: RouteContext): Promise<Response> {
  const [update] = await env.DB.batch([
    env.DB.prepare("UPDATE sensor_placements SET removed = 1 WHERE sensor_id = ? RETURNING sensor_id").bind(params.sensor),
    clearMeasuredMark(env.DB, params.sensor),
  ]);
  const removed = update.results[0];
  if (!removed) return json({ error: "no such sensor on the plan" }, 404);
  logLine("sensor_removed", { sensor: params.sensor });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// 0 to under 360, to a tenth of a degree.
export function normaliseFacing(deg: number): number {
  const r = round(((deg % 360) + 360) % 360, 1);
  return r >= 360 ? 0 : r;
}

const toJson = (s: PlanSensor) => ({ ...s, last_checkin_at: new Date(s.last_checkin_at).toISOString() });
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const coordinate = (v: unknown) => finite(v) && Math.abs(v) <= MAX_COORDINATE_M;
const round = (v: number, places: number) => {
  const r = Math.round(v * 10 ** places) / 10 ** places;
  return r === 0 ? 0 : r; // never -0
};
