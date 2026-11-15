// The warnings part of a logging activity: one line per warning with its time and each board's outcome, and Send
// warning while the service says the activity can be warned about. While the service says the activity alerts,
// that part is the alert: it says where logging was detected and offers Send warning and Dismiss. A Send's request
// id is kept per activity until the service answers it, so pressing again after a lost reply never sends a second
// warning.
import { clockTime, refresh, signIn } from "/dashboard/shell.js";

const ON_ITS_WAY = "A warning is on its way";
const FAILED = "Couldn't send the warning. Try again.";
const DISMISS_FAILED = "Couldn't dismiss. Try again.";

/**
 * @typedef {"pending" | "played" | "failed" | "no_confirmation" | "not_delivered" | "no_buzzer" | "calibrating"} Outcome
 * @typedef {{ id: string, sent_at: string, on_its_way: boolean,
 *   outcomes: { sensor_id: string, sensor_name: string, outcome: Outcome }[] }} Warning
 * @typedef {{ category: string, first_at: string, newest_event_id: number, warnable: boolean,
 *   warnings: Warning[], alert: boolean, sensor_names: string[] }} Warnable
 */

/** How each outcome reads, in the order the line lists them. @type {[Outcome, (names: string) => string][]} */
const PHRASES = [
  ["played", (n) => `played on ${n}`],
  ["pending", (n) => `on its way to ${n}`],
  ["failed", (n) => `failed on ${n}`],
  ["no_confirmation", (n) => `no confirmation from ${n}`],
  ["not_delivered", (n) => `not delivered to ${n} (offline)`],
  ["no_buzzer", (n) => `no buzzer on ${n}`],
  ["calibrating", (n) => `skipped ${n} (calibrating)`],
];

/** "Warning sent 12:03:41 · played on Sensor 1, Sensor 2 · not delivered to Sensor 3 (offline)". @param {Warning} w */
export function warningLine(w) {
  const parts = [`Warning sent ${clockTime(new Date(w.sent_at))}`];
  for (const [outcome, phrase] of PHRASES) {
    const names = w.outcomes.filter((o) => o.outcome === outcome).map((o) => o.sensor_name);
    if (names.length) parts.push(phrase(names.join(", ")));
  }
  return parts.join(" · ");
}

/** Per activity, by its newest event id: the request id of a Send not yet answered, and the Send in flight. */
/** @type {Map<number, { requestId: string, inFlight: Promise<string | null> | null }>} */
const sends = new Map();

/** A Send for this activity is in flight. @param {Warnable} a */
const sending = (a) => Boolean(sends.get(a.newest_event_id)?.inFlight);

/**
 * Sends a warning about the activity. Resolves null once the service has it (and refreshes every view), or the
 * error to show. A press while a Send for the activity is in flight joins it.
 * @param {Warnable} a
 * @returns {Promise<string | null>}
 */
export function sendWarning(a) {
  const key = a.newest_event_id;
  let s = sends.get(key);
  if (!s) {
    s = { requestId: crypto.randomUUID(), inFlight: null };
    sends.set(key, s);
  }
  const state = s;
  state.inFlight ??= post(key, state.requestId).finally(() => { state.inFlight = null; });
  return state.inFlight;
}

/** @param {number} eventId @param {string} requestId @returns {Promise<string | null>} */
async function post(eventId, requestId) {
  try {
    const res = await fetch("/dashboard/api/warnings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, event_id: eventId }),
    });
    if (res.status === 401) {
      signIn();
      return null;
    }
    if (res.ok) {
      sends.delete(eventId);
      refresh();
      return null;
    }
    const reply = await res.json().catch(() => ({}));
    // The service answered: the next press is a new Send. A server error may have sent it, so a retry keeps the id.
    if (res.status < 500) sends.delete(eventId);
    return res.status === 409 && reply.reason === "on_its_way" ? ON_ITS_WAY : FAILED;
  } catch {
    return FAILED; // no answer: the warning may have been sent, so the retry keeps the request id
  }
}

/** Per activity, across redraws: the error its last Send or Dismiss left, and a Dismiss in flight. */
/** @type {Map<string, { error: string | null, dismissing: boolean }>} */
const cards = new Map();

/** An activity keeps its key while it grows: its category and first event. @param {Warnable} a */
const keyOf = (a) => `${a.category} ${a.first_at}`;

/**
 * Dismisses the activity's alert for every researcher. Resolves null once the service has it, or the error to show.
 * @param {Warnable} a
 * @returns {Promise<string | null>}
 */
async function dismiss(a) {
  try {
    const res = await fetch("/dashboard/api/dismissals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: a.newest_event_id }),
    });
    if (res.status === 401) {
      signIn();
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    refresh();
    return null;
  } catch {
    return DISMISS_FAILED;
  }
}

/**
 * The activity's warning lines, error and actions, for appending to its body.
 * @param {Warnable} a
 * @param {() => void} redraw draws the activities again from the last reply
 * @returns {HTMLElement[]}
 */
export function warningPart(a, redraw) {
  const key = keyOf(a);
  const state = cards.get(key) ?? { error: null, dismissing: false };
  cards.set(key, state);
  if (state.error === ON_ITS_WAY && !a.warnings.some((w) => w.on_its_way)) state.error = null;
  if (state.error === DISMISS_FAILED && !a.alert) state.error = null;

  /** @type {HTMLElement[]} */
  const out = a.warnings.map((w) => {
    const p = document.createElement("p");
    p.className = "activity-warning";
    p.textContent = warningLine(w);
    return p;
  });
  /** @type {HTMLElement[]} */
  const controls = [];
  if (state.error) {
    const p = document.createElement("p");
    p.className = "error";
    p.setAttribute("role", "alert");
    p.textContent = state.error;
    controls.push(p);
  }
  const actions = document.createElement("div");
  actions.className = "activity-actions";
  if (a.warnable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = a.alert ? "button warn" : "link";
    button.textContent = a.warnings.length ? "Send again" : "Send warning";
    button.disabled = sending(a) || state.dismissing;
    button.addEventListener("click", async () => {
      state.error = null;
      const sent = sendWarning(a);
      redraw();
      state.error = await sent;
      redraw();
    });
    actions.append(button);
  }
  if (a.alert) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link";
    button.textContent = "Dismiss";
    button.disabled = sending(a) || state.dismissing;
    button.addEventListener("click", async () => {
      if (state.dismissing) return;
      state.dismissing = true;
      state.error = null;
      redraw();
      state.error = await dismiss(a);
      state.dismissing = false;
      redraw();
    });
    actions.append(button);
  }
  if (actions.children.length) controls.push(actions);
  if (!a.alert) return [...out, ...controls];

  // The alert: the same controls, named as one region with what was detected and where.
  const alert = document.createElement("section");
  alert.className = "activity-alert";
  alert.setAttribute("aria-label", "Logging alert");
  const names = [...a.sensor_names].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));
  const text = document.createElement("p");
  text.className = "aside-text";
  text.textContent = `Logging detected near ${names.join(", ")}`;
  alert.append(text, ...controls);
  return [...out, alert];
}
