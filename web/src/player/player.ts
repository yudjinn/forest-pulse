// The demo player's samples: the credits list and the recordings, read from the bucket's player/ area
// (committed in web/bucket/player/, prepared by demo-kit/player_samples.py) and served to a signed-in researcher.
import { json } from "../http.ts";
import type { RouteContext } from "../router.ts";

const LIST_KEY = "player/samples.json";
const FILE_NAME = /^[a-z0-9][a-z0-9-]*\.wav$/;

interface StoredSample {
  id: string;
  name: string;
  kind: string;
  file: string;
  seconds: number;
  credit: { recordist: string | null; source: string; url: string; licence: string; licence_url: string };
}

const sampleURL = (file: string) => `/dashboard/api/player/samples/${encodeURIComponent(file)}`;

// GET /dashboard/api/player/samples -> { samples: [{ id, name, kind, seconds, credit, url }] } in the list's order.
export async function listSamples(_request: Request, ctx: RouteContext): Promise<Response> {
  const stored = await ctx.env.STORAGE.get(LIST_KEY);
  if (!stored) return json({ samples: [] });
  const { samples } = await stored.json<{ samples: StoredSample[] }>();
  return json({
    samples: samples.map(({ id, name, kind, seconds, credit, file }) => ({ id, name, kind, seconds, credit, url: sampleURL(file) })),
  });
}

// GET /dashboard/api/player/samples/:file -> the recording, streamed from the bucket.
export async function sampleAudio(_request: Request, ctx: RouteContext): Promise<Response> {
  const file = ctx.params.file;
  const object = FILE_NAME.test(file) ? await ctx.env.STORAGE.get(`player/${file}`) : null;
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
