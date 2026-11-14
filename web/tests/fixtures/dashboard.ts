// Researcher-side helpers for journeys: the local dev secrets and signing in through the real sign-in page.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
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

// Opens a dashboard page signed out, signs in on the page it is sent to, and waits to be back on that page.
export async function signIn(page: Page, dashboardPath = "/dashboard/", origin = "") {
  await page.goto(origin + dashboardPath);
  await page.getByLabel("Password").fill(devVars().DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(origin + dashboardPath);
}
