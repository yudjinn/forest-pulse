// The researchers' live event log: the latest events, newest first by corrected time, each with its sensor's name
// as shown now.
import type { RouteContext } from "./router.ts";
import { json } from "./http.ts";
import { sensorNames } from "./sensors/plan.ts";

export const LOG_LIMIT = 200;

interface LogRow {
  id: number;
  sensor_id: string;
  sound_id: string;
  sound_name: string;
  category: string;
  confidence: number;
  angle_deg: number | null;
  occurred_at: number;
}

export async function listEvents(_request: Request, { env }: RouteContext): Promise<Response> {
  const [rows, name] = await Promise.all([
    env.DB.prepare(
      `SELECT id, sensor_id, sound_id, sound_name, category, confidence, angle_deg, occurred_at
       FROM events ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    ).bind(LOG_LIMIT).all<LogRow>(),
    sensorNames(env.DB),
  ]);
  return json({
    events: rows.results.map((r) => ({
      ...r, sensor_name: name(r.sensor_id), occurred_at: new Date(r.occurred_at).toISOString(),
    })),
  });
}
