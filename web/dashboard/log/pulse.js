// The pulse along the foot of the map: the last 90 s, running right to left. Every sensor check-in is a small
// beat and every sound heard is a spike in its category's colour, as tall as the sensors were sure. Nothing on it
// is invented: a flat line means nothing was heard.
import { serviceNow } from "/dashboard/shell.js";
import { onEvents } from "/dashboard/log/log.js";
import { onBeat } from "/dashboard/plan/plan.js";
import { colorOf } from "/dashboard/plan/scene.js";

const SPAN_MS = 90_000;
const FRAME_MS = 66;
// Pixels between the line's points, and half a spike's width in those points.
const STEP = 2;
const NOW_INSET = 34;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("pulse"));
const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Check-ins, on this page's clock. @type {number[]} */
let beats = [];
/** Sounds heard, one per moment and category, on the service's clock. @type {{ at: number, confidence: number, category: string }[]} */
let spikes = [];
let width = 0, height = 0, scale = 1;
/** @type {Float32Array} */
let line = new Float32Array(0);
let lastDraw = 0;
// The line as last drawn was flat: with nothing new to show it is left as it is.
let flat = false;

onBeat((at) => {
  beats.push(at);
});

onEvents((events) => {
  /** @type {Map<string, { at: number, confidence: number, category: string }>} */
  const by = new Map();
  for (const e of events) {
    const at = Date.parse(e.occurred_at);
    // Sensors hearing one sound report it within moments of each other: one spike, as tall as the surest.
    const key = `${e.category} ${Math.round(at / 1500)}`;
    const seen = by.get(key);
    if (!seen || e.confidence > seen.confidence) by.set(key, { at, confidence: e.confidence, category: e.category });
  }
  spikes = [...by.values()];
});

function resize() {
  const box = canvas.getBoundingClientRect();
  width = Math.max(1, Math.round(box.width));
  height = Math.max(1, Math.round(box.height));
  scale = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  line = new Float32Array(Math.ceil(width / STEP) + 1);
  lastDraw = 0;
  flat = false;
}

function draw() {
  const now = Date.now(), end = width - NOW_INSET, mid = height * 0.56, perMs = end / SPAN_MS;
  beats = beats.filter((at) => now - at < SPAN_MS);
  const serviceToPage = now - serviceNow();
  const shown = spikes.map((s) => ({ ...s, x: end - (now - (s.at + serviceToPage)) * perMs })).filter((s) => s.x > -30 && s.x <= end);
  const quiet = !beats.length && !shown.length;
  if (quiet && flat) return;
  flat = quiet;
  line.fill(0);
  /** Adds a bump to the line around a place. @param {number} x @param {number} half @param {(u: number) => number} shape */
  const add = (x, half, shape) => {
    const from = Math.max(0, Math.floor((x - half) / STEP)), to = Math.min(line.length - 1, Math.ceil((x + half) / STEP));
    for (let i = from; i <= to; i++) line[i] += shape((i * STEP - x) / half);
  };
  for (const at of beats) add(end - (now - at) * perMs, 9, (u) => 4 * Math.exp(-9 * u * u));
  // A spike has the shape of the pulse in the logo's leaf: a tall beat between two dips.
  for (const s of shown) add(s.x, 26, (u) => s.confidence * height * 0.44 * Math.exp(-9 * u * u) * Math.cos(u * 7.2));

  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, width, height);
  const path = new Path2D();
  path.moveTo(0, mid - line[0]);
  for (let i = 1; i * STEP <= end; i++) path.lineTo(i * STEP, mid - line[i]);
  g.lineJoin = "round";
  g.lineWidth = 1.5;
  g.strokeStyle = "rgba(251,247,239,.4)";
  g.stroke(path);
  for (const s of shown) {
    g.save();
    g.beginPath();
    g.rect(s.x - 24, 0, Math.min(48, end - s.x + 24), height);
    g.clip();
    g.shadowColor = colorOf(s.category);
    g.shadowBlur = 10;
    g.strokeStyle = colorOf(s.category);
    g.lineWidth = 2;
    g.stroke(path);
    g.restore();
  }
  g.fillStyle = "#fbf7ef";
  g.shadowColor = "#fbf7ef";
  g.shadowBlur = 12;
  g.beginPath();
  g.arc(end, mid, 3.5, 0, Math.PI * 2);
  g.fill();
  g.shadowBlur = 0;
}

/** The line creeps a pixel every few frames, so it is drawn about 15 times a second, and once a second when still. */
/** @param {number} t */
function tick(t) {
  // A page in the background draws nothing: the browser stops calling this.
  requestAnimationFrame(tick);
  if (t - lastDraw < (still ? 1000 : FRAME_MS)) return;
  lastDraw = t;
  draw();
}

new ResizeObserver(resize).observe(canvas);
resize();
requestAnimationFrame(tick);
