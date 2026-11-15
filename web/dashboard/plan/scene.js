// The map: a tilted disc of ground seen from above and to one side, drawn on one canvas. It keeps every sensor in
// sight around its centre, with rings a round number of metres apart, and widens to hold a sound heard further out.
// Researchers turn it by dragging. Other modules draw on it as layers (the sensors, the sounds, the measured
// distances) and place their labels over it.
//
// It draws only while something moves: a layer that animates says so through active(), and anything that changes
// what is shown calls invalidate(). An idle map costs nothing. The ground, its rings and the trees are kept as a
// picture between frames and drawn afresh only when the view moves, so a frame of waves or a check-in's ring costs
// one copy and the few things that changed. On a device that cannot keep up, the map draws at a lower resolution.
// Plan metres: x to the right, y up, z height above the ground.

/**
 * What a layer is handed on every draw.
 * @typedef {{ P: (x: number, y: number, z?: number) => [number, number, number], range: number, squash: number,
 *   toCamera: number, centre: [number, number], slab: number, width: number, height: number, device: boolean,
 *   still: boolean }} View
 * P gives screen x and y and the pixels one metre covers there. range is the disc's radius in metres, slab its
 * radius in pixels, squash how much the tilt flattens a circle, toCamera the plan angle from the centre toward the
 * viewer. device is true while the Devices panel is open; still when the researcher asked for reduced motion.
 */
/**
 * @typedef {{ depth: number, draw: () => void }} Sprite something standing on the ground, drawn back to front
 * @typedef {{
 *   ground?: (g: CanvasRenderingContext2D, view: View, now: number) => void,
 *   sprites?: (g: CanvasRenderingContext2D, view: View, now: number) => Sprite[],
 *   overlay?: (view: View, now: number) => void,
 *   extent?: () => { anchors?: [number, number][], reach?: [number, number][] },
 *   active?: (now: number) => boolean,
 * }} Layer
 * ground draws flat on the disc (clipped to it); overlay places the layer's own elements over the map. extent
 * lists plan points: anchors set the map's centre and base size, reach widens it. now is this page's clock in ms.
 */

const TAU = Math.PI * 2;
const HOME = { az: -0.42, el: 0.6 };
const DEVICE_EL = 1.08;
const MIN_RANGE_M = 1.7;
// The viewer stands this many disc radii from the centre: nearer exaggerates the perspective.
const STAND_BACK = 3.4;
// The canvas never holds more pixels than this, however large or dense the screen.
const MAX_PIXELS = 3_000_000;
// A device that averages more than this many ms a frame while the map animates gets a coarser canvas, down to a floor.
const SLOW_FRAME_MS = 24;
const PACE_FRAMES = 45;
const MIN_QUALITY = 0.4;
const IVORY = "251,247,239";
export const FONT = '"Avenir Next", Avenir, "Nunito Sans", "Segoe UI", system-ui, sans-serif';
/** @type {Record<string, string>} */
export const COLOR = { logging: "#ff6a3c", vehicle: "#f6b93b", poaching: "#f0457c", wildlife: "#8fe3d0" };

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("scene"));
const screen = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
// The ground as last drawn, and the view it was drawn for.
const ground = document.createElement("canvas");
const groundContext = /** @type {CanvasRenderingContext2D} */ (ground.getContext("2d"));
let groundFor = "";
// Where the drawing below goes: the screen, or the kept ground while it is being redrawn.
let g = screen;
/** Where layers put the elements they place over the map. */
export const overlay = /** @type {HTMLElement} */ (document.getElementById("map-overlay"));
/** The researcher asked for reduced motion: nothing on the map animates. */
export const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** @type {Layer[]} */
const layers = [];
const camera = {
  az: HOME.az, el: HOME.el, azT: HOME.az, elT: HOME.el,
  logRange: Math.log(2.2), x: 0, y: 0, side: 0,
};
let device = false;
let held = false;
let fitted = false;
/** @type {{ x: number, y: number, range: number }} */
let target = { x: 0, y: 0, range: 2.2 };
let width = 0, height = 0, backing = 1;
// 1 on a device that keeps up; lowered step by step on one that does not.
let quality = 1;
// The pace of animated frames: their running average, how many since it was last judged, the setting a step down
// was taken from until that step is judged, and whether adjusting has stopped. chained: the last frame asked for
// this one, so the time between them is a frame's.
let frameMs = 16;
let paced = 0;
/** @type {{ quality: number, ms: number } | null} */
let trial = null;
let paceSettled = false;
let chained = false;
// The projection of the frame being drawn.
let cx = 0, cy = 0, slab = 0, focal = 0, range = 2.2, squash = 0.5, toCamera = 0;
let posX = 0, posY = 0, posZ = 0, fX = 0, fY = 0, fZ = 0, rX = 0, rY = 0, uX = 0, uY = 0, uZ = 0;
// The last point projected by px(): screen x, y and pixels per metre.
let sx = 0, sy = 0, sk = 0;
let raf = 0;
let lastFrame = 0;

