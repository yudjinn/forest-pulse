// Calibrate, at the top of the Devices panel: the button, the run's state beside it, and the measured distance
// drawn between the sensors a calibration run placed. The service runs the run; this page starts it and follows
// the shell's poll. Sensors are named as the plan names them. The distances show while the Devices panel is open.
import { poll, refresh, serviceClock, serviceNow, signIn } from "/dashboard/shell.js";
import { onSensors, sensorsNow } from "/dashboard/plan/plan.js";
import { addLayer, invalidate, overlay, place, ringPath } from "/dashboard/plan/scene.js";

/**
 * @typedef {{ id: string, state: "waiting" | "beeping" | "calibrated" | "failed", ready: number,
 *   participants: number, finished_at: number | null,
 *   failure: { sensors: string[], reason: string } | null, speed_of_sound_assumed: boolean }} RunState
 * @typedef {{ run_id: string, measured_at: number, sensors: string[],
 *   distances: { a: string, b: string, distance_m: number }[], speed_of_sound_assumed: boolean,
 *   left_out: string[] }} Layout
 * @typedef {{ now: number, eligible: number, running: boolean, run: RunState | null, layout: Layout | null }}
 *   CalibrationState
 */

// A finished run's failure shows this long by the service's clock; progress shows while the run lasts.
const SHOW_FAILURE_MS = 60_000;
/** @type {Record<string, string>} */
const REASONS = {
  not_ready: "not ready",
  no_stream: "couldn't start the stream",
  emit_failed: "couldn't beep",
  own_beep_not_heard: "its beep wasn't heard",
  report_missing: "report missing",
  not_repeatable: "distances not repeatable",
};
// Failures of a pair, said around the pair's names.
/** @type {Record<string, (a: string, b: string) => string>} */
const PAIR_REASONS = {
  no_direction: (a, b) => `couldn't tell direction between ${a} and ${b}`,
  not_a_triangle: (a, b) => `distance between ${a} and ${b} too long for a triangle`,
  too_flat: (a, b) => `${a} and ${b} nearly in line with the third sensor`,
  bearings_disagree: (a, b) => `directions between ${a} and ${b} don't match the distances`,
};

const status = /** @type {HTMLElement} */ (document.querySelector(".calibrate-status"));
const button = /** @type {HTMLButtonElement} */ (document.querySelector(".calibrate-button"));

/** @type {CalibrationState | null} */
let state = null;
let starting = false;
// Why the service refused the last press, shown until a poll at least REFUSED_MS later.
/** @type {{ text: string, until: number } | null} */
let refused = null;
const REFUSED_MS = 4000;
// The plan's names for its sensors.
/** @type {Map<string, string>} */
let names = new Map();
/** A sensor's name on the plan, or its own id when it is not on the plan. @param {string} id */
const nameOf = (id) => names.get(id) ?? id;

/** @param {number} n */
const pad = (n) => String(n).padStart(2, "0");
/** @param {number} ms */
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** @param {CalibrationState} s */
function line(s) {
  const run = s.run;
  if (run?.state === "waiting") return `Waiting for boards (${run.ready} of ${run.participants} ready)`;
  if (run?.state === "beeping") return "Beeping";
  if (run?.state === "failed" && run.failure && run.finished_at !== null
    && s.now - run.finished_at < SHOW_FAILURE_MS) {
    const sensors = run.failure.sensors.map(nameOf);
    const reason = run.failure.reason;
    const pair = PAIR_REASONS[reason];
    if (pair && sensors.length === 2) return `Calibration failed: ${pair(sensors[0], sensors[1])}`;
    return `Calibration failed: ${sensors.join(" and ")} ${REASONS[reason] ?? reason}`;
  }
  if (s.layout) {
    return [
      `Calibrated ${hhmm(s.layout.measured_at)}`,
      ...(s.layout.speed_of_sound_assumed ? ["speed of sound assumed"] : []),
      ...s.layout.left_out.map((id) => `${nameOf(id)} left out`),
    ].join(", ");
  }
  return "";
}

