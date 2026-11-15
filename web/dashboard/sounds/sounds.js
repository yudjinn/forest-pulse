// What the sensors listen for, down the right of the map: every sound sensors can report, each with its switch, and
// a Delete for each taught sound behind a confirmation; Teach a new sound opens the teach dialog, whose module loads
// on first use. The sensitivity every sound must reach sits in the Devices panel. The list follows the shell's 2 s
// poll; a switch or the sensitivity saves at once and goes back to the saved value if the save fails. Once this
// researcher changes the list (here, or by teaching), a line says how many sensors on the plan have the latest
// version, from the same poll, until the page is reloaded. A sound lights up in its row as sensors report it.
import { poll, refresh, signIn } from "/dashboard/shell.js";
import { onEvents } from "/dashboard/log/log.js";
import { colorOf, rgba } from "/dashboard/plan/scene.js";

const CATEGORY = /** @type {Record<string, string>} */ ({
  logging: "Logging",
  vehicle: "Vehicle",
  poaching: "Poaching",
  wildlife: "Wildlife",
});
const KIND = /** @type {Record<string, string>} */ ({ detector: "Trained detector", label: "Built-in label" });

/** @typedef {{ id: string, name: string, category: string, kind: string, enabled: boolean, taught: boolean }} Sound */
/**
 * @typedef {{ item: HTMLLIElement, name: HTMLElement, meta: HTMLElement, toggle: HTMLInputElement,
 *   remove: HTMLButtonElement, error: HTMLElement, saving: boolean, deleting: boolean }} Row
 */

const SVG = "http://www.w3.org/2000/svg";
const list = /** @type {HTMLUListElement} */ (document.querySelector("#sounds .sound-list"));
const confirm = /** @type {HTMLDialogElement} */ (document.querySelector(".sound-confirm"));
const confirmTitle = /** @type {HTMLElement} */ (confirm.querySelector("h2"));
/** @type {Map<string, Row>} */
const rows = new Map();
// The newest sound-list version seen. Every change bumps it, so a poll that answers with an older version was read
// before a save this page already knows about, and is ignored.
let version = 0;
let nextId = 0;
const reach = /** @type {HTMLElement} */ (document.querySelector("#sounds .sound-reach"));
// Whether this researcher changed the sound list since the page loaded.
let changed = false;

/** A change this page made (teaching included): the version it moved the list to. @param {number} to */
export function madeChange(to) {
  version = Math.max(version, to);
  changed = true;
  refresh();
}
// The sound the open confirmation would delete.
/** @type {string | null} */
let pending = null;

/** @param {string} id */
function makeRow(id) {
  const item = document.createElement("li");
  const label = document.createElement("label");
  label.className = "sound";
  const icon = document.createElement("span");
  icon.className = "category-icon";
  const name = document.createElement("span");
  name.className = "sound-name";
  name.id = `sound-name-${nextId++}`;
  // The category, which the icon and its colour show, in words for a screen reader.
  const meta = document.createElement("span");
  meta.className = "aside-text";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-labelledby", name.id);
  toggle.id = `sound-switch-${nextId++}`;
  label.htmlFor = toggle.id;
  label.append(icon, name, meta);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "sound-delete";
  remove.title = "Delete";
  const cross = document.createElementNS(SVG, "svg");
  cross.setAttribute("class", "icon");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", "#icon-close");
  cross.append(use);
  remove.append(cross);
  remove.hidden = true;
  const row = document.createElement("div");
  row.className = "sound-row";
  row.append(label, remove, toggle);
  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  item.append(row, error);
  /** @type {Row} */
  const made = { item, name, meta, toggle, remove, error, saving: false, deleting: false };
  toggle.addEventListener("change", () => save(id, made));
  remove.addEventListener("click", () => {
    made.error.hidden = true;
    pending = id;
    confirmTitle.textContent = `Delete ${made.name.textContent}?`;
    confirm.showModal();
  });
  return made;
}

/** @param {string} id @param {Row} row */
async function remove(id, row) {
  row.deleting = true;
  row.remove.disabled = true;
  row.error.hidden = true;
  try {
    const res = await fetch(`/dashboard/api/sounds/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.status === 401) return signIn();
    // Already gone (deleted from another tab): the next poll drops the row.
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = /** @type {{ version: number }} */ (await res.json());
    madeChange(reply.version);
    rows.delete(id);
    row.item.remove();
  } catch {
    row.error.textContent = "Couldn't delete, try again";
    row.error.hidden = false;
  } finally {
    row.deleting = false;
    row.remove.disabled = false;
  }
}

confirm.addEventListener("click", (e) => {
  const action = /** @type {HTMLElement} */ (e.target).closest("button")?.dataset.action;
  if (!action) return;
  confirm.close();
  const row = pending === null ? undefined : rows.get(pending);
  if (action === "delete" && pending !== null && row && !row.deleting) remove(pending, row);
  pending = null;
});

/** @param {string} id @param {Row} row */
async function save(id, row) {
  const enabled = row.toggle.checked;
  row.saving = true;
  row.toggle.disabled = true;
  row.error.hidden = true;
  try {
    const res = await fetch(`/dashboard/api/sounds/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.status === 401) return signIn();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = /** @type {{ sound: Sound, version: number }} */ (await res.json());
    madeChange(reply.version);
    row.toggle.checked = reply.sound.enabled;
  } catch {
    row.toggle.checked = !enabled;
    row.error.textContent = "Couldn't save, try again";
    row.error.hidden = false;
  } finally {
    row.saving = false;
    row.toggle.disabled = false;
  }
}

