// The only place a local port or state path is derived. Every port a run uses
// comes from FP_E2E_PORT_BASE, so concurrent runs in different worktrees never
// collide: app = base, inspector = base + 1, base + 2 to base + 9 reserved.
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

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Local D1 and R2 state for this run only; wiped when the server starts.
export const stateDir = path.join(webRoot, ".wrangler", `e2e-${portBase}`);
