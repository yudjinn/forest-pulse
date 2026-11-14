// Matches a request against the route table, enforces each route's access, and falls back to the static files.
// Researcher pages and data live under /dashboard and need a session; the sensor API lives under /api/v1 and
// needs the sensor key; everything else is the public landing page, served from the files.
import type { Env } from "./env.ts";
import { json, redirect } from "./http.ts";
import { logLine } from "./log.ts";
import { hasSession, signInLocation } from "./auth/session.ts";
import { sensorKeyOk } from "./api/key.ts";
import type { IntakeHooks } from "./api/intake.ts";

// public: anyone. researcher: a signed-in session. sensor: the shared sensor key.
export type Access = "public" | "researcher" | "sensor";

export interface RouteContext {
  env: Env;
  // Path parameters named by ":name" segments in the route's path, already URL-decoded.
  params: Record<string, string>;
  hooks: IntakeHooks;
  waitUntil(promise: Promise<unknown>): void;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // Literal segments and ":name" parameters, for example "/api/v1/sensors/:sensor/checkin".
  path: string;
  access: Access;
  handle(request: Request, ctx: RouteContext): Response | Promise<Response>;
}

// Dashboard files anyone may fetch: what the sign-in page itself needs.
const PUBLIC_DASHBOARD_FILES = new Set(["/dashboard/shell.css"]);

export async function route(
  request: Request,
  env: Env,
  exec: ExecutionContext,
  routes: readonly Route[],
  hooks: IntakeHooks,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  let pathMatched = false;
  for (const r of routes) {
    const params = matchPath(r.path, path);
    if (!params) continue;
    pathMatched = true;
    if (r.method !== request.method && !(r.method === "GET" && request.method === "HEAD")) continue;
    const denied = await deny(r.access, request, env, url);
    if (denied) return denied;
    return r.handle(request, { env, params, hooks, waitUntil: (p) => exec.waitUntil(p) });
  }
  if (pathMatched) return json({ error: "method not allowed" }, 405);

  if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
  if (path === "/dashboard") return redirect("/dashboard/");
  if (path.startsWith("/dashboard/")) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
    if (!PUBLIC_DASHBOARD_FILES.has(path)) {
      const denied = await deny("researcher", request, env, url);
      if (denied) return denied;
    }
  }
  return env.ASSETS.fetch(request);
}

async function deny(access: Access, request: Request, env: Env, url: URL): Promise<Response | null> {
  if (access === "public") return null;
  if (access === "sensor") {
    if (await sensorKeyOk(request, env)) return null;
    logLine("sensor_request", { decision: "unauthorised", path: url.pathname });
    return json({ error: "sensor key rejected" }, 401);
  }
  if (await hasSession(request, env)) return null;
  // A data request is refused; a page sends the researcher to sign in and back.
  if (url.pathname.startsWith("/dashboard/api/")) return json({ error: "signed out" }, 401);
  return redirect(signInLocation(url));
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) {
      if (!got[i]) return null;
      try {
        params[want[i].slice(1)] = decodeURIComponent(got[i]);
      } catch {
        return null;
      }
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}
