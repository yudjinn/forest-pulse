// The only place a local port or state path is derived. Every port a run uses
// comes from FP_E2E_PORT_BASE, so concurrent runs in different worktrees never
// collide: app = base, inspector = base + 1, a journey's own second service = base + 2 (inspector base + 3),
// base + 4 to base + 9 reserved.
import { fileURLToPath } from "node:url";
import path from "node:path";

const raw = process.env.FP_E2E_PORT_BASE ?? "8800";
export const portBase = Number.parseInt(raw, 10);
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65000) {
  throw new Error(`FP_E2E_PORT_BASE must be an integer port between 1024 and 65000, got "${raw}"`);
}

export const appPort = Number(process.env.FP_E2E_APP_PORT ?? portBase);
export const inspectorPort = Number(process.env.FP_E2E_INSPECTOR_PORT ?? portBase + 1);
export const baseURL = `http://127.0.0.1:${appPort}`;
// A second local service a journey starts and stops itself (see tests/fixtures/service.ts).
export const secondAppPort = portBase + 2;
export const secondInspectorPort = portBase + 3;

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Local D1 and R2 state for this server only; wiped when it starts. Keyed by the app port, which is the port base
// for the main server, so a second service never shares its state.
export const stateDir = path.join(webRoot, ".wrangler", `e2e-${appPort}`);
