// Teaching journey: a researcher teaches Boreal owl from dropped recordings on the Teach page, after seeing too few
// usable recordings refused and a failed upload save nothing; the sound appears in the Sounds list, and sensors
// pull it at their next check-in: a boreal owl the detector never heard is reported, a tawny owl is not.
// It runs on its own fresh service: teaching changes the sound list for every sensor, so the shared service never
// sees it. The teaching clips are boreal owls by recordists the player's samples do not use; the replayed owls are
// the player's own samples, kept out of the other-sounds library and the teaching clips.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../fixtures/dashboard.ts";
import { replay, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { teachServicePorts, webRoot } from "../ports.ts";

const owls = path.join(webRoot, "tests", "fixtures", "owls");
const teachingSet = (name: string) =>
  readdirSync(path.join(owls, name)).filter((f) => f.endsWith(".wav")).sort().map((f) => path.join(owls, name, f));
// A recording as the browser gets it from a drop or the file picker.
const asFile = (file: string) => ({ name: path.basename(file), mimeType: "audio/wav", buffer: readFileSync(file) });
const playerSample = (file: string) => path.join(webRoot, "bucket", "player", file);

const clipRow = (page: Page, file: string) => page.getByRole("listitem").filter({ hasText: file });

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

test("a researcher teaches Boreal owl; sensors then report a new boreal owl and not a tawny owl", async ({ page, context }) => {
  test.setTimeout(240_000);
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

    // The same name again, in any case, is refused and changes nothing.
    const again = await page.request.post(`${origin}/dashboard/api/teach`, {
      headers: { "Content-Type": "application/octet-stream" }, data: teachRequest("boreal OWL", 5),
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
    const heard = await replay({ sensorId: borealSensor, wavs: [playerSample("boreal-owl-1.wav")], serverUrl: origin });
    expect(heard).toMatch(new RegExp(`sound list ${after.version}: .*Boreal owl`));
    expect(heard).toContain("0 event(s) still queued");
    const tawny = await replay({ sensorId: tawnySensor, wavs: [playerSample("tawny-owl.wav")], serverUrl: origin });
    expect(tawny).toMatch(new RegExp(`sound list ${after.version}: .*Boreal owl`));
    expect(tawny).toContain("0 event(s) still queued");
    await expect(log.getByRole("row").filter({ hasText: borealSensor }).filter({ hasText: "Boreal owl" }).first())
      .toBeVisible({ timeout: 5000 });
    await log.waitForTimeout(2500); // one more poll of the log
    await expect(log.getByRole("row").filter({ hasText: tawnySensor }).filter({ hasText: "Boreal owl" })).toHaveCount(0);
  } finally {
    await service.stop();
  }
});