/** @param {string} hex @param {number} a */
export function rgba(hex, a) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A category's colour; an unknown category draws in ivory. @param {string} category */
export const colorOf = (category) => COLOR[category] ?? "#fbf7ef";

/** Projects into sx, sy, sk without allocating. @param {number} x @param {number} y @param {number} z */
function px(x, y, z) {
  const vx = x - posX, vy = y - posY, vz = z - posZ;
  sk = focal / (vx * fX + vy * fY + vz * fZ);
  sx = cx + (vx * rX + vy * rY) * sk;
  sy = cy - (vx * uX + vy * uY + vz * uZ) * sk;
}

/** @param {number} x @param {number} y @param {number} [z] @returns {[number, number, number]} */
function P(x, y, z = 0) {
  px(x, y, z);
  return [sx, sy, sk];
}

/**
 * The plan point under a place on the page, for dragging a sensor across the ground.
 * @param {number} clientX @param {number} clientY @returns {[number, number]}
 */
export function unproject(clientX, clientY) {
  const box = canvas.getBoundingClientRect();
  const dx = clientX - box.left - cx, dy = cy - (clientY - box.top);
  const dirX = fX * focal + rX * dx + uX * dy;
  const dirY = fY * focal + rY * dx + uY * dy;
  const dirZ = fZ * focal + uZ * dy;
  const t = -posZ / dirZ;
  return [posX + dirX * t, posY + dirY * t];
}

/**
 * Starts a path along a circle (or an arc of one) lying on the ground.
 * @param {number} x @param {number} y @param {number} radius @param {number} [from] @param {number} [to]
 */
export function ringPath(x, y, radius, from = 0, to = TAU) {
  g.beginPath();
  const n = Math.max(10, Math.round((72 * (to - from)) / TAU));
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    px(x + radius * Math.cos(a), y + radius * Math.sin(a), 0);
    if (i) g.lineTo(sx, sy);
    else g.moveTo(sx, sy);
  }
}

/** A thin bright line with a soft glow. @param {number[]} a @param {number[]} b @param {string} color @param {number} alpha */
export function glowLine(a, b, color, alpha) {
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.strokeStyle = rgba(color, alpha * 0.16);
  g.lineWidth = 8;
  g.stroke();
  g.strokeStyle = rgba(color, alpha * 0.75);
  g.lineWidth = 1.6;
  g.stroke();
}

/** @type {WeakMap<HTMLElement, string>} */
const placed = new WeakMap();

/**
 * Moves an overlay element to a screen point, touching the page only when the point changed.
 * @param {HTMLElement} el @param {number} x @param {number} y @param {string} [anchor] a CSS translate for the
 *   element's own box, "-50%, -100%" to stand it on the point
 */
