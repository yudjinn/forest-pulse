// What every sensor request shares: its body and clock offset, the sensor's registration, the current sound-list
// version, and the hooks later capabilities attach to (registered in routes.ts).
import type { Env } from "../env.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";

export interface SensorRow {
  id: string;
  instance_id: string | null;
  sdk_version: string | null;
  model: string | null;
  sound_list_version: number | null;
  queued_events: number | null;
  clock_offset_ms: number;
  first_seen_at: number;
  last_checkin_at: number;
}

// A sensor checked in, or posted events before ever checking in (then registered as if it had checked in, with
// no instance). previous is null the first time the service hears from it.
export interface SensorCheckin {
  previous: SensorRow | null;
  current: SensorRow;
  now: number;
}

export interface AcceptedEvent {
  id: number;
  sensor_id: string;
  event_id: string;
  sound_id: string;
  sound_name: string;
  category: string;
  confidence: number;
  angle_deg: number | null;
  angle_confidence: number | null;
  level_dbfs: number | null;
  occurred_at: number;
  received_at: number;
}

// Called after the change is stored, in registration order, before the sensor gets its reply. A hook that throws
// is logged and skipped: the sensor's delivery stands either way. Hooks must not depend on each other's side
// effects (the table is append-only, so their order is landing order); each reads what it needs from D1.
export interface IntakeHooks {
  sensorCheckedIn: Array<(env: Env, checkin: SensorCheckin) => Promise<void>>;
  eventsAccepted: Array<(env: Env, events: AcceptedEvent[]) => Promise<void>>;
}

export async function runHooks<T>(hooks: Array<(env: Env, arg: T) => Promise<void>>, env: Env, arg: T, name: string) {
  for (const hook of hooks) {
    try {
      await hook(env, arg);
    } catch (e) {
      logLine("hook_failed", { hook: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export const MAX_SENSOR_ID = 253; // a full hostname, the library's default id

export function badRequest(reason: string, sensor: string | undefined): Response {
  logLine("sensor_request", { decision: "rejected", sensor, reason });
  return json({ error: reason }, 400);
}

// A sensor request body: a JSON object with sent_at, the sensor's clock when sending. Returns the body and the clock
// offset (service receive time minus sent_at), or the 400 reply.
export async function readBody(request: Request, sensor: string, receivedAt: number):
  Promise<{ body: Record<string, unknown>; offsetMs: number } | Response> {
  if (sensor.length > MAX_SENSOR_ID) return badRequest("sensor_id is too long", undefined);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("body is not JSON", sensor);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("body is not a JSON object", sensor);
  }
  const sentAt = parseTime((body as Record<string, unknown>).sent_at);
  if (sentAt === null) return badRequest("sent_at missing or not a UTC time", sensor);
  return { body: body as Record<string, unknown>, offsetMs: receivedAt - sentAt };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

// A UTC ISO 8601 time (milliseconds optional) as milliseconds since the epoch, or null.
export function parseTime(v: unknown): number | null {
  if (typeof v !== "string" || !ISO_UTC.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export async function soundListVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT version FROM sound_list WHERE id = 1").first<{ version: number }>();
  return row?.version ?? 0;
}

export interface CheckinFields {
  instance_id: string | null;
  sdk_version: string | null;
  model: string | null;
  sound_list_version: number | null;
  queued_events: number | null;
  clock_offset_ms: number;
}

// Records that a sensor was heard from now, creating it on first contact, then runs the check-in hooks.
export async function registerSensor(env: Env, hooks: IntakeHooks, id: string, fields: CheckinFields, now: number) {
  const previous = await env.DB.prepare("SELECT * FROM sensors WHERE id = ?").bind(id).first<SensorRow>();
  const current = await env.DB.prepare(
    `INSERT INTO sensors (id, instance_id, sdk_version, model, sound_list_version, queued_events, clock_offset_ms,
       first_seen_at, last_checkin_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT (id) DO UPDATE SET instance_id = excluded.instance_id, sdk_version = excluded.sdk_version,
       model = excluded.model, sound_list_version = excluded.sound_list_version,
       queued_events = excluded.queued_events, clock_offset_ms = excluded.clock_offset_ms,
       last_checkin_at = excluded.last_checkin_at
     RETURNING *`,
  ).bind(id, fields.instance_id, fields.sdk_version, fields.model, fields.sound_list_version, fields.queued_events,
    Math.round(fields.clock_offset_ms), now).first<SensorRow>();
  if (!current) throw new Error("sensor upsert returned no row");
  await runHooks(hooks.sensorCheckedIn, env, { previous, current, now }, "sensorCheckedIn");
  return current;
}
