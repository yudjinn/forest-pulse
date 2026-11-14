// The sensor plan on the overview page: a top-down view of every sensor, drawn to fit with a 1 m grid, and a card
// per sensor with its health. Researchers drag a sensor (or move it with the arrow keys) and type its facing; each
// change saves at once and the plan follows the shell's 2 s poll, so other researchers' edits appear too.
// Plan metres: x to the right, y up. Facing: degrees clockwise from the plan's up.
//
// Other capabilities draw on the plan through addLayer (see below); layers sit above the grid and below the sensors.
import { clockTime, poll } from "/dashboard/shell.js";

/**
 * @typedef {{ id: string, x_m: number, y_m: number, facing_deg: number, online: boolean, last_checkin_at: string,
 *   sdk_version: string | null, model: string | null, sound_list_version: number | null, shared_name: boolean }}
 *   PlanSensor
 */
/**
 * What a layer is handed on every draw: the sensors as drawn, a projection from plan metres to the drawing's pixels,
 * and the drawing's size.
 * @typedef {{ sensors: PlanSensor[], toScreen: (x: number, y: number) => [number, number], pxPerMetre: number,
 *   width: number, height: number }} PlanView
 */
/**
 * @typedef {{ draw: (g: SVGGElement, view: PlanView) => void, extent?: () => [number, number][] }} PlanLayer
 */

const SVG = "http://www.w3.org/2000/svg";
const MARGIN_M = 1.5;
const MIN_SPAN_M = 4;
const SNAP_M = 0.1;
// After a save, the saved value is shown until a poll agrees with it or this long has passed (a poll that was
// already in flight answers with the old value).
const HOLD_MS = 4000;
const KEY_SAVE_DELAY_MS = 600;
const LABEL_CHARS = 24;

const section = /** @type {HTMLElement} */ (document.getElementById("plan"));
const body = /** @type {HTMLElement} */ (section.querySelector(".plan-body"));
const svg = /** @type {SVGSVGElement} */ (section.querySelector(".plan-map"));
const list = /** @type {HTMLUListElement} */ (section.querySelector(".plan-sensors"));
const empty = /** @type {HTMLElement} */ (section.querySelector(".plan-empty"));
const error = /** @type {HTMLElement} */ (section.querySelector(".plan-error"));

const grid = svgEl("g", { class: "plan-grid" });
const layerRoot = svgEl("g", { class: "plan-layers" });
const markerRoot = svgEl("g", { class: "plan-markers" });
svg.append(grid, layerRoot, markerRoot);

/** @type {PlanSensor[]} */
let sensors = [];
let loaded = false;
/**
 * Values this page saved (or is dragging) that a poll may not show yet, per sensor.
 * @type {Map<string, { x_m?: number, y_m?: number, facing_deg?: number, until: number }>}
 */
const held = new Map();
/** @type {{ id: string, pointerId: number, from: { x_m: number, y_m: number }, moved: boolean } | null} */
let drag = null;
/** @type {{ scale: number, ox: number, oy: number, width: number, height: number } | null} */
let view = null;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const keySaves = new Map();
/** @type {{ layer: PlanLayer, g: SVGGElement }[]} */
const layers = [];

/**
 * Adds a layer to the plan. Its draw runs on every redraw of the plan with its own emptied group; its optional
 * extent lists plan points (metres) the view must keep in sight. Call redraw when the layer's own data changes.
 * @param {PlanLayer} layer
 * @returns {{ redraw: () => void }}
 */
export function addLayer(layer) {
  const g = svgEl("g");
  layerRoot.append(g);
  layers.push({ layer, g });
  draw();
  return { redraw: draw };
}

/**
 * @param {string} name
 * @param {Record<string, string | number>} [attrs]
 */
