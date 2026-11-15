// The public demo's service: the dashboard page at /dashboard/ loads this module before any other, and from then on
// every request the page makes for researcher data is answered here, in the browser, from a scripted forest. Nothing
// reaches the real service, so a visitor needs no password and can never see or change the researchers' data.
// Moving a sensor on the map is kept in this page only; every other change is refused (its controls are hidden by
// demo.css). The replies have the real service's shapes (src/ and the typedefs in each dashboard module).

const API = "/dashboard/api/";
const CYCLE_MS = 120_000;
// The page opens this far into the first cycle, so the map and the list already hold something.
const OPENED_INTO_MS = 20_000;
const SHOW_FOR_MS = 15_000;
const MERGE_GAP_MS = 60_000;
const CHECKIN_MS = 3000;
const KEEP_MS = 15 * 60_000;
const LOG_LIMIT = 200;

/** @typedef {{ id: string, number: number, x_m: number, y_m: number, facing_deg: number }} DemoSensor */
/** @type {DemoSensor[]} */
const sensors = [
  { id: "fp-demo-1", number: 1, x_m: 0, y_m: 1.6, facing_deg: 180 },
  { id: "fp-demo-2", number: 2, x_m: -1.4, y_m: -0.8, facing_deg: 60 },
  { id: "fp-demo-3", number: 3, x_m: 1.4, y_m: -0.8, facing_deg: 300 },
];
const nameOf = (/** @type {string} */ id) => `Sensor ${sensors.find((s) => s.id === id)?.number ?? id}`;

const sounds = [
  { id: "chainsaw", name: "Chainsaw", category: "logging", kind: "detector", enabled: true, taught: false },
  { id: "tools", name: "Tools", category: "logging", kind: "label", enabled: true, taught: false },
  { id: "power-tool", name: "Power tool", category: "logging", kind: "label", enabled: true, taught: false },
  { id: "vehicle", name: "Vehicle", category: "vehicle", kind: "label", enabled: true, taught: false },
  { id: "engine", name: "Engine", category: "vehicle", kind: "label", enabled: true, taught: false },
  { id: "aircraft", name: "Aircraft", category: "vehicle", kind: "label", enabled: false, taught: false },
  { id: "gunshot", name: "Gunshot", category: "poaching", kind: "label", enabled: true, taught: false },
  { id: "boreal-owl", name: "Boreal owl", category: "wildlife", kind: "detector", enabled: true, taught: true },
];
const soundById = new Map(sounds.map((s) => [s.id, s]));

/**
 * One cycle of the forest: at `at` ms into the cycle, a sound from a source at (x, y) is heard by these sensors.
 * Heard by two, it is placed where their directions cross; heard by one, it is a direction only.
 * @type {{ at: number, sound: string, x: number, y: number, by: string[] }[]}
 */
const SCRIPT = [
  { at: 4000, sound: "boreal-owl", x: -0.7, y: 0.9, by: ["fp-demo-1", "fp-demo-2"] },
  { at: 9500, sound: "boreal-owl", x: -0.7, y: 0.9, by: ["fp-demo-2", "fp-demo-1"] },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
    at: 25_000 + i * 6000, sound: i === 5 ? "power-tool" : "chainsaw", x: 0.9 + 0.04 * i, y: 0.4,
    by: i % 2 ? ["fp-demo-3", "fp-demo-1"] : ["fp-demo-1", "fp-demo-3"],
  })),
  { at: 82_000, sound: "engine", x: -2.2, y: 1.8, by: ["fp-demo-2"] },
  { at: 88_000, sound: "engine", x: -2.3, y: 2.0, by: ["fp-demo-2"] },
  { at: 101_000, sound: "gunshot", x: 0.2, y: -1.9, by: ["fp-demo-2", "fp-demo-3"] },
];

const opened = Date.now();
const start = opened - OPENED_INTO_MS;

/** A repeatable number in [0, 1) for a seed, so a reply never jitters between polls. @param {number} seed */
function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const round = (/** @type {number} */ v, /** @type {number} */ to) => Math.round(v * 10 ** to) / 10 ** to;
const norm = (/** @type {number} */ deg) => ((deg % 360) + 360) % 360;
/** The bearing from a point to another, clockwise from +y, as the map draws it. */
const bearing = (/** @type {number} */ fx, /** @type {number} */ fy, /** @type {number} */ tx, /** @type {number} */ ty) =>
  norm((Math.atan2(tx - fx, ty - fy) * 180) / Math.PI);

/**
 * @typedef {{ id: number, sensor_id: string, sound_id: string, occurred_at: number, confidence: number,
 *   angle_deg: number, line: { x_m: number, y_m: number, deg: number },
 *   point: { x_m: number, y_m: number, partner: string } | null }} DemoEvent
 */