// The sensitivity, shown and set in whole percent. `saved` is the value the service last reported. While the slider
// is being dragged or saved, polls update `saved` but leave the slider where the researcher put it.
const sensitivity = /** @type {HTMLElement} */ (document.querySelector(".sensitivity"));
const slider = /** @type {HTMLInputElement} */ (sensitivity.querySelector("input"));
const sliderValue = /** @type {HTMLElement} */ (sensitivity.querySelector(".sensitivity-value"));
const sliderError = /** @type {HTMLElement} */ (sensitivity.querySelector(".error"));
let saved = 50;
let moving = false;
let savingSensitivity = false;

/** @param {number} percent */
function showSensitivity(percent) {
  slider.value = String(percent);
  sliderValue.textContent = `${percent}%`;
  slider.setAttribute("aria-valuetext", `${percent}%`);
}

// Saves whatever the slider shows, one save at a time: a value picked while a save is on its way is sent after it,
// so this page's saves reach the service in the order they were made.
async function saveSensitivity() {
  if (savingSensitivity) return;
  savingSensitivity = true;
  sliderError.hidden = true;
  try {
    for (let percent = Number(slider.value); percent !== saved; percent = Number(slider.value)) {
      const res = await fetch("/dashboard/api/sounds", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sensitivity: percent / 100 }),
      });
      if (res.status === 401) return signIn();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reply = /** @type {{ sensitivity: number, version: number }} */ (await res.json());
      madeChange(reply.version);
      saved = Math.round(reply.sensitivity * 100);
    }
  } catch {
    sliderError.textContent = "Couldn't save, try again";
    sliderError.hidden = false;
  } finally {
    savingSensitivity = false;
    if (!moving) showSensitivity(saved);
  }
}

slider.addEventListener("input", () => {
  moving = true;
  showSensitivity(Number(slider.value));
});
slider.addEventListener("change", () => {
  moving = false;
  saveSensitivity();
});
// A drag let go where it started fires no change: the slider is free for polls again.
for (const type of ["pointerup", "blur"]) {
  slider.addEventListener(type, () => {
    if (Number(slider.value) === saved) moving = false;
  });
}

/**
 * @param {{ version: number, sensitivity: number, reach: { sensors: number, reached: number }, sounds: Sound[] }} data
 */
function render(data) {
  if (data.version < version) return;
  version = data.version;
  const { sensors, reached } = data.reach;
  reach.hidden = !changed || sensors === 0;
  reach.textContent = `Reached ${reached} of ${sensors} ${sensors === 1 ? "sensor" : "sensors"}`;
  saved = Math.round(data.sensitivity * 100);
  if (!moving && !savingSensitivity) showSensitivity(saved);
  sensitivity.hidden = false;
  const seen = new Set();
  const items = data.sounds.map((s) => {
    seen.add(s.id);
    let row = rows.get(s.id);
    if (!row) {
      row = makeRow(s.id);
      rows.set(s.id, row);
    }
    row.name.textContent = s.name;
    row.meta.textContent = CATEGORY[s.category] ?? s.category;
    row.item.title = KIND[s.kind] ?? s.kind;
    if (!row.saving) row.toggle.checked = s.enabled;
    row.item.className = `c-${s.category}${row.toggle.checked ? "" : " off"}`;
    row.remove.hidden = !s.taught;
    row.remove.setAttribute("aria-label", `Delete ${s.name}`);
    return row.item;
  });
  for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
  // Re-appending keeps each element (and the focus on a switch); only the order is applied.
  if (items.some((item, i) => list.children[i] !== item) || list.children.length !== items.length) {
    list.replaceChildren(...items);
  }
}

// A sound heard since the last reply lights up in its row, in its category's colour.
let newest = -1;
onEvents((events) => {
  const before = newest;
  newest = Math.max(newest, ...events.map((e) => e.id));
  if (before < 0) return; // what the first reply shows was heard before this page opened
  for (const e of events.filter((e) => e.id > before)) {
    const row = [...rows.values()].find((r) => r.name.textContent === e.sound_name);
    row?.item.animate([{ background: rgba(colorOf(e.category), 0.3) }, { background: "transparent" }], { duration: 1800 });
  }
});

const teach = /** @type {HTMLDialogElement} */ (document.getElementById("teach"));
/** @type {HTMLElement} */ (document.querySelector(".teach-open")).addEventListener("click", () => {
  teach.showModal();
  import("/dashboard/teach/teach.js");
});

poll("/dashboard/api/sounds", render);
