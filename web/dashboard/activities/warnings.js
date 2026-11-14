// The warnings part of a logging activity's card: one line per warning with its time and each board's outcome, and
// Send warning while the service says the activity can be warned about. A Send carries a request id that is kept
// until the service answers it, so pressing again after a lost reply never sends a second warning.
import { clockTime, refresh } from "/dashboard/shell.js";

const ON_ITS_WAY = "A warning is on its way";
const FAILED = "Couldn't send the warning. Try again.";

/**
 * @typedef {"pending" | "played" | "failed" | "no_confirmation" | "not_delivered" | "no_buzzer" | "calibrating"} Outcome
 * @typedef {{ id: string, sent_at: string, on_its_way: boolean,
 *   outcomes: { sensor_id: string, sensor_name: string, outcome: Outcome }[] }} Warning
 * @typedef {{ category: string, first_at: string, newest_event_id: number, warnable: boolean,
 *   warnings: Warning[] }} Warnable
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

/** Per card, across redraws: the request id of a Send not yet answered, whether one is in flight, and its error. */
/** @type {Map<string, { requestId: string | null, sending: boolean, error: string | null }>} */
const cards = new Map();

/** A card keeps its key while it grows: its category and first event. @param {Warnable} a */
const keyOf = (a) => `${a.category} ${a.first_at}`;

/**
 * The card's warning lines, error and Send button, for appending to its body.
 * @param {Warnable} a
 * @param {() => void} redraw draws the cards again from the last reply
 * @returns {HTMLElement[]}
 */
export function warningPart(a, redraw) {
  const key = keyOf(a);
  const state = cards.get(key) ?? { requestId: null, sending: false, error: null };
  cards.set(key, state);
  if (state.error === ON_ITS_WAY && !a.warnings.some((w) => w.on_its_way)) state.error = null;

  /** @type {HTMLElement[]} */
  const out = a.warnings.map((w) => {
    const p = document.createElement("p");
    p.className = "activity-warning";
    p.textContent = warningLine(w);
    return p;
  });
  if (state.error) {
    const p = document.createElement("p");
    p.className = "error";
    p.setAttribute("role", "alert");
    p.textContent = state.error;
    out.push(p);
  }
  if (a.warnable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "activity-warn";
    button.textContent = a.warnings.length ? "Send again" : "Send warning";
    button.disabled = state.sending;
    button.addEventListener("click", () => send(a, state, redraw));
    out.push(button);
  }
  return out;
}

/** @param {Warnable} a @param {{ requestId: string | null, sending: boolean, error: string | null }} state
 *  @param {() => void} redraw */
async function send(a, state, redraw) {
  if (state.sending) return;
  state.requestId ??= crypto.randomUUID();
  state.sending = true;
  state.error = null;
  redraw();
  try {
    const res = await fetch("/dashboard/api/warnings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: state.requestId, event_id: a.newest_event_id }),
    });
    if (res.status === 401) {
      location.assign("/dashboard/signin");
      return;
    }
    if (res.ok) {
      state.requestId = null;
      refresh();
      return;
    }
    const reply = await res.json().catch(() => ({}));
    state.error = res.status === 409 && reply.reason === "on_its_way" ? ON_ITS_WAY : FAILED;
    // The service answered: the next press is a new Send. A server error may have sent it, so a retry keeps the id.
    if (res.status < 500) state.requestId = null;
  } catch {
    state.error = FAILED; // no answer: the warning may have been sent, so the retry keeps the request id
  } finally {
    state.sending = false;
    redraw();
  }
}