/** Every event heard from the demo's start until now, oldest first. @param {number} now @returns {DemoEvent[]} */
function eventsUntil(now) {
  /** @type {DemoEvent[]} */
  const out = [];
  const first = Math.max(0, Math.floor((now - KEEP_MS - start) / CYCLE_MS));
  for (let cycle = first; start + cycle * CYCLE_MS <= now; cycle++) {
    SCRIPT.forEach((h, k) => {
      const base = start + cycle * CYCLE_MS + h.at;
      h.by.forEach((sensorId, j) => {
        const id = (cycle * SCRIPT.length + k) * 4 + j + 1;
        const at = base + j * 180;
        if (at > now || at < now - KEEP_MS) return;
        const s = /** @type {DemoSensor} */ (sensors.find((x) => x.id === sensorId));
        const deg = round(norm(bearing(s.x_m, s.y_m, h.x, h.y) + (noise(id) - 0.5) * 4), 2);
        const located = h.by.length > 1;
        out.push({
          id, sensor_id: sensorId, sound_id: h.sound, occurred_at: at,
          confidence: round(0.62 + noise(id + 0.5) * 0.33, 3),
          angle_deg: Math.round(norm(deg - s.facing_deg)),
          line: { x_m: s.x_m, y_m: s.y_m, deg },
          point: located
            ? { x_m: round(h.x + (noise(cycle + k) - 0.5) * 0.1, 2), y_m: round(h.y + (noise(cycle - k) - 0.5) * 0.1, 2),
              partner: h.by[1 - j] }
            : null,
        });
      });
    });
  }
  return out;
}

/** The distance from a sensor to a point, to a centimetre. @param {string} id @param {{ x_m: number, y_m: number }} p */
function distance(id, p) {
  const s = /** @type {DemoSensor} */ (sensors.find((x) => x.id === id));
  return round(Math.hypot(p.x_m - s.x_m, p.y_m - s.y_m), 2);
}

/** @param {DemoEvent} e */
const distances = (e) => e.point
  ? [e.sensor_id, e.point.partner].sort().map((id) => ({
    sensor_id: id, sensor_name: nameOf(id), distance_m: distance(id, /** @type {{ x_m: number, y_m: number }} */ (e.point)),
  }))
  : [];

/** @param {number} now */
function listSensors(now) {
  return {
    sensors: sensors.map((s, i) => {
      const offset = i * 900;
      const checkin = Math.floor((now - offset) / CHECKIN_MS) * CHECKIN_MS + offset;
      return {
        id: s.id, number: s.number, name: nameOf(s.id), x_m: s.x_m, y_m: s.y_m, facing_deg: s.facing_deg,
        online: true, last_checkin_at: new Date(checkin).toISOString(), sdk_version: "0.7.1", model: "mn10_as",
        sound_list_version: 1, shared_name: false, sound_list: "current", recordings_per_min: 3 + i,
        trigger: { snr_db: 6.4 - i, ratio_db: 1.2 + i * 0.3, coherence: 0.61 + i * 0.04 }, noise_floor_dbfs: -54 + i * 2,
      };
    }),
  };
}

/** @param {number} now */
function listEvents(now) {
  return {
    events: eventsUntil(now).reverse().slice(0, LOG_LIMIT).map((e) => {
      const sound = /** @type {(typeof sounds)[number]} */ (soundById.get(e.sound_id));
      return {
        id: e.id, sensor_id: e.sensor_id, sensor_name: nameOf(e.sensor_id), sound_id: e.sound_id, sound_name: sound.name,
        category: sound.category, confidence: e.confidence, angle_deg: e.angle_deg,
        occurred_at: new Date(e.occurred_at).toISOString(),
      };
    }),
  };
}

