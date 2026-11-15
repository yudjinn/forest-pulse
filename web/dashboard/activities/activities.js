// What was heard, down the left of the map: an activity per suspected situation, newest first, refreshed by the
// shell's 2 s poll. An activity heard in the last 15 s, or one that alerts or has a warning on its way, stands
// large. A logging activity also carries its warnings, Send warning, and the alert while the service says it
// alerts (warnings.js). Clear events, behind its confirmation, sits with the event log.
import { clockTime, poll, refresh, serviceNow, signIn } from "/dashboard/shell.js";
import { warningPart } from "/dashboard/activities/warnings.js";
import { setAlarming } from "/dashboard/plan/plan.js";

const CATEGORY = /** @type {Record<string, string>} */ ({
  logging: "Logging",
  vehicle: "Vehicle",
  poaching: "Poaching",
  wildlife: "Wildlife",
});
// An activity stands large this long after its last event: as long as its sound shows on the map.
const LIVE_MS = 15_000;

const section = /** @type {HTMLElement} */ (document.getElementById("activities"));
const list = /** @type {HTMLOListElement} */ (section.querySelector(".activity-list"));
const empty = /** @type {HTMLElement} */ (section.querySelector(".activities-empty"));
const error = /** @type {HTMLElement} */ (document.querySelector(".activities-error"));
const clear = /** @type {HTMLButtonElement} */ (document.querySelector(".activities-clear"));
const confirm = /** @type {HTMLDialogElement} */ (document.querySelector(".activities-confirm"));

/**
 * @typedef {{ category: string, sounds: string[], sensors: string[], sensor_names: string[], first_at: string,
 *   last_at: string, event_count: number, location: { x_m: number, y_m: number,
 *   distances: { sensor_id: string, sensor_name: string, distance_m: number }[] } | null }
 *   & import("./warnings.js").Warnable} Activity
 */

let clearing = false;
let count = 0;
/** @type {{ activities: Activity[] } | null} */
let last = null;
// What the list last drew: a reply that changes nothing rebuilds nothing, so a press is never lost to a redraw.
let drawn = "";
const redraw = () => last && render(last, true);
/** @type {ReturnType<typeof setTimeout> | undefined} */
let settle;

/** @param {string} className @param {...(string | Node)} parts */
function line(className, ...parts) {
  const p = document.createElement("p");
  p.className = className;
  p.append(...parts);
  return p;
}

/** @param {string} text */
function part(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

/** @param {Activity} a */
const live = (a) => a.alert || a.warnings.some((w) => w.on_its_way) || serviceNow() - Date.parse(a.last_at) < LIVE_MS;

/**
 * One activity: its category, then a line each for its sounds, where it was, and when, how often and by which
 * sensors it was heard.
 * @param {Activity} a
 */
function card(a) {
  const item = document.createElement("li");
  item.className = `activity c-${a.category}${live(a) ? " live" : ""}`;
  const icon = document.createElement("img");
  icon.src = `/dashboard/icons/${a.category}.svg`;
  icon.alt = "";
  icon.dataset.testid = "activity-icon";
  icon.width = 24;
  icon.height = 24;
  const badge = document.createElement("span");
  badge.className = "activity-icon";
  badge.append(icon);

  const name = document.createElement("h3");
  name.textContent = CATEGORY[a.category] ?? a.category;
  const first = clockTime(new Date(a.first_at));
  const end = clockTime(new Date(a.last_at));
  const body = document.createElement("div");
  body.className = "activity-body";
  body.append(name, line("activity-sounds", a.sounds.join(", ")));
  if (a.location) {
    body.append(line("activity-meta", a.location.distances
      .map((d) => `${d.distance_m.toFixed(1)} m from ${d.sensor_name}`).join(", ")));
  }
  body.append(line("activity-meta", part(first === end ? first : `${first} to ${end}`), ", ",
    part(a.event_count === 1 ? "1 event" : `${a.event_count} events`), ", ", part(a.sensor_names.join(", "))));
  if (a.category === "logging") body.append(...warningPart(a, redraw));
  item.append(badge, body);
  return item;
}

/**
 * @param {{ activities: Activity[] }} data
 * @param {boolean} [force] draw even when the reply is the one already drawn: something this page holds changed
 */
function render(data, force = false) {
  last = data;
  const key = JSON.stringify(data.activities) + data.activities.map(live).join();
  if (force || key !== drawn) {
    drawn = key;
    // A focused button keeps the focus through the redraw.
    const active = document.activeElement;
    const focused = active instanceof HTMLButtonElement && list.contains(active)
      ? { at: [...list.children].indexOf(/** @type {Element} */ (active.closest("li"))), text: active.textContent }
      : null;
    list.replaceChildren(...data.activities.map(card));
    if (focused) {
      [...(list.children[focused.at]?.querySelectorAll("button") ?? [])].find((b) => b.textContent === focused.text)?.focus();
    }
  }
  count = data.activities.length;
  empty.hidden = count > 0;
  clear.disabled = clearing || count === 0;
  document.body.classList.toggle("alerting", data.activities.some((a) => a.alert));
  // The boards a warning is still on its way to are sounding it, or about to.
  setAlarming(new Set(data.activities.flatMap((a) => a.warnings.filter((w) => w.on_its_way)
    .flatMap((w) => w.outcomes.filter((o) => o.outcome === "pending").map((o) => o.sensor_id)))));
  // An activity that stands large settles small once its time is up, without waiting for a poll to change.
  clearTimeout(settle);
  const due = data.activities.map((a) => Date.parse(a.last_at) + LIVE_MS - serviceNow()).filter((ms) => ms > 0);
  if (due.length) settle = setTimeout(redraw, Math.min(...due) + 50);
}

clear.addEventListener("click", () => {
  error.hidden = true;
  confirm.showModal();
});

confirm.addEventListener("click", async (e) => {
  const action = /** @type {HTMLElement} */ (e.target).closest("button")?.dataset.action;
  if (!action) return;
  confirm.close();
  if (action !== "clear") return;
  clearing = true;
  clear.disabled = true;
  try {
    const res = await fetch("/dashboard/api/events", { method: "DELETE" });
    if (res.status === 401) return signIn();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render({ activities: [] });
    refresh();
  } catch {
    error.textContent = "Couldn't clear, try again";
    error.hidden = false;
  } finally {
    clearing = false;
    clear.disabled = count === 0;
  }
});

poll("/dashboard/api/activities", render);
