// The warnings part of a logging activity's card: one line per warning with its time and each board's outcome, and
// Send warning while the service says the activity can be warned about. The alert banner the shell shows on every
// page while the service says an activity alerts: Send warning and Dismiss. The card and the banner share one Send,
// whose request id is kept per activity until the service answers it, so pressing again after a lost reply, from
// either place, never sends a second warning.
// The shell imports this module for the banner and this module imports the shell; neither uses the other while
// loading, so the cycle is safe.
import { clockTime, refresh } from "/dashboard/shell.js";

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

/** A Send for this activity is in flight, from the card or the banner. @param {Warnable} a */
const sending = (a) => Boolean(sends.get(a.newest_event_id)?.inFlight);

/**
 * Sends a warning about the activity, from its card or the banner. Resolves null once the service has it (and
 * refreshes every view), or the error to show. A press while a Send for the activity is in flight joins it.
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
      location.assign("/dashboard/signin");
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

/** Per card, across redraws: the error its last Send left. */
/** @type {Map<string, { error: string | null }>} */
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
  const state = cards.get(key) ?? { error: null };
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
    button.disabled = sending(a);
    button.addEventListener("click", async () => {
      state.error = null;
      const sent = sendWarning(a);
      redraw();
      state.error = await sent;
      redraw();
    });
    out.push(button);
  }
  return out;
}

/**
 * The alert banner, for the shell to place under its header and feed from its poll of the activities reply. It
 * shows the newest activity the reply marks as alerting, its boards by name in number order, with Send warning and
 * Dismiss, and nothing otherwise.
 * @returns {{ element: HTMLElement, render: (data: { activities: Warnable[] }) => void }}
 */
export function alertBanner() {
  const element = document.createElement("section");
  element.className = "shell-alert";
  element.setAttribute("aria-label", "Logging alert");
  element.hidden = true;
  const text = document.createElement("p");
  text.className = "shell-alert-text";
  const send = document.createElement("button");
  send.type = "button";
  send.textContent = "Send warning";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "secondary";
  dismiss.textContent = "Dismiss";
  const actions = document.createElement("div");
  actions.className = "shell-alert-actions";
  actions.append(send, dismiss);
  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "alert");
  element.append(text, actions, error);

  /** The activity shown, its error (kept while the same activity alerts) and a Dismiss in flight. */
  /** @type {{ shown: Warnable | null, key: string | null, error: string | null, dismissing: boolean }} */
  const state = { shown: null, key: null, error: null, dismissing: false };

  const draw = () => {
    const a = state.shown;
    element.hidden = !a;
    if (!a) return;
    const names = [...a.sensor_names].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));
    text.textContent = `Logging detected near ${names.join(", ")}`;
    send.disabled = sending(a) || state.dismissing;
    dismiss.disabled = sending(a) || state.dismissing;
    error.textContent = state.error ?? "";
    error.hidden = !state.error;
  };

  /** Hides the banner once its action went through, until the refreshed reply says what to show. */
  const done = () => {
    state.shown = null;
    state.key = null;
    state.error = null;
    draw();
  };

  send.addEventListener("click", async () => {
    const a = state.shown;
    if (!a) return;
    state.error = null;
    const sent = sendWarning(a);
    draw();
    const failed = await sent;
    if (failed) state.error = failed;
    else if (state.key === keyOf(a)) return done();
    draw();
  });

  dismiss.addEventListener("click", async () => {
    const a = state.shown;
    if (!a || state.dismissing) return;
    state.dismissing = true;
    state.error = null;
    draw();
    try {
      const res = await fetch("/dashboard/api/dismissals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: a.newest_event_id }),
      });
      if (res.status === 401) {
        location.assign("/dashboard/signin");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.dismissing = false;
      refresh();
      if (state.key === keyOf(a)) return done();
    } catch {
      state.error = DISMISS_FAILED;
    } finally {
      state.dismissing = false;
    }
    draw();
  });

  /** @param {{ activities: Warnable[] }} data */
  const render = (data) => {
    const a = data.activities.find((x) => x.alert) ?? null;
    const key = a && keyOf(a);
    if (key !== state.key) state.error = null;
    state.shown = a;
    state.key = key;
    draw();
  };
  return { element, render };
}
