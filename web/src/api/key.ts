// The shared sensor key (DEVICE_KEY), sent by every sensor as "Authorization: Bearer <key>".
import type { Env } from "../env.ts";
import { secretMatches } from "../http.ts";

export async function sensorKeyOk(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return secretMatches(header.slice("Bearer ".length), env.DEVICE_KEY);
}
