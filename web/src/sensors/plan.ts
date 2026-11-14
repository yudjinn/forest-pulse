// The sensors on the plan: where each stands and faces, whether it is online, and whether two running devices
// share its name. A sensor joins the plan on check-in (the check-in hook), researchers move, turn and remove it,
// and everything that needs a sensor's placement or online state reads it through readPlan.
// Plan metres: x to the right, y up. Facing: degrees clockwise from the plan's up, 0 to under 360.
import type { Env } from "../env.ts";
import type { SensorCheckin } from "../api/intake.ts";
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";

// A sensor is offline once this long has passed without a check-in. The one place the rule lives.
export const OFFLINE_AFTER_MS = 30_000;
// Two process identities checking in under one name within this window share the name.
export const SHARED_NAME_WINDOW_MS = 30_000;
// The default spot of each new sensor: this far to the right of the most recently added one on the plan, facing it.
const NEW_SENSOR_SPACING_M = 3;
// Positions beyond this many metres from the origin are refused.
const MAX_COORDINATE_M = 100_000;

export const isOnline = (lastCheckinAt: number, now: number) => now - lastCheckinAt < OFFLINE_AFTER_MS;

export interface PlanSensor {
  id: string;
  x_m: number;
  y_m: number;
  facing_deg: number;
  online: boolean;
  last_checkin_at: number;
  sdk_version: string | null;
  model: string | null;
  sound_list_version: number | null;
  // Two different running devices checked in under this name within the shared-name window.
  shared_name: boolean;
}

interface PlanRow extends Omit<PlanSensor, "online" | "shared_name"> {
  instances: number;
}

// The sensors on the plan (removed ones excluded), in the order they were added; only those named when ids is
// given. Online and the shared-name warning are judged at now.
export async function readPlan(db: D1Database, now: number, ids?: string[]): Promise<PlanSensor[]> {
  const rows = await db.prepare(
    `SELECT p.sensor_id AS id, p.x_m, p.y_m, p.facing_deg, s.last_checkin_at, s.sdk_version, s.model,
       s.sound_list_version,
       (SELECT COUNT(*) FROM sensor_instances i WHERE i.sensor_id = p.sensor_id AND i.last_checkin_at > ?1) AS instances
     FROM sensor_placements p JOIN sensors s ON s.id = p.sensor_id
     WHERE p.removed = 0 AND (?2 IS NULL OR p.sensor_id IN (SELECT value FROM json_each(?2)))
     ORDER BY p.seq`,
  ).bind(now - SHARED_NAME_WINDOW_MS, ids ? JSON.stringify(ids) : null).all<PlanRow>();
  return rows.results.map(({ instances, ...r }) => ({
    ...r,
    online: isOnline(r.last_checkin_at, now),
    shared_name: instances >= 2,
  }));
}

// Check-in hook: a sensor new to the plan gets its default spot (the first at the origin facing right, each later
// one 3 m to the right of the most recently added one still on the plan, facing it); a removed sensor comes back at
// its kept placement.
// One statement, so two first check-ins at once still get different spots. Then records the device identity.
export async function placeOnCheckin(env: Env, { current, now }: SensorCheckin): Promise<void> {
  const db = env.DB;
  const statements = [
    db.prepare(
      `INSERT INTO sensor_placements (sensor_id, x_m, y_m, facing_deg)
       SELECT ?1,
         COALESCE((SELECT x_m + ?2 FROM sensor_placements WHERE removed = 0 ORDER BY seq DESC LIMIT 1), 0),
         COALESCE((SELECT y_m FROM sensor_placements WHERE removed = 0 ORDER BY seq DESC LIMIT 1), 0),
         CASE WHEN EXISTS (SELECT 1 FROM sensor_placements WHERE removed = 0) THEN 270 ELSE 90 END
       WHERE true
       ON CONFLICT (sensor_id) DO UPDATE SET removed = 0 WHERE removed = 1`,
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

// GET /dashboard/api/sensors: the plan as researchers see it.
export async function listPlan(_request: Request, { env }: RouteContext): Promise<Response> {
  return json({ sensors: (await readPlan(env.DB, Date.now())).map(toJson) });
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
  const changed = await env.DB.prepare(
    `UPDATE sensor_placements SET x_m = COALESCE(?2, x_m), y_m = COALESCE(?3, y_m),
       facing_deg = COALESCE(?4, facing_deg)
     WHERE sensor_id = ?1 AND removed = 0 RETURNING sensor_id`,
  ).bind(params.sensor, x, y, facing).first();
  if (!changed) return json({ error: "no such sensor on the plan" }, 404);
  logLine("sensor_placed", { sensor: params.sensor, x_m: x, y_m: y, facing_deg: facing });
  const [sensor] = await readPlan(env.DB, Date.now(), [params.sensor]);
  if (!sensor) return json({ error: "no such sensor on the plan" }, 404); // removed between the two statements
  return json({ sensor: toJson(sensor) });
}

// DELETE /dashboard/api/sensors/:sensor: takes the sensor off the plan until it checks in again.
export async function removeSensor(_request: Request, { env, params }: RouteContext): Promise<Response> {
  const removed = await env.DB.prepare("UPDATE sensor_placements SET removed = 1 WHERE sensor_id = ? RETURNING sensor_id")
    .bind(params.sensor).first();
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
