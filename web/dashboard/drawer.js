// The Devices panel and the presenter's player: what the two buttons at the top right open. The panel has two
// tabs, Devices and Event log; the pulse along the foot of the map opens it on the log. While the panel is open
// the map tips up to a plan view and the sensors on it can be moved. The player's own module loads on first use.
import { setDeviceMode } from "/dashboard/plan/scene.js";

const drawer = /** @type {HTMLElement} */ (document.getElementById("drawer"));
const openDevices = /** @type {HTMLButtonElement} */ (document.getElementById("open-devices"));
const openPlayer = /** @type {HTMLButtonElement} */ (document.getElementById("open-player"));
const player = /** @type {HTMLElement} */ (document.getElementById("player"));
const tabs = /** @type {HTMLButtonElement[]} */ ([...drawer.querySelectorAll("[role=tab]")]);

/** @param {HTMLButtonElement} tab */
function select(tab) {
  for (const t of tabs) {
    t.setAttribute("aria-selected", String(t === tab));
    const panel = document.getElementById(/** @type {string} */ (t.getAttribute("aria-controls")));
    if (panel) panel.hidden = t !== tab;
  }
}

/** @param {boolean} open @param {HTMLButtonElement} [tab] */
function showDrawer(open, tab) {
  if (open) showPlayer(false);
  if (tab) select(tab);
  drawer.hidden = !open;
  openDevices.setAttribute("aria-expanded", String(open));
  setDeviceMode(open);
}

/** @param {boolean} open */
function showPlayer(open) {
  player.hidden = !open;
  openPlayer.setAttribute("aria-expanded", String(open));
  if (open) import("/dashboard/player/player.js");
}

openDevices.addEventListener("click", () => showDrawer(drawer.hidden !== false, tabs[0]));
openPlayer.addEventListener("click", () => showPlayer(player.hidden !== false));
/** @type {HTMLElement} */ (drawer.querySelector(".drawer-close")).addEventListener("click", () => showDrawer(false));
/** @type {HTMLElement} */ (document.querySelector(".pulse")).addEventListener("click", () => showDrawer(true, tabs[1]));
for (const tab of tabs) tab.addEventListener("click", () => select(tab));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
  if (!player.hidden) showPlayer(false);
  else if (!drawer.hidden) showDrawer(false);
});