function svgEl(name, attrs = {}) {
  const el = /** @type {any} */ (document.createElementNS(SVG, name));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** The sensor as this page shows it: the poll's data with any value it has saved and not yet seen back. */
/** @param {PlanSensor} s @returns {PlanSensor} */
function shown(s) {
  const h = held.get(s.id);
  return h ? { ...s, ...h } : s;
}

/** @param {{ sensors: PlanSensor[] }} data */
function render(data) {
  sensors = data.sensors;
  loaded = true;
  const now = Date.now();
  for (const [id, h] of held) {
    const s = sensors.find((x) => x.id === id);
    const dragging = drag?.id === id || keySaves.has(id);
    const agrees = s && (h.x_m === undefined || (near(s.x_m, h.x_m) && near(s.y_m, /** @type {number} */ (h.y_m))))
      && (h.facing_deg === undefined || near(s.facing_deg, h.facing_deg));
    if (!dragging && (!s || agrees || now > h.until)) held.delete(id);
  }
  draw();
}

/** @param {number} a @param {number} b */
const near = (a, b) => Math.abs(a - b) < 1e-6;

function draw() {
  if (!loaded) return;
  const items = sensors.map(shown);
  empty.hidden = items.length > 0;
  body.hidden = items.length === 0;
  if (items.length === 0) return;
  // While a sensor is being dragged the view holds still; it refits once the sensor is dropped.
  if (!drag || !view) view = fit(items);
  const v = view;
  svg.setAttribute("viewBox", `0 0 ${v.width} ${v.height}`);
  svg.setAttribute("height", String(v.height));
  /** @type {(x: number, y: number) => [number, number]} */
  const toScreen = (x, y) => [v.ox + x * v.scale, v.oy - y * v.scale];
  drawGrid(v);
  const planView = { sensors: items, toScreen, pxPerMetre: v.scale, width: v.width, height: v.height };
  for (const { layer, g } of layers) {
    g.replaceChildren();
    try {
      layer.draw(g, planView);
    } catch (e) {
      console.error(e);
    }
  }
  drawMarkers(items, toScreen);
  drawCards(items);
}

/** @param {PlanSensor[]} items */
function fit(items) {
  const width = Math.max(1, Math.round(svg.getBoundingClientRect().width));
  const height = Math.round(Math.min(480, Math.max(220, width * 0.6)));
  /** @type {[number, number][]} */
  const points = items.map((s) => [s.x_m, s.y_m]);
  for (const { layer } of layers) {
    try {
      points.push(...(layer.extent?.() ?? []));
    } catch (e) {
      console.error(e);
    }
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(MIN_SPAN_M, maxX - minX + 2 * MARGIN_M);
  const spanY = Math.max(MIN_SPAN_M, maxY - minY + 2 * MARGIN_M);
  const scale = Math.min(width / spanX, height / spanY);
  return {
    scale,
    ox: width / 2 - ((minX + maxX) / 2) * scale,
    oy: height / 2 + ((minY + maxY) / 2) * scale,
    width,
    height,
  };
}

/** @param {{ scale: number, ox: number, oy: number, width: number, height: number }} v */
function drawGrid(v) {
  const lines = [];
  // At a scale where 1 m lines would run together the grid is left out rather than drawn as a solid wash.
  if (v.scale >= 4) {
    for (let x = Math.ceil(-v.ox / v.scale); x <= Math.floor((v.width - v.ox) / v.scale); x++) {
      const px = v.ox + x * v.scale;
      lines.push(svgEl("line", { x1: px, y1: 0, x2: px, y2: v.height, class: x === 0 ? "plan-axis" : "" }));
    }
    for (let y = Math.ceil((v.oy - v.height) / v.scale); y <= Math.floor(v.oy / v.scale); y++) {
      const py = v.oy - y * v.scale;
      lines.push(svgEl("line", { x1: 0, y1: py, x2: v.width, y2: py, class: y === 0 ? "plan-axis" : "" }));
    }
  }
  grid.replaceChildren(...lines);
}

/** @type {Map<string, { g: SVGGElement, pointer: SVGPathElement, label: SVGTextElement }>} */
const markers = new Map();

/** @param {PlanSensor[]} items @param {(x: number, y: number) => [number, number]} toScreen */
function drawMarkers(items, toScreen) {
  const seen = new Set();
  for (const s of items) {
    seen.add(s.id);
    let m = markers.get(s.id);
    if (!m) {
      m = makeMarker(s.id);
      markers.set(s.id, m);
      markerRoot.append(m.g);
    }
    const [px, py] = toScreen(s.x_m, s.y_m);
    m.g.setAttribute("transform", `translate(${px.toFixed(1)} ${py.toFixed(1)})`);
    m.g.setAttribute("class", `plan-sensor${s.online ? "" : " offline"}${s.shared_name ? " shared" : ""}`);
    m.pointer.setAttribute("transform", `rotate(${s.facing_deg})`);
    m.label.textContent = s.id.length > LABEL_CHARS ? `${s.id.slice(0, LABEL_CHARS - 1)}…` : s.id;
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) {
      m.g.remove();
      markers.delete(id);
    }
  }
}

/** @param {string} id */
function makeMarker(id) {
  const g = /** @type {SVGGElement} */ (svgEl("g", { role: "button", tabindex: 0, "aria-label": `Move ${id}` }));
  const pointer = svgEl("path", { class: "plan-sensor-facing", d: "M0 -22 L8 -7 L-8 -7 Z" });
  // A touch-sized target around the dot and its pointer, so a finger or a click near the sensor picks it up.
  const target = svgEl("circle", { class: "plan-sensor-target", r: 22 });
  const dot = svgEl("circle", { class: "plan-sensor-dot", r: 10 });
  const label = svgEl("text", { class: "plan-sensor-label", y: 30, "text-anchor": "middle" });
  g.append(target, pointer, dot, label);
  g.addEventListener("pointerdown", (e) => startDrag(id, g, e));
  g.addEventListener("pointermove", (e) => moveDrag(id, e));
  g.addEventListener("pointerup", (e) => endDrag(id, e, false));
  g.addEventListener("pointercancel", (e) => endDrag(id, e, true));
  g.addEventListener("keydown", (e) => nudge(id, e));
  return { g, pointer, label };
}

/** @param {string} id */
const current = (id) => {
  const s = sensors.find((x) => x.id === id);
  return s ? shown(s) : null;
};

/** @param {number} v */
const snap = (v) => {
  const r = Math.round(v / SNAP_M) * SNAP_M;
  return Math.round(r * 1000) / 1000 || 0;
};

/** @param {string} id @param {SVGGElement} g @param {PointerEvent} e */
function startDrag(id, g, e) {
  if (e.button !== 0 || drag) return;
  const s = current(id);
  if (!s) return;
  e.preventDefault();
  g.setPointerCapture(e.pointerId);
  g.focus();
  drag = { id, pointerId: e.pointerId, from: { x_m: s.x_m, y_m: s.y_m }, moved: false };
}

/** @param {string} id @param {PointerEvent} e */
function moveDrag(id, e) {
  if (!drag || drag.id !== id || drag.pointerId !== e.pointerId || !view) return;
  const box = svg.getBoundingClientRect();
  const x = snap((e.clientX - box.left - view.ox) / view.scale);
  const y = snap((view.oy - (e.clientY - box.top)) / view.scale);
  const h = held.get(id);
  if (h?.x_m === x && h?.y_m === y) return;
  drag.moved = true;
  held.set(id, { ...h, x_m: x, y_m: y, until: Infinity });
  draw();
}

/** @param {string} id @param {PointerEvent} e @param {boolean} cancelled */
function endDrag(id, e, cancelled) {
  if (!drag || drag.id !== id || drag.pointerId !== e.pointerId) return;
  const { from, moved } = drag;
  drag = null;
  const h = held.get(id);
  if (cancelled || !moved || !h || h.x_m === undefined || h.y_m === undefined
    || (near(h.x_m, from.x_m) && near(h.y_m, from.y_m))) {
    if (h) {
      delete h.x_m;
      delete h.y_m;
      h.until = Date.now() + HOLD_MS;
    }
    draw();
    return;
  }
  save(id, { x_m: h.x_m, y_m: h.y_m });
}

const STEPS = /** @type {Record<string, [number, number]>} */ ({
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
});

/** Arrow keys move a focused sensor by 0.1 m (1 m with Shift); the move saves once the keys rest. */
/** @param {string} id @param {KeyboardEvent} e */
function nudge(id, e) {
  const step = STEPS[e.key];
  const s = current(id);
  if (!step || !s || drag) return;
  e.preventDefault();
  const d = e.shiftKey ? 1 : SNAP_M;
  const x = snap(s.x_m + step[0] * d);
  const y = snap(s.y_m + step[1] * d);
  held.set(id, { ...held.get(id), x_m: x, y_m: y, until: Infinity });
  draw();
  clearTimeout(keySaves.get(id));
  keySaves.set(id, setTimeout(() => {
    keySaves.delete(id);
    save(id, { x_m: x, y_m: y });
  }, KEY_SAVE_DELAY_MS));
}

/**
 * Saves a placement change. On success the saved values stay shown until a poll agrees; on failure the sensor goes
 * back to where the service has it and the plan says so.
 * @param {string} id
 * @param {{ x_m: number, y_m: number } | { facing_deg: number }} change
 */
async function save(id, change) {
  held.set(id, { ...held.get(id), ...change, until: Infinity });
  draw();
  try {
    const res = await fetch(`/dashboard/api/sensors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    if (res.status === 401) return signIn();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = /** @type {{ sensor: PlanSensor }} */ (await res.json()).sensor;
    const h = held.get(id);
    if (h) {
      // Hold what the service stored (a facing comes back normalised), unless a newer edit is already showing.
      for (const key of /** @type {(keyof typeof change)[]} */ (Object.keys(change))) {
        if (near(/** @type {number} */ (h[key]), /** @type {any} */ (change)[key])) h[key] = saved[key];
      }
      if (drag?.id !== id && !keySaves.has(id)) h.until = Date.now() + HOLD_MS;
    }
    error.hidden = true;
  } catch {
    const h = held.get(id);
    if (h) {
      for (const key of Object.keys(change)) delete /** @type {any} */ (h)[key];
      if (drag?.id !== id && !keySaves.has(id)) h.until = Date.now() + HOLD_MS;
    }
    const input = cards.get(id)?.facing;
    if (input && "facing_deg" in change) {
      const s = current(id);
      if (s) input.value = formatFacing(s.facing_deg);
    }
    error.textContent = "Couldn't save, try again";
    error.hidden = false;
  }
  draw();
}

/** @param {string} id */
async function remove(id) {
  try {
    const res = await fetch(`/dashboard/api/sensors/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.status === 401) return signIn();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sensors = sensors.filter((s) => s.id !== id);
    held.delete(id);
    error.hidden = true;
    draw();
  } catch {
    error.textContent = "Couldn't save, try again";
    error.hidden = false;
  }
}

function signIn() {
  location.assign(location.pathname === "/dashboard/"
    ? "/dashboard/signin"
    : `/dashboard/signin?next=${encodeURIComponent(location.pathname)}`);
}

/**
 * @typedef {{ item: HTMLLIElement, name: HTMLElement, status: HTMLElement, warning: HTMLElement,
 *   checkin: HTMLElement, versions: HTMLElement, position: HTMLElement, facing: HTMLInputElement }} Card
 */
/** @type {Map<string, Card>} */
const cards = new Map();
let nextId = 0;

/** @param {PlanSensor[]} items */
function drawCards(items) {
  const seen = new Set();
  const els = items.map((s) => {
    seen.add(s.id);
    let c = cards.get(s.id);
    if (!c) {
      c = makeCard(s.id);
      cards.set(s.id, c);
    }
    c.item.className = `plan-card${s.online ? "" : " offline"}`;
    c.status.textContent = s.online ? "Online" : "Offline";
    c.warning.hidden = !s.shared_name;
    c.checkin.textContent = checkinTime(new Date(s.last_checkin_at));
    c.versions.textContent = [
      `Library ${s.sdk_version ?? "unknown"}`,
      `model ${s.model ?? "unknown"}`,
      `sound list ${s.sound_list_version ?? "unknown"}`,
    ].join(", ");
    c.position.textContent = `x ${s.x_m.toFixed(1)} m, y ${s.y_m.toFixed(1)} m`;
    if (document.activeElement !== c.facing) c.facing.value = formatFacing(s.facing_deg);
    return c.item;
  });
  for (const id of cards.keys()) if (!seen.has(id)) cards.delete(id);
  // Re-appending keeps each element (and the focus in a facing field); only the order is applied.
  if (els.some((el, i) => list.children[i] !== el) || list.children.length !== els.length) list.replaceChildren(...els);
}

/** @param {string} id @returns {Card} */
function makeCard(id) {
  const n = nextId++;
  const item = document.createElement("li");
  const head = document.createElement("div");
  head.className = "plan-card-head";
  const name = document.createElement("h3");
  name.textContent = id;
  const status = document.createElement("span");
  status.className = "plan-status";
  head.append(name, status);

  const warning = document.createElement("p");
  warning.className = "plan-warning";
  warning.textContent = "Two devices share this name";

  const facts = document.createElement("dl");
  /** @param {string} term */
  const fact = (term) => {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    facts.append(dt, dd);
    return dd;
  };
  const checkin = fact("Last check-in");
  const versions = fact("Versions");
  const position = fact("Position");

  const actions = document.createElement("div");
  actions.className = "plan-card-actions";
  const label = document.createElement("label");
  label.htmlFor = `plan-facing-${n}`;
  label.textContent = "Facing";
  const field = document.createElement("span");
  field.className = "plan-facing";
  const facing = document.createElement("input");
  facing.id = `plan-facing-${n}`;
  facing.type = "number";
  facing.inputMode = "decimal";
  facing.step = "any";
  const unit = document.createElement("span");
  unit.textContent = "°";
  unit.setAttribute("aria-hidden", "true");
  field.append(facing, unit);
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "plan-remove";
  removeButton.textContent = "Remove";
  removeButton.setAttribute("aria-label", `Remove ${id}`);
  actions.append(label, field, removeButton);

  item.append(head, warning, facts, actions);

  facing.addEventListener("change", () => {
    const value = Number.parseFloat(facing.value);
    const s = current(id);
    if (!Number.isFinite(value)) {
      if (s) facing.value = formatFacing(s.facing_deg);
      return;
    }
    const normalised = normaliseFacing(value);
    facing.value = formatFacing(normalised);
    if (s && near(s.facing_deg, normalised)) return;
    save(id, { facing_deg: normalised });
  });
  facing.addEventListener("keydown", (e) => {
    if (e.key === "Enter") facing.blur();
  });
  removeButton.addEventListener("click", () => remove(id));
  return { item, name, status, warning, checkin, versions, position, facing };
}

/** The same normalisation the service applies, so the field shows the stored value at once. @param {number} deg */
function normaliseFacing(deg) {
  const r = Math.round((((deg % 360) + 360) % 360) * 10) / 10;
  return r >= 360 ? 0 : r;
}

/** @param {number} deg */
const formatFacing = (deg) => String(Math.round(deg * 10) / 10);

/** HH:MM:SS today, with the date before it on an earlier day. @param {Date} d */
function checkinTime(d) {
  const today = new Date();
  return d.toDateString() === today.toDateString() ? clockTime(d) : `${d.toLocaleDateString()} ${clockTime(d)}`;
}

new ResizeObserver(() => {
  if (!drag) draw();
}).observe(svg);

poll("/dashboard/api/sensors", render);
