// The only place a local port or state path is derived. Every port a run uses
// comes from FP_E2E_PORT_BASE, so concurrent runs in different worktrees never
// collide: app = base, inspector = base + 1, a journey's own second service = base + 2 (inspector base + 3),
// the sounds journey's own service = base + 4 (inspector base + 5), the teaching journeys' own service = base + 6
// (inspector base + 7), the plan journey's own service = base + 8 (inspector base + 9).
// A second block, base + 50 to base + 59, holds five more pairs for journeys that need their own fresh service:
// the activities journey = base + 50 (inspector base + 51), the location journey = base + 52 (inspector base + 53),
// the rehearsal journeys = base + 54 (inspector base + 55), base + 56 to base + 59 reserved.
// A journey that changes the sound list (teach, reteach, delete, switch) never runs on the shared service, whose list
// other journeys compare against the seed: it starts its own service on its own pair.
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
// The sounds journey's own service: it switches sounds off for everyone on it, so it never shares one.
export const soundsServicePorts = { appPort: portBase + 4, inspectorPort: portBase + 5 };
// The teaching journeys' own service (teach, and later reteach and delete).
export const teachServicePorts = { appPort: portBase + 6, inspectorPort: portBase + 7 };
// The plan journey's own service: it needs a plan no other journey has added sensors to.
export const planServicePorts = { appPort: portBase + 8, inspectorPort: portBase + 9 };
// The activities journey's own service: it clears every event, which other journeys on the shared service read.
export const activitiesServicePorts = { appPort: portBase + 50, inspectorPort: portBase + 51 };
// The location journey's own service: it needs a plan of its own and no other sensor hearing a chainsaw.
export const locationServicePorts = { appPort: portBase + 52, inspectorPort: portBase + 53 };
// The rehearsal journeys' own service: they teach the stage's sounds, which changes the sound list.
export const rehearsalServicePorts = { appPort: portBase + 54, inspectorPort: portBase + 55 };

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Local D1 and R2 state for this server only; wiped when it starts. Keyed by the app port, which is the port base
// for the main server, so a second service never shares its state.
export const stateDir = path.join(webRoot, ".wrangler", `e2e-${appPort}`);
// The activities journey's own service's local state, read to check what clearing kept.
export const activitiesServiceStateDir = path.join(webRoot, ".wrangler", `e2e-${activitiesServicePorts.appPort}`);
