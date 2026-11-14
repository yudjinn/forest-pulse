// Calibrate on the sensor plan: the button, the run's state beside it, and the measured distance drawn between the
// sensors a calibration run placed. The service runs the run; this page starts it and follows the shell's poll.
// Sensors are named as the plan names them.
import { poll, refresh } from "/dashboard/shell.js";
import { addLayer, addTool } from "/dashboard/plan/plan.js";

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

const SVG = "http://www.w3.org/2000/svg";
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

const status = document.createElement("p");
status.className = "calibrate-status";
status.setAttribute("role", "status");
const button = document.createElement("button");
button.type = "button";
button.className = "calibrate-button";
button.textContent = "Calibrate";
button.disabled = true;
addTool(status);
addTool(button);

/** @type {CalibrationState | null} */
let state = null;
// The service's clock minus this page's, from the latest reply.
let skew = 0;
let starting = false;
// Why the service refused the last press, shown until a poll at least REFUSED_MS later.
/** @type {{ text: string, until: number } | null} */
let refused = null;
const REFUSED_MS = 4000;
// The plan's names for its sensors, as of its latest draw.
/** @type {Map<string, string>} */
let names = new Map();
/** A sensor's name on the plan, or its own id when it is not on the plan. @param {string} id */
const nameOf = (id) => names.get(id) ?? id;

/** @param {string} name @param {Record<string, string | number>} attrs */
function svgEl(name, attrs) {
  const el = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

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
  const text = refused?.text ?? (state ? line({ ...state, now: Date.now() + skew }) : "");
  status.textContent = text;
  status.hidden = !text;
}

const layer = addLayer({
  draw(g, view) {
    // The status line names sensors too, so it follows the plan's names.
    names = new Map(view.sensors.map((s) => [s.id, s.name]));
    show();
    if (!state?.layout) return;
    for (const d of state.layout.distances) {
      const a = view.sensors.find((s) => s.id === d.a);
      const b = view.sensors.find((s) => s.id === d.b);
      if (!a || !b) continue;
      const [x1, y1] = view.toScreen(a.x_m, a.y_m);
      const [x2, y2] = view.toScreen(b.x_m, b.y_m);
      const text = `${d.distance_m.toFixed(2)} m`;
      const group = svgEl("g", { class: "calibrate-distance", role: "img", "aria-label": `Measured ${text} from ${a.name} to ${b.name}` });
      group.append(svgEl("line", { x1, y1, x2, y2 }));
      const label = svgEl("text", { x: ((x1 + x2) / 2).toFixed(1), y: ((y1 + y2) / 2 - 8).toFixed(1), "text-anchor": "middle" });
      label.textContent = text;
      group.append(label);
      g.append(group);
    }
  },
});

/** @param {CalibrationState} data */
function render(data) {
  skew = data.now - Date.now();
  state = data;
  if (refused && Date.now() > refused.until) refused = null;
  show();
  layer.redraw();
}

button.addEventListener("click", async () => {
  starting = true;
  show();
  try {
    const res = await fetch("/dashboard/api/calibration", { method: "POST" });
    if (res.status === 401) {
      location.assign("/dashboard/signin");
      return;
    }
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
