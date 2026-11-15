// Sounds journey: a researcher reads the sound list, sees a failed save flip back, switches Chainsaw off and on, and
// moves the sensitivity, while a real sensor (the library's replay) picks each change up at its next check-in, the
// page counts the sensors the change has reached and the plan flags the sensor until it has, and a second
// researcher's page follows. It runs on its own fresh service: switching a sound off or moving the sensitivity
// applies to every sensor, so the shared service never sees it.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { devVars, showDevices, showEventLog, signIn } from "../fixtures/dashboard.ts";
import { asSensor, referenceClip, replay, sensorName, silentWav, uniqueSensorId } from "../fixtures/sensor.ts";
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
const reach = (page: Page) => page.getByRole("status").filter({ hasText: /^Reached / });

// The sound names in the list a replay's sensor fetched at a given version, from its own log line.
function fetchedList(out: string, version: number): string[] {
  const line = out.match(new RegExp(`sound list ${version}: (.*)`));
  expect(line, `the sensor fetched sound list ${version}`).not.toBeNull();
  return line![1].split(", ");
}

// The chainsaw reference clip at 0.6% volume, a distant chainsaw. The full clip is heard at 0.98, above the
// sensitivity's 90% top, so no setting could silence it; at this volume every window scores between 0.4 and about
// 0.6, so the sensor reports it once at 50% and never at 70%.
function distantChainsaw(): string {
  const wav = readFileSync(referenceClip("chainsaw.wav"));
  let at = 12;
  while (wav.toString("ascii", at, at + 4) !== "data") at += 8 + wav.readUInt32LE(at + 4) + (wav.readUInt32LE(at + 4) & 1);
  const end = at + 8 + wav.readUInt32LE(at + 4);
  const out = Buffer.from(wav);
  for (let i = at + 8; i < end; i += 2) out.writeInt16LE(Math.trunc(wav.readInt16LE(i) * 0.006), i);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "fp-distant-")), "distant-chainsaw.wav");
  writeFileSync(file, out);
  return file;
}

// The confidence a replay's sensor heard Chainsaw at, from its own log line, or null when it heard none.
function heardChainsaw(out: string): number | null {
  const line = out.match(/heard Chainsaw \((\d\.\d+)\)/);
  return line ? Number(line[1]) : null;
}

