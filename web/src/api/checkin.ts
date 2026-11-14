// Check-in and the sound list (docs/device-api.md).
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { MAX_SENSOR_ID, badRequest, readBody, registerSensor, soundListVersion } from "./intake.ts";

export const MODEL = "mn10_as";

export async function checkin(request: Request, { env, params, hooks }: RouteContext): Promise<Response> {
  const now = Date.now();
  const read = await readBody(request, params.sensor, now);
  if (read instanceof Response) return read;
  const { body, offsetMs } = read;
  await registerSensor(env, hooks, params.sensor, {
    instance_id: str(body.instance_id),
    sdk_version: str(body.sdk_version),
    model: str(body.model),
    sound_list_version: int(body.sound_list_version),
    queued_events: int(body.queued_events),
    clock_offset_ms: offsetMs,
  }, now);
  return json({ server_time: new Date(now).toISOString(), sound_list_version: await soundListVersion(env.DB) });
}

interface SoundRow {
  id: string;
  name: string;
  category: string;
  kind: "detector" | "label";
  threshold: number;
  label: string | null;
  weights: string | null;
  bias: number | null;
}

export async function soundList(_request: Request, { env, params }: RouteContext): Promise<Response> {
  if (params.sensor.length > MAX_SENSOR_ID) return badRequest("sensor_id is too long", undefined);
  const [version, rows] = await Promise.all([
    soundListVersion(env.DB),
    env.DB.prepare(
      "SELECT id, name, category, kind, threshold, label, weights, bias FROM sounds WHERE enabled = 1 ORDER BY rowid",
    ).all<SoundRow>(),
  ]);
  const sounds = rows.results.map((s) => {
    const base = { id: s.id, name: s.name, category: s.category, kind: s.kind, threshold: s.threshold };
    return s.kind === "detector"
      ? { ...base, weights: JSON.parse(s.weights ?? "[]") as number[], bias: s.bias }
      : { ...base, label: s.label };
  });
  return json({ version, model: MODEL, sounds });
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v.slice(0, 200) : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}
