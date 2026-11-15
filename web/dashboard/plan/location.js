// Where sounds came from, shown on the map for 15 s after each sound, by the service's clock. A sound two sensors
// heard is a point: waves spread from it, a line runs from it to each sensor with the distance, and a flag stands
// over it. A sound one sensor heard, or two whose directions never cross, is only a direction: a beam from the
// sensor with a flag along it. What the service stored at arrival is drawn as it was, wherever the sensors are now.
import { poll, serviceClock, serviceNow } from "/dashboard/shell.js";
import { addLayer, colorOf, glowLine, invalidate, overlay, place, rgba, ringPath } from "/dashboard/plan/scene.js";

/**
 * @typedef {{ event_id: number, sensor_id: string, sensor_name: string, x_m: number, y_m: number,
 *   direction_deg: number, occurred_at: number, sound_name: string, category: string, located: boolean }}
 *   DirectionLine
 * @typedef {{ x_m: number, y_m: number, occurred_at: number, sound_name: string, category: string,
 *   from: { sensor_id: string, sensor_name: string, x_m: number, y_m: number, distance_m: number }[] }} CrossingPoint
 */

const TAU = Math.PI * 2;
const SHOW_FOR_MS = 15_000;
const FADE_MS = 1500;
// Half the width of a direction's beam, in radians.
const BEAM = 0.13;
const CATEGORY = /** @type {Record<string, string>} */ ({
  logging: "Logging", vehicle: "Vehicle", poaching: "Poaching", wildlife: "Wildlife",
});

/** @type {DirectionLine[]} */
let lines = [];
/** @type {CrossingPoint[]} */
let points = [];
/** When each thing first showed on this page, for its fade in. @type {Map<string, number>} */
const born = new Map();
/** The things shown in the frame being drawn. @type {Set<string>} */
let live = new Set();

/** Notes that a thing is shown this frame. @param {string} key @param {number} now */
function show(key, now) {
  live.add(key);
  if (!born.has(key)) born.set(key, now);
}

/** @param {{ occurred_at: number }} item */
const showing = (item) => item.occurred_at + SHOW_FOR_MS > serviceNow();
/** @param {number} m */
const metres = (m) => `${m.toFixed(1)} m`;
/** How strongly to draw it: fading in as it appears and out as its time ends. @param {{ occurred_at: number }} item @param {string} key @param {number} now */
function strength(item, key, now) {
  const since = now - (born.get(key) ?? now);
  const left = item.occurred_at + SHOW_FOR_MS - serviceNow();
  return Math.min(1, Math.max(0, left / FADE_MS)) * Math.min(1, Math.max(0.15, since / 400));
}

/**
 * The newest shown point of each category, with every sound of the category located now: one sound heard under
 * several names (a chainsaw is also a power tool) is one place on the map.
 * @returns {(CrossingPoint & { sounds: string[] })[]}
 */
function located() {
  /** @type {Map<string, CrossingPoint & { sounds: string[] }>} */
  const by = new Map();
  for (const p of points.filter(showing)) {
    const sounds = by.get(p.category)?.sounds ?? [];
    if (!sounds.includes(p.sound_name)) sounds.push(p.sound_name);
    by.set(p.category, { ...p, sounds });
  }
  return [...by.values()];
}

/** The newest shown direction per sensor and category that no point accounts for. */
function directions() {
  /** @type {Map<string, DirectionLine>} */
  const by = new Map();
  for (const l of lines.filter((l) => showing(l) && !l.located)) by.set(`${l.category} ${l.sensor_id}`, l);
  return [...by.values()];
}

// The elements placed over the map, kept across frames by key.
/** @type {Map<string, HTMLElement>} */
const placedEls = new Map();
/** @type {Set<string>} */
let used = new Set();

/**
 * The overlay element for a key, made on first use.
 * @param {string} key @param {() => HTMLElement} make
 */
function element(key, make) {
  used.add(key);
  let el = placedEls.get(key);
  if (!el) {
    el = make();
    placedEls.set(key, el);
    overlay.append(el);
  }
  return el;
}

/** @param {string} category @param {boolean} named whether the flag reads as one image with a name of its own */
function makeFlag(category, named) {
  const flag = document.createElement("p");
  flag.className = `map-flag c-${category}`;
  if (named) flag.setAttribute("role", "img");
  const icon = document.createElement("span");
  icon.className = "category-icon";
  flag.append(icon, document.createElement("b"), document.createElement("span"));
  return flag;
}

