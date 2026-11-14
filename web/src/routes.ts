// The route table: every path the Worker answers itself, with who may call it, and the hooks that run on sensor
// intake. Additive only: add a line, never reorder or rewrite one (docs/agents/ownership.md).
// Paths: researcher pages and data under /dashboard (data under /dashboard/api), the sensor API under /api/v1.
// Any other /dashboard file is served from web/dashboard/ to a signed-in researcher; the rest is the landing page.
import type { Route } from "./router.ts";
import type { IntakeHooks } from "./api/intake.ts";
import { signIn, signInPage } from "./auth/signin.ts";
import { checkin, soundList } from "./api/checkin.ts";
import { postEvents } from "./api/events.ts";
import { listEvents } from "./eventlog.ts";
import { listSounds, switchSound } from "./sounds/sounds.ts";
import { listSamples, sampleAudio } from "./player/player.ts";
import { clearEvents, listActivities } from "./activities/activities.ts";

export const routes: Route[] = [
  { method: "GET", path: "/dashboard/signin", access: "public", handle: signInPage },
  { method: "POST", path: "/dashboard/signin", access: "public", handle: signIn },
  { method: "GET", path: "/dashboard/api/events", access: "researcher", handle: listEvents },
  { method: "POST", path: "/api/v1/sensors/:sensor/checkin", access: "sensor", handle: checkin },
  { method: "GET", path: "/api/v1/sensors/:sensor/sounds", access: "sensor", handle: soundList },
  { method: "POST", path: "/api/v1/sensors/:sensor/events", access: "sensor", handle: postEvents },
  { method: "GET", path: "/dashboard/api/sounds", access: "researcher", handle: listSounds },
  { method: "PATCH", path: "/dashboard/api/sounds/:sound", access: "researcher", handle: switchSound },
  { method: "GET", path: "/dashboard/api/player/samples", access: "researcher", handle: listSamples },
  { method: "GET", path: "/dashboard/api/player/samples/:file", access: "researcher", handle: sampleAudio },
  { method: "GET", path: "/dashboard/api/activities", access: "researcher", handle: listActivities },
  { method: "DELETE", path: "/dashboard/api/events", access: "researcher", handle: clearEvents },
];

// Run after a check-in (or first contact) is stored, and after a request's accepted events are stored.
export const hooks: IntakeHooks = {
  sensorCheckedIn: [],
  eventsAccepted: [],
};
