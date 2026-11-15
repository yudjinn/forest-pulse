// The teach dialog: a name, a category and 5 to 100 dropped recordings. Each recording is checked, decoded and summarised
// here as soon as it is added (clean and mixed over the hall background), with its progress in its row; Teach sends
// only the summaries. The service trains and saves the sound, the dialog closes and the sound appears in the list.
// The dashboard loads this module (and with it the model) only when the dialog is first opened.
import { signIn } from "/dashboard/shell.js";
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

/**
 * @typedef {{
 *   file: File, item: HTMLLIElement, status: HTMLElement, progress: HTMLProgressElement, retry: HTMLButtonElement,
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

/** @type {Clip[]} */
let clips = [];
let teaching = false;
let queue = Promise.resolve();
/** @type {Promise<Float32Array> | null} */
let background = null;

const live = () => clips.filter((c) => !c.removed);
const accepted = () => live().filter((c) => c.state !== "skipped");

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
  submit.disabled = teaching || busy;
  submit.textContent = teaching ? "Teaching…" : "Teach";
  form.setAttribute("aria-busy", String(teaching || busy));
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
  clip.item.classList.add("skipped");
  clip.progress.hidden = true;
  setStatus(clip, reason);
}

/** @param {File} file */
function addClip(file) {
  const item = document.createElement("li");
  const name = document.createElement("span");
  name.className = "clip-name";
  name.textContent = file.name;
  const status = document.createElement("span");
  status.className = "clip-status";
  const progress = document.createElement("progress");
  progress.setAttribute("aria-label", `${file.name} progress`);
  progress.value = 0;
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
  item.append(name, status, retry, remove, progress);
  list.append(item);
  /** @type {Clip} */
  const clip = { file, item, status, progress, retry, state: "waiting", removed: false, clean: [], mixed: [] };
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
  const total = accepted().reduce((sum, c) => sum + c.file.size, 0);
  if (accepted().length >= MAX_CLIPS) skip(clip, "Too many recordings");
  else if (!EXTENSIONS.includes(extension)) skip(clip, "Couldn't be read");
  else if (file.size > MAX_FILE || total + file.size > MAX_TOTAL) skip(clip, "Too large");
  else {
    clip.state = "waiting";
    setStatus(clip, "Waiting");
    queue = queue.then(() => summariseClip(clip));
  }
}

/** @param {FileList | File[]} files */
function addFiles(files) {
  showError();
  const seen = new Set(live().map((c) => `${c.file.name}|${c.file.size}|${c.file.lastModified}`));
  for (const file of files) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const clip = addClip(file);
    admit(clip);
    clips.push(clip);
  }
  clips = live();
  refresh();
}

/** @param {Clip} clip */
async function summariseClip(clip) {
  if (clip.removed) return;
  clip.state = "working";
  setStatus(clip, "Reading");
  refresh();
  let parts;
  try {
    const { audio, rate } = await decode(await clip.file.arrayBuffer());
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
  try {
    const [hall] = await Promise.all([hallBackground(), loadModel()]);
    setStatus(clip, "Summarising");
    clip.progress.max = parts.length * 2;
    for (const part of parts) {
      if (clip.removed) return;
      clip.clean.push(await summarise(part));
      clip.progress.value += 1;
      clip.mixed.push(await summarise(mixOver(part, hall)));
      clip.progress.value += 1;
    }
  } catch {
    skip(clip, "Not summarised");
    clip.retry.hidden = false;
    showError(FAILED);
    refresh();
    return;
  }
  clip.state = "ready";
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
  refresh();
  try {
    const res = await fetch("/dashboard/api/teach", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: encode(ready),
    });
    if (res.status === 401) return signIn();
    if (res.ok) {
      // The sound list shows the new sound, and how far this change has reached the sensors.
      const reply = /** @type {{ version: number }} */ (await res.json());
      teaching = false;
      dialog.close();
      madeChange(reply.version);
      return;
    }
    const reply = /** @type {{ error?: string }} */ (await res.json().catch(() => ({})));
    showError(reply.error && SERVICE_REFUSALS.has(reply.error) ? reply.error : FAILED);
  } catch {
    showError(FAILED);
  }
  teaching = false;
  refresh();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!teaching) teach();
});
// Closing the dialog, taught or not, leaves it empty for the next sound.
dialog.addEventListener("close", () => {
  for (const clip of clips) clip.removed = true;
  clips = [];
  list.replaceChildren();
  form.reset();
  showError();
  refresh();
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
takeChosenFiles(); // files chosen before this module finished loading
refresh();
// The model is tens of megabytes: fetch it while the name is typed, not after the first drop. A failure here is
// retried by the first recording, which reports it.
loadModel().catch(() => {});
