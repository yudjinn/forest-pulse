// The sounds sensors can report, as researchers see and switch them, and the one way the sound list changes.
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { soundListReach } from "../sensors/plan.ts";

// Moves the sound-list version on, but only when the statement just before it in the same batch touched a row: a
// change that changed nothing would otherwise make every sensor refetch an unchanged list.
const BUMP_VERSION = "UPDATE sound_list SET version = version + 1 WHERE id = 1 AND changes() > 0";

// Runs one statement that changes the sounds table together with the sound-list version bump, in one D1 batch, so
// a change and its new version land or fail together and every sensor fetches the new list at its next check-in.
// The version moves on only when the change touched a row: a sound gone between a caller's read and this write
// changes nothing. Returns the change's own result and the list's version. Teaching and deleting go through this
// too; the sensitivity takes the same bump in its own batch, which also reads the value it replaces.
export async function changeSoundList(db: D1Database, change: D1PreparedStatement):
  Promise<{ result: D1Result; version: number }> {
  const [result, , version] = await db.batch([
    change,
    db.prepare(BUMP_VERSION),
    db.prepare("SELECT version FROM sound_list WHERE id = 1"),
  ]);
  return { result, version: (version.results[0] as { version: number }).version };
}

interface SoundRow {
  id: string;
  name: string;
  category: string;
  kind: "detector" | "label";
  enabled: number;
  taught_at: number | null;
}

// `taught` marks a sound a researcher taught: only those can be deleted.
const toSound = (r: SoundRow) => ({
  id: r.id, name: r.name, category: r.category, kind: r.kind, enabled: r.enabled === 1, taught: r.taught_at !== null,
});
const COLUMNS = "id, name, category, kind, enabled, taught_at";

export const SEEDED_KEPT = "Only taught sounds can be deleted";

// Every sound, switched on or off, in the sound list's order, with the list's current version and sensitivity, and
// how far that version has reached: {sensors, reached}, the sensors on the plan and those that last reported it.
// One batch, so the reach is counted against the version it is sent with.
export async function listSounds(_request: Request, { env }: RouteContext): Promise<Response> {
  const [rows, list, reach] = await env.DB.batch([
    env.DB.prepare(`SELECT ${COLUMNS} FROM sounds ORDER BY rowid`),
    env.DB.prepare("SELECT version, sensitivity FROM sound_list WHERE id = 1"),
    soundListReach(env.DB),
  ]);
  const { version, sensitivity } = list.results[0] as { version: number; sensitivity: number };
  return json({
    version, sensitivity, reach: reach.results[0] as { sensors: number; reached: number },
    sounds: (rows.results as SoundRow[]).map(toSound),
  });
}

// The sensitivity: the confidence every sound must reach before a sensor reports it, served as every sound's
// threshold. 0.2 to 0.9 in steps of 0.05; anything else is refused rather than rounded.
const STEP = 0.05;
const MIN_STEPS = 4;
const MAX_STEPS = 18;

function toSensitivity(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const steps = Math.round(v / STEP);
  if (Math.abs(v / STEP - steps) > 1e-6 || steps < MIN_STEPS || steps > MAX_STEPS) return null;
  return steps / 20;
}

// Sets the sensitivity: body {"sensitivity": 0.2 to 0.9}. The change and the version bump land in one batch, so
// every sensor fetches the new thresholds at its next check-in; the last save wins. Replies {sensitivity, version}.
export async function setSensitivity(request: Request, { env }: RouteContext): Promise<Response> {
  let value: unknown;
  try {
    value = ((await request.json()) as { sensitivity?: unknown } | null)?.sensitivity;
  } catch {
    // not JSON: refused below
  }
  const sensitivity = toSensitivity(value);
  if (sensitivity === null) return json({ error: "sensitivity must be 0.2 to 0.9 in steps of 0.05" }, 400);

  const [before, , , after] = await env.DB.batch([
    env.DB.prepare("SELECT sensitivity FROM sound_list WHERE id = 1"),
    env.DB.prepare("UPDATE sound_list SET sensitivity = ? WHERE id = 1 AND sensitivity <> ?").bind(sensitivity, sensitivity),
    env.DB.prepare(BUMP_VERSION),
    env.DB.prepare("SELECT version, sensitivity FROM sound_list WHERE id = 1"),
  ]);
  const from = (before.results[0] as { sensitivity: number }).sensitivity;
  const now = after.results[0] as { version: number; sensitivity: number };
  if (from !== now.sensitivity) logLine("sensitivity_changed", { from, to: now.sensitivity, version: now.version });
  return json(now);
}

// Switches one sound on or off: body {"enabled": true | false}. Replies with the sound and the list's version.
export async function switchSound(request: Request, { env, params }: RouteContext): Promise<Response> {
  let enabled: unknown;
  try {
    enabled = ((await request.json()) as { enabled?: unknown } | null)?.enabled;
  } catch {
    // not JSON: refused below
  }
  if (typeof enabled !== "boolean") return json({ error: "enabled must be true or false" }, 400);

  const select = env.DB.prepare(`SELECT ${COLUMNS} FROM sounds WHERE id = ?`).bind(params.sound);
  const current = await select.first<SoundRow>();
  if (!current) return json({ error: "no such sound" }, 404);
  if ((current.enabled === 1) === enabled) {
    const version = await env.DB.prepare("SELECT version FROM sound_list WHERE id = 1").first<number>("version");
    return json({ sound: toSound(current), version });
  }
  const { result, version } = await changeSoundList(
    env.DB,
    env.DB.prepare(`UPDATE sounds SET enabled = ? WHERE id = ? RETURNING ${COLUMNS}`).bind(enabled ? 1 : 0, params.sound),
  );
  const row = (result.results as SoundRow[])[0];
  if (!row) return json({ error: "no such sound" }, 404); // deleted between the read and the switch
  logLine("sound_switched", { sound: row.id, enabled, version });
  return json({ sound: toSound(row), version });
}

// Deletes a taught sound: sensors drop it at their next check-in, events for it arriving afterwards are answered as
// dropped, and past events keep the name they were stored with. Replies {id, version}; 404 for an unknown sound,
// 409 for a seeded one.
export async function deleteSound(_request: Request, { env, params }: RouteContext): Promise<Response> {
  const current = await env.DB.prepare(`SELECT ${COLUMNS} FROM sounds WHERE id = ?`).bind(params.sound).first<SoundRow>();
  if (!current) return json({ error: "no such sound" }, 404);
  if (current.taught_at === null) return json({ error: SEEDED_KEPT }, 409);
  const { result, version } = await changeSoundList(
    env.DB,
    env.DB.prepare("DELETE FROM sounds WHERE id = ? AND taught_at IS NOT NULL RETURNING id").bind(params.sound),
  );
  if (!result.results.length) return json({ error: "no such sound" }, 404); // deleted meanwhile
  logLine("sound_deleted", { sound: current.id, name: current.name, version });
  return json({ id: current.id, version });
}
