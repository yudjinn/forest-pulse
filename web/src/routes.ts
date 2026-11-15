// The route table: every path the Worker answers itself, with who may call it, and the hooks that run on sensor
// intake. Additive only: add a line, never reorder or rewrite one (docs/agents/ownership.md).
// Paths: the researchers' page at / with its sign-in at /signin and its data under /dashboard/api, the sensor API
// under /api/v1. The page and code files under /dashboard are served by router.ts (the public demo at /dashboard/).
import type { Route } from "./router.ts";
import type { IntakeHooks } from "./api/intake.ts";
import { signIn, signInPage } from "./auth/signin.ts";
import { checkin, soundList } from "./api/checkin.ts";
import { postEvents } from "./api/events.ts";
import { listEvents } from "./eventlog.ts";
import { deleteSound, listSounds, setSensitivity, switchSound } from "./sounds/sounds.ts";
import { listSamples, sampleAudio } from "./player/player.ts";
import { listPlan, placeOnCheckin, placeSensor, removeSensor } from "./sensors/plan.ts";
import { clearEvents, listActivities } from "./activities/activities.ts";
import { teachBackground, teachSound } from "./teach/teach.ts";
import { listLocations, locateOnArrival } from "./location/location.ts";
import { calibrationState, postReport, startCalibration } from "./calibration/calibration.ts";
import { dismissAlert, sendWarning } from "./warnings/warnings.ts";

export const routes: Route[] = [
  { method: "GET", path: "/signin", access: "public", handle: signInPage },
  { method: "POST", path: "/signin", access: "public", handle: signIn },
  { method: "GET", path: "/dashboard/api/events", access: "researcher", handle: listEvents },
  { method: "POST", path: "/api/v1/sensors/:sensor/checkin", access: "sensor", handle: checkin },
  { method: "GET", path: "/api/v1/sensors/:sensor/sounds", access: "sensor", handle: soundList },
  { method: "POST", path: "/api/v1/sensors/:sensor/events", access: "sensor", handle: postEvents },
  { method: "GET", path: "/dashboard/api/sounds", access: "researcher", handle: listSounds },
  { method: "PATCH", path: "/dashboard/api/sounds/:sound", access: "researcher", handle: switchSound },
  { method: "DELETE", path: "/dashboard/api/sounds/:sound", access: "researcher", handle: deleteSound },
  { method: "GET", path: "/dashboard/api/player/samples", access: "researcher", handle: listSamples },
  { method: "GET", path: "/dashboard/api/player/samples/:file", access: "researcher", handle: sampleAudio },
  { method: "GET", path: "/dashboard/api/sensors", access: "researcher", handle: listPlan },
  { method: "PATCH", path: "/dashboard/api/sensors/:sensor", access: "researcher", handle: placeSensor },
  { method: "DELETE", path: "/dashboard/api/sensors/:sensor", access: "researcher", handle: removeSensor },
  { method: "GET", path: "/dashboard/api/activities", access: "researcher", handle: listActivities },
  { method: "DELETE", path: "/dashboard/api/events", access: "researcher", handle: clearEvents },
  { method: "POST", path: "/dashboard/api/teach", access: "researcher", handle: teachSound },
  { method: "GET", path: "/dashboard/api/teach/background", access: "researcher", handle: teachBackground },
  { method: "GET", path: "/dashboard/api/locations", access: "researcher", handle: listLocations },
  { method: "GET", path: "/dashboard/api/calibration", access: "researcher", handle: calibrationState },
  { method: "POST", path: "/dashboard/api/calibration", access: "researcher", handle: startCalibration },
  { method: "POST", path: "/api/v1/sensors/:sensor/calibration", access: "sensor", handle: postReport },
  { method: "PATCH", path: "/dashboard/api/sounds", access: "researcher", handle: setSensitivity },
  { method: "POST", path: "/dashboard/api/warnings", access: "researcher", handle: sendWarning },
  { method: "POST", path: "/dashboard/api/dismissals", access: "researcher", handle: dismissAlert },
];

// Run after a check-in (or first contact) is stored, and after a request's accepted events are stored.
export const hooks: IntakeHooks = {
  sensorCheckedIn: [placeOnCheckin],
  eventsAccepted: [locateOnArrival],
};