export function place(el, x, y, anchor = "-50%, -50%") {
  const at = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${anchor})`;
  if (placed.get(el) === at) return;
  placed.set(el, at);
  el.style.transform = at;
}

/** Adds a layer; layers draw in the order they were added. @param {Layer} layer */
export function addLayer(layer) {
  layers.push(layer);
  invalidate();
}

/** Something shown changed: draw again. */
export function invalidate() {
  if (!raf) raf = requestAnimationFrame(frame);
}

/** The Devices panel opened or closed: the map tips up to a plan view and makes room for the panel. @param {boolean} on */
export function setDeviceMode(on) {
  device = on;
  camera.elT = on ? DEVICE_EL : HOME.el;
  invalidate();
}

/** Whether the Devices panel is open. */
export const deviceMode = () => device;

/** While a sensor is dragged the map holds still; it fits again once the sensor is dropped. @param {boolean} on */
export function holdView(on) {
  held = on;
  invalidate();
}

function resize() {
  const box = canvas.getBoundingClientRect();
  width = Math.max(1, Math.round(box.width));
  height = Math.max(1, Math.round(box.height));
  backing = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (width * height))) * quality;
  canvas.width = ground.width = Math.round(width * backing);
  canvas.height = ground.height = Math.round(height * backing);
  groundFor = "";
  invalidate();
}

/** Where the map should be centred and how far it should reach, from what the layers must keep in sight. */
function fit() {
  /** @type {[number, number][]} */
  const anchors = [];
  /** @type {[number, number][]} */
  const reach = [];
  for (const layer of layers) {
    const e = layer.extent?.();
    if (e?.anchors) anchors.push(...e.anchors);
    if (e?.reach) reach.push(...e.reach);
  }
  if (!anchors.length) return { x: 0, y: 0, range: 2.2 };
  const xs = anchors.map((p) => p[0]), ys = anchors.map((p) => p[1]);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2;
  let r = MIN_RANGE_M;
  for (const p of anchors) r = Math.max(r, Math.hypot(p[0] - x, p[1] - y) * 2.3);
  for (const p of reach) r = Math.max(r, Math.hypot(p[0] - x, p[1] - y) * 1.22 + 0.4);
  return { x, y, range: r };
}

/** @param {number} dt seconds since the last frame @returns {boolean} whether the view is still moving */
function moveCamera(dt) {
  if (!held) target = fit();
  // The first fit is taken as it is: the map opens on its sensors rather than flying to them.
  const k = still || !fitted ? 1 : 1 - Math.exp(-dt * 3.4);
  fitted = true;
  const wantSide = device ? 1 : 0;
  const logTarget = Math.log(target.range);
  camera.az += (camera.azT - camera.az) * k;
  camera.el += (camera.elT - camera.el) * k;
  camera.x += (target.x - camera.x) * k;
  camera.y += (target.y - camera.y) * k;
  camera.side += (wantSide - camera.side) * k;
  camera.logRange += (logTarget - camera.logRange) * (k === 1 ? 1 : 1 - Math.exp(-dt * 2));
  return Math.abs(camera.azT - camera.az) > 1e-3 || Math.abs(camera.elT - camera.el) > 1e-3
    || Math.abs(wantSide - camera.side) > 1e-3 || Math.abs(logTarget - camera.logRange) > 1e-3
    || Math.hypot(target.x - camera.x, target.y - camera.y) > range * 1e-3;
}

function project() {
  const wide = width > 900;
  slab = (wide ? Math.min(width * 0.265, height * 0.5) : Math.min(width * 0.47, height * 0.6)) * (1 - 0.2 * camera.side);
  cx = width / 2 - (wide ? 200 * camera.side : 0);
  cy = height * (wide ? 0.455 : 0.5);
  range = Math.exp(camera.logRange);
  const d = range * STAND_BACK;
  const ce = Math.cos(camera.el), se = Math.sin(camera.el), sa = Math.sin(camera.az), ca = Math.cos(camera.az);
  fX = -ce * sa; fY = ce * ca; fZ = -se;
  rX = ca; rY = sa;
  uX = rY * fZ; uY = -rX * fZ; uZ = rX * fY - rY * fX;
  posX = camera.x + d * ce * sa; posY = camera.y - d * ce * ca; posZ = d * se;
  focal = slab * STAND_BACK;
  squash = se;
  toCamera = Math.atan2(-ca, sa);
}

// The trees along the far rim: scenery that frames the disc, placed by the disc and not by the plan.
const trees = Array.from({ length: 46 }, (_, i) => {
  /** @param {number} n */
  const r = (n) => {
    const v = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  return { a: (i / 46) * TAU + r(1) * 0.1, out: 0.9 + r(2) * 0.085, tall: 0.13 + r(3) * 0.13, tone: r(4) };
});

function drawSlab() {
  const x = camera.x, y = camera.y, thick = range * 0.075, n = 96;
  px(x, y, -thick * 4);
  g.save();
  g.translate(sx, sy);
  g.scale(1, squash);
  let fill = g.createRadialGradient(0, 0, slab * 0.5, 0, 0, slab * 1.5);
  fill.addColorStop(0, "rgba(0,0,0,.5)");
  fill.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = fill;
  g.beginPath();
  g.arc(0, 0, slab * 1.5, 0, TAU);
  g.fill();
  g.restore();
  // The rim's side, where it faces the viewer.
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU, a1 = ((i + 1.05) / n) * TAU, mid = (a0 + a1) / 2;
    if (Math.cos(mid - toCamera) < -0.12) continue;
    const light = 0.25 + 0.75 * Math.max(0, Math.cos(mid - toCamera + 0.9));
    g.fillStyle = `rgb(${(3 + 6 * light) | 0},${(24 + 30 * light) | 0},${(13 + 16 * light) | 0})`;
    g.beginPath();
    px(x + range * Math.cos(a0), y + range * Math.sin(a0), 0);
    g.moveTo(sx, sy);
    px(x + range * Math.cos(a1), y + range * Math.sin(a1), 0);
    g.lineTo(sx, sy);
    px(x + range * Math.cos(a1), y + range * Math.sin(a1), -thick);
    g.lineTo(sx, sy);
    px(x + range * Math.cos(a0), y + range * Math.sin(a0), -thick);
    g.lineTo(sx, sy);
    g.fill();
  }
  ringPath(x, y, range);
  fill = g.createLinearGradient(0, cy - slab * squash, 0, cy + slab * squash * 1.2);
  fill.addColorStop(0, "#0a4126");
  fill.addColorStop(1, "#136a3d");
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = `rgba(${IVORY},.34)`;
  g.lineWidth = 1.25;
  g.stroke();
}

/** Rings a round number of metres apart; as the map widens, one spacing fades into the next. */
function drawRings() {
  const x = camera.x, y = camera.y;
  g.font = `600 12px ${FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const step of [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]) {
    const count = range / step;
    const weight = Math.min(1, Math.max(0, count - 1.6)) * Math.min(1, Math.max(0, (7.5 - count) / 2.5));
    if (weight <= 0.02) continue;
    for (let r = step; r < range * 0.985; r += step) {
      ringPath(x, y, r);
      g.strokeStyle = `rgba(${IVORY},${0.17 * weight})`;
      g.lineWidth = 1;
      g.stroke();
      if (weight > 0.55) {
        const a = toCamera + 0.62;
        px(x + r * Math.cos(a), y + r * Math.sin(a), 0);
        const text = `${r} m`;
        g.lineWidth = 4;
        g.strokeStyle = "rgba(4,32,17,.9)";
        g.strokeText(text, sx, sy);
        g.fillStyle = `rgba(${IVORY},${0.6 * weight})`;
        g.fillText(text, sx, sy);
      }
    }
  }
  px(x, y, 0);
  g.save();
  g.translate(sx, sy);
  g.scale(1, squash);
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, slab * 0.7);
  glow.addColorStop(0, "rgba(60,170,105,.22)");
  glow.addColorStop(1, "rgba(60,170,105,0)");
  g.fillStyle = glow;
  g.beginPath();
  g.arc(0, 0, slab * 0.7, 0, TAU);
  g.fill();
  g.restore();
}