test("a researcher switches Chainsaw off and on and moves the sensitivity; a sensor follows at its next check-in", async ({ page, context, browser }) => {
  test.setTimeout(300_000);
  const service = new SecondService(soundsServicePorts);
  await service.start();
  try {
    const origin = service.url;
    await signIn(page, "/dashboard/", origin);
    // The sensitivity and the sensors' cards are in the Devices panel, which opens over the sound list: a second
    // tab keeps it open.
    const panel = await context.newPage();
    await panel.goto(`${origin}/dashboard/`);
    await showDevices(panel);
    // Each switch moves the list's version on by one from wherever this fresh service starts.
    const start: number = (await (await page.request.get(`${origin}/dashboard/api/sounds`)).json()).version;

    // Every seeded sound, by name, with its category and kind, switched on.
    for (const [name, category, kind] of SEEDED) {
      await expect(soundSwitch(page, name)).toBeChecked();
      const row = page.getByRole("listitem").filter({ has: soundSwitch(page, name) });
      await expect(row).toContainText(category);
      await expect(row).toContainText(kind);
    }

    // The sensitivity starts at 50%. A save of it that fails puts the slider back and says so.
    const sensitivity = panel.getByRole("slider");
    await expect(sensitivity).toHaveValue("50");
    await expect(panel.getByText("Report sounds at 50% confidence or more")).toBeVisible();
    await panel.route(`${origin}/dashboard/api/sounds`, (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 500, body: "{}" }) : route.continue());
    await sensitivity.fill("60");
    await expect(panel.getByRole("alert")).toHaveText("Couldn't save, try again");
    await expect(sensitivity).toHaveValue("50");
    await expect(panel.getByText("Report sounds at 50% confidence or more")).toBeVisible();
    await panel.unroute(`${origin}/dashboard/api/sounds`);
    expect((await (await page.request.get(`${origin}/dashboard/api/sounds`)).json()).sensitivity).toBe(0.5);

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
    await showEventLog(log);
    const sensorId = uniqueSensorId("sounds");
    const stateDir = path.join(mkdtempSync(path.join(os.tmpdir(), "fp-sounds-")), "state");
    const first = await replay({ sensorId, wavs: [referenceClip("chainsaw.wav")], stateDir, serverUrl: origin });
    expect(fetchedList(first, start)).toContain("Chainsaw");
    expect(first).toContain("0 event(s) still queued");
    const name = await sensorName(page.request, sensorId, origin);
    const rows = log.getByRole("row").filter({ has: log.getByRole("cell", { name, exact: true }) });
    await expect(rows.filter({ hasText: "Chainsaw" })).toHaveCount(1, { timeout: 3000 });
    const before = await rows.count();

    // Before any change the page says nothing about the sensors.
    await expect(reach(page)).toHaveCount(0);

    // Switched off: the page counts the sensor as not reached yet and the plan shows it updating, until the sensor's
    // next check-ins fetch a list without Chainsaw and report it: its next run fetches the list, and the run after
    // reports it at its first check-in (a run can stop before a second one).
    const sensorCard = panel.getByRole("list", { name: "Sensors" }).getByRole("listitem")
      .filter({ has: panel.getByText(sensorId, { exact: true }) });
    // The sensor has just checked in with the list it holds, so it is online when the switch lands.
    await asSensor(sensorId, [{ call: "checkin", fields: { sound_list_version: start } }], undefined, origin);
    await soundSwitch(page, "Chainsaw").click();
    await expect(soundSwitch(page, "Chainsaw")).not.toBeChecked();
    await expect(soundSwitch(page, "Chainsaw")).toBeEnabled();
    await expect(page.getByRole("listitem").filter({ has: soundSwitch(page, "Chainsaw") }))
      .not.toContainText("Couldn't save");
    await expect(reach(page)).toHaveText("Reached 0 of 1 sensor");
    await expect(sensorCard.getByText("Updating", { exact: true })).toBeVisible({ timeout: 3000 });
    const checkin = await replay({ sensorId, wavs: [silentWav()], stateDir, serverUrl: origin });
    expect(fetchedList(checkin, start + 1)).not.toContain("Chainsaw");

    // A chainsaw now adds nothing, and the earlier chainsaw row is still there.
    const off = await replay({ sensorId, wavs: [referenceClip("chainsaw.wav")], stateDir, serverUrl: origin });
    expect(off).toContain("0 event(s) still queued");
    await expect(reach(page)).toHaveText("Reached 1 of 1 sensor", { timeout: 3000 });
    await expect(sensorCard.getByText("Updating", { exact: true })).toBeHidden({ timeout: 3000 });
    await expect(sensorCard.getByText("Outdated sound list")).toBeHidden();

    // The switch stays off after a reload; the count does not.
    await page.reload();
    await expect(soundSwitch(page, "Chainsaw")).not.toBeChecked();
    await expect(soundSwitch(page, "Gunshot")).toBeChecked();
    await expect(reach(page)).toHaveCount(0);
    // An event for it sent anyway (a sensor still on its old list) is answered as dropped and not stored.
    const sent = await page.request.post(`${origin}/api/v1/sensors/${sensorId}/events`, {
      headers: { Authorization: `Bearer ${devVars().DEVICE_KEY}` },
      data: { sent_at: new Date().toISOString(), events: [
        { event_id: "late-chainsaw", detected_at: new Date().toISOString(), sound_id: "chainsaw", confidence: 0.9 },
      ] },
    });
    expect((await sent.json()).results).toEqual([{ event_id: "late-chainsaw", status: "dropped" }]);
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

    // Another researcher has the page open when the sensitivity moves to 70%; their page follows at its next poll.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, "/dashboard/", origin);
    await showDevices(otherPage);
    await expect(otherPage.getByRole("slider")).toHaveValue("50");
    await sensitivity.fill("70");
    await expect(panel.getByText("Report sounds at 70% confidence or more")).toBeVisible();
    await expect(panel.getByRole("alert")).toBeHidden();
    // A sensitivity change is a sound-list change: the sensor has not reached it yet. With the Devices panel open
    // over the sound list, the line sits under the sensitivity.
    await expect(reach(page)).toHaveText("Reached 0 of 1 sensor");
    await expect(panel.getByRole("tabpanel", { name: "Devices" }).getByRole("status").filter({ hasText: /^Reached / }))
      .toHaveText("Reached 0 of 1 sensor");
    await expect.poll(async () => (await (await page.request.get(`${origin}/dashboard/api/sounds`)).json()))
      .toMatchObject({ sensitivity: 0.7, version: start + 3 });
    await expect(otherPage.getByRole("slider")).toHaveValue("70");
    await expect(otherPage.getByText("Report sounds at 70% confidence or more")).toBeVisible();
    await other.close();

    // Every sound a sensor fetches now carries 0.7 as its threshold, and a distant chainsaw is no longer reported.
    const [list] = await asSensor(sensorId, [{ call: "sounds" }], undefined, origin);
    expect(list.version).toBe(start + 3);
    expect(list.sounds.map((s: { name: string }) => s.name)).toContain("Chainsaw");
    for (const s of list.sounds) expect(s.threshold, s.name).toBe(0.7);
    const distant = distantChainsaw();
    expect(fetchedList(await replay({ sensorId, wavs: [silentWav()], stateDir, serverUrl: origin }), start + 3))
      .toContain("Chainsaw");
    const quiet = await replay({ sensorId, wavs: [distant], stateDir, serverUrl: origin });
    expect(heardChainsaw(quiet)).toBeNull();
    expect(quiet).toContain("0 event(s) still queued");
    await log.waitForTimeout(2500); // one more poll of the log
    await expect(rows.filter({ hasText: "Chainsaw" })).toHaveCount(2);

    // Back at 50%, the same replay is heard below 70% and reported once.
    await sensitivity.fill("50");
    await expect(panel.getByText("Report sounds at 50% confidence or more")).toBeVisible();
    await expect.poll(async () => (await (await page.request.get(`${origin}/dashboard/api/sounds`)).json()))
      .toMatchObject({ sensitivity: 0.5, version: start + 4 });
    expect(fetchedList(await replay({ sensorId, wavs: [silentWav()], stateDir, serverUrl: origin }), start + 4))
      .toContain("Chainsaw");
    const heard = await replay({ sensorId, wavs: [distant], stateDir, serverUrl: origin });
    const confidence = heardChainsaw(heard);
    expect(confidence, "the distant chainsaw's logged confidence").not.toBeNull();
    expect(confidence!).toBeGreaterThanOrEqual(0.5);
    expect(confidence!).toBeLessThan(0.7);
    expect(heard).toContain("0 event(s) still queued");
    await expect(rows.filter({ hasText: "Chainsaw" })).toHaveCount(3, { timeout: 3000 });
  } finally {
    await service.stop();
  }
});
