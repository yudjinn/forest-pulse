// Teaching a new sound: the dashboard's teach dialog sends the summaries of a researcher's recordings (never audio), and this
// trains a detector against the stored summaries of other sounds in the same request, saves it switched on, and
// moves the sound-list version on so every sensor pulls it at its next check-in.
//
// Request (POST /dashboard/api/teach, application/octet-stream), all little-endian:
//   uint32 H | H bytes of UTF-8 JSON {"name", "category", "clips": [{"file", "windows"}]} | zero padding to a multiple
//   of 4 | float32 rows of 960: for each clip in order, `windows` clean rows then `windows` mixed rows.
// Stored library (bucket teach/): other-sounds.f32 (float32 rows of 960), other-sounds.json (what the rows are),
// hall.wav (the background the page mixes recordings over, served by GET /dashboard/api/teach/background).
import type { RouteContext } from "../router.ts";
import type { Env } from "../env.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { changeSoundList } from "../sounds/sounds.ts";
import { DIM, trainDetector } from "./train.ts";

export const CATEGORIES = ["logging", "vehicle", "poaching", "wildlife"] as const;
export const MIN_CLIPS = 5;
export const MAX_CLIPS = 100;
const MAX_WINDOWS_PER_CLIP = 12; // the first 60 s in 5 s windows
const MAX_NAME = 60;
const MAX_HEADER = 64 * 1024;
const MAX_BODY = 4 + MAX_HEADER + MAX_CLIPS * MAX_WINDOWS_PER_CLIP * 2 * DIM * 4;
const THRESHOLD = 0.5;
const LIBRARY_ROWS = "teach/other-sounds.f32";
const BACKGROUND = "teach/hall.wav";

export const TOO_FEW = "Needs at least 5 usable recordings";
export const NAME_TAKEN = "A sound with this name already exists";

export interface TeachRequest {
  name: string;
  category: (typeof CATEGORIES)[number];
  clips: { file: string; windows: number }[];
  rows: Float32Array;
}

// The request body -> the request, or what is wrong with it.
export function parseTeachRequest(body: ArrayBuffer): TeachRequest | { error: string } {
  if (body.byteLength < 4) return { error: "empty request" };
  const view = new DataView(body);
  const headerLength = view.getUint32(0, true);
  if (headerLength > MAX_HEADER || 4 + headerLength > body.byteLength) return { error: "bad header length" };
  let header: { name?: unknown; category?: unknown; clips?: unknown };
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(new Uint8Array(body, 4, headerLength)));
  } catch {
    return { error: "header is not JSON" };
  }
  const name = typeof header?.name === "string" ? header.name.trim() : "";
  if (!name || name.length > MAX_NAME) return { error: `name must be 1 to ${MAX_NAME} characters` };
  const category = CATEGORIES.find((c) => c === header.category);
  if (!category) return { error: "unknown category" };
  if (!Array.isArray(header.clips)) return { error: "clips must be a list" };
  const clips: TeachRequest["clips"] = [];
  for (const clip of header.clips as { file?: unknown; windows?: unknown }[]) {
    const windows = clip?.windows;
    if (typeof windows !== "number" || !Number.isInteger(windows) || windows < 1 || windows > MAX_WINDOWS_PER_CLIP) {
      return { error: "each clip needs 1 to 12 windows" };
    }
    clips.push({ file: typeof clip.file === "string" ? clip.file.slice(0, 200) : "", windows });
  }
  if (clips.length < MIN_CLIPS) return { error: TOO_FEW };
  if (clips.length > MAX_CLIPS) return { error: `at most ${MAX_CLIPS} recordings` };
  const start = 4 + Math.ceil(headerLength / 4) * 4;
  const count = clips.reduce((sum, c) => sum + 2 * c.windows, 0);
  if (body.byteLength !== start + count * DIM * 4) return { error: "summaries do not match the clip list" };
  const rows = new Float32Array(body, start, count * DIM);
  if (!rows.every(Number.isFinite)) return { error: "summaries must be finite numbers" };
  return { name, category, clips, rows };
}

// The stored summaries of other sounds, kept per isolate while the stored object is unchanged.
let library: { etag: string; rows: Float32Array } | null = null;

async function otherSounds(env: Env): Promise<Float32Array> {
  const head = await env.STORAGE.head(LIBRARY_ROWS);
  if (!head) throw new Error("the other-sounds library is missing from storage");
  if (library?.etag === head.etag) return library.rows;
  const object = await env.STORAGE.get(LIBRARY_ROWS);
  if (!object) throw new Error("the other-sounds library is missing from storage");
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength % (DIM * 4) !== 0) throw new Error("the other-sounds library is malformed");
  library = { etag: object.etag, rows: new Float32Array(bytes) };
  return library.rows;
}