function drawTrees() {
  const back = trees.map((t) => ({ t, facing: Math.cos(t.a - toCamera) })).filter((o) => o.facing < 0.2)
    .sort((a, b) => a.facing - b.facing);
  for (const { t, facing } of back) {
    px(camera.x + range * t.out * Math.cos(t.a), camera.y + range * t.out * Math.sin(t.a), 0);
    const h = t.tall * range * sk, x = sx, y = sy;
    g.globalAlpha = Math.min(1, (0.2 - facing) / 0.35);
    g.fillStyle = "#06301a";
    g.fillRect(x - h * 0.025, y - h * 0.12, h * 0.05, h * 0.12);
    for (let i = 0; i < 3; i++) {
      const base = y - h * (0.1 + i * 0.24), top = base - h * (0.46 - i * 0.03), half = h * (0.23 - i * 0.05);
      g.fillStyle = `rgb(${(12 + t.tone * 8) | 0},${(74 + t.tone * 26) | 0},${(44 + t.tone * 14) | 0})`;
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x - half, base);
      g.lineTo(x, base);
      g.fill();
      g.fillStyle = `rgb(${(24 + t.tone * 10) | 0},${(104 + t.tone * 30) | 0},${(62 + t.tone * 16) | 0})`;
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x + half, base);
      g.lineTo(x, base);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}

