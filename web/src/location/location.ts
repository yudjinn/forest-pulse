// Where a sound came from. When an event with an angle arrives, its direction line on the plan (the sensor's facing
// plus the angle, from where the sensor stands) is stored with it; when another online sensor heard the same sound
// within 3 s, the point where the two lines cross is stored too. Both are fixed at arrival, from the placement and
// online state at that moment, so later placement edits or a sensor going offline never move what was shown.
import type { Env } from "../env.ts";
import type { AcceptedEvent } from "../api/intake.ts";
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { byName, readPlan, sensorNames } from "../sensors/plan.ts";
import { type Candidate, choosePartner, crossing, directionDeg, normaliseDeg, PAIR_WINDOW_MS } from "./geometry.ts";

// Lines and points show on the plan for this long after the event's corrected time.
export const SHOW_FOR_MS = 15_000;

interface StoredLine extends Candidate {
  sensor_id: string;
  line_x_m: number;
  line_y_m: number;
  line_deg: number;
}

// Events-accepted hook. One request's events all come from one sensor; every line is stored before any pairing,
// so two sensors' deliveries arriving together still find each other.
export async function locateOnArrival(env: Env, events: AcceptedEvent[]): Promise<void> {
  const db = env.DB;
  const plan = await readPlan(db, Date.now());
  const placed = new Map(plan.map((s) => [s.id, s]));
  const lines = events.flatMap((e) => {
    const s = placed.get(e.sensor_id);
    if (e.angle_deg === null || !s) return [];
    const deg = normaliseDeg(round(directionDeg(s.facing_deg, e.angle_deg), 2));
    // The posting sensor is evidently alive: events delivered after a Wi-Fi drop can arrive before the check-in
    // that would show it online again, and must still find their partner.
    return [{ event: e, online: true, x_m: s.x_m, y_m: s.y_m, deg }];
  });
  if (!lines.length) return;
  await db.batch(lines.map((l) =>
    db.prepare("UPDATE events SET line_x_m = ?2, line_y_m = ?3, line_deg = ?4 WHERE id = ?1")
      .bind(l.event.id, l.x_m, l.y_m, l.deg)));

  // One query per line and one write per crossing, each set in a single batch, so a backlog delivery of many
  // events costs two round trips rather than two per event.
  const online = JSON.stringify(plan.filter((s) => s.online).map((s) => s.id));
  const pairing = lines.filter((l) => l.online);
  if (!pairing.length) return;
  const found = await db.batch<StoredLine>(pairing.map(({ event: e }) => db.prepare(
    `SELECT id, sensor_id, angle_confidence, occurred_at, line_x_m, line_y_m, line_deg FROM events
     WHERE sound_id = ?1 AND sensor_id != ?2 AND line_deg IS NOT NULL AND occurred_at BETWEEN ?3 AND ?4
       AND sensor_id IN (SELECT value FROM json_each(?5))`,
  ).bind(e.sound_id, e.sensor_id, e.occurred_at - PAIR_WINDOW_MS, e.occurred_at + PAIR_WINDOW_MS, online)));
  const located = pairing.flatMap((l, i) => {
    const e = l.event;
    const partner = choosePartner(found[i].results);
    if (!partner) return [];
    const point = crossing(l, { x_m: partner.line_x_m, y_m: partner.line_y_m, deg: partner.line_deg });
    logLine("event_located", {
      event: e.id, sensor: e.sensor_id, partner: partner.id, partner_sensor: partner.sensor_id, crossed: point !== null,
    });
    if (!point) return [];
    return [db.prepare(
      `UPDATE events SET location_x_m = ?2, location_y_m = ?3, location_partner_id = ?4, location_partner_sensor = ?5,
         location_distance_m = ?6, location_partner_distance_m = ?7 WHERE id = ?1`,
    ).bind(e.id, round(point.x_m, 3), round(point.y_m, 3), partner.id, partner.sensor_id,
      round(point.distance_a_m, 3), round(point.distance_b_m, 3))];
  });
  if (located.length) await db.batch(located);
}

