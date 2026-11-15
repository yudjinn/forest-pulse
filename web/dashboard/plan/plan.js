// The sensors: each one stands on the map as a numbered puck with a pointer for its facing, and has a card in the
// Devices panel with its health, each named as the service names it ("Sensor N", its own id on the card beneath),
// whether it has the current sound list as the service judges it, and its trigger health as it last reported it
// (read-only: nothing on the card sets a trigger). While the Devices panel is open researchers drag a sensor (or
// move it with the arrow keys) and type its facing; each change saves at once and the plan follows the shell's 2 s
// poll, so other researchers' edits appear too.
// Plan metres: x to the right, y up. Facing: degrees clockwise from the plan's up.
import { clockTime, poll, signIn } from "/dashboard/shell.js";
import { COLOR, FONT, addLayer, holdView, invalidate, overlay, place, rgba, ringPath, unproject } from "/dashboard/plan/scene.js";

/**
 * @typedef {{ id: string, number: number | null, name: string, x_m: number, y_m: number, facing_deg: number, online: boolean, last_checkin_at: string,
 *   sdk_version: string | null, model: string | null, sound_list_version: number | null, shared_name: boolean,
 *   sound_list: "current" | "updating" | "outdated", recordings_per_min: number | null,
 *   trigger: { snr_db?: number, ratio_db?: number, coherence?: number } | null, noise_floor_dbfs: number | null }}
 *   PlanSensor
 */

const TAU = Math.PI * 2;
const SNAP_M = 0.1;
// After a save, the saved value is shown until a poll agrees with it or this long has passed (a poll that was
// already in flight answers with the old value).
const HOLD_MS = 4000;
const KEY_SAVE_DELAY_MS = 600;
// A check-in shows as a ring leaving the puck for this long.
const BEAT_MS = 900;

const list = /** @type {HTMLUListElement} */ (document.querySelector(".plan-sensors"));
const empty = /** @type {HTMLElement} */ (document.querySelector(".plan-empty"));
const error = /** @type {HTMLElement} */ (document.querySelector(".plan-error"));
const status = /** @type {HTMLElement} */ (document.querySelector(".status"));
const statusText = /** @type {HTMLElement} */ (status.querySelector(".status-text"));

/** @type {PlanSensor[]} */
let sensors = [];
let loaded = false;
/**
 * Values this page saved (or is dragging) that a poll may not show yet, per sensor.
 * @type {Map<string, { x_m?: number, y_m?: number, facing_deg?: number, until: number }>}
 */
const held = new Map();
/**
 * The drag in progress: the sensor's position when it started, and what was held for it then.
 * @type {{ id: string, pointerId: number, from: { x_m: number, y_m: number }, at: { x: number, y: number }, moved: boolean,
 *   before: { x_m?: number, y_m?: number, facing_deg?: number, until: number } | undefined } | null}
 */
let drag = null;
/**
 * Sensors this page just removed, with their last check-in then. A poll already in flight still lists them; they
 * stay hidden until a poll stops listing them or shows a newer check-in (the sensor came back).
 * @type {Map<string, { checkin: string, until: number }>}
 */
const removing = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const keySaves = new Map();
/** Where each puck is drawn: it glides to a new place the service gives it (a calibration run, another researcher). */
/** @type {Map<string, { x: number, y: number }>} */
const drawn = new Map();
/** When each sensor's latest check-in reached this page, on this page's clock. */
/** @type {Map<string, { checkin: string, at: number }>} */
const beats = new Map();
/** Sensors sounding the warning alarm now. @type {Set<string>} */
let alarming = new Set();
// What the map last drew of the sensors: a reply that changes none of it draws nothing.
let mapped = "";
/** @type {((sensors: PlanSensor[]) => void)[]} */
const watchers = [];
/** @type {((at: number) => void)[]} */
const beatWatchers = [];

/** The sensors as the page shows them now. */
export const sensorsNow = () => sensors.map(shown);

/** Calls back with the sensors as shown, now and whenever they change. @param {(sensors: PlanSensor[]) => void} watch */
export function onSensors(watch) {
  watchers.push(watch);
  if (loaded) watch(sensorsNow());
}

/** Calls back each time a sensor's check-in reaches the page. @param {(at: number) => void} watch */
export function onBeat(watch) {
  beatWatchers.push(watch);
}

