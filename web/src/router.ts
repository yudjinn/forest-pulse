// Matches a request against the route table, enforces each route's access, and falls back to the static files.
// The researchers' dashboard is the page at / and its data lives under /dashboard/api; both need a session. The page
// at /dashboard/ is the public demo: the same page answered by a simulated service in the browser. The sensor API
// lives under /api/v1 and needs the sensor key. The dashboard's code under /dashboard/ and the brand files are public.
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

// Where the one dashboard page lives in the files: served at / to a researcher and, rewritten, at /dashboard/ as
// the demo.
const DASHBOARD_FILE = "/dashboard/";
// Pages the one-page dashboard replaced, with or without the trailing slash or index.html, and its old sign-in
// address: an old bookmark lands on the researchers' dashboard (signed out: its sign-in). The modules still served
// from those folders (teach.js, player.css) are not pages.
const RETIRED_PAGE = /^\/dashboard\/((sounds|teach|player)(\/(index\.html)?)?|signin(\.html)?)$/;

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
  if (path === "/") {
    const denied = await deny("researcher", request, env, url);
    if (denied) return denied;
    return env.ASSETS.fetch(new Request(new URL(DASHBOARD_FILE, url), request));
  }
  if (path === "/dashboard" || path === "/dashboard/index.html") return redirect("/dashboard/");
  if (RETIRED_PAGE.test(path)) return redirect("/");
  if (path === "/dashboard/") return demoPage(request, env);
  if (path.startsWith("/dashboard/api/")) return json({ error: "not found" }, 404);
  if (path.startsWith("/dashboard/") && request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405);
  }
  return env.ASSETS.fetch(request);
}

// The public demo: the dashboard page with the demo's simulated service loaded before any other script, so no
// request from it reaches the researchers' data, and the controls that change anything hidden.
async function demoPage(request: Request, env: Env): Promise<Response> {
  // Fetched unconditionally: the page's file validators say nothing about what the rewrite adds.
  const file = await env.ASSETS.fetch(new Request(new URL(DASHBOARD_FILE, request.url), { method: request.method }));
  const rewritten = new HTMLRewriter()
    .on("html", { element: (el) => void el.setAttribute("class", "demo") })
    .on("title", { element: (el) => void el.setInnerContent("Forest Pulse demo") })
    .on('script[src="/dashboard/shell.js"]', {
      element: (el) => void el.before(
        '<link rel="stylesheet" href="/dashboard/demo/demo.css">\n    <script type="module" src="/dashboard/demo/demo.js"></script>\n    ',
        { html: true }),
    })
    .on("body", {
      element: (el) => void el.prepend(
        '<p class="demo-note" role="note"><b>This is a demo with simulated sounds.</b> '
          + "Forest Pulse is a working product, running on real sensors.</p>",
        { html: true }),
    })
    .transform(file);
  const headers = new Headers(rewritten.headers);
  headers.delete("ETag");
  headers.set("Cache-Control", "no-store");
  return new Response(rewritten.body, { status: rewritten.status, headers });
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
