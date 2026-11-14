// Check-in and the sound list (docs/device-api.md).
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { MAX_SENSOR_ID, badRequest, readBody, registerSensor } from "./intake.ts";
import { calibrationCheckin } from "../calibration/calibration.ts";
import { noteSoundListCheckin } from "../sensors/plan.ts";
import { warningCheckin } from "../warnings/warnings.ts";

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
  // While the sensor takes part in a calibration run, the reply carries the run (docs/device-api.md). A failure there
  // is logged and the check-in still stands, like an intake hook's.
  let calibration = null;
  try {
    calibration = await calibrationCheckin(env, params.sensor, body, now);
  } catch (e) {
    logLine("hook_failed", { hook: "calibrationCheckin", error: e instanceof Error ? e.message : String(e) });
  }
  // A warning's alarm while one waits for this sensor, and its confirmation (docs/device-api.md, "Warnings"); a
  // failure there is logged the same way.
  let alarm = null;
  try {
    alarm = await warningCheckin(env, params.sensor, body, now);
  } catch (e) {
    logLine("hook_failed", { hook: "warningCheckin", error: e instanceof Error ? e.message : String(e) });
  }
  return json({
    server_time: new Date(now).toISOString(), sound_list_version: await noteSoundListCheckin(env.DB, params.sensor),
    ...(calibration ? { calibration } : {}),
    ...(alarm ? { alarm } : {}),
  });
}

interface SoundRow {
  id: string;
  name: string;
  category: string;
  kind: "detector" | "label";
  label: string | null;
  weights: string | null;
  bias: number | null;
}

// Every sound carries the one sensitivity researchers set as its threshold; the stored per-sound threshold is not
// served. The list and its version are read in one batch, so a sensor never gets a newer version with older contents.
export async function soundList(_request: Request, { env, params }: RouteContext): Promise<Response> {
  if (params.sensor.length > MAX_SENSOR_ID) return badRequest("sensor_id is too long", undefined);
  const [list, rows] = await env.DB.batch([
    env.DB.prepare("SELECT version, sensitivity FROM sound_list WHERE id = 1"),
    env.DB.prepare(
      "SELECT id, name, category, kind, label, weights, bias FROM sounds WHERE enabled = 1 ORDER BY rowid",
    ),
  ]);
  const { version, sensitivity } = list.results[0] as { version: number; sensitivity: number };
  const sounds = (rows.results as SoundRow[]).map((s) => {
    const base = { id: s.id, name: s.name, category: s.category, kind: s.kind, threshold: sensitivity };
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