/** The sensors a warning is on its way to: they strobe on the map as their buzzers sound. @param {Set<string>} ids */
export function setAlarming(ids) {
  const changed = ids.size !== alarming.size || [...ids].some((id) => !alarming.has(id));
  alarming = ids;
  if (changed) draw();
}

/** The sensor as this page shows it: the poll's data with any value it has saved and not yet seen back. */
/** @param {PlanSensor} s @returns {PlanSensor} */
function shown(s) {
  const h = held.get(s.id);
  return h ? { ...s, ...h } : s;
}

/** @param {{ sensors: PlanSensor[] }} data */
function render(data) {
  const now = Date.now();
  for (const [id, r] of removing) {
    const s = data.sensors.find((x) => x.id === id);
    if (!s || s.last_checkin_at !== r.checkin || now > r.until) removing.delete(id);
  }
  sensors = data.sensors.filter((s) => !removing.has(s.id));
  for (const s of sensors) {
    const b = beats.get(s.id);
    if (b?.checkin === s.last_checkin_at) continue;
    // What the first reply shows already happened: only a check-in seen arriving beats.
    beats.set(s.id, { checkin: s.last_checkin_at, at: loaded && s.online ? now : 0 });
    if (!loaded || !s.online) continue;
    for (const watch of beatWatchers) watch(now);
    invalidate();
  }
  loaded = true;
  // Another researcher removed the sensor being dragged: the drag ends with it.
  if (drag && !sensors.some((s) => s.id === drag?.id)) endHold();
  for (const [id, h] of held) {
    const s = sensors.find((x) => x.id === id);
    const dragging = drag?.id === id || keySaves.has(id);
    const agrees = s && (h.x_m === undefined || (near(s.x_m, h.x_m) && near(s.y_m, /** @type {number} */ (h.y_m))))
      && (h.facing_deg === undefined || near(s.facing_deg, h.facing_deg));
    if (!dragging && (!s || agrees || now > h.until)) held.delete(id);
  }
  draw();
}

function endHold() {
  drag = null;
  holdView(false);
}

/** @param {number} a @param {number} b */
const near = (a, b) => Math.abs(a - b) < 1e-6;

/** Brings the cards, the handles and the status line up to date and has the map drawn again. */
function draw() {
  if (!loaded) return;
  const items = sensorsNow();
  empty.hidden = items.length > 0;
  const online = items.filter((s) => s.online).length;
  status.hidden = items.length === 0;
  status.classList.toggle("short", online < items.length);
  statusText.textContent = online === items.length
    ? `${online} ${online === 1 ? "sensor" : "sensors"} listening`
    : `${online} of ${items.length} sensors listening`;
  for (const id of drawn.keys()) if (!items.some((s) => s.id === id)) drawn.delete(id);
  drawMarkers(items);
  drawCards(items);
  for (const watch of watchers) watch(items);
  const key = JSON.stringify(items.map((s) => [s.id, s.number, s.x_m, s.y_m, s.facing_deg, s.online, s.sound_list,
    s.shared_name, alarming.has(s.id)]));
  if (key === mapped) return;
  mapped = key;
  invalidate();
}

/** Where a sensor's puck is this frame: gliding toward its place, or at it while this page moves it. */
/** @param {PlanSensor} s @param {boolean} still */
function glide(s, still) {
  const at = drawn.get(s.id);
  if (!at || still || held.has(s.id)) {
    const to = { x: s.x_m, y: s.y_m };
    drawn.set(s.id, to);
    return to;
  }
  at.x += (s.x_m - at.x) * 0.16;
  at.y += (s.y_m - at.y) * 0.16;
  if (Math.hypot(s.x_m - at.x, s.y_m - at.y) < 0.004) {
    at.x = s.x_m;
    at.y = s.y_m;
  }
  return at;
}

addLayer({
  extent: () => ({ anchors: sensorsNow().map((s) => [s.x_m, s.y_m]) }),
  active(now) {
    return alarming.size > 0
      || sensors.some((s) => {
        const at = drawn.get(s.id), to = shown(s);
        return (at && (at.x !== to.x_m || at.y !== to.y_m)) || now - (beats.get(s.id)?.at ?? 0) < BEAT_MS;
      });
  },
  sprites(g, view, now) {
    return sensorsNow().map((s) => {
      const at = glide(s, view.still);
      const [x, y, k] = view.P(at.x, at.y);
      return { depth: k, draw: () => drawPuck(g, view, now, s, at, x, y, k) };
    });
  },
  overlay(view) {
    for (const s of sensorsNow()) {
      const m = markers.get(s.id), at = drawn.get(s.id);
      if (!m || !at) continue;
      const [x, y, k] = view.P(at.x, at.y);
      place(m.button, x, y - puckRadius(k) * 0.42);
      m.button.disabled = !view.device;
    }
  },
});

