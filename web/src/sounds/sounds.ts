// The sounds sensors can report, as researchers see and switch them, and the one way the sound list changes.
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";

// Runs statements that change the sounds table together with the sound-list version bump, in one D1 batch, so a
// change and its new version land or fail together and every sensor fetches the new list at its next check-in.
// Returns the changes' own results, in order, and the new version. Teaching and deleting go through this too.
export async function changeSoundList(db: D1Database, changes: D1PreparedStatement[]):
  Promise<{ results: D1Result[]; version: number }> {
  const replies = await db.batch([
    ...changes,
    db.prepare("UPDATE sound_list SET version = version + 1 WHERE id = 1 RETURNING version"),
  ]);
  const bump = replies[replies.length - 1] as D1Result<{ version: number }>;
  return { results: replies.slice(0, -1), version: bump.results[0].version };
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

// Every sound, switched on or off, in the sound list's order, with the list's current version.
export async function listSounds(_request: Request, { env }: RouteContext): Promise<Response> {
  const [rows, version] = await env.DB.batch([
    env.DB.prepare(`SELECT ${COLUMNS} FROM sounds ORDER BY rowid`),
    env.DB.prepare("SELECT version FROM sound_list WHERE id = 1"),
  ]);
  return json({
    version: (version.results[0] as { version: number }).version,
    sounds: (rows.results as SoundRow[]).map(toSound),
  });
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
  const { results, version } = await changeSoundList(env.DB, [
    env.DB.prepare(`UPDATE sounds SET enabled = ? WHERE id = ? RETURNING ${COLUMNS}`)
      .bind(enabled ? 1 : 0, params.sound),
  ]);
  const row = (results[0].results as SoundRow[])[0];
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
  const { results, version } = await changeSoundList(env.DB, [
    env.DB.prepare("DELETE FROM sounds WHERE id = ? AND taught_at IS NOT NULL RETURNING id").bind(params.sound),
  ]);
  if (!results[0].results.length) return json({ error: "no such sound" }, 404); // deleted meanwhile
  logLine("sound_deleted", { sound: current.id, name: current.name, version });
  return json({ id: current.id, version });
}
