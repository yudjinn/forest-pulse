// The live event log: the latest events, newest first, refreshed by the shell's 2 s poll.
import { clockTime, poll } from "/dashboard/shell.js";

const section = /** @type {HTMLElement} */ (document.getElementById("log"));
const body = /** @type {HTMLTableSectionElement} */ (section.querySelector("tbody"));
const empty = /** @type {HTMLElement} */ (section.querySelector(".log-empty"));

/**
 * @typedef {{ id: number, sensor_id: string, sensor_name: string, sound_name: string, confidence: number, angle_deg: number | null,
 *   occurred_at: string }} LogEvent
 */

/** @param {{ events: LogEvent[] }} data */
function render(data) {
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
}

poll("/dashboard/api/events", render);