function show() {
  button.disabled = starting || !state || state.running || state.eligible < 2;
  const text = refused?.text ?? (state ? line({ ...state, now: serviceNow() }) : "");
  if (status.textContent !== text) status.textContent = text;
  status.hidden = !text;
}

/** The measured distances between sensors still on the plan, with where each end stands. */
function measured() {
  const sensors = sensorsNow();
  return (state?.layout?.distances ?? []).flatMap((d) => {
    const a = sensors.find((s) => s.id === d.a), b = sensors.find((s) => s.id === d.b);
    return a && b ? [{ a, b, text: `${d.distance_m.toFixed(2)} m` }] : [];
  });
}

/** One label per measured distance, kept across frames. @type {Map<string, HTMLElement>} */
const labels = new Map();

addLayer({
  active: () => state?.run?.state === "beeping",
  ground(g, view, now) {
    // While the boards beep, each sensor on the plan sends out rings.
    if (state?.run?.state === "beeping" && !view.still) {
      sensorsNow().filter((s) => s.online).forEach((s, i) => {
        const u = (now / 1400 + i / 3) % 1;
        ringPath(s.x_m, s.y_m, 0.15 + u * 1.1);
        g.strokeStyle = `rgba(251,247,239,${0.8 * (1 - u)})`;
        g.lineWidth = 2;
        g.stroke();
      });
    }
    if (!view.device) return;
    for (const { a, b } of measured()) {
      const from = view.P(a.x_m, a.y_m), to = view.P(b.x_m, b.y_m);
      g.setLineDash([4, 5]);
      g.beginPath();
      g.moveTo(from[0], from[1]);
      g.lineTo(to[0], to[1]);
      g.strokeStyle = "rgba(251,247,239,.55)";
      g.lineWidth = 1.2;
      g.stroke();
      g.setLineDash([]);
    }
  },
  overlay(view) {
    const seen = new Set();
    for (const { a, b, text } of view.device ? measured() : []) {
      const key = `${a.id} ${b.id}`;
      seen.add(key);
      let el = labels.get(key);
      if (!el) {
        el = document.createElement("span");
        el.className = "map-label";
        el.setAttribute("role", "img");
        el.append(document.createElement("span"));
        labels.set(key, el);
        overlay.append(el);
      }
      const label = `Measured ${text} from ${a.name} to ${b.name}`;
      if (el.getAttribute("aria-label") !== label) el.setAttribute("aria-label", label);
      if (el.firstElementChild && el.firstElementChild.textContent !== text) el.firstElementChild.textContent = text;
      const from = view.P(a.x_m, a.y_m), to = view.P(b.x_m, b.y_m);
      place(el, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2 - 10);
    }
    for (const [key, el] of labels) {
      if (seen.has(key)) continue;
      el.remove();
      labels.delete(key);
    }
  },
});

// The status line names sensors too, so it follows the plan's names.
onSensors((sensors) => {
  names = new Map(sensors.map((s) => [s.id, s.name]));
  show();
});

// What the map last drew of the run and the measured layout: a reply that changes neither draws nothing.
let mapped = "";

/** @param {CalibrationState} data */
function render(data) {
  serviceClock(data.now);
  state = data;
  if (refused && Date.now() > refused.until) refused = null;
  show();
  const key = JSON.stringify([data.run?.state, data.layout]);
  if (key === mapped) return;
  mapped = key;
  invalidate();
}

button.addEventListener("click", async () => {
  starting = true;
  show();
  try {
    const res = await fetch("/dashboard/api/calibration", { method: "POST" });
    if (res.status === 401) return signIn();
    if (!res.ok) {
      /** @type {{ error?: string }} */
      const body = await res.json().catch(() => ({}));
      refused = { text: body.error ?? "Couldn't start, try again", until: Date.now() + REFUSED_MS };
    }
  } catch {
    refused = { text: "Couldn't start, try again", until: Date.now() + REFUSED_MS };
  } finally {
    starting = false;
    show();
    refresh();
  }
});

poll("/dashboard/api/calibration", render);