/** @param {number} t */
function frame(t) {
  raf = 0;
  const previous = lastFrame;
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;
  const now = Date.now();
  const moving = moveCamera(dt);
  project();
  /** @type {View} */
  const view = {
    P, range, squash, toCamera, centre: [camera.x, camera.y], slab, width, height, device, still,
  };
  // The ground is redrawn into its kept picture only when the view has moved since it was last drawn.
  const viewKey = [camera.az, camera.el, camera.logRange, camera.x, camera.y, camera.side].map((v) => v.toFixed(4)).join();
  if (viewKey !== groundFor) {
    groundFor = viewKey;
    g = groundContext;
    g.setTransform(backing, 0, 0, backing, 0, 0);
    g.clearRect(0, 0, width, height);
    drawSlab();
    g.save();
    ringPath(camera.x, camera.y, range);
    g.clip();
    drawRings();
    g.restore();
    drawTrees();
    g = screen;
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.drawImage(ground, 0, 0);
  g.setTransform(backing, 0, 0, backing, 0, 0);
  g.save();
  ringPath(camera.x, camera.y, range);
  g.clip();
  for (const layer of layers) each(() => layer.ground?.(g, view, now));
  g.restore();
  /** @type {Sprite[]} */
  const sprites = [];
  for (const layer of layers) each(() => sprites.push(...(layer.sprites?.(g, view, now) ?? [])));
  // Pixels per metre fall with distance, so the smallest is the furthest away.
  for (const s of sprites.sort((a, b) => a.depth - b.depth)) each(s.draw);
  for (const layer of layers) each(() => layer.overlay?.(view, now));
  const animating = moving || turning !== null || layers.some((layer) => layer.active?.(now));
  if (chained) keepUp(t - previous);
  chained = animating;
  if (animating) invalidate();
}

/**
 * Judges the pace every few dozen animated frames and lowers the canvas's resolution a step while frames come
 * slowly. A step that buys nothing is taken back and the map stops adjusting: the screen's own rate (a 30 Hz
 * projector) is the limit then, not the drawing.
 * @param {number} ms since the last frame
 */
function keepUp(ms) {
  if (paceSettled) return;
  frameMs += (ms - frameMs) * 0.1;
  if (++paced < PACE_FRAMES) return;
  paced = 0;
  if (trial) {
    if (frameMs > trial.ms * 0.85) {
      quality = trial.quality;
      paceSettled = true;
      trial = null;
      resize();
      return;
    }
    trial = null;
  }
  if (frameMs <= SLOW_FRAME_MS || quality <= MIN_QUALITY) return;
  trial = { quality, ms: frameMs };
  quality = Math.max(MIN_QUALITY, quality * 0.75);
  resize();
}

/** One layer failing never takes the map down with it. @param {() => void} draw */
function each(draw) {
  try {
    draw();
  } catch (e) {
    console.error(e);
  }
}

// Turning the map: drag anywhere on it; double-click puts it back.
/** @type {{ id: number, x: number, y: number } | null} */
let turning = null;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || turning) return;
  turning = { id: e.pointerId, x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("turning");
});
canvas.addEventListener("pointermove", (e) => {
  if (!turning || turning.id !== e.pointerId) return;
  camera.az = camera.azT = camera.azT - (e.clientX - turning.x) * 0.006;
  camera.el = camera.elT = Math.min(1.35, Math.max(0.32, camera.elT + (e.clientY - turning.y) * 0.004));
  turning.x = e.clientX;
  turning.y = e.clientY;
  invalidate();
});
/** @param {PointerEvent} e */
const endTurn = (e) => {
  if (!turning || turning.id !== e.pointerId) return;
  turning = null;
  canvas.classList.remove("turning");
};
canvas.addEventListener("pointerup", endTurn);
canvas.addEventListener("pointercancel", endTurn);
canvas.addEventListener("dblclick", () => {
  camera.azT = HOME.az;
  camera.elT = device ? DEVICE_EL : HOME.el;
  invalidate();
});

new ResizeObserver(resize).observe(canvas);
resize();
