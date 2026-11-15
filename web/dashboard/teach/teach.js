// Teaching a sound, on the whole screen as one line from left to right: a name, a category and 5 to 100 dropped
// recordings; the model that listens to them; the detector they become; and the sensors it is sent to. Each
// recording is checked, decoded and summarised here as soon as it is added (clean and mixed over the hall
// background), and is a tile as wide as it is large, its own waveform filling as it is listened to. Teach sends
// only the summaries; the service trains and saves the sound. The detector then shows at the tiles' scale with how
// many times smaller it is, and goes to each sensor on the plan as that sensor reports the new sound list. The
// dialog closes once every sensor online has it, or on Done.
// The dashboard loads this module (and with it the model) only when the dialog is first opened.
import { signIn } from "/dashboard/shell.js";
import { onSensors, sensorsNow } from "/dashboard/plan/plan.js";
import { madeChange } from "/dashboard/sounds/sounds.js";
import { DIM, decode, loadModel, mixOver, summarise, toModelRate, windows } from "/dashboard/teach/summaries.js";

const MIN_CLIPS = 5;
const MAX_CLIPS = 100;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
const EXTENSIONS = [".wav", ".mp3", ".flac", ".ogg", ".m4a"];
const TOO_FEW = "Needs at least 5 usable recordings";
const FAILED = "Teaching failed, try again";
// Refusals the service words for the researcher; anything else is a failure.
const SERVICE_REFUSALS = new Set([TOO_FEW, "A sound with this name already exists"]);

const SVG = "http://www.w3.org/2000/svg";
// A tile's size on the screen: a minute of 32 kHz mono (3.84 MB) is 132 px wide, and a pile too large for its place
// is drawn smaller, tiles and detector alike.
const PX_PER_MB = 132 / 3.84;
const TILE_HEIGHT = 48;
const MIN_TILE_PX = 14;
const PILE_ROWS = 5.5;
const TILE_GAP = 8;
// A taught detector is always 960 weights and a bias, about this large as a sensor receives it. Until the sound is
// taught the screen shows this as an estimate, dimmed and called one; the service then says exactly how large.
const ABOUT_DETECTOR_BYTES = 19_000;
// Training takes the service under a second: the line shows it for at least this long, so it is seen to happen.
const TRAINING_SHOWN_MS = 1400;
const PEAKS = 64;
// More sensors than this and the pucks are drawn smaller, so every one on the plan still stands at the line's end.
const ROOMY_PUCKS = 5;
// After teaching, the line stays up at least this long, then until every sensor online has the detector and a
// moment more, and never longer than the last.
const SHOW_MS = 2600;
const AFTER_LAST_MS = 1800;
const MAX_WAIT_MS = 20_000;
const FLIGHT_MS = 1100;

/**
 * @typedef {{
 *   file: File, item: HTMLLIElement, status: HTMLElement, progress: HTMLProgressElement, retry: HTMLButtonElement,
 *   wave: HTMLElement, heard: HTMLElement, peaks: Float32Array | null, drawn: string,
 *   state: "waiting" | "working" | "ready" | "skipped", removed: boolean,
 *   clean: Float32Array[], mixed: Float32Array[],
 * }} Clip
 */

