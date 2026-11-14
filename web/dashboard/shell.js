// The dashboard shell, shared by every researcher page: the header with its navigation, and live polling with
// the connection-lost banner. A page loads this module and builds its own content in <main>.
// Additive only: add a navigation entry, never reorder or rewrite one (docs/agents/ownership.md).

/** @type {{ href: string, label: string }[]} */
const NAV = [
  { href: "/dashboard/", label: "Live" },
  { href: "/dashboard/sounds/", label: "Sounds" },
];

const POLL_MS = 2000;
const FAILURES_BEFORE_LOST = 3;

const banner = document.createElement("p");
banner.className = "connection-lost";
banner.setAttribute("role", "alert");
banner.hidden = true;

/** @type {Set<{ failures: number }>} */
const pollers = new Set();
/** @type {Date | null} */
let lastUpdate = null;

function mountHeader() {
  const header = document.createElement("header");
  header.className = "shell-header";
  const home = document.createElement("a");
  home.href = "/dashboard/";
  home.className = "shell-home";
  const logo = document.createElement("img");
  logo.src = "/brand/logo-horizontal-inverse.svg";
  logo.alt = "Forest Pulse";
  home.append(logo);
  header.append(home);
  // One page needs no navigation.
  if (NAV.length > 1) {
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Dashboard");
    for (const item of NAV) {
      const a = document.createElement("a");
      a.href = item.href;
      a.textContent = item.label;
      if (item.href === location.pathname) a.setAttribute("aria-current", "page");
      nav.append(a);
    }
    header.append(nav);
  }
  document.body.prepend(header, banner);
}

/** @param {number} n */
const pad = (n) => String(n).padStart(2, "0");

/** HH:MM:SS in the researcher's local time. @param {Date} d */
export function clockTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function showConnection() {
  const lost = [...pollers].some((p) => p.failures >= FAILURES_BEFORE_LOST);
  banner.textContent = lastUpdate ? `Connection lost, last update ${clockTime(lastUpdate)}` : "Connection lost";
  banner.hidden = !lost;
}

/**
 * Fetches a researcher data path every 2 s and hands each successful JSON reply to render. A signed-out reply goes
 * to sign-in; after 3 failed polls in a row the banner shows, and the next success clears it.
 * @param {string} path
 * @param {(data: any) => void} render
 */
export function poll(path, render) {
  const state = { failures: 0 };
  pollers.add(state);
  const tick = async () => {
    const started = Date.now();
    try {
      const res = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(POLL_MS) });
      if (res.status === 401) {
        const back = location.pathname + location.search;
        location.assign(back === "/dashboard/" ? "/dashboard/signin" : `/dashboard/signin?next=${encodeURIComponent(back)}`);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
      state.failures = 0;
      lastUpdate = new Date();
    } catch {
      state.failures += 1;
    }
    showConnection();
    setTimeout(tick, Math.max(0, POLL_MS - (Date.now() - started)));
  };
  tick();
}

mountHeader();
