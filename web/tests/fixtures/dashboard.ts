// Researcher-side helpers for journeys: the local dev secrets and signing in through the real sign-in page.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { webRoot } from "../ports.ts";

// The local secrets from web/.dev.vars (written by tests/serve.ts with dev values when missing).
export function devVars(): { DASHBOARD_PASSWORD: string; DEVICE_KEY: string; SESSION_SECRET: string } {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path.join(webRoot, ".dev.vars"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars as ReturnType<typeof devVars>;
}

// Opens the Devices panel on one of its tabs, or switches to it: Devices holds the sensors' cards, Calibrate and the
// sensitivity (and the map's sensors can be moved while it is open); Event log holds the log and Clear events.
async function showTab(page: Page, name: "Devices" | "Event log") {
  const tab = page.getByRole("tab", { name, exact: true });
  await opened(page.getByRole("button", { name: "Devices", exact: true }), tab);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
export const showDevices = (page: Page) => showTab(page, "Devices");
export const showEventLog = (page: Page) => showTab(page, "Event log");

// Opens the presenter's player from the speaker button.
export const showPlayer = (page: Page) =>
  opened(page.getByRole("button", { name: "Play sounds", exact: true }), page.getByRole("region", { name: "Play sounds" }));

// Opens the teach dialog from the sound list, and returns it.
export async function openTeach(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: "Teach a new sound" });
  await opened(page.getByRole("button", { name: "Teach a new sound" }), dialog);
  return dialog;
}

// Presses a button unless what it opens already shows. The page keeps these buttons disabled until its scripts are
// listening, so a press right after the page loads waits for them.
async function opened(button: Locator, shown: Locator) {
  if (!(await shown.isVisible())) await button.click();
  await expect(shown).toBeVisible();
}

// Opens a dashboard page signed out, signs in on the page it is sent to, and waits to be back on that page.
export async function signIn(page: Page, dashboardPath = "/", origin = "") {
  await page.goto(origin + dashboardPath);
  await page.getByLabel("Password").fill(devVars().DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(origin + dashboardPath);
}
