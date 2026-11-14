// The sign-in page and the form it posts: one shared password (DASHBOARD_PASSWORD) opens a 7-day session.
import type { RouteContext } from "../router.ts";
import { redirect, secretMatches } from "../http.ts";
import { logLine } from "../log.ts";
import { hasSession, safeNext, sessionCookie } from "./session.ts";

export async function signInPage(request: Request, { env }: RouteContext): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (await hasSession(request, env)) return redirect(next);
  return page(request, env, next, false, 200);
}

export async function signIn(request: Request, { env }: RouteContext): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  let password = "";
  try {
    const form = await request.formData();
    password = String(form.get("password") ?? "");
  } catch {
    // an unreadable form is a wrong password
  }
  if (!(await secretMatches(password, env.DASHBOARD_PASSWORD))) {
    logLine("sign_in", { decision: "refused" });
    return page(request, env, next, true, 401);
  }
  logLine("sign_in", { decision: "accepted" });
  return redirect(next, { "Set-Cookie": await sessionCookie(env) });
}

// The static sign-in page, with the form posting back to the page that was asked for and, after a wrong password,
// the error shown.
async function page(request: Request, env: RouteContext["env"], next: string, wrong: boolean, status: number) {
  const file = await env.ASSETS.fetch(new Request(new URL("/dashboard/signin", request.url)));
  const action = next === "/dashboard/" ? "/dashboard/signin" : `/dashboard/signin?next=${encodeURIComponent(next)}`;
  const rewritten = new HTMLRewriter()
    .on("form#signin", { element: (el) => void el.setAttribute("action", action) })
    .on("#signin-error", { element: (el) => void (wrong && el.removeAttribute("hidden")) })
    .transform(file);
  const headers = new Headers(rewritten.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(rewritten.body, { status, headers });
}
