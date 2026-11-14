// Suspected activities on the overview page, newest first, refreshed by the shell's 2 s poll, and the Clear events
// action behind its confirmation.
import { clockTime, poll } from "/dashboard/shell.js";

const CATEGORY = /** @type {Record<string, string>} */ ({
  logging: "Logging",
  vehicle: "Vehicle",
  poaching: "Poaching",
  wildlife: "Wildlife",
});

const section = /** @type {HTMLElement} */ (document.getElementById("activities"));
const list = /** @type {HTMLOListElement} */ (section.querySelector(".activity-list"));
const empty = /** @type {HTMLElement} */ (section.querySelector(".activities-empty"));
const error = /** @type {HTMLElement} */ (section.querySelector(".error"));
const clear = /** @type {HTMLButtonElement} */ (section.querySelector(".activities-clear"));
const confirm = /** @type {HTMLDialogElement} */ (section.querySelector(".activities-confirm"));

/**
 * @typedef {{ category: string, sounds: string[], sensors: string[], first_at: string, last_at: string,
 *   event_count: number, location: { x_m: number, y_m: number,
 *   distances: { sensor_id: string, distance_m: number }[] } | null }} Activity
 */

let clearing = false;
let count = 0;

/** @param {string} className @param {string} text */
function line(className, text) {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

/** One card: icon, category and event count, then one line each for sounds, time and sensors. @param {Activity} a */
function card(a) {
  const item = document.createElement("li");
  item.className = `activity activity-${a.category}`;
  const icon = document.createElement("img");
  icon.src = `/dashboard/icons/${a.category}.svg`;
  icon.alt = "";
  icon.dataset.testid = "activity-icon";
  icon.width = 24;
  icon.height = 24;
  const badge = document.createElement("span");
  badge.className = "activity-icon";
  badge.append(icon);

  const title = document.createElement("div");
  title.className = "activity-title";
  const name = document.createElement("h3");
  name.textContent = CATEGORY[a.category] ?? a.category;
  title.append(name, line("activity-count", a.event_count === 1 ? "1 event" : `${a.event_count} events`));

  const first = clockTime(new Date(a.first_at));
  const last = clockTime(new Date(a.last_at));
  const body = document.createElement("div");
  body.className = "activity-body";
  body.append(
    title,
    line("activity-sounds", a.sounds.join(", ")),
    line("activity-meta", first === last ? first : `${first} to ${last}`),
    line("activity-meta", a.sensors.join(", ")),
  );
  if (a.location) {
    body.append(line("activity-meta", a.location.distances
      .map((d) => `${d.distance_m.toFixed(1)} m from ${d.sensor_id}`).join(", ")));
  }
  item.append(badge, body);
  return item;
}

/** @param {{ activities: Activity[] }} data */
function render(data) {
  list.replaceChildren(...data.activities.map(card));
  count = data.activities.length;
  empty.hidden = count > 0;
  clear.disabled = clearing || count === 0;
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
    if (res.status === 401) {
      location.assign("/dashboard/signin");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render({ activities: [] });
  } catch {
    error.textContent = "Couldn't clear, try again";
    error.hidden = false;
  } finally {
    clearing = false;
    clear.disabled = count === 0;
  }
});

poll("/dashboard/api/activities", render);
