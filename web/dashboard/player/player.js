// The presenter's player: tap a sample and it loops through the phone's audio (and so a paired speaker) until Stop
// or another sample is tapped. Each recording is decoded once and looped by the audio engine, so the seam never
// gaps, and the screen is kept awake while something plays.

const section = /** @type {HTMLElement} */ (document.getElementById("player"));
const list = /** @type {HTMLUListElement} */ (section.querySelector(".sample-list"));
const stopButton = /** @type {HTMLButtonElement} */ (section.querySelector(".player-stop"));
const listError = /** @type {HTMLElement} */ (section.querySelector(":scope > .error"));

/**
 * @typedef {{ recordist: string | null, source: string, url: string, licence: string, licence_url: string }} Credit
 * @typedef {{ id: string, name: string, kind: string, seconds: number, credit: Credit, url: string }} Sample
 * @typedef {{ sample: Sample, button: HTMLButtonElement, state: HTMLElement, error: HTMLElement,
 *   buffer: Promise<AudioBuffer> | null }} Row
 */

const audio = new AudioContext();
// iOS: play like a media player, through the silent switch.
const session = /** @type {{ audioSession?: { type: string } }} */ (/** @type {unknown} */ (navigator)).audioSession;
if (session) session.type = "playback";

/** @type {{ row: Row, source: AudioBufferSourceNode } | null} */
let current = null;
/** @type {Row | null} The row tapped last, while its recording is still loading. */
let pending = null;
/** @type {WakeLockSentinel | null} */
let wakeLock = null;

function signIn() {
  location.assign(`/dashboard/signin?next=${encodeURIComponent(location.pathname)}`);
}

/** Fetches and decodes a row's recording once; a failure is forgotten so the next tap tries again. @param {Row} row */
function load(row) {
  if (!row.buffer) {
    const buffer = fetch(row.sample.url).then(async (res) => {
      if (res.status === 401) signIn();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return audio.decodeAudioData(await res.arrayBuffer());
    });
    buffer.catch(() => {
      if (row.buffer === buffer) row.buffer = null;
    });
    row.buffer = buffer;
  }
  return row.buffer;
}

/** @param {Row} row @param {"idle" | "loading" | "playing"} state */
function show(row, state) {
  row.button.setAttribute("aria-pressed", String(state === "playing"));
  row.button.setAttribute("aria-busy", String(state === "loading"));
  row.state.textContent = state === "playing" ? "Playing" : state === "loading" ? "Loading" : "";
  stopButton.disabled = !current && !pending;
}

async function holdScreen() {
  if (wakeLock || !("wakeLock" in navigator)) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!current || wakeLock) {
      lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    // Refused (battery saver, not visible): playback goes on regardless.
  }
}

function releaseScreen() {
  wakeLock?.release();
  wakeLock = null;
}

function stop() {
  const waiting = pending;
  pending = null;
  if (waiting) show(waiting, "idle");
  if (current) {
    const { row, source } = current;
    current = null;
    source.onended = null;
    source.stop();
    show(row, "idle");
  }
  releaseScreen();
}

/** @param {Row} row */
async function play(row) {
  stop();
  pending = row;
  row.error.hidden = true;
  show(row, "loading");
  const resumed = audio.resume(); // inside the tap, where browsers allow audio to start
  let buffer;
  try {
    buffer = await load(row);
    await resumed;
  } catch {
    if (pending !== row) return;
    pending = null;
    show(row, "idle");
    row.error.hidden = false;
    return;
  }
  if (pending !== row) return; // Stop or another sample was tapped while this one loaded
  pending = null;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(audio.destination);
  source.onended = () => {
    if (current?.source !== source) return;
    current = null;
    show(row, "idle");
    releaseScreen();
  };
  source.start();
  current = { row, source };
  show(row, "playing");
  holdScreen();
}

/** @param {Credit} credit */
function creditLine(credit) {
  const p = document.createElement("p");
  p.className = "sample-credit";
  const source = document.createElement("a");
  source.href = credit.url;
  source.textContent = credit.source;
  const licence = document.createElement("a");
  licence.href = credit.licence_url;
  licence.textContent = credit.licence;
  for (const a of [source, licence]) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  if (credit.recordist) p.append(`${credit.recordist}, `);
  p.append(source, ", ", licence);
  return p;
}

/** @param {Sample} sample */
function makeRow(sample) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sample";
  const name = document.createElement("span");
  name.className = "sample-name";
  name.textContent = sample.name;
  const state = document.createElement("span");
  state.className = "sample-state";
  button.append(name, state);
  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "alert");
  error.textContent = "Couldn't play this sample";
  error.hidden = true;
  item.append(button, creditLine(sample.credit), error);
  /** @type {Row} */
  const row = { sample, button, state, error, buffer: null };
  button.addEventListener("click", () => (current?.row === row || pending === row ? stop() : play(row)));
  show(row, "idle");
  list.append(item);
  return row;
}

stopButton.addEventListener("click", stop);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !current) return;
  holdScreen();
  audio.resume().catch(() => {});
});
// A phone may suspend or interrupt the audio (a call, the screen locking): carry on once it allows.
audio.addEventListener("statechange", () => {
  if (current && audio.state !== "running" && audio.state !== "closed") audio.resume().catch(() => {});
});

async function start() {
  try {
    const res = await fetch("/dashboard/api/player/samples", { cache: "no-store" });
    if (res.status === 401) return signIn();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    /** @type {{ samples: Sample[] }} */
    const { samples } = await res.json();
    // Load every recording now, so a tap on stage starts at once.
    for (const row of samples.map(makeRow)) load(row).catch(() => {});
  } catch {
    listError.hidden = false;
  }
}

start();
