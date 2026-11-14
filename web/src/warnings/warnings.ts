// Warnings: a researcher sends one about a logging activity, the boards whose events make up that activity get the
// alarm on their next check-in reply and confirm what happened, and the activity's card lists every warning with
// each board's outcome (docs/device-api.md, "Warnings").
//
// A warning stores the newest event of its activity at sending and belongs to whichever activity holds that event
// now, so activities stay derived on read. Outcomes advance lazily: a board not picked up 15 s after sending reads as
// not delivered, and one delivered but not confirmed 15 s after delivery as no confirmation, on whatever request
// reads them; nothing runs on a timer.
import type { Env } from "../env.ts";
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { type Activity, type ActivityEvent, groupActivities } from "../activities/group.ts";
import { byName, isOnline, sensorNames } from "../sensors/plan.ts";

// Send warning shows while a logging activity goes on and this long after its last event.
export const WARN_WINDOW_MS = 5 * 60_000;
// A board gets the alarm only within this long of sending (it never plays late)...
export const PICKUP_MS = 15_000;
// ...and has this long from delivery to confirm. So every board has an outcome at most 30 s after sending.
export const CONFIRM_MS = 15_000;
const WARN_CATEGORY = "logging";
const MAX_REQUEST_ID = 100;

type Status = "pending" | "delivered" | "played" | "failed" | "not_delivered" | "no_buzzer" | "calibrating";
// What the card shows for a board; pending: on its way (not picked up, or not confirmed yet).
export type Outcome = "pending" | "played" | "failed" | "no_confirmation" | "not_delivered" | "no_buzzer" | "calibrating";

export interface WarningReply {
  id: string;
  sent_at: string;
  // Some board has no outcome yet; a Send for the same activity meanwhile is refused.
  on_its_way: boolean;
  // One per board, by name.
  outcomes: { sensor_id: string; sensor_name: string; outcome: Outcome }[];
}

interface TargetRow {
  id: string;
  event_id: number;
  sent_at: number;
  sensor_id: string | null;
  status: Status | null;
  delivered_at: number | null;
}

interface StoredWarning {
  id: string;
  event_id: number;
  sent_at: number;
  targets: { sensor_id: string; outcome: Outcome }[];
}

// A target with an outcome still to come, as SQL over warnings w and warning_targets t at the time bound to `now`.
const unsettled = (now: string) =>
  `((t.status = 'pending' AND w.sent_at > ${now} - ${PICKUP_MS})
    OR (t.status = 'delivered' AND t.delivered_at > ${now} - ${CONFIRM_MS}))`;

function outcome(status: Status, sentAt: number, deliveredAt: number | null, now: number): Outcome {
  if (status === "pending") return now - sentAt < PICKUP_MS ? "pending" : "not_delivered";
  if (status === "delivered") return now - (deliveredAt ?? sentAt) < CONFIRM_MS ? "pending" : "no_confirmation";
  return status;
}

// Every stored warning, oldest first, or only the one sent with requestId.
async function readWarnings(db: D1Database, now: number, requestId?: string): Promise<StoredWarning[]> {
  const rows = await db.prepare(
    `SELECT w.id, w.event_id, w.sent_at, t.sensor_id, t.status, t.delivered_at
     FROM warnings w LEFT JOIN warning_targets t ON t.warning_id = w.id
     WHERE ?1 IS NULL OR w.request_id = ?1
     ORDER BY w.sent_at, w.id`,
  ).bind(requestId ?? null).all<TargetRow>();
  const byId = new Map<string, StoredWarning>();
  for (const r of rows.results) {
    let w = byId.get(r.id);
    if (!w) {
      w = { id: r.id, event_id: r.event_id, sent_at: r.sent_at, targets: [] };
      byId.set(r.id, w);
    }
    if (r.sensor_id !== null && r.status !== null) {
      w.targets.push({ sensor_id: r.sensor_id, outcome: outcome(r.status, r.sent_at, r.delivered_at, now) });
    }
  }
  return [...byId.values()];
}

function toReply(w: StoredWarning, name: (id: string) => string): WarningReply {
  return {
    id: w.id,
    sent_at: new Date(w.sent_at).toISOString(),
    on_its_way: w.targets.some((t) => t.outcome === "pending"),
    outcomes: w.targets.map((t) => ({ sensor_id: t.sensor_id, sensor_name: name(t.sensor_id), outcome: t.outcome }))
      .sort((a, b) => byName(a.sensor_name, b.sensor_name)),
  };
}

// ---- activities ------------------------------------------------------------------------------------------------

