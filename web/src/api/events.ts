// Batched events (docs/device-api.md): one result per event, in order, and the current sound-list version.
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { type AcceptedEvent, badRequest, parseTime, readBody, registerSensor, runHooks, soundListVersion } from "./intake.ts";

export const MAX_EVENTS = 100;
const MAX_EVENT_ID = 128;

type Result =
  | { event_id: string | null; status: "accepted" | "duplicate" | "dropped" }
  | { event_id: string | null; status: "rejected"; reason: string };

interface ValidEvent {
  event_id: string;
  sound_id: string;
  detected_at: string;
  detected_ms: number;
  confidence: number;
  angle_deg: number | null;
  angle_confidence: number | null;
  level_dbfs: number | null;
}

export async function postEvents(request: Request, { env, params, hooks }: RouteContext): Promise<Response> {
  const receivedAt = Date.now();
  const sensor = params.sensor;
  const read = await readBody(request, sensor, receivedAt);
  if (read instanceof Response) return read;
  const { body, offsetMs } = read;
  const events = body.events;
  if (!Array.isArray(events)) return badRequest("events must be a list", sensor);
  if (events.length > MAX_EVENTS) return badRequest(`more than ${MAX_EVENTS} events in one request`, sensor);

  const known = await env.DB.prepare("SELECT 1 FROM sensors WHERE id = ?").bind(sensor).first();
  if (!known) {
    await registerSensor(env, hooks, sensor, {
      instance_id: null, sdk_version: null, model: null, sound_list_version: null, queued_events: null,
      clock_offset_ms: offsetMs,
    }, receivedAt);
  }

  const checked = events.map(validate);
  const valid = checked.filter((c): c is ValidEvent => !("reason" in c));
  const [sounds, stored] = await Promise.all([
    env.DB.prepare("SELECT id, name, category FROM sounds WHERE enabled = 1")
      .all<{ id: string; name: string; category: string }>(),
    valid.length
      ? env.DB.prepare(
        "SELECT event_id FROM events WHERE sensor_id = ?1 AND event_id IN (SELECT value FROM json_each(?2))",
      ).bind(sensor, JSON.stringify(valid.map((e) => e.event_id))).all<{ event_id: string }>()
      : Promise.resolve({ results: [] as { event_id: string }[] }),
  ]);
  const soundById = new Map(sounds.results.map((s) => [s.id, s]));
  const seen = new Set(stored.results.map((r) => r.event_id));

  // Decide each event; inserts run in one batch, and an insert that finds the event already stored (a concurrent
  // duplicate) turns into a duplicate.
  const results: Result[] = [];
  const inserts: { index: number; event: ValidEvent; sound: { id: string; name: string; category: string } }[] = [];
  checked.forEach((c, index) => {
    if ("reason" in c) {
      results.push({ event_id: c.event_id, status: "rejected", reason: c.reason });
    } else if (seen.has(c.event_id)) {
      results.push({ event_id: c.event_id, status: "duplicate" });
    } else {
      seen.add(c.event_id);
      const sound = soundById.get(c.sound_id);
      if (!sound) {
        results.push({ event_id: c.event_id, status: "dropped" });
      } else {
        results.push({ event_id: c.event_id, status: "accepted" });
        inserts.push({ index, event: c, sound });
      }
    }
  });

  const accepted: AcceptedEvent[] = [];
  // Corrected to the service's clock, and never later than its arrival: a board clock stepped back between hearing
  // and sending would otherwise put the event in the future, where its activity stays "ongoing" and keeps alerting.
  const occurredAt = (detectedMs: number) => Math.min(Math.round(detectedMs + offsetMs), receivedAt);
  if (inserts.length) {
    const replies = await env.DB.batch<{ id: number }>(inserts.map(({ event: e, sound }) => env.DB.prepare(
      `INSERT INTO events (sensor_id, event_id, sound_id, sound_name, category, confidence, angle_deg,
         angle_confidence, detected_at, occurred_at, received_at, level_dbfs)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (sensor_id, event_id) DO NOTHING
       RETURNING id`,
    ).bind(sensor, e.event_id, sound.id, sound.name, sound.category, e.confidence, e.angle_deg, e.angle_confidence,
      e.detected_at, occurredAt(e.detected_ms), receivedAt, e.level_dbfs)));
    replies.forEach((reply, i) => {
      const { index, event: e, sound } = inserts[i];
      const row = reply.results[0];
      if (!row) {
        results[index] = { event_id: e.event_id, status: "duplicate" };
        return;
      }
      accepted.push({
        id: row.id, sensor_id: sensor, event_id: e.event_id, sound_id: sound.id, sound_name: sound.name,
        category: sound.category, confidence: e.confidence, angle_deg: e.angle_deg,
        angle_confidence: e.angle_confidence, level_dbfs: e.level_dbfs, occurred_at: occurredAt(e.detected_ms),
        received_at: receivedAt,
      });
    });
  }

  results.forEach((r, i) => {
    logLine("sensor_event", {
      decision: r.status, sensor, sound: soundOf(events[i]), event_id: r.event_id,
      ...(r.status === "rejected" ? { reason: r.reason } : {}),
    });
  });

  if (accepted.length) await runHooks(hooks.eventsAccepted, env, accepted, "eventsAccepted");
  return json({ results, sound_list_version: await soundListVersion(env.DB) });
}

function validate(raw: unknown): ValidEvent | { event_id: string | null; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { event_id: null, reason: "event is not a JSON object" };
  }
  const e = raw as Record<string, unknown>;
  const id = typeof e.event_id === "string" && e.event_id.length > 0 && e.event_id.length <= MAX_EVENT_ID
    ? e.event_id : null;
  // Echo the id exactly as sent, so the sensor can match the result to its queued event.
  const bad = (reason: string) => ({ event_id: typeof e.event_id === "string" ? e.event_id : null, reason });
  if (id === null) return bad(`event_id missing or longer than ${MAX_EVENT_ID} characters`);
  const detected = parseTime(e.detected_at);
  if (detected === null) return bad("detected_at missing or not a UTC time");
  if (typeof e.sound_id !== "string" || e.sound_id.length === 0) return bad("sound_id missing");
  if (!isUnit(e.confidence)) return bad("confidence must be a number from 0 to 1");
  let angle: number | null = null;
  if (e.angle_deg !== undefined && e.angle_deg !== null) {
    if (typeof e.angle_deg !== "number" || !Number.isFinite(e.angle_deg)) return bad("angle_deg must be a number");
    angle = ((e.angle_deg % 360) + 360) % 360;
  }
  let angleConfidence: number | null = null;
  if (e.angle_confidence !== undefined && e.angle_confidence !== null) {
    if (!isUnit(e.angle_confidence)) return bad("angle_confidence must be a number from 0 to 1");
    angleConfidence = e.angle_confidence;
  }
  // Optional and advisory: a level outside a plausible range is dropped, never a reason to refuse the event.
  const level = typeof e.level_dbfs === "number" && Number.isFinite(e.level_dbfs) && e.level_dbfs >= -150
    && e.level_dbfs <= 10 ? e.level_dbfs : null;
  return {
    event_id: id, sound_id: e.sound_id, detected_at: e.detected_at as string, detected_ms: detected,
    confidence: e.confidence, angle_deg: angle, angle_confidence: angleConfidence, level_dbfs: level,
  };
}

function isUnit(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function soundOf(raw: unknown): string | undefined {
  const s = (raw as { sound_id?: unknown } | null)?.sound_id;
  return typeof s === "string" ? s.slice(0, 100) : undefined;
}