const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("teach"));
const form = /** @type {HTMLFormElement} */ (document.querySelector(".teach-form"));
const nameInput = /** @type {HTMLInputElement} */ (form.elements.namedItem("name"));
const filesInput = /** @type {HTMLInputElement} */ (form.elements.namedItem("recordings"));
const drop = /** @type {HTMLElement} */ (form.querySelector(".drop"));
const list = /** @type {HTMLUListElement} */ (form.querySelector(".clip-list"));
const error = /** @type {HTMLElement} */ (form.querySelector(".error"));
const submit = /** @type {HTMLButtonElement} */ (form.querySelector("button[type=submit]"));
const recordings = /** @type {HTMLElement} */ (form.querySelector(".teach-recordings"));
const total = /** @type {HTMLElement} */ (form.querySelector(".teach-total"));
const hearing = /** @type {HTMLElement} */ (form.querySelector(".teach-hearing"));
const heardArc = /** @type {SVGCircleElement} */ (form.querySelector(".teach-heard"));
const detectorSize = /** @type {HTMLElement} */ (form.querySelector(".teach-detector-size"));
const detectorWhat = /** @type {HTMLElement} */ (form.querySelector(".teach-detector-what"));
const ESTIMATE = detectorWhat.textContent;
const seed = /** @type {HTMLElement} */ (form.querySelector(".teach-seed"));
const pucks = /** @type {HTMLElement} */ (form.querySelector(".teach-pucks"));
const got = /** @type {HTMLElement} */ (form.querySelector(".teach-got"));
const claim = /** @type {HTMLElement} */ (form.querySelector(".teach-claim"));
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** @type {Clip[]} */
let clips = [];
let teaching = false;
let queue = Promise.resolve();
/** @type {Promise<Float32Array> | null} */
let background = null;
let detectorBytes = ABOUT_DETECTOR_BYTES;
/**
 * The sound just taught, while its detector goes out: the sound list's version with it, when it was taught, the
 * sensors a dot has left for and those it has reached.
 * @type {{ version: number, at: number, flown: Set<string>, landed: Set<string>,
 *   closing: ReturnType<typeof setTimeout> | undefined, giveUp: ReturnType<typeof setTimeout> } | null}
 */
let taught = null;

const live = () => clips.filter((c) => !c.removed);
const accepted = () => live().filter((c) => c.state !== "skipped");

/** @param {number} bytes */
function size(bytes) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return bytes >= 1e3 ? `${Math.round(bytes / 1e3)} KB` : "0 MB";
}

function hallBackground() {
  background ??= (async () => {
    const res = await fetch("/dashboard/api/teach/background");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { audio, rate } = await decode(await res.arrayBuffer());
    return toModelRate(audio, rate);
  })();
  background.catch(() => { background = null; });
  return background;
}

function refresh() {
  const busy = live().some((c) => c.state === "waiting" || c.state === "working");
  submit.disabled = !taught && (teaching || busy);
  submit.textContent = taught ? "Done" : teaching ? "Teaching…" : "Teach";
  form.setAttribute("aria-busy", String(teaching || busy));
  layout();
}

/** Sizes every tile, and the detector, to one scale, and says how large the recordings are together. */
function layout() {
  const shown = accepted();
  recordings.classList.toggle("has-clips", live().length > 0);
  const bytes = shown.reduce((sum, c) => sum + c.file.size, 0);
  total.textContent = size(bytes);
  const pile = list.clientWidth || 444;
  const largest = Math.max(1, ...shown.map((c) => c.file.size));
  const scale = Math.min(PX_PER_MB, pile / (largest / 1e6),
    bytes ? (pile * PILE_ROWS - TILE_GAP * shown.length) / (bytes / 1e6) : PX_PER_MB);
  for (const clip of shown) {
    // The one exception to the scale: a recording too small to see at it still gets a sliver.
    const width = Math.max(MIN_TILE_PX, Math.round((scale * clip.file.size) / 1e6));
    clip.item.style.width = `${width}px`;
    drawWave(clip, width);
  }
  const side = Math.min(14, Math.max(3, Math.sqrt((detectorBytes / 1e6) * scale * TILE_HEIGHT)));
  seed.style.width = seed.style.height = `${side.toFixed(1)}px`;
  progress();
}

/** How far the listening has come: each tile's own part, the ring around the model, and the line under it. */
function progress() {
  const shown = accepted();
  let done = 0, all = 0, ready = 0;
  for (const clip of shown) {
    const part = clip.state === "ready" ? 1 : clip.state === "working" ? clip.progress.value / (clip.progress.max || 1) : 0;
    if (clip.state === "ready") ready += 1;
    all += clip.file.size;
    done += clip.file.size * part;
    clip.heard.style.width = `${(part * 100).toFixed(1)}%`;
  }
  heardArc.setAttribute("stroke-dasharray", `${(465 * (all ? done / all : 0)).toFixed(1)} 465`);
  heardArc.style.opacity = done ? "1" : "0"; // a round-ended line of no length still draws a dot
  const working = shown.some((c) => c.state === "working" || c.state === "waiting");
  dialog.classList.toggle("listening", working && !taught);
  hearing.textContent = taught || !shown.length ? ""
    : working ? `listening, ${Math.min(ready + 1, shown.length)} of ${shown.length}`
    : `heard all ${ready}`;
}

