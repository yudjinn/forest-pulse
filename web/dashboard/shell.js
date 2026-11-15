// The dashboard shell: live polling with the connection-lost line, the service's clock, and going to sign-in. Every
// part of the one page loads this module and builds its own content.

const POLL_MS = 2000;
const FAILURES_BEFORE_LOST = 3;

const lost = /** @type {HTMLElement} */ (document.querySelector(".connection-lost"));

/** @type {Set<{ failures: number, tick: () => void }>} */
const pollers = new Set();
/** @type {Date | null} */
let lastUpdate = null;
// The service's clock minus this page's, from the latest reply that carried the service's time.
let skew = 0;

/** @param {number} n */
const pad = (n) => String(n).padStart(2, "0");

/** HH:MM:SS in the researcher's local time. @param {Date} d */
export function clockTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The service's time now, in ms since the epoch, as far as its replies have told this page. */
export const serviceNow = () => Date.now() + skew;

/** A reply said what time the service has. @param {number} now */
export function serviceClock(now) {
  skew = now - Date.now();
}

/** A signed-out reply: the researcher signs in and comes back. */
export function signIn() {
  location.assign("/dashboard/signin");
}

function showConnection() {
  const isLost = [...pollers].some((p) => p.failures >= FAILURES_BEFORE_LOST);
  lost.textContent = lastUpdate ? `Connection lost, last update ${clockTime(lastUpdate)}` : "Connection lost";
  lost.hidden = !isLost;
}

/**
 * Fetches a researcher data path every 2 s and hands each successful JSON reply to render. A signed-out reply goes
 * to sign-in; after 3 failed polls in a row the connection-lost line shows, and the next success clears it.
 * @param {string} path
 * @param {(data: any) => void} render
 */
export function poll(path, render) {
  let run = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const tick = async () => {
    const mine = ++run;
    clearTimeout(timer);
    const started = Date.now();
    try {
      const res = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(POLL_MS) });
      if (mine !== run) return;
      if (res.status === 401) return signIn();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (mine !== run) return;
      render(data);
      state.failures = 0;
      lastUpdate = new Date();
    } catch {
      if (mine !== run) return;
      state.failures += 1;
    }
    showConnection();
    timer = setTimeout(tick, Math.max(0, POLL_MS - (Date.now() - started)));
  };
  const state = { failures: 0, tick };
  pollers.add(state);
  tick();
}

/**
 * Polls every live view on the page now and discards replies to requests already in flight, which may have been
 * answered before a change the page just made.
 */
export function refresh() {
  for (const p of pollers) p.tick();
}
