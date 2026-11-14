// The researchers' suspected activities, and clearing every event (and so every activity) after a rehearsal.
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { type Activity, type ActivityEvent, groupActivities } from "./group.ts";
import { LOCATION_COLUMNS, type LocationColumns, latestLocation } from "../location/location.ts";
import { sensorNames } from "../sensors/plan.ts";

// The newest activities, each with its category, sounds, first and last corrected time, event count and sensors
// (ids, and their names as shown now).
export async function listActivities(_request: Request, { env }: RouteContext): Promise<Response> {
  const [rows, name] = await Promise.all([
    env.DB.prepare(
      `SELECT id, sensor_id, sound_name, category, occurred_at, ${LOCATION_COLUMNS} FROM events ORDER BY occurred_at, id`,
    ).all<ActivityEvent & LocationColumns>(),
    sensorNames(env.DB),
  ]);
  return json({ activities: groupActivities(rows.results).map((a) => toReply(a, name)) });
}

function toReply(a: Activity<ActivityEvent & LocationColumns>, name: (id: string) => string) {
  return {
    category: a.category,
    sounds: a.sounds,
    sensors: a.sensors,
    sensor_names: a.sensors.map(name),
    first_at: new Date(a.first_at).toISOString(),
    last_at: new Date(a.last_at).toISOString(),
    event_count: a.events.length,
    location: latestLocation(a.events, name),
  };
}

// Deletes every stored event, which removes every activity and every duplicate-detection record with them. Sensors,
// their placements and sounds stay. One batch, so a failure leaves everything as it was: a slice that keeps
// per-event rows in a table of its own adds that table's DELETE to this batch.
export async function clearEvents(_request: Request, { env }: RouteContext): Promise<Response> {
  const [events] = await env.DB.batch([env.DB.prepare("DELETE FROM events")]);
  logLine("events_cleared", { events: events.meta.changes });
  return json({ cleared: events.meta.changes });
}