// The warnings part of each activity in the activities reply: its newest event (what a Send names), whether Send
// warning shows now, and the warnings that belong to it, oldest first.
export async function activityWarnings(db: D1Database, now: number) {
  const warnings = await readWarnings(db, now);
  return (a: Activity, name: (id: string) => string) => {
    const ids = new Set(a.events.map((e) => e.id));
    return {
      newest_event_id: a.events[a.events.length - 1].id,
      warnable: warnable(a, now),
      warnings: warnings.filter((w) => ids.has(w.event_id)).map((w) => toReply(w, name)),
    };
  };
}

const warnable = (a: Activity, now: number) => a.category === WARN_CATEGORY && now - a.last_at < WARN_WINDOW_MS;

// Clear events deletes warnings with the events they belong to: these go in its batch.
export function clearWarnings(db: D1Database): D1PreparedStatement[] {
  return [db.prepare("DELETE FROM warning_targets"), db.prepare("DELETE FROM warnings")];
}

// ---- researchers -----------------------------------------------------------------------------------------------

// POST /dashboard/api/warnings with {"request_id", "event_id"}: sends a warning about the activity holding that event
// to the boards whose events make it up now. 201 {warning}; 200 {warning} when request_id already sent one (a retry);
// refusals are {error, reason}: 409 on_its_way while a warning about that activity is on its way, 409 closed when
// it is not a logging activity heard in the last 5 minutes, 404 gone when no activity holds the event, 400 invalid.
export async function sendWarning(request: Request, { env }: RouteContext): Promise<Response> {
  const db = env.DB;
  const now = Date.now();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // not JSON: refused below
  }
  const requestId = body.request_id;
  const eventId = body.event_id;
  if (typeof requestId !== "string" || !requestId || requestId.length > MAX_REQUEST_ID) {
    return refuse(400, "invalid", `request_id must be a string of 1 to ${MAX_REQUEST_ID} characters`);
  }
  if (typeof eventId !== "number" || !Number.isSafeInteger(eventId)) {
    return refuse(400, "invalid", "event_id must be an event's id");
  }
  const retried = await sentWith(db, requestId, now);
  if (retried) return json({ warning: retried });

  const events = await db.prepare("SELECT id, sensor_id, sound_name, category, occurred_at FROM events")
    .all<ActivityEvent>();
  const activity = groupActivities(events.results, Infinity).find((a) => a.events.some((e) => e.id === eventId));
  if (!activity) return refuse(404, "gone", "No activity holds that event");
  if (!warnable(activity, now)) return refuse(409, "closed", "Warnings are for logging heard in the last 5 minutes");

  const id = crypto.randomUUID();
  const newest = activity.events[activity.events.length - 1].id;
  const targets = await targetsFor(db, activity.sensors, now);
  // The warning only when no warning about this activity is on its way, and its boards only with it: one batch, so
  // two Sends at once make one warning.
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO warnings (id, request_id, event_id, sent_at)
       SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (
         SELECT 1 FROM warnings w JOIN warning_targets t ON t.warning_id = w.id
         WHERE w.event_id IN (SELECT value FROM json_each(?5)) AND ${unsettled("?4")})
       ON CONFLICT (request_id) DO NOTHING`,
    ).bind(id, requestId, newest, now, JSON.stringify(activity.events.map((e) => e.id))),
    ...targets.map((t) => db.prepare(
      `INSERT INTO warning_targets (warning_id, sensor_id, status)
       SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM warnings WHERE id = ?1)`,
    ).bind(id, t.sensor_id, t.status)),
  ]);
  if (!inserted.meta.changes) {
    const raced = await sentWith(db, requestId, now);
    if (raced) return json({ warning: raced });
    return refuse(409, "on_its_way", "A warning is on its way");
  }
  logLine("warning_sent", { warning: id, event: newest, targets });
  return json({ warning: (await sentWith(db, requestId, now))! }, 201);
}

function refuse(status: number, reason: "invalid" | "gone" | "closed" | "on_its_way", error: string) {
  return json({ error, reason }, status);
}

async function sentWith(db: D1Database, requestId: string, now: number): Promise<WarningReply | null> {
  const [w] = await readWarnings(db, now, requestId);
  if (!w) return null;
  return toReply(w, await sensorNames(db));
}

// Each board's starting status: no buzzer (its last check-in did not say it can warn), not delivered (offline now),
// calibrating (taking part in a calibration run), or pending.
async function targetsFor(db: D1Database, sensors: string[], now: number) {
  const [rows, calibrating] = await db.batch<unknown>([
    db.prepare("SELECT id, last_checkin_at, can_warn FROM sensors WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(sensors)),
    calibratingSensors(db),
  ]);
  const known = new Map((rows.results as { id: string; last_checkin_at: number; can_warn: number }[])
    .map((r) => [r.id, r]));
  const busy = new Set((calibrating.results as { sensor_id: string }[]).map((r) => r.sensor_id));
  return sensors.map((sensor_id) => {
    const s = known.get(sensor_id);
    const status: Status = !s || !s.can_warn ? "no_buzzer"
      : !isOnline(s.last_checkin_at, now) ? "not_delivered"
      : busy.has(sensor_id) ? "calibrating"
      : "pending";
    return { sensor_id, status };
  });
}

// The sensors taking part in the calibration run in progress (not left out of it).
function calibratingSensors(db: D1Database, sensor?: string) {
  return db.prepare(
    `SELECT p.sensor_id FROM calibration_participants p JOIN calibration_runs r ON r.id = p.run_id
     WHERE r.status IN ('waiting', 'scheduled') AND p.dropped = 0 AND (?1 IS NULL OR p.sensor_id = ?1)`,
  ).bind(sensor ?? null);
}

// ---- sensors ---------------------------------------------------------------------------------------------------

// The check-in's warning part: stores whether the sensor can warn, records its confirmation, and returns the alarm
// for its reply while a warning waits for it (null otherwise). The reply carries the alarm from the first pickup
// until the board confirms, at most 15 s after sending; the board plays each id once. A board that no longer says it
// can warn, or is calibrating, at pickup gets that outcome instead.
export async function warningCheckin(env: Env, sensorId: string, body: Record<string, unknown>, now: number) {
  const db = env.DB;
  const canWarn = body.can_warn === true ? 1 : 0;
  const done = confirmation(body.alarm_done);
  const results = await db.batch<unknown>([
    db.prepare("UPDATE sensors SET can_warn = ?2 WHERE id = ?1 AND can_warn IS NOT ?2").bind(sensorId, canWarn),
    ...(done ? [db.prepare(
      `UPDATE warning_targets SET status = ?3, confirmed_at = ?4
       WHERE warning_id = ?1 AND sensor_id = ?2 AND status = 'delivered' AND delivered_at > ?4 - ${CONFIRM_MS}`,
    ).bind(done.id, sensorId, done.result, now)] : []),
    db.prepare(
      `SELECT t.warning_id, t.status FROM warning_targets t JOIN warnings w ON w.id = t.warning_id
       WHERE t.sensor_id = ?1 AND ${unsettled("?2")} AND w.sent_at > ?2 - ${PICKUP_MS}
       ORDER BY w.sent_at, w.id`,
    ).bind(sensorId, now),
  ]);
  if (done && results[1].meta.changes) logLine("warning_confirmed", { warning: done.id, sensor: sensorId, result: done.result });
  const waiting = results[results.length - 1].results as { warning_id: string; status: Status }[];
  if (!waiting.length) return null;

  const skip: Status | null = !canWarn ? "no_buzzer"
    : (await calibratingSensors(db, sensorId).first()) ? "calibrating" : null;
  if (skip) {
    const pending = waiting.filter((w) => w.status === "pending");
    if (pending.length) await db.batch(pending.map((w) => db.prepare(
      "UPDATE warning_targets SET status = ?3 WHERE warning_id = ?1 AND sensor_id = ?2 AND status = 'pending'",
    ).bind(w.warning_id, sensorId, skip)));
    return null;
  }
  const first = waiting[0];
  if (first.status === "pending") {
    const delivered = await db.prepare(
      `UPDATE warning_targets SET status = 'delivered', delivered_at = ?3
       WHERE warning_id = ?1 AND sensor_id = ?2 AND status = 'pending'
         AND EXISTS (SELECT 1 FROM warnings WHERE id = ?1 AND sent_at > ?3 - ${PICKUP_MS})`,
    ).bind(first.warning_id, sensorId, now).run();
    if (!delivered.meta.changes) return null; // cleared, or another check-in under this id picked it up just now
    logLine("warning_delivered", { warning: first.warning_id, sensor: sensorId });
  }
  return { id: first.warning_id };
}

function confirmation(v: unknown): { id: string; result: "played" | "failed" } | null {
  if (typeof v !== "object" || v === null) return null;
  const { id, result } = v as Record<string, unknown>;
  if (typeof id !== "string" || (result !== "played" && result !== "failed")) return null;
  return { id, result };
}