/** A puck's radius on screen: its real size, held between a size that stays readable and one that stays modest. */
/** @param {number} k pixels per metre where it stands */
const puckRadius = (k) => Math.min(25, Math.max(11, 0.095 * k));

/**
 * @param {CanvasRenderingContext2D} g @param {import("./scene.js").View} view @param {number} now
 * @param {PlanSensor} s @param {{ x: number, y: number }} at @param {number} x @param {number} y @param {number} k
 */
function drawPuck(g, view, now, s, at, x, y, k) {
  const rx = puckRadius(k), tall = rx * 0.42;
  /** @param {number} cy @param {number} r */
  const disc = (cy, r) => {
    g.beginPath();
    g.ellipse(x, cy, r, r * view.squash, 0, 0, TAU);
  };
  g.globalAlpha = s.online ? 1 : 0.38;
  // Which way its forward points.
  const turn = (s.facing_deg * Math.PI) / 180, len = rx / k;
  const fx = Math.sin(turn), fy = Math.cos(turn);
  const tip = view.P(at.x + fx * len * 2.5, at.y + fy * len * 2.5);
  const left = view.P(at.x + fx * len * 1.75 + fy * len * 0.5, at.y + fy * len * 1.75 - fx * len * 0.5);
  const right = view.P(at.x + fx * len * 1.75 - fy * len * 0.5, at.y + fy * len * 1.75 + fx * len * 0.5);
  g.fillStyle = "rgba(251,247,239,.8)";
  g.beginPath();
  g.moveTo(tip[0], tip[1]);
  g.lineTo(left[0], left[1]);
  g.lineTo(right[0], right[1]);
  g.fill();
  if (s.online && !view.still) {
    const beat = (now - (beats.get(s.id)?.at ?? 0)) / BEAT_MS;
    if (beat < 1) {
      disc(y, rx * (1.2 + 1.3 * beat));
      g.strokeStyle = `rgba(251,247,239,${0.4 * (1 - beat)})`;
      g.lineWidth = 1.5;
      g.stroke();
    }
  }
  if (alarming.has(s.id)) {
    // The alarm's hi-lo stutter, one tone every 150 ms.
    const hi = view.still || Math.floor(now / 150) % 2 === 0;
    disc(y, rx * (hi ? 1.7 : 2.4));
    g.strokeStyle = rgba(COLOR.logging, 0.95);
    g.lineWidth = hi ? 4 : 2.5;
    g.stroke();
    for (let i = 0; i < 2 && !view.still; i++) {
      const u = (now / 700 + i / 2) % 1;
      ringPath(at.x, at.y, 0.1 + u * 0.9);
      g.strokeStyle = rgba(COLOR.logging, 0.7 * (1 - u));
      g.lineWidth = 2;
      g.stroke();
    }
  }
  g.fillStyle = "rgba(0,0,0,.35)";
  disc(y + 2, rx * 1.12);
  g.fill();
  g.fillStyle = "#b5ad98";
  disc(y, rx);
  g.fill();
  g.fillRect(x - rx, y - tall, rx * 2, tall);
  g.fillStyle = "#fbf7ef";
  disc(y - tall, rx);
  g.fill();
  if (s.number !== null) {
    g.fillStyle = "#0b4827";
    g.font = `700 ${rx * (s.number > 9 ? 0.8 : 1.02)}px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.save();
    g.translate(x, y - tall + 0.5);
    g.scale(1, Math.min(1, Math.max(0.7, view.squash + 0.28)));
    g.fillText(String(s.number), 0, 0);
    g.restore();
  }
  if (s.shared_name) {
    // Two devices check in under this id: a broken ring around the puck.
    disc(y, rx * 1.3);
    g.setLineDash([5, 4]);
    g.strokeStyle = COLOR.vehicle;
    g.lineWidth = 2;
    g.stroke();
    g.setLineDash([]);
  }
  if (s.sound_list === "outdated") {
    g.fillStyle = COLOR.vehicle;
    g.beginPath();
    g.arc(x + rx * 0.8, y - tall - rx * view.squash * 0.9, 5, 0, TAU);
    g.fill();
  }
  if (drag?.id === s.id || document.activeElement === markers.get(s.id)?.button) {
    disc(y, rx * 1.55);
    g.setLineDash([3, 4]);
    g.strokeStyle = "rgba(251,247,239,.9)";
    g.lineWidth = 1.5;
    g.stroke();
    g.setLineDash([]);
  }
  g.globalAlpha = 1;
}

/** Each sensor's handle over its puck. @type {Map<string, { button: HTMLButtonElement, label: HTMLElement }>} */
const markers = new Map();

/** @param {PlanSensor[]} items */
function drawMarkers(items) {
  const seen = new Set();
  for (const s of items) {
    seen.add(s.id);
    let m = markers.get(s.id);
    if (!m) {
      m = makeMarker(s.id);
      markers.set(s.id, m);
      overlay.append(m.button);
    }
    const notes = [...(s.sound_list === "outdated" ? ["outdated sound list"] : []),
      ...(alarming.has(s.id) ? ["sounding the alarm"] : [])];
    m.button.setAttribute("aria-label", [`Move ${s.name}`, ...notes].join(", "));
    m.label.textContent = s.name;
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) {
      m.button.remove();
      markers.delete(id);
    }
  }
}

/** @param {string} id */
function makeMarker(id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "map-sensor";
  button.disabled = true;
  const label = document.createElement("span");
  button.append(label);
  button.addEventListener("pointerdown", (e) => startDrag(id, button, e));
  button.addEventListener("pointermove", (e) => moveDrag(id, e));
  button.addEventListener("pointerup", (e) => endDrag(id, e, false));
  button.addEventListener("pointercancel", (e) => endDrag(id, e, true));
  // Capture can go without a pointerup (the element left the page); after a pointerup the drag is already over.
  button.addEventListener("lostpointercapture", (e) => endDrag(id, e, true));
  button.addEventListener("keydown", (e) => nudge(id, e));
  button.addEventListener("focus", invalidate);
  button.addEventListener("blur", invalidate);
  return { button, label };
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

/** @param {string} id @param {HTMLButtonElement} button @param {PointerEvent} e */
function startDrag(id, button, e) {
  if (e.button !== 0 || drag) return;
  const s = current(id);
  if (!s) return;
  e.preventDefault();
  button.setPointerCapture(e.pointerId);
  button.focus();
  const h = held.get(id);
  drag = {
    id, pointerId: e.pointerId, from: { x_m: s.x_m, y_m: s.y_m }, at: { x: e.clientX, y: e.clientY }, moved: false,
    before: h && { ...h },
  };
  holdView(true);
}

/** @param {string} id @param {PointerEvent} e */
function moveDrag(id, e) {
  if (!drag || drag.id !== id || drag.pointerId !== e.pointerId) return;
  // A click that jiggles a few pixels is not a move: a saved move clears a measured layout.
  if (!drag.moved && Math.hypot(e.clientX - drag.at.x, e.clientY - drag.at.y) < DRAG_START_PX) return;
  const [wx, wy] = unproject(e.clientX, e.clientY);
  const x = snap(wx), y = snap(wy);
  const h = held.get(id);
  if (h?.x_m === x && h?.y_m === y) return;
  drag.moved = true;
  held.set(id, { ...h, x_m: x, y_m: y, until: Infinity });
  draw();
}

/** @param {string} id @param {PointerEvent} e @param {boolean} cancelled */
function endDrag(id, e, cancelled) {
  if (!drag || drag.id !== id || drag.pointerId !== e.pointerId) return;
  const { from, moved, before } = drag;
  endHold();
  const h = held.get(id);
  if (cancelled || !moved || !h || h.x_m === undefined || h.y_m === undefined
    || (near(h.x_m, from.x_m) && near(h.y_m, from.y_m))) {
    // Nothing to save: the sensor shows what it showed before the drag.
    if (before) held.set(id, before);
    else held.delete(id);
    draw();
    return;
  }
  save(id, { x_m: h.x_m, y_m: h.y_m });
}

const DRAG_START_PX = 6;

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
 * back to where the service has it and the panel says so.
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
    const s = sensors.find((x) => x.id === id);
    if (s) removing.set(id, { checkin: s.last_checkin_at, until: Date.now() + HOLD_MS });
    sensors = sensors.filter((s) => s.id !== id);
    held.delete(id);
    error.hidden = true;
    draw();
  } catch {
    error.textContent = "Couldn't save, try again";
    error.hidden = false;
  }
}

/**
 * @typedef {{ item: HTMLLIElement, name: HTMLElement, status: HTMLElement, warning: HTMLElement,
 *   soundList: HTMLElement, checkin: HTMLElement, health: HTMLElement, healthTerm: HTMLElement, versions: HTMLElement,
 *   position: HTMLElement, facing: HTMLInputElement, removeButton: HTMLButtonElement }} Card
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
    c.name.textContent = s.name;
    c.removeButton.setAttribute("aria-label", `Remove ${s.name}`);
    c.status.textContent = s.online ? "Online" : "Offline";
    c.warning.hidden = !s.shared_name;
    c.soundList.hidden = s.sound_list === "current";
    c.soundList.className = s.sound_list === "outdated" ? "plan-warning" : "plan-updating";
    c.soundList.textContent = s.sound_list === "outdated" ? "Outdated sound list" : "Updating";
    c.checkin.textContent = checkinTime(new Date(s.last_checkin_at));
    // Each part stays on one line, so a narrow card wraps the line only between parts.
    const health = triggerHealth(s);
    c.health.replaceChildren(...health.flatMap((part, i) => {
      const el = document.createElement("span");
      el.className = "plan-health-part";
      el.textContent = part;
      return i ? [" · ", el] : [el];
    }));
    c.health.hidden = c.healthTerm.hidden = !health.length;
    c.versions.textContent = [
      `Library ${s.sdk_version ?? "unknown"}`,
      `model ${s.model ?? "unknown"}`,
      `sound list ${s.sound_list_version ?? "unknown"}`,
    ].join(", ");
    c.position.textContent = `x ${s.x_m.toFixed(1)} m, y ${s.y_m.toFixed(1)} m`;
    if (document.activeElement !== c.facing) c.facing.value = formatFacing(s.facing_deg);
    return c.item;
  });
  for (const [id, c] of cards) {
    if (!seen.has(id)) {
      c.item.remove();
      cards.delete(id);
    }
  }
  // Only cards out of place move, so a card already in place (and the focus in its facing field) stays put.
  els.forEach((el, i) => {
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
  });
}

/** @param {string} id @returns {Card} */
function makeCard(id) {
  const n = nextId++;
  const item = document.createElement("li");
  const head = document.createElement("div");
  head.className = "plan-card-head";
  const title = document.createElement("div");
  title.className = "plan-card-title";
  const name = document.createElement("h3");
  const sensorId = document.createElement("p");
  sensorId.className = "plan-card-id";
  sensorId.textContent = id;
  title.append(name, sensorId);
  const status = document.createElement("span");
  status.className = "plan-status";
  head.append(title, status);

  const warning = document.createElement("p");
  warning.className = "plan-warning";
  warning.textContent = "Two devices share this id";

  const soundList = document.createElement("p");
  soundList.hidden = true;

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
  const health = fact("Trigger health");
  const healthTerm = /** @type {HTMLElement} */ (health.previousElementSibling);
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
  actions.append(label, field, removeButton);

  item.append(head, warning, soundList, facts, actions);

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
  return {
    item, name, status, warning, soundList, checkin, health, healthTerm, versions, position, facing, removeButton,
  };
}

/**
 * The parts of the sensor's trigger health line, "12 recordings/min · trigger 4 dB / 0 dB / 0.60 · floor -52 dBFS":
 * the trigger values keep their places with "?" for one the sensor did not report, and a part with nothing known is
 * left out. None when the sensor's last check-in carried none (a library older than 0.5.0).
 * @param {PlanSensor} s
 * @returns {string[]}
 */
function triggerHealth(s) {
  const parts = [];
  const per = s.recordings_per_min;
  if (per !== null) parts.push(`${per} ${per === 1 ? "recording" : "recordings"}/min`);
  const t = s.trigger;
  if (t) {
    const values = [t.snr_db, t.ratio_db].map((v) => (v === undefined ? "?" : `${tenths(v)} dB`));
    values.push(t.coherence === undefined ? "?" : t.coherence.toFixed(2));
    parts.push(`trigger ${values.join(" / ")}`);
  }
  if (s.noise_floor_dbfs !== null) parts.push(`floor ${tenths(s.noise_floor_dbfs)} dBFS`);
  return parts;
}

/** To a tenth, without a trailing ".0" and never "-0". @param {number} v */
const tenths = (v) => String(Math.round(v * 10) / 10 || 0);

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

poll("/dashboard/api/sensors", render);