interface ShownRow {
  id: number;
  sensor_id: string;
  occurred_at: number;
  line_x_m: number;
  line_y_m: number;
  line_deg: number;
  location_x_m: number | null;
  location_y_m: number | null;
  location_partner_id: number | null;
  location_partner_sensor: string | null;
  location_distance_m: number | null;
  location_partner_distance_m: number | null;
  partner_x_m: number | null;
  partner_y_m: number | null;
}

// GET /dashboard/api/locations: the lines and crossing points to show now, with the service's clock so the page
// can take each one down when its time is up. Each names its sensors as shown now.
export async function listLocations(_request: Request, { env }: RouteContext): Promise<Response> {
  const now = Date.now();
  const name = await sensorNames(env.DB);
  const rows = await env.DB.prepare(
    `SELECT e.id, e.sensor_id, e.occurred_at, e.line_x_m, e.line_y_m, e.line_deg, e.location_x_m, e.location_y_m,
       e.location_partner_id, e.location_partner_sensor, e.location_distance_m, e.location_partner_distance_m,
       p.line_x_m AS partner_x_m, p.line_y_m AS partner_y_m
     FROM events e LEFT JOIN events p ON p.id = e.location_partner_id
     WHERE e.line_deg IS NOT NULL AND e.occurred_at > ?1
     ORDER BY e.occurred_at, e.id`,
  ).bind(now - SHOW_FOR_MS).all<ShownRow>();
  const located = new Map(rows.results.filter((r) => r.location_partner_id !== null).map((r) => [r.id, r]));
  const points = [];
  for (const r of located.values()) {
    if (r.location_x_m === null || r.location_y_m === null || r.partner_x_m === null || r.partner_y_m === null) continue;
    // Both events of a pair can hold the same crossing; it is shown once.
    const back = located.get(r.location_partner_id as number);
    if (back && back.location_partner_id === r.id && back.id < r.id) continue;
    points.push({
      x_m: r.location_x_m,
      y_m: r.location_y_m,
      occurred_at: r.occurred_at,
      from: [
        { sensor_id: r.sensor_id, x_m: r.line_x_m, y_m: r.line_y_m, distance_m: r.location_distance_m },
        { sensor_id: r.location_partner_sensor, x_m: r.partner_x_m, y_m: r.partner_y_m,
          distance_m: r.location_partner_distance_m },
      ].map(named(name)).sort(bySensor),
    });
  }
  return json({
    now,
    lines: rows.results.map((r) => ({
      event_id: r.id, sensor_id: r.sensor_id, sensor_name: name(r.sensor_id), x_m: r.line_x_m, y_m: r.line_y_m,
      direction_deg: r.line_deg,
      occurred_at: r.occurred_at,
    })),
    points,
  });
}

// The stored location columns an activity read selects alongside its own.
export const LOCATION_COLUMNS =
  "location_x_m, location_y_m, location_partner_sensor, location_distance_m, location_partner_distance_m";

export interface LocationColumns {
  sensor_id: string;
  location_x_m: number | null;
  location_y_m: number | null;
  location_partner_sensor: string | null;
  location_distance_m: number | null;
  location_partner_distance_m: number | null;
}

// An activity's latest location: the crossing of its most recent located event (events oldest first), or null.
// name gives each sensor's name as shown now.
export function latestLocation(events: readonly LocationColumns[], name: (id: string) => string) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.location_x_m === null || e.location_y_m === null) continue;
    const distances = [
      { sensor_id: e.sensor_id, distance_m: e.location_distance_m },
      { sensor_id: e.location_partner_sensor, distance_m: e.location_partner_distance_m },
    ].map(named(name)).sort(bySensor);
    return { x_m: e.location_x_m, y_m: e.location_y_m, distances };
  }
  return null;
}

// Adds each sensor's name as shown now; a partner whose id is missing is named by nothing.
const named = (name: (id: string) => string) => <T extends { sensor_id: string | null }>(f: T) =>
  ({ ...f, sensor_name: f.sensor_id === null ? null : name(f.sensor_id) });

// Distances are listed by sensor name, so a pair reads the same whichever event arrived first.
const bySensor = (a: { sensor_name: string | null }, b: { sensor_name: string | null }) =>
  byName(a.sensor_name ?? "", b.sensor_name ?? "");

const round = (v: number, places: number) => {
  const r = Math.round(v * 10 ** places) / 10 ** places;
  return r === 0 ? 0 : r;
};
