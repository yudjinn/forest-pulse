// Player journey: a presenter's phone loops one demo sample at a time, each with its credit, and every chainsaw
// sample is still caught by the seeded chainsaw detector that never trained on it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { showPlayer, signIn } from "../fixtures/dashboard.ts";
import { replay, uniqueSensorId } from "../fixtures/sensor.ts";
import { webRoot } from "../ports.ts";

const bucket = path.join(webRoot, "bucket", "player");
const samples: { id: string; name: string; kind: string; file: string; seconds: number;
  credit: { recordist: string | null; source: string; licence: string } }[] =
  JSON.parse(readFileSync(path.join(bucket, "samples.json"), "utf8")).samples;
const byKind = (kind: string) => samples.filter((s) => s.kind === kind);

test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

const sampleButton = (page: Page, name: string) => page.getByRole("button", { name });
const sampleRow = (page: Page, name: string) => page.getByRole("listitem").filter({ has: sampleButton(page, name) });

test("a presenter's phone loops one sample at a time until it is tapped again, with credits", async ({ page }) => {
  const [chainsaw] = byKind("chainsaw");
  const [owl, otherOwl] = byKind("boreal owl");
  const [tawny] = byKind("tawny owl");
  // One recording fails to load; the rest of the player keeps working.
  await page.route(`**/dashboard/api/player/samples/${tawny.file}`, (route) => route.abort());

  // The player's old address lands on the dashboard (signed out: its sign-in); the speaker button opens the player.
  await page.goto("/dashboard/player/");
  await expect(page).toHaveURL(/\/dashboard\/signin$/);
  await signIn(page);
  const opener = page.getByRole("button", { name: "Play sounds", exact: true });
  await showPlayer(page);

  // Every sample is listed with its credit.
  for (const s of samples) {
    const row = sampleRow(page, s.name);
    await expect(row).toContainText(s.credit.source);
    await expect(row).toContainText(s.credit.licence);
    if (s.credit.recordist) await expect(row).toContainText(s.credit.recordist);
  }

  // A chainsaw plays and keeps playing past its own length: it loops instead of ending.
  await sampleButton(page, chainsaw.name).tap();
  await expect(sampleButton(page, chainsaw.name)).toHaveAttribute("aria-pressed", "true");
  await expect(sampleRow(page, chainsaw.name)).toContainText("Playing");
  await page.waitForTimeout((chainsaw.seconds + 1.5) * 1000);
  await expect(sampleButton(page, chainsaw.name)).toHaveAttribute("aria-pressed", "true");

  // An owl takes over: the chainsaw stops.
  await sampleButton(page, owl.name).tap();
  await expect(sampleButton(page, owl.name)).toHaveAttribute("aria-pressed", "true");
  await expect(sampleButton(page, chainsaw.name)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Playing")).toHaveCount(1);

  // The recording that fails to load says so; another sample still plays.
  await sampleButton(page, tawny.name).tap();
  await expect(sampleRow(page, tawny.name).getByText("Couldn't play this sample")).toBeVisible();
  await expect(sampleButton(page, tawny.name)).toHaveAttribute("aria-pressed", "false");
  await sampleButton(page, otherOwl.name).tap();
  await expect(sampleButton(page, otherOwl.name)).toHaveAttribute("aria-pressed", "true");

  // Closing the player leaves it playing; tapping the sample again silences it.
  await opener.tap();
  await expect(sampleButton(page, otherOwl.name)).toBeHidden();
  await opener.tap();
  await expect(sampleButton(page, otherOwl.name)).toHaveAttribute("aria-pressed", "true");
  await sampleButton(page, otherOwl.name).tap();
  await expect(page.getByText("Playing")).toHaveCount(0);
  await expect(sampleButton(page, otherOwl.name)).toHaveAttribute("aria-pressed", "false");
});

test("every chainsaw sample is detected by the seeded chainsaw detector", async ({ page }) => {
  await signIn(page);
  const chainsaws = byKind("chainsaw");
  expect(chainsaws.length).toBeGreaterThanOrEqual(2);
  const heard = await Promise.all(chainsaws.map(async (s) => {
    const sensorId = uniqueSensorId(`player-${s.id}`);
    const out = await replay({ sensorId, wavs: [path.join(bucket, s.file)] });
    expect(out).toContain("0 event(s) still queued");
    return { sample: s.id, sensorId };
  }));
  const res = await page.request.get("/dashboard/api/events");
  expect(res.status()).toBe(200);
  const events: { sensor_id: string; sound_name: string }[] = (await res.json()).events;
  for (const { sample, sensorId } of heard) {
    const names = events.filter((e) => e.sensor_id === sensorId).map((e) => e.sound_name);
    expect(names, sample).toContain("Chainsaw");
  }
});
