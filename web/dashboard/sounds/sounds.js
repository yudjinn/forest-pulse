// The Sounds page: every sound sensors can report, each with its switch, and a Delete for each taught sound behind a
// confirmation. The list follows the shell's 2 s poll; a switch saves at once and flips back if the save fails.
import { poll } from "/dashboard/shell.js";

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

const list = /** @type {HTMLUListElement} */ (document.querySelector("#sounds .sound-list"));
const confirm = /** @type {HTMLDialogElement} */ (document.querySelector("#sounds .sound-confirm"));
const confirmTitle = /** @type {HTMLElement} */ (confirm.querySelector("h2"));
/** @type {Map<string, Row>} */
const rows = new Map();
// The newest sound-list version seen. Every change bumps it, so a poll that answers with an older version was read
// before a save this page already knows about, and is ignored.
let version = 0;
let nextId = 0;
// The sound the open confirmation would delete.
/** @type {string | null} */
let pending = null;

/** @param {string} id */
function makeRow(id) {
  const item = document.createElement("li");
  const label = document.createElement("label");
  label.className = "sound";
  const text = document.createElement("span");
  text.className = "sound-text";
  const name = document.createElement("span");
  name.className = "sound-name";
  name.id = `sound-name-${nextId++}`;
  const meta = document.createElement("span");
  meta.className = "sound-meta";
  text.append(name, meta);
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-labelledby", name.id);
  label.append(text, toggle);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "sound-delete";
  remove.textContent = "Delete";
  remove.hidden = true;
  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  item.append(label, remove, error);
  /** @type {Row} */
  const row = { item, name, meta, toggle, remove, error, saving: false, deleting: false };
  toggle.addEventListener("change", () => save(id, row));
  remove.addEventListener("click", () => {
    row.error.hidden = true;
    pending = id;
    confirmTitle.textContent = `Delete ${row.name.textContent}?`;
    confirm.showModal();
  });
  return row;
}

/** @param {string} id @param {Row} row */
async function remove(id, row) {
  row.deleting = true;
  row.remove.disabled = true;
  row.error.hidden = true;
  try {
    const res = await fetch(`/dashboard/api/sounds/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.status === 401) {
      location.assign(`/dashboard/signin?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    // Already gone (deleted from another tab): the next poll drops the row.
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = /** @type {{ version: number }} */ (await res.json());
    version = Math.max(version, reply.version);
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
    if (res.status === 401) {
      location.assign(`/dashboard/signin?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = /** @type {{ sound: Sound, version: number }} */ (await res.json());
    version = Math.max(version, reply.version);
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

/** @param {{ version: number, sounds: Sound[] }} data */
function render(data) {
  if (data.version < version) return;
  version = data.version;
  const seen = new Set();
  const items = data.sounds.map((s) => {
    seen.add(s.id);
    let row = rows.get(s.id);
    if (!row) {
      row = makeRow(s.id);
      rows.set(s.id, row);
    }
    row.name.textContent = s.name;
    row.meta.textContent = `${CATEGORY[s.category] ?? s.category} · ${KIND[s.kind] ?? s.kind}`;
    if (!row.saving) row.toggle.checked = s.enabled;
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

poll("/dashboard/api/sounds", render);
