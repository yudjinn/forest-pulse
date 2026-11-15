// The event log, in its tab of the Devices panel: the latest events, newest first, refreshed by the shell's 2 s
// poll. Other parts of the page follow the same events (the pulse, the sound list).
import { clockTime, poll } from "/dashboard/shell.js";

const body = /** @type {HTMLTableSectionElement} */ (document.querySelector(".log-table tbody"));
const table = /** @type {HTMLElement} */ (document.querySelector(".log-table"));
const empty = /** @type {HTMLElement} */ (document.querySelector(".log-empty"));

/**
 * @typedef {{ id: number, sensor_id: string, sensor_name: string, sound_id: string, sound_name: string,
 *   category: string, confidence: number, angle_deg: number | null, occurred_at: string }} LogEvent
 */

/** @type {((events: LogEvent[]) => void)[]} */
const watchers = [];
// What the table last drew, so a reply that changes nothing touches nothing.
/** @type {string | null} */
let drawn = null;

/** Calls back with the latest events, newest first, on every reply. @param {(events: LogEvent[]) => void} watch */
export function onEvents(watch) {
  watchers.push(watch);
}

/** @param {{ events: LogEvent[] }} data */
function render(data) {
  for (const watch of watchers) watch(data.events);
  const key = data.events.map((e) => `${e.id} ${e.sensor_name}`).join("|");
  if (key === drawn) return;
  drawn = key;
  const rows = data.events.map((e) => {
    const tr = document.createElement("tr");
    const cells = [
      clockTime(new Date(e.occurred_at)),
      e.sensor_name,
      e.sound_name,
      `${Math.round(e.confidence * 100)}%`,
      e.angle_deg === null ? "" : `${Math.round(e.angle_deg)}°`,
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  });
  body.replaceChildren(...rows);
  empty.hidden = rows.length > 0;
  table.hidden = rows.length === 0;
}

poll("/dashboard/api/events", render);
