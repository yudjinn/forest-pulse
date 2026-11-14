// Where sounds came from, drawn on the sensor plan: a line from the sensor in the direction it heard each sound,
// and the point where two sensors' lines cross with the distance from each. Each shows for 15 s after the sound,
// by the service's clock; what the service stored at arrival is drawn as it was, wherever the sensors are now.
import { poll } from "/dashboard/shell.js";
import { addLayer } from "/dashboard/plan/plan.js";

/**
 * @typedef {{ event_id: number, sensor_id: string, x_m: number, y_m: number, direction_deg: number,
 *   occurred_at: number }} DirectionLine
 * @typedef {{ x_m: number, y_m: number, occurred_at: number,
 *   from: { sensor_id: string, x_m: number, y_m: number, distance_m: number }[] }} CrossingPoint
 */

const SVG = "http://www.w3.org/2000/svg";
const SHOW_FOR_MS = 15_000;
const LINE = "#0b4827";
const POINT = "#9a2c12";
const IVORY = "#fbf7ef";

/** @type {DirectionLine[]} */
let lines = [];
/** @type {CrossingPoint[]} */
let points = [];
// The service's clock minus this page's, from the latest reply.
let skew = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let expiry;

/** @param {string} name @param {Record<string, string | number>} attrs */
function svgEl(name, attrs) {
  const el = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const serviceNow = () => Date.now() + skew;
/** @param {{ occurred_at: number }} item */
const showing = (item) => item.occurred_at + SHOW_FOR_MS > serviceNow();
/** @param {number} m */
const metres = (m) => `${m.toFixed(1)} m`;

const layer = addLayer({
  draw(g, view) {
    // Long enough to cross the whole drawing from any sensor in view.
    const reach = (2 * (view.width + view.height)) / view.pxPerMetre;
    for (const l of lines.filter(showing)) {
      const r = (l.direction_deg * Math.PI) / 180;
      const [x1, y1] = view.toScreen(l.x_m, l.y_m);
      const [x2, y2] = view.toScreen(l.x_m + reach * Math.sin(r), l.y_m + reach * Math.cos(r));
      g.append(svgEl("line", {
        x1, y1, x2, y2, stroke: LINE, "stroke-width": 2, "stroke-opacity": 0.6, "stroke-dasharray": "6 4",
        role: "img", "aria-label": `Direction from ${l.sensor_id}`,
      }));
    }
    for (const p of points.filter(showing)) {
      const [px, py] = view.toScreen(p.x_m, p.y_m);
      for (const f of p.from) {
        const [sx, sy] = view.toScreen(f.x_m, f.y_m);
        const label = svgEl("text", {
          x: ((sx + px) / 2).toFixed(1), y: ((sy + py) / 2 - 6).toFixed(1), "text-anchor": "middle",
          fill: POINT, "font-size": 13, "font-weight": 600, stroke: IVORY, "stroke-width": 3, "paint-order": "stroke",
          "aria-hidden": "true",
        });
        label.textContent = metres(f.distance_m);
        g.append(label);
      }
      g.append(svgEl("circle", {
        cx: px, cy: py, r: 7, fill: POINT, stroke: "#fff", "stroke-width": 2, role: "img",
        "aria-label": `Location, ${p.from.map((f) => `${metres(f.distance_m)} from ${f.sensor_id}`).join(", ")}`,
      }));
    }
  },
  extent() {
    return points.filter(showing).map((p) => /** @type {[number, number]} */ ([p.x_m, p.y_m]));
  },
});

// Redraws when the next shown line or point is due to go, so it goes on time between polls.
function scheduleExpiry() {
  clearTimeout(expiry);
  const due = [...lines, ...points].filter(showing).map((i) => i.occurred_at + SHOW_FOR_MS - serviceNow());
  if (!due.length) return;
  expiry = setTimeout(() => {
    layer.redraw();
    scheduleExpiry();
  }, Math.max(0, Math.min(...due)) + 50);
}

/** @param {{ now: number, lines: DirectionLine[], points: CrossingPoint[] }} data */
function render(data) {
  skew = data.now - Date.now();
  lines = data.lines;
  points = data.points;
  layer.redraw();
  scheduleExpiry();
}

poll("/dashboard/api/locations", render);
