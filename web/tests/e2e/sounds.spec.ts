// Sounds journey: a researcher reads the sound list, sees a failed save flip back, and switches Chainsaw off and on
// while a real sensor (the library's replay) picks each change up at its next check-in.
// It runs on its own fresh service: switching a sound off applies to every sensor, so the shared service never sees it.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../fixtures/dashboard.ts";
import { referenceClip, replay, silentWav, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { soundsServicePorts } from "../ports.ts";

const SEEDED = [
  ["Chainsaw", "Logging", "Trained detector"],
  ["Tools", "Logging", "Built-in label"],
  ["Power tool", "Logging", "Built-in label"],
  ["Vehicle", "Vehicle", "Built-in label"],
  ["Engine", "Vehicle", "Built-in label"],
  ["Aircraft", "Vehicle", "Built-in label"],
  ["Gunshot", "Poaching", "Built-in label"],
];

const soundSwitch = (page: Page, name: string) => page.getByRole("switch", { name, exact: true });

// The sound names in the list a replay's sensor fetched at a given version, from its own log line.
function fetchedList(out: string, version: number): string[] {
  const line = out.match(new RegExp(`sound list ${version}: (.*)`));
  expect(line, `the sensor fetched sound list ${version}`).not.toBeNull();
  return line![1].split(", ");
}

test("a researcher switches Chainsaw off and on; a sensor follows at its next check-in and history stays", async ({ page, context }) => {
  test.setTimeout(240_000);
  const service = new SecondService(soundsServicePorts);
  await service.start();
  try {
    const origin = service.url;
    await signIn(page, "/dashboard/sounds/", origin);
    await expect(page.getByRole("link", { name: "Sounds" })).toHaveAttribute("aria-current", "page");
    // Each switch moves the list's version on by one from wherever this fresh service starts.
    const start: number = (await (await page.request.get(`${origin}/dashboard/api/sounds`)).json()).version;

    // Every seeded sound, by name, with its category and kind, switched on.
    for (const [name, category, kind] of SEEDED) {
      await expect(soundSwitch(page, name)).toBeChecked();
      const row = page.getByRole("listitem").filter({ has: soundSwitch(page, name) });
      await expect(row).toContainText(category);
      await expect(row).toContainText(kind);
    }

    // A save that fails flips the switch back and says so.
    await page.route(`${origin}/dashboard/api/sounds/*`, (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 500, body: "{}" }) : route.continue());
    await soundSwitch(page, "Gunshot").click();
    await expect(page.getByRole("listitem").filter({ has: soundSwitch(page, "Gunshot") }))
      .toContainText("Couldn't save, try again");
    await expect(soundSwitch(page, "Gunshot")).toBeChecked();
    await expect(soundSwitch(page, "Gunshot")).toBeEnabled();
    await page.unroute(`${origin}/dashboard/api/sounds/*`);

    // A sensor that keeps its state hears a chainsaw; the row shows in the live log.
    const log = await context.newPage();
    await log.goto(`${origin}/dashboard/`);
    const sensorId = uniqueSensorId("sounds");
    const stateDir = path.join(mkdtempSync(path.join(os.tmpdir(), "fp-sounds-")), "state");
    const rows = log.getByRole("row").filter({ hasText: sensorId });
    const first = await replay({ sensorId, wavs: [referenceClip("chainsaw.wav")], stateDir, serverUrl: origin });
    expect(fetchedList(first, start)).toContain("Chainsaw");
    expect(first).toContain("0 event(s) still queued");
    await expect(rows.filter({ hasText: "Chainsaw" })).toHaveCount(1, { timeout: 3000 });
    const before = await rows.count();

    // Switched off, it stays off after a reload, and the sensor's next check-in fetches a list without it.
    await soundSwitch(page, "Chainsaw").click();
    await expect(soundSwitch(page, "Chainsaw")).not.toBeChecked();
    await expect(soundSwitch(page, "Chainsaw")).toBeEnabled();
    await expect(page.getByRole("listitem").filter({ has: soundSwitch(page, "Chainsaw") }))
      .not.toContainText("Couldn't save");
    await page.reload();
    await expect(soundSwitch(page, "Chainsaw")).not.toBeChecked();
    await expect(soundSwitch(page, "Gunshot")).toBeChecked();
    const checkin = await replay({ sensorId, wavs: [silentWav()], stateDir, serverUrl: origin });
    expect(fetchedList(checkin, start + 1)).not.toContain("Chainsaw");

    // A chainsaw now adds nothing, and the earlier chainsaw row is still there.
    const off = await replay({ sensorId, wavs: [referenceClip("chainsaw.wav")], stateDir, serverUrl: origin });
    expect(off).toContain("0 event(s) still queued");
    await log.waitForTimeout(2500); // one more poll of the log
    await expect(rows).toHaveCount(before);
    await expect(rows.filter({ hasText: "Chainsaw" })).toHaveCount(1);

    // Switched back on, the next check-in brings it back and a chainsaw is reported again.
    await soundSwitch(page, "Chainsaw").click();
    await expect(soundSwitch(page, "Chainsaw")).toBeChecked();
    await expect(soundSwitch(page, "Chainsaw")).toBeEnabled();
    const back = await replay({ sensorId, wavs: [silentWav()], stateDir, serverUrl: origin });
    expect(fetchedList(back, start + 2)).toContain("Chainsaw");
    const on = await replay({ sensorId, wavs: [referenceClip("chainsaw.wav")], stateDir, serverUrl: origin });
    expect(on).toContain("0 event(s) still queued");
    await expect(rows.filter({ hasText: "Chainsaw" })).toHaveCount(2, { timeout: 3000 });
  } finally {
    await service.stop();
  }
});