// The sound with this name ignoring case, any letters (the unique index on the table folds only A to Z and guards
// the race between this check and the insert), or null. `taught` tells a taught sound from a seeded one.
export async function soundNamed(db: D1Database, name: string):
  Promise<{ id: string; name: string; taught: boolean } | null> {
  const wanted = name.toLowerCase();
  const { results } = await db.prepare("SELECT id, name, taught_at FROM sounds")
    .all<{ id: string; name: string; taught_at: number | null }>();
  const found = results.find((s) => s.name.toLowerCase() === wanted);
  return found ? { id: found.id, name: found.name, taught: found.taught_at !== null } : null;
}

// A readable, unique id: the name as a slug plus a random suffix, so events stay legible and ids never repeat.
function soundId(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40) || "sound";
  const suffix = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${slug}-${suffix}`;
}

// POST /dashboard/api/teach -> 201 {sound: {id, name, category, kind, enabled}, version} for a new sound; 200 with the
// same reply when the name is a taught sound's, whose detector (weights, bias, taught time) is replaced in place, so
// its id, name, category and switch stay and past events stay linked; 400 {error} for a bad or too small request;
// 409 {error} when the name is a seeded sound's; 500 {error} when teaching failed. Nothing is saved on an error.
export async function teachSound(request: Request, { env }: RouteContext): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY) return json({ error: "request too large" }, 413);
  let parsed: TeachRequest | { error: string };
  try {
    const body = await request.arrayBuffer();
    parsed = body.byteLength > MAX_BODY ? { error: "request too large" } : parseTeachRequest(body);
  } catch {
    logLine("teach_failed", { reason: "upload did not complete" });
    return json({ error: "upload did not complete" }, 400);
  }
  if ("error" in parsed) {
    logLine("teach_failed", { reason: parsed.error });
    return json({ error: parsed.error }, 400);
  }
  const { name, category, clips, rows } = parsed;
  logLine("teach_received", { name, category, clips: clips.length, summaries: rows.length / DIM });

  try {
    const existing = await soundNamed(env.DB, name);
    if (existing && !existing.taught) {
      logLine("teach_failed", { name, reason: "name taken" });
      return json({ error: NAME_TAKEN }, 409);
    }
    const negatives = await otherSounds(env);
    const started = Date.now();
    const detector = trainDetector(rows, negatives);
    if (!detector.weights.every(Number.isFinite) || !Number.isFinite(detector.bias)) throw new Error("training diverged");
    logLine("teach_trained", {
      name, positives: rows.length / DIM, negatives: negatives.length / DIM, iterations: detector.iterations,
      ms: Date.now() - started,
    });

    if (existing) {
      const replaced = await changeSoundList(
        env.DB,
        env.DB.prepare(
          "UPDATE sounds SET weights = ?, bias = ?, taught_at = ? WHERE id = ? AND taught_at IS NOT NULL " +
          "RETURNING id, name, category, kind, enabled",
        ).bind(JSON.stringify(detector.weights), detector.bias, Date.now(), existing.id),
      );
      const row = (replaced.result.results as { id: string; name: string; category: string; kind: string;
        enabled: number }[])[0];
      if (row) {
        logLine("teach_replaced", { name: row.name, sound: row.id, version: replaced.version });
        return json({
          sound: { id: row.id, name: row.name, category: row.category, kind: row.kind, enabled: row.enabled === 1 },
          version: replaced.version,
        }, 200);
      }
      // Deleted since the check above: taught as a new sound below.
    }

    const id = soundId(name);
    let saved;
    try {
      saved = await changeSoundList(
        env.DB,
        env.DB.prepare(
          "INSERT INTO sounds (id, name, category, kind, threshold, enabled, weights, bias, taught_at) " +
          "VALUES (?, ?, ?, 'detector', ?, 1, ?, ?, ?)",
        ).bind(id, name, category, THRESHOLD, JSON.stringify(detector.weights), detector.bias, Date.now()),
      );
    } catch (e) {
      // Taught under the same name by someone else since the check above: the batch saved nothing.
      if (String(e).includes("UNIQUE")) {
        logLine("teach_failed", { name, reason: "name taken" });
        return json({ error: NAME_TAKEN }, 409);
      }
      throw e;
    }
    logLine("teach_saved", { name, sound: id, version: saved.version });
    return json({ sound: { id, name, category, kind: "detector", enabled: true }, version: saved.version }, 201);
  } catch (e) {
    logLine("teach_failed", { name, reason: e instanceof Error ? e.message : String(e) });
    return json({ error: "teaching failed" }, 500);
  }
}

// GET /dashboard/api/teach/background -> the hall background the teach dialog mixes recordings over.
export async function teachBackground(_request: Request, { env }: RouteContext): Promise<Response> {
  const object = await env.STORAGE.get(BACKGROUND);
  if (!object) return json({ error: "not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(object.size),
      "Cache-Control": "private, max-age=300",
      ETag: object.httpEtag,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