/**
 * A recording's loudness along its length, in PEAKS steps from 0 to 1, for its tile's waveform.
 * @param {Float32Array} audio
 */
function peaksOf(audio) {
  const out = new Float32Array(PEAKS);
  const step = Math.max(1, Math.floor(audio.length / PEAKS));
  let top = 1e-9;
  for (let i = 0; i < PEAKS; i++) {
    let peak = 0;
    for (let j = i * step, end = Math.min(audio.length, j + step); j < end; j++) {
      const v = Math.abs(audio[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > top) top = peak;
  }
  for (let i = 0; i < PEAKS; i++) out[i] = Math.sqrt(out[i] / top);
  return out;
}

/** Draws a tile's waveform at its width: low even bars until the recording has been read, then its own shape. */
/** @param {Clip} clip @param {number} width */
function drawWave(clip, width) {
  const key = `${width} ${clip.peaks ? "read" : "unread"}`;
  if (clip.drawn === key) return;
  clip.drawn = key;
  const count = Math.max(2, Math.floor((width - 6) / 4));
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("viewBox", `0 0 ${width} ${TILE_HEIGHT}`);
  for (let i = 0; i < count; i++) {
    const loud = clip.peaks ? clip.peaks[Math.floor((i / count) * PEAKS)] : 0.12;
    const tall = 4 + 34 * loud;
    const bar = document.createElementNS(SVG, "rect");
    bar.setAttribute("x", String(3 + i * 4));
    bar.setAttribute("y", (TILE_HEIGHT / 2 - tall / 2).toFixed(1));
    bar.setAttribute("width", "2.2");
    bar.setAttribute("height", tall.toFixed(1));
    bar.setAttribute("rx", "1.1");
    svg.append(bar);
  }
  clip.heard.replaceChildren(svg.cloneNode(true));
  clip.wave.replaceChildren(svg, clip.heard);
}

/** @param {string} [message] */
function showError(message) {
  error.textContent = message ?? "";
  error.hidden = !message;
}

/** @param {Clip} clip @param {string} text */
function setStatus(clip, text) {
  clip.status.textContent = text;
}

/** @param {Clip} clip @param {string} reason */
function skip(clip, reason) {
  clip.state = "skipped";
  clip.item.classList.remove("working");
  clip.item.classList.add("skipped");
  clip.progress.hidden = true;
  setStatus(clip, reason);
}

/** @param {File} file */
function addClip(file) {
  const item = document.createElement("li");
  item.title = file.name;
  const wave = document.createElement("span");
  wave.className = "clip-wave";
  wave.setAttribute("aria-hidden", "true");
  const heard = document.createElement("span");
  const name = document.createElement("span");
  name.className = "clip-name";
  name.textContent = file.name;
  const status = document.createElement("span");
  status.className = "clip-status";
  const progressBar = document.createElement("progress");
  progressBar.setAttribute("aria-label", `${file.name} progress`);
  progressBar.value = 0;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "clip-retry";
  retry.textContent = "Try again";
  retry.setAttribute("aria-label", `Try ${file.name} again`);
  retry.hidden = true;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "clip-remove";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${file.name}`);
  item.append(wave, name, status, retry, remove, progressBar);
  list.append(item);
  /** @type {Clip} */
  const clip = {
    file, item, status, progress: progressBar, retry, wave, heard, peaks: null, drawn: "",
    state: "waiting", removed: false, clean: [], mixed: [],
  };
  remove.addEventListener("click", () => {
    clip.removed = true;
    item.remove();
    refresh();
  });
  // Only a recording the model or the hall background failed on: it summarises again from the start.
  retry.addEventListener("click", () => {
    showError();
    retry.hidden = true;
    item.classList.remove("skipped");
    clip.clean = [];
    clip.mixed = [];
    clip.progress.value = 0;
    clip.progress.hidden = false;
    admit(clip);
    refresh();
  });
  return clip;
}

/** Skips a recording over a limit, otherwise queues it to be summarised. @param {Clip} clip */
function admit(clip) {
  const { file } = clip;
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const sum = accepted().filter((c) => c !== clip).reduce((n, c) => n + c.file.size, 0);
  if (accepted().filter((c) => c !== clip).length >= MAX_CLIPS) skip(clip, "Too many recordings");
  else if (!EXTENSIONS.includes(extension)) skip(clip, "Couldn't be read");
  else if (file.size > MAX_FILE || sum + file.size > MAX_TOTAL) skip(clip, "Too large");
  else {
    clip.state = "waiting";
    setStatus(clip, "Waiting");
    queue = queue.then(() => summariseClip(clip));
  }
}

/** @param {FileList | File[]} files */
function addFiles(files) {
  if (taught) return; // the sound is taught: the line is showing where its detector goes
  showError();
  const seen = new Set(live().map((c) => `${c.file.name}|${c.file.size}|${c.file.lastModified}`));
  for (const file of files) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const clip = addClip(file);
    clips.push(clip);
    admit(clip);
  }
  clips = live();
  refresh();
}

/** @param {Clip} clip */
async function summariseClip(clip) {
  if (clip.removed) return;
  clip.state = "working";
  clip.item.classList.add("working");
  setStatus(clip, "Reading");
  refresh();
  let parts;
  try {
    const { audio, rate } = await decode(await clip.file.arrayBuffer());
    clip.peaks = peaksOf(audio);
    parts = windows(audio, rate);
  } catch {
    skip(clip, "Couldn't be read");
    refresh();
    return;
  }
  if (parts.length === 0) {
    skip(clip, "Shorter than 1 s");
    refresh();
    return;
  }
  refresh();
  try {
    const [hall] = await Promise.all([hallBackground(), loadModel()]);
    setStatus(clip, "Summarising");
    clip.progress.max = parts.length * 2;
    for (const part of parts) {
      if (clip.removed) return;
      clip.clean.push(await summarise(part));
      clip.progress.value += 1;
      progress();
      clip.mixed.push(await summarise(mixOver(part, hall)));
      clip.progress.value += 1;
      progress();
    }
  } catch {
    skip(clip, "Not summarised");
    clip.retry.hidden = false;
    showError(FAILED);
    refresh();
    return;
  }
  clip.state = "ready";
  clip.item.classList.remove("working");
  clip.progress.hidden = true;
  setStatus(clip, "Ready");
  refresh();
}

// The teach request: a JSON header with the clip list, then each clip's clean and mixed summaries as float32 rows.
/** @param {Clip[]} ready */
function encode(ready) {
  const header = new TextEncoder().encode(JSON.stringify({
    name: nameInput.value.trim(),
    category: new FormData(form).get("category"),
    clips: ready.map((c) => ({ file: c.file.name, windows: c.clean.length })),
  }));
  const start = 4 + Math.ceil(header.length / 4) * 4;
  const rows = ready.reduce((n, c) => n + c.clean.length + c.mixed.length, 0);
  const body = new ArrayBuffer(start + rows * DIM * 4);
  new DataView(body).setUint32(0, header.length, true);
  new Uint8Array(body, 4, header.length).set(header);
  const out = new Float32Array(body, start);
  let at = 0;
  for (const c of ready) {
    for (const row of [...c.clean, ...c.mixed]) {
      out.set(row, at);
      at += DIM;
    }
  }
  return body;
}

async function teach() {
  showError();
  const ready = live().filter((c) => c.state === "ready");
  if (ready.length < MIN_CLIPS) {
    showError(TOO_FEW);
    return;
  }
  teaching = true;
  dialog.classList.add("training");
  refresh();
  const started = Date.now();
  try {
    const res = await fetch("/dashboard/api/teach", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: encode(ready),
    });
    if (res.status === 401) return signIn();
    if (res.ok) {
      const reply = /** @type {{ version: number, detector_bytes?: number }} */ (await res.json());
      await new Promise((r) => setTimeout(r, Math.max(0, started + TRAINING_SHOWN_MS - Date.now())));
      teaching = false;
      dialog.classList.remove("training");
      if (dialog.open) show(reply.version, reply.detector_bytes ?? ABOUT_DETECTOR_BYTES, ready);
      // The sound list shows the new sound, and how far this change has reached the sensors.
      madeChange(reply.version);
      return;
    }
    const reply = /** @type {{ error?: string }} */ (await res.json().catch(() => ({})));
    showError(reply.error && SERVICE_REFUSALS.has(reply.error) ? reply.error : FAILED);
  } catch {
    showError(FAILED);
  }
  teaching = false;
  dialog.classList.remove("training");
  refresh();
}

/** How many times smaller, said in round numbers: 4,426 is "4,400 times smaller". @param {number} times */
function timesSmaller(times) {
  const round = times >= 1000 ? Math.round(times / 100) * 100 : times >= 100 ? Math.round(times / 10) * 10 : Math.round(times);
  return `${round.toLocaleString("en")} times smaller`;
}

/**
 * The sound is taught: the detector shows at the tiles' scale with how many times smaller it is than the
 * recordings it came from, and starts on its way to the sensors.
 * @param {number} version the sound list's version with the new detector
 * @param {number} bytes the detector's size as a sensor receives it
 * @param {Clip[]} from the recordings it was taught from
 */
function show(version, bytes, from) {
  detectorBytes = bytes;
  taught = {
    version, at: Date.now(), flown: new Set(), landed: new Set(), closing: undefined,
    giveUp: setTimeout(() => dialog.close(), MAX_WAIT_MS),
  };
  dialog.classList.add("taught");
  detectorSize.textContent = size(bytes);
  detectorWhat.textContent = "the detector";
  const times = from.reduce((sum, c) => sum + c.file.size, 0) / bytes;
  claim.textContent = times >= 2 ? timesSmaller(times) : "";
  refresh();
  showSensors(sensorsNow());
}

/** The pucks drawn, by sensor. @type {Map<string, HTMLElement>} */
const puckOf = new Map();

/**
 * The sensors at the end of the line, as the plan has them. Once a sound is taught, a dot leaves the detector for
 * each sensor that reports the new sound list, and the count follows the dots as they land.
 * @param {import("../plan/plan.js").PlanSensor[]} sensors
 */
function showSensors(sensors) {
  pucks.classList.toggle("many", sensors.length > ROOMY_PUCKS);
  for (const [id, el] of puckOf) {
    if (sensors.some((s) => s.id === id)) continue;
    el.remove();
    puckOf.delete(id);
  }
  for (const s of sensors) {
    let el = puckOf.get(s.id);
    if (!el) {
      el = document.createElement("i");
      el.append(document.createElement("b"));
      puckOf.set(s.id, el);
      pucks.append(el);
    }
    const has = el.classList.contains("has");
    el.className = `teach-puck${s.online ? "" : " offline"}${has ? " has" : ""}`;
    /** @type {HTMLElement} */ (el.firstElementChild).textContent = s.number === null ? "" : String(s.number);
  }
  const now = taught;
  if (!now) {
    got.textContent = "";
    return;
  }
  /** @param {import("../plan/plan.js").PlanSensor} s */
  const has = (s) => s.sound_list_version !== null && s.sound_list_version >= now.version;
  for (const s of sensors.filter(has)) {
    if (now.flown.has(s.id)) continue;
    now.flown.add(s.id);
    const puck = puckOf.get(s.id);
    (puck ? fly(puck) : Promise.resolve()).then(() => {
      if (taught !== now) return;
      puck?.classList.add("has");
      now.landed.add(s.id);
      showSensors(sensorsNow());
    });
  }
  const landed = sensors.filter((s) => now.landed.has(s.id)).length;
  got.textContent = sensors.length
    ? `${landed} of ${sensors.length} ${sensors.length === 1 ? "sensor has" : "sensors have"} it`
    : "";
  // Every sensor online has it (or none is online): the dialog closes once it has been up long enough to read. The
  // close is set once and stands through later replies, and is taken back only if a sensor without it comes online.
  if (!sensors.every((s) => !s.online || now.landed.has(s.id))) {
    clearTimeout(now.closing);
    now.closing = undefined;
  } else if (now.closing === undefined) {
    const wait = Math.max(now.at + SHOW_MS - Date.now(), now.landed.size ? AFTER_LAST_MS : 0);
    now.closing = setTimeout(() => dialog.close(), wait);
  }
}

/** A dot leaves the detector for a sensor's puck; resolves as it lands. @param {HTMLElement} puck */
function fly(puck) {
  if (still || !dialog.open) return Promise.resolve();
  const from = seed.getBoundingClientRect(), to = puck.getBoundingClientRect();
  const x0 = from.left + from.width / 2, y0 = from.top + from.height / 2;
  const x1 = to.left + to.width / 2, y1 = to.top + 16;
  const dot = document.createElement("i");
  dot.className = "teach-fly";
  dialog.append(dot);
  const frames = Array.from({ length: 21 }, (_, i) => {
    const t = i / 20, eased = t * t * (3 - 2 * t);
    return { transform: `translate(${(x0 + (x1 - x0) * t).toFixed(1)}px, ${(y0 + (y1 - y0) * eased).toFixed(1)}px)` };
  });
  return dot.animate(frames, { duration: FLIGHT_MS, easing: "ease-in-out", fill: "forwards" }).finished
    .then(() => dot.remove(), () => dot.remove());
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (taught) dialog.close();
  else if (!teaching) teach();
});
// The line takes the chosen category's colour.
form.addEventListener("change", () => {
  for (const name of [...dialog.classList]) if (name.startsWith("c-")) dialog.classList.remove(name);
  dialog.classList.add(`c-${new FormData(form).get("category")}`);
});
// Closing the dialog, taught or not, leaves it empty for the next sound.
dialog.addEventListener("close", () => {
  if (taught) {
    clearTimeout(taught.closing);
    clearTimeout(taught.giveUp);
  }
  taught = null;
  for (const clip of clips) clip.removed = true;
  clips = [];
  list.replaceChildren();
  form.reset();
  dialog.className = "teach c-wildlife";
  detectorBytes = ABOUT_DETECTOR_BYTES;
  detectorSize.textContent = size(ABOUT_DETECTOR_BYTES);
  detectorWhat.textContent = ESTIMATE;
  claim.textContent = "";
  for (const el of puckOf.values()) el.classList.remove("has");
  for (const dot of dialog.querySelectorAll(".teach-fly")) dot.remove();
  showError();
  refresh();
  showSensors(sensorsNow());
});
/** @type {HTMLElement} */ (form.querySelector(".teach-cancel")).addEventListener("click", () => dialog.close());
const takeChosenFiles = () => {
  if (filesInput.files?.length) addFiles([...filesInput.files]);
  filesInput.value = "";
};
filesInput.addEventListener("change", takeChosenFiles);
drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
// While the dialog is open a drop anywhere on the page is taken. (The sound list's module keeps a dropped file from
// opening in the browser at any time.)
document.addEventListener("drop", (event) => {
  drop.classList.remove("over");
  if (dialog.open && event.dataTransfer?.files.length) addFiles([...event.dataTransfer.files]);
});
// A tile's width follows the pile's, which follows the window's.
new ResizeObserver(layout).observe(list);
onSensors(showSensors);
takeChosenFiles(); // files chosen before this module finished loading
refresh();
// The model is tens of megabytes: fetch it while the name is typed, not after the first drop. A failure here is
// retried by the first recording, which reports it.
loadModel().catch(() => {});
