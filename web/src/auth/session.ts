// The researcher session: a cookie holding its expiry time, signed with SESSION_SECRET (HMAC-SHA256).
// Stateless, so a session survives deploys and needs no storage; it ends when it expires.
import type { Env } from "../env.ts";

export const SESSION_COOKIE = "fp_session";
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const VERSION = "v1";

export async function sessionCookie(env: Env, now = Date.now()): Promise<string> {
  const payload = `${VERSION}.${now + SESSION_SECONDS * 1000}`;
  const sig = await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(payload));
  return `${SESSION_COOKIE}=${payload}.${base64url(sig)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export async function hasSession(request: Request, env: Env, now = Date.now()): Promise<boolean> {
  if (!env.SESSION_SECRET) return false;
  const value = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  const parts = value?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== VERSION) return false;
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires) || expires <= now) return false;
  const sig = fromBase64url(parts[2]);
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", await key(env), sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
}

// Where a signed-out page request goes: the sign-in page, remembering the page that was asked for.
export function signInLocation(url: URL): string {
  const back = url.pathname + url.search;
  return back === "/" ? "/signin" : `/signin?next=${encodeURIComponent(back)}`;
}

// The page to return to after signing in: only the researchers' dashboard, with its query if it had one.
export function safeNext(next: string | null): string {
  if (!next || (next !== "/" && !next.startsWith("/?")) || next.includes("\\")) return "/";
  return next;
}

async function key(env: Env): Promise<CryptoKey> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]);
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
