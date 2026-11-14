// Teaching journey: a researcher teaches Boreal owl from dropped recordings on the Teach page, after seeing too few
// usable recordings refused and a failed upload save nothing; the sound appears in the Sounds list, and sensors
// pull it at their next check-in: a boreal owl the detector never heard is reported, a tawny owl is not. Teaching
// Boreal owl again with other recordings replaces its detector in place; deleting it, after a confirmation and a
// failed attempt, takes it off sensors at their next check-in while the log keeps its earlier rows.
// It runs on its own fresh service: teaching changes the sound list for every sensor, so the shared service never
// sees it. The teaching clips are boreal owls by recordists the player's samples do not use; the replayed owls are
// the player's own samples, kept out of the other-sounds library and the teaching clips.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { devVars, signIn } from "../fixtures/dashboard.ts";
import { asSensor, replay, sensorName, silentWav, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { teachServicePorts, webRoot } from "../ports.ts";

const owls = path.join(webRoot, "tests", "fixtures", "owls");
const teachingSet = (name: string) =>
  readdirSync(path.join(owls, name)).filter((f) => f.endsWith(".wav")).sort().map((f) => path.join(owls, name, f));
// A recording as the browser gets it from a drop or the file picker.
const asFile = (file: string) => ({ name: path.basename(file), mimeType: "audio/wav", buffer: readFileSync(file) });
const playerSample = (file: string) => path.join(webRoot, "bucket", "player", file);

const clipRow = (page: Page, file: string) => page.getByRole("listitem").filter({ hasText: file });

// The sound names in the list a replay's sensor fetched at a given version, from its own log line.
function fetchedList(out: string, version: number): string[] {
  const line = out.match(new RegExp(`sound list ${version}: (.*)`));
  expect(line, `the sensor fetched sound list ${version}`).not.toBeNull();
  return line![1].split(", ");
}

// A teach request with the right shape: n clips of one window each, every summary zero.
function teachRequest(name: string, clips: number): Buffer {
  const header = Buffer.from(JSON.stringify({
    name, category: "wildlife", clips: Array.from({ length: clips }, (_, i) => ({ file: `c${i}.wav`, windows: 1 })),
  }));
  const start = 4 + Math.ceil(header.length / 4) * 4;
  const body = Buffer.alloc(start + clips * 2 * 960 * 4);
  body.writeUInt32LE(header.length, 0);
  header.copy(body, 4);
  return body;
}

test("a researcher teaches, reteaches and deletes Boreal owl; sensors follow at each check-in and history stays", async ({ page, context }) => {
  test.setTimeout(480_000);
  const service = new SecondService(teachServicePorts);
  await service.start();
  try {
    const origin = service.url;
    await signIn(page, "/dashboard/sounds/", origin);
    const before = await (await page.request.get(`${origin}/dashboard/api/sounds`)).json();
    // The Sounds list in its own tab, following the 2 s poll.
    const sounds = await context.newPage();
    await sounds.goto(`${origin}/dashboard/sounds/`);
    await expect(sounds.getByRole("switch")).toHaveCount(before.sounds.length);

    await page.getByRole("link", { name: "Teach a new sound" }).click();
    await expect(page).toHaveURL(`${origin}/dashboard/teach/`);
    await expect(page.getByRole("heading", { name: "Teach a new sound" })).toBeVisible();
    await page.getByLabel("Name").fill("Boreal owl");
    await expect(page.getByLabel("Category")).toHaveValue("wildlife");

    // Four recordings and a file that is not audio: the file is skipped with its reason, and Teach is refused.
    const clips = teachingSet("teach-a");
    await page.getByLabel("Recordings").setInputFiles([
      ...clips.slice(0, 4).map(asFile),
      { name: "field-notes.wav", mimeType: "audio/wav", buffer: Buffer.from("these are notes, not a recording") },
    ]);
    // Recordings are read in turn, so the file's verdict comes after the four before it are summarised.
    await expect(clipRow(page, "field-notes.wav")).toContainText("Couldn't be read", { timeout: 60_000 });
    for (const clip of clips.slice(0, 4)) {
      await expect(clipRow(page, path.basename(clip))).toContainText("Ready", { timeout: 60_000 });
    }
    await page.getByRole("button", { name: "Teach" }).click();
    await expect(page.getByText("Needs at least 5 usable recordings")).toBeVisible();

    // Two more make six. An upload that fails says so and saves nothing.
    await page.getByLabel("Recordings").setInputFiles(clips.slice(4));
    for (const clip of clips.slice(4)) {
      await expect(clipRow(page, path.basename(clip))).toContainText("Ready", { timeout: 60_000 });
    }
    await page.route(`${origin}/dashboard/api/teach`, (route) => route.abort("failed"));
    await page.getByRole("button", { name: "Teach" }).click();
    await expect(page.getByText("Teaching failed, try again")).toBeVisible();
    await expect(page.getByRole("button", { name: "Teach" })).toBeEnabled();
    await page.unroute(`${origin}/dashboard/api/teach`);
    const unchanged = await (await page.request.get(`${origin}/dashboard/api/sounds`)).json();
    expect(unchanged).toEqual(before);
    await expect(sounds.getByRole("switch")).toHaveCount(before.sounds.length);
    await expect(sounds.getByText("Boreal owl")).toHaveCount(0);

    // Teaching again works: the page returns to the Sounds list, which shows the new sound switched on, and the
    // other tab's list picks it up on its own.
    await page.getByRole("button", { name: "Teach" }).click();
    await expect(page).toHaveURL(`${origin}/dashboard/sounds/`, { timeout: 60_000 });
    const owl = page.getByRole("switch", { name: "Boreal owl", exact: true });
    await expect(owl).toBeChecked();
    await expect(page.getByRole("listitem").filter({ has: owl })).toContainText("Wildlife · Trained detector");
    await expect(sounds.getByRole("switch", { name: "Boreal owl", exact: true })).toBeChecked({ timeout: 5000 });
    const after = await (await page.request.get(`${origin}/dashboard/api/sounds`)).json();
    expect(after.version).toBe(before.version + 1);
    expect(after.sounds).toHaveLength(before.sounds.length + 1);

    // A seeded sound's name, in any case, is refused and changes nothing.
    const again = await page.request.post(`${origin}/dashboard/api/teach`, {
      headers: { "Content-Type": "application/octet-stream" }, data: teachRequest("chainSAW", 5),
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).error).toBe("A sound with this name already exists");
    expect((await (await page.request.get(`${origin}/dashboard/api/sounds`)).json()).version).toBe(after.version);

    // Two sensors check in and pull the new list. One hears a boreal owl the detector never heard; the other hears
    // a tawny owl. Only the first is reported as Boreal owl in the live log.
    const log = await context.newPage();
    await log.goto(`${origin}/dashboard/`);
    const borealSensor = uniqueSensorId("teach-boreal");
    const tawnySensor = uniqueSensorId("teach-tawny");
    // The boreal owl sensor keeps its state, so its later check-ins follow the list it has.
    const borealState = path.join(mkdtempSync(path.join(os.tmpdir(), "fp-teach-")), "state");
    const heard = await replay({
      sensorId: borealSensor, wavs: [playerSample("boreal-owl-1.wav")], stateDir: borealState, serverUrl: origin,
    });
    expect(heard).toMatch(new RegExp(`sound list ${after.version}: .*Boreal owl`));
    expect(heard).toContain("0 event(s) still queued");
    const tawny = await replay({ sensorId: tawnySensor, wavs: [playerSample("tawny-owl.wav")], serverUrl: origin });
    expect(tawny).toMatch(new RegExp(`sound list ${after.version}: .*Boreal owl`));
    expect(tawny).toContain("0 event(s) still queued");
    // The log names each sensor as the plan does.
    const owlRows = async (id: string) => log.getByRole("row")
      .filter({ has: log.getByRole("cell", { name: await sensorName(page.request, id, origin), exact: true }) })
      .filter({ hasText: "Boreal owl" });
    const borealRows = await owlRows(borealSensor);
    await expect(borealRows.first()).toBeVisible({ timeout: 5000 });
    await log.waitForTimeout(2500); // one more poll of the log
    await expect(await owlRows(tawnySensor)).toHaveCount(0);
    const heardRows = await borealRows.count();

    // Teaching Boreal owl again with the second set of recordings replaces its detector: the Sounds list still has
    // one Boreal owl, and a sensor's next sound-list fetch carries a higher version and new weights for the same id.
    const fetchSounds = async () => (await asSensor(borealSensor, [{ call: "sounds" }], undefined, origin))[0];
    const taught = (await fetchSounds()).sounds.find((s: { name: string }) => s.name === "Boreal owl");
    await page.getByRole("link", { name: "Teach a new sound" }).click();
    await page.getByLabel("Name").fill("Boreal owl");
    const retaught = teachingSet("teach-b");
    await page.getByLabel("Recordings").setInputFiles(retaught.map(asFile));
    for (const clip of retaught) {
      await expect(clipRow(page, path.basename(clip))).toContainText("Ready", { timeout: 60_000 });
    }
    await page.getByRole("button", { name: "Teach" }).click();
    await expect(page).toHaveURL(`${origin}/dashboard/sounds/`, { timeout: 60_000 });
    await expect(owl).toBeChecked();
    await expect(page.getByRole("switch", { name: "Boreal owl" })).toHaveCount(1);
    const replaced = await fetchSounds();
    expect(replaced.version).toBe(after.version + 1);
    const newOwl = replaced.sounds.find((s: { name: string }) => s.name === "Boreal owl");
    expect(newOwl.id).toBe(taught.id);
    expect(newOwl.weights).toHaveLength(960);
    expect(newOwl.weights).not.toEqual(taught.weights);
    expect(replaced.sounds).toHaveLength(after.sounds.length);

    // Seeded sounds have no Delete; the service refuses one anyway.
    const chainsaw = before.sounds.find((s: { name: string }) => s.name === "Chainsaw");
    await expect(page.getByRole("button", { name: "Delete Chainsaw" })).toHaveCount(0);
    expect((await page.request.delete(`${origin}/dashboard/api/sounds/${chainsaw.id}`)).status()).toBe(409);

    // Deleting asks first, naming the sound. A delete that fails says so and keeps the sound.
    const owlRow = page.getByRole("listitem").filter({ has: owl });
    const confirm = page.getByRole("dialog", { name: "Delete Boreal owl?" });
    await page.getByRole("button", { name: "Delete Boreal owl" }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await page.route(`${origin}/dashboard/api/sounds/*`, (route) =>
      route.request().method() === "DELETE" ? route.fulfill({ status: 500, body: "{}" }) : route.continue());
    await page.getByRole("button", { name: "Delete Boreal owl" }).click();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(owlRow).toContainText("Couldn't delete, try again");
    await expect(owl).toBeVisible();
    await page.unroute(`${origin}/dashboard/api/sounds/*`);
    expect((await (await page.request.get(`${origin}/dashboard/api/sounds`)).json()).version).toBe(replaced.version);

    // Deleted, it leaves both lists, and the sensor's next check-in fetches a list without it.
    await page.getByRole("button", { name: "Delete Boreal owl" }).click();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(owl).toHaveCount(0);
    await expect(sounds.getByRole("switch", { name: "Boreal owl", exact: true })).toHaveCount(0, { timeout: 5000 });
    const deleted = await (await page.request.get(`${origin}/dashboard/api/sounds`)).json();
    expect(deleted.version).toBe(replaced.version + 1);
    expect(deleted.sounds).toHaveLength(before.sounds.length);
    const checkin = await replay({ sensorId: borealSensor, wavs: [silentWav()], stateDir: borealState, serverUrl: origin });
    expect(fetchedList(checkin, deleted.version)).not.toContain("Boreal owl");

    // A boreal owl now adds nothing; an event for it sent anyway is answered as dropped; earlier rows stay.
    const unheard = await replay({
      sensorId: borealSensor, wavs: [playerSample("boreal-owl-1.wav")], stateDir: borealState, serverUrl: origin,
    });
    expect(unheard).toContain("0 event(s) still queued");
    const late = await page.request.post(`${origin}/api/v1/sensors/${borealSensor}/events`, {
      headers: { Authorization: `Bearer ${devVars().DEVICE_KEY}` },
      data: { sent_at: new Date().toISOString(), events: [
        { event_id: "late-owl", detected_at: new Date().toISOString(), sound_id: taught.id, confidence: 0.9 },
      ] },
    });
    expect((await late.json()).results).toEqual([{ event_id: "late-owl", status: "dropped" }]);
    await log.reload();
    await expect(borealRows.first()).toBeVisible();
    await log.waitForTimeout(2500); // one more poll of the log
    await expect(borealRows).toHaveCount(heardRows);
  } finally {
    await service.stop();
  }
});