/** @param {number} now */
function listActivities(now) {
  /** @type {{ category: string, events: DemoEvent[] }[]} */
  const all = [];
  /** @type {Map<string, { category: string, events: DemoEvent[] }>} */
  const latest = new Map();
  for (const e of eventsUntil(now)) {
    const category = /** @type {(typeof sounds)[number]} */ (soundById.get(e.sound_id)).category;
    let a = latest.get(category);
    if (!a || e.occurred_at - a.events[a.events.length - 1].occurred_at >= MERGE_GAP_MS) {
      a = { category, events: [] };
      latest.set(category, a);
      all.push(a);
    }
    a.events.push(e);
  }
  const lastOf = (/** @type {{ events: DemoEvent[] }} */ a) => a.events[a.events.length - 1];
  all.sort((a, b) => lastOf(b).occurred_at - lastOf(a).occurred_at);
  return {
    activities: all.slice(0, 50).map((a) => {
      const last = lastOf(a);
      const located = a.events.filter((e) => e.point).pop();
      const names = [...new Set(a.events.map((e) => /** @type {any} */ (soundById.get(e.sound_id)).name))];
      const ids = [...new Set(a.events.map((e) => e.sensor_id))];
      return {
        category: a.category, sounds: names, sensors: ids, sensor_names: ids.map(nameOf),
        first_at: new Date(a.events[0].occurred_at).toISOString(), last_at: new Date(last.occurred_at).toISOString(),
        event_count: a.events.length,
        location: located?.point ? { x_m: located.point.x_m, y_m: located.point.y_m, distances: distances(located) } : null,
        newest_event_id: last.id, warnable: false, warnings: [],
        alert: a.category === "logging" && now - last.occurred_at < MERGE_GAP_MS,
      };
    }),
  };
}

/** @param {number} now */
function listLocations(now) {
  const shown = eventsUntil(now).filter((e) => e.occurred_at > now - SHOW_FOR_MS);
  const ids = new Set(shown.map((e) => e.id));
  const points = [];
  const inPoint = new Set();
  for (const e of shown) {
    if (!e.point || inPoint.has(e.id)) continue;
    const partner = shown.find((p) => p.sensor_id === e.point?.partner && p.point?.partner === e.sensor_id
      && Math.abs(p.occurred_at - e.occurred_at) < 1000 && ids.has(p.id));
    if (!partner) continue;
    inPoint.add(e.id).add(partner.id);
    const sound = /** @type {(typeof sounds)[number]} */ (soundById.get(e.sound_id));
    points.push({
      x_m: e.point.x_m, y_m: e.point.y_m, occurred_at: partner.occurred_at, sound_name: sound.name, category: sound.category,
      from: [e, partner].map((x) => ({
        sensor_id: x.sensor_id, sensor_name: nameOf(x.sensor_id), x_m: x.line.x_m, y_m: x.line.y_m,
        distance_m: distance(x.sensor_id, /** @type {{ x_m: number, y_m: number }} */ (e.point)),
      })).sort((a, b) => a.sensor_id.localeCompare(b.sensor_id)),
    });
  }
  return {
    now,
    lines: shown.map((e) => {
      const sound = /** @type {(typeof sounds)[number]} */ (soundById.get(e.sound_id));
      return {
        event_id: e.id, sensor_id: e.sensor_id, sensor_name: nameOf(e.sensor_id), x_m: e.line.x_m, y_m: e.line.y_m,
        direction_deg: e.line.deg, occurred_at: e.occurred_at, sound_name: sound.name, category: sound.category,
        located: inPoint.has(e.id),
      };
    }),
    points,
  };
}

/** @param {unknown} body @param {number} [status] */
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A placement change, kept on this page only. @param {string} id @param {unknown} body */
function placeSensor(id, body) {
  const s = sensors.find((x) => x.id === id);
  if (!s) return reply({ error: "not found" }, 404);
  const change = /** @type {Record<string, unknown>} */ (body ?? {});
  for (const key of /** @type {const} */ (["x_m", "y_m", "facing_deg"])) {
    const v = change[key];
    if (typeof v === "number" && Number.isFinite(v)) s[key] = key === "facing_deg" ? round(norm(v), 1) : round(v, 2);
  }
  return reply({ sensor: listSensors(Date.now()).sensors.find((x) => x.id === id) });
}

/** @param {string} path @param {string} method @param {unknown} body */
function answer(path, method, body) {
  const now = Date.now();
  if (method === "GET") {
    if (path === "sensors") return reply(listSensors(now));
    if (path === "events") return reply(listEvents(now));
    if (path === "activities") return reply(listActivities(now));
    if (path === "locations") return reply(listLocations(now));
    if (path === "calibration") return reply({ now, eligible: sensors.length, running: false, run: null, layout: null });
    if (path === "sounds") return reply({ version: 1, sensitivity: 0.5, reach: { sensors: 3, reached: 3 }, sounds });
    if (path === "player/samples") return reply({ samples: [] });
    return reply({ error: "not found" }, 404);
  }
  const sensor = path.match(/^sensors\/([^/]+)$/);
  if (method === "PATCH" && sensor) return placeSensor(decodeURIComponent(sensor[1]), body);
  return reply({ error: "the demo changes nothing" }, 403);
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(API)) return realFetch(input, init);
  request.signal.throwIfAborted();
  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await request.json();
    } catch {
      // no body, or not JSON
    }
  }
  return answer(url.pathname.slice(API.length), request.method, body);
};