/** @param {HTMLElement} flag @param {string} name @param {string} detail @param {number} opacity @param {string} [label] */
function setFlag(flag, name, detail, opacity, label) {
  if (flag.children[1].textContent !== name) flag.children[1].textContent = name;
  if (flag.children[2].textContent !== detail) flag.children[2].textContent = detail;
  if (label && flag.getAttribute("aria-label") !== label) flag.setAttribute("aria-label", label);
  flag.style.opacity = opacity.toFixed(2);
}

/** What a flag calls its sounds: the one sound heard, or the category when several were. @param {string} category @param {string[]} sounds */
const flagName = (category, sounds) => (sounds.length === 1 ? sounds[0] : CATEGORY[category] ?? category);

addLayer({
  extent: () => ({ reach: located().map((p) => /** @type {[number, number]} */ ([p.x_m, p.y_m])) }),
  active: () => lines.some(showing) || points.some(showing),
  ground(g, view, now) {
    // Every sensor that heard something rings in the sound's colour.
    for (const l of lines.filter(showing)) {
      const [x, y, k] = view.P(l.x_m, l.y_m);
      const r = Math.min(25, Math.max(11, 0.095 * k)) * 1.5;
      g.beginPath();
      g.ellipse(x, y, r, r * view.squash, 0, 0, TAU);
      g.strokeStyle = rgba(colorOf(l.category), 0.8 * strength(l, `ring ${l.event_id}`, now));
      g.lineWidth = 3;
      g.stroke();
    }
    // Three sensors hearing one sound give a point per pair, a little apart: every pair's lines are drawn, and
    // the newest point carries the waves, the distances and the flag.
    for (const p of points.filter(showing)) {
      const a = strength(p, `point ${p.category}`, now), at = view.P(p.x_m, p.y_m);
      for (const f of p.from) glowLine(at, view.P(f.x_m, f.y_m), colorOf(p.category), a * 0.75);
    }
    for (const p of located()) {
      const color = colorOf(p.category), a = strength(p, `point ${p.category}`, now);
      const reach = Math.max(0.6, ...p.from.map((f) => f.distance_m)) * 1.12;
      const phase = view.still ? 0.5 : (now / 2300) % 1;
      for (let i = 0; i < 3; i++) {
        const u = (phase + i / 3) % 1, wave = a * (1 - u) ** 1.3;
        ringPath(p.x_m, p.y_m, u * reach);
        g.strokeStyle = rgba(color, wave * 0.14);
        g.lineWidth = 7;
        g.stroke();
        g.strokeStyle = rgba(color, wave * 0.85);
        g.lineWidth = 1.6;
        g.stroke();
      }
      const source = view.P(p.x_m, p.y_m);
      for (const f of p.from) {
        const sensor = view.P(f.x_m, f.y_m);
        if (view.still) continue;
        // Dashes run from the sound to the sensor, the way it travelled.
        g.setLineDash([9, 30]);
        g.lineDashOffset = -(now / 26) % 39;
        g.beginPath();
        g.moveTo(source[0], source[1]);
        g.lineTo(sensor[0], sensor[1]);
        g.strokeStyle = rgba(color, a);
        g.lineWidth = 2.6;
        g.stroke();
        g.setLineDash([]);
      }
      g.save();
      g.translate(source[0], source[1]);
      g.scale(1, view.squash);
      const radius = Math.max(26, 0.4 * source[2]);
      const glow = g.createRadialGradient(0, 0, 0, 0, 0, radius);
      glow.addColorStop(0, rgba(color, 0.75 * a));
      glow.addColorStop(1, rgba(color, 0));
      g.fillStyle = glow;
      g.beginPath();
      g.arc(0, 0, radius, 0, TAU);
      g.fill();
      g.restore();
    }
    for (const l of directions()) {
      const color = colorOf(l.category), a = strength(l, `line ${l.category} ${l.sensor_id}`, now);
      const turn = (l.direction_deg * Math.PI) / 180;
      const far = view.range * 2 + Math.hypot(l.x_m - view.centre[0], l.y_m - view.centre[1]);
      /** @param {number} angle @param {number} r */
      const at = (angle, r) => view.P(l.x_m + Math.sin(angle) * r, l.y_m + Math.cos(angle) * r);
      const from = view.P(l.x_m, l.y_m), end = at(turn, view.range * 1.1);
      const fill = g.createLinearGradient(from[0], from[1], end[0], end[1]);
      fill.addColorStop(0, rgba(color, 0.5 * a));
      fill.addColorStop(1, rgba(color, 0));
      g.fillStyle = fill;
      g.beginPath();
      g.moveTo(from[0], from[1]);
      for (let i = 0; i <= 8; i++) {
        const edge = at(turn - BEAM + (2 * BEAM * i) / 8, far);
        g.lineTo(edge[0], edge[1]);
      }
      g.fill();
      // Arcs run inward along the beam, toward the sensor.
      const phase = view.still ? 0.4 : (now / 2000) % 1;
      for (let i = 0; i < 3; i++) {
        const u = 1 - ((phase + i / 3) % 1), r = view.range * 0.9 * u;
        g.beginPath();
        for (let j = 0; j <= 8; j++) {
          const edge = at(turn - BEAM + (2 * BEAM * j) / 8, r);
          if (j) g.lineTo(edge[0], edge[1]);
          else g.moveTo(edge[0], edge[1]);
        }
        g.strokeStyle = rgba(color, a * 0.8 * (1 - u));
        g.lineWidth = 2;
        g.stroke();
      }
    }
  },
  sprites(g, view, now) {
    return located().map((p) => {
      const [x, y, k] = view.P(p.x_m, p.y_m);
      return {
        depth: k,
        draw() {
          // The post the flag stands on.
          const color = colorOf(p.category), a = strength(p, `point ${p.category}`, now), top = y - flagHeight(view);
          const fill = g.createLinearGradient(0, y, 0, top);
          fill.addColorStop(0, rgba(color, a));
          fill.addColorStop(1, rgba(color, 0.35 * a));
          g.strokeStyle = fill;
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x, top);
          g.stroke();
          g.fillStyle = rgba(color, a);
          g.beginPath();
          g.ellipse(x, y, 6, 6 * view.squash, 0, 0, TAU);
          g.fill();
        },
      };
    });
  },
  overlay(view, now) {
    used = new Set();
    live = new Set();
    for (const p of located()) {
      const key = `point ${p.category}`;
      show(key, now);
      const a = strength(p, key, now);
      const [x, y] = view.P(p.x_m, p.y_m);
      const nearest = p.from.reduce((n, f) => (f.distance_m < n.distance_m ? f : n));
      const flag = element(key, () => makeFlag(p.category, true));
      setFlag(flag, flagName(p.category, p.sounds), `${metres(nearest.distance_m)} away`, a,
        `Location, ${p.from.map((f) => `${metres(f.distance_m)} from ${f.sensor_name}`).join(", ")}`);
      place(flag, x, y - flagHeight(view), "-50%, -100%");
      for (const f of p.from) {
        const sensor = view.P(f.x_m, f.y_m);
        const label = element(`${key} ${f.sensor_id}`, () => {
          const el = document.createElement("span");
          el.className = "map-label";
          return el;
        });
        if (label.textContent !== metres(f.distance_m)) label.textContent = metres(f.distance_m);
        label.style.opacity = a.toFixed(2);
        place(label, sensor[0] + (x - sensor[0]) * 0.38, sensor[1] + (y - sensor[1]) * 0.38 - 12);
      }
    }
    // Every shown direction is on the page by name, whether or not a point accounts for it.
    for (const l of lines.filter(showing)) {
      const mark = element(`mark ${l.event_id}`, () => {
        const el = document.createElement("span");
        el.className = "map-mark";
        el.setAttribute("role", "img");
        return el;
      });
      const label = `Direction from ${l.sensor_name}`;
      if (mark.getAttribute("aria-label") !== label) mark.setAttribute("aria-label", label);
      const [x, y] = view.P(l.x_m, l.y_m);
      place(mark, x, y);
      show(`ring ${l.event_id}`, now);
    }
    for (const l of directions()) {
      const key = `line ${l.category} ${l.sensor_id}`;
      show(key, now);
      const turn = (l.direction_deg * Math.PI) / 180, r = view.range * 0.6;
      const [x, y] = view.P(l.x_m + Math.sin(turn) * r, l.y_m + Math.cos(turn) * r);
      const flag = element(key, () => makeFlag(l.category, false));
      setFlag(flag, l.sound_name, "direction only", strength(l, key, now));
      place(flag, x, y - 14, "-50%, -100%");
    }
    for (const [key, el] of placedEls) {
      if (used.has(key)) continue;
      el.remove();
      placedEls.delete(key);
    }
    for (const key of born.keys()) if (!live.has(key)) born.delete(key);
  },
});

/** How far above its point a flag stands, in pixels. @param {import("./scene.js").View} view */
const flagHeight = (view) => Math.max(70, view.slab * 0.24);

// What the last reply showed: a reply that shows the same draws nothing (what is showing already keeps the map
// drawing until its time is up).
let replied = "";

/** @param {{ now: number, lines: DirectionLine[], points: CrossingPoint[] }} data */
function render(data) {
  serviceClock(data.now);
  const key = JSON.stringify([data.lines, data.points]);
  if (key === replied) return;
  replied = key;
  lines = data.lines;
  points = data.points;
  invalidate();
}

poll("/dashboard/api/locations", render);
