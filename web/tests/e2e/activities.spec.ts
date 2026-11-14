// Activities journey: a researcher watches a chainsaw and a vehicle become one Logging and one Vehicle activity, a
// sensor with a clock 5 minutes behind join the right one by corrected time, then clears the rehearsal noise.
// It runs on its own fresh service: clearing removes every event, which other journeys on the shared service read.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { devVars, signIn } from "../fixtures/dashboard.ts";
import { asSensor, referenceClip, replay, sensorName, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { activitiesServicePorts, activitiesServiceStateDir, webRoot } from "../ports.ts";

const run = promisify(execFile);
const SEEDED = ["Chainsaw", "Tools", "Power tool", "Vehicle", "Engine", "Aircraft", "Gunshot"];

const activities = (page: Page) => page.getByRole("list", { name: "Activities" }).getByRole("listitem");
const activity = (page: Page, category: string) =>
  activities(page).filter({ has: page.getByRole("heading", { name: category, exact: true }) });

async function storedSensors(): Promise<string[]> {
  const { stdout } = await run(path.join(webRoot, "node_modules", ".bin", "wrangler"), [
    "d1", "execute", "DB", "--local", "--persist-to", activitiesServiceStateDir, "--json",
    "--command", "SELECT id FROM sensors ORDER BY id",
  ], { cwd: webRoot, timeout: 60_000 });
  return JSON.parse(stdout)[0].results.map((r: { id: string }) => r.id);
}

test("events become activities by category and corrected time, and Clear events removes them all", async ({ page }) => {
  test.setTimeout(240_000);
  const service = new SecondService(activitiesServicePorts);
  await service.start();
  try {
    const origin = service.url;
    await signIn(page, "/dashboard/", origin);
    await expect(page.getByText("Nothing heard yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear events" })).toBeDisabled();

    // A sensor hears a chainsaw: one Logging activity with its icon, sound, time, count and sensor, named as the
    // plan names it.
    const saw = uniqueSensorId("act-saw");
    expect(await replay({ sensorId: saw, wavs: [referenceClip("chainsaw.wav")], serverUrl: origin }))
      .toContain("0 event(s) still queued");
    const sawName = await sensorName(page.request, saw, origin);
    const logging = activity(page, "Logging");
    await expect(logging).toHaveCount(1, { timeout: 3000 });
    await expect(logging).toContainText("Chainsaw");
    await expect(logging).toContainText("1 event");
    await expect(logging.getByText(sawName, { exact: true })).toBeVisible();
    await expect(logging.getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeVisible();
    await expect(page.getByText("Nothing heard yet")).toBeHidden();

    // Within 60 s a second sensor reports a vehicle (through the library's own client): its own Vehicle activity. It
    // never checked in, so it is not on the plan and the activity names it by its id.
    const road = uniqueSensorId("act-road");
    const [posted] = await asSensor(road, [{ call: "post_events", events: [
      { event_id: "vehicle-1", detected_at: new Date().toISOString(), sound_id: "vehicle", confidence: 0.8 },
    ] }], devVars().DEVICE_KEY, origin);
    expect(posted.results).toEqual([{ event_id: "vehicle-1", status: "accepted" }]);
    const vehicle = activity(page, "Vehicle");
    await expect(vehicle).toHaveCount(1, { timeout: 3000 });
    await expect(vehicle).toContainText("Vehicle");
    await expect(vehicle).toContainText("1 event");
    await expect(vehicle.getByText(road, { exact: true })).toBeVisible();
    await expect(activities(page)).toHaveCount(2);
    for (const [card, icon] of [[logging, "logging"], [vehicle, "vehicle"]] as const) {
      await expect(card.getByTestId("activity-icon")).toHaveAttribute("src", `/dashboard/icons/${icon}.svg`);
      expect(await card.getByTestId("activity-icon").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    }

    // A sensor whose clock runs 5 minutes behind hears a chainsaw: corrected, it joins the same Logging activity
    // instead of starting one 5 minutes in the past.
    const behind = uniqueSensorId("act-behind");
    expect(await replay({ sensorId: behind, wavs: [referenceClip("chainsaw.wav")], serverUrl: origin, clockShiftS: -300 }))
      .toContain("0 event(s) still queued");
    await expect(logging).toContainText("2 events", { timeout: 3000 });
    await expect(logging.getByText(`${sawName}, ${await sensorName(page.request, behind, origin)}`, { exact: true }))
      .toBeVisible();
    await expect(logging.getByText(/^\d{2}:\d{2}:\d{2} to \d{2}:\d{2}:\d{2}$/)).toBeVisible();
    await expect(activities(page)).toHaveCount(2);

    const sounds = await page.request.get(`${origin}/dashboard/api/sounds`);
    const version: number = (await sounds.json()).version;

    // A clear that fails says so and leaves everything as it was.
    await page.route(`${origin}/dashboard/api/events`, (route) =>
      route.request().method() === "DELETE" ? route.fulfill({ status: 500, body: "{}" }) : route.continue());
    await page.getByRole("button", { name: "Clear events" }).click();
    const confirm = page.getByRole("dialog", { name: "Clear events?" });
    await expect(confirm).toContainText("Every event and activity will be removed.");
    await confirm.getByRole("button", { name: "Clear events" }).click();
    await expect(page.getByText("Couldn't clear, try again")).toBeVisible();
    await page.waitForTimeout(2500); // one more poll
    await expect(activities(page)).toHaveCount(2);
    await page.unroute(`${origin}/dashboard/api/events`);

    // Cancel keeps everything too.
    await page.getByRole("button", { name: "Clear events" }).click();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText("Couldn't clear, try again")).toBeHidden();
    await expect(activities(page)).toHaveCount(2);

    // Confirmed, every event and activity is gone; the sensors, their placements and the sounds stay as they were.
    const sawCard = page.getByRole("list", { name: "Sensors" }).getByRole("listitem")
      .filter({ has: page.getByText(saw, { exact: true }) });
    await sawCard.getByLabel("Facing").fill("45");
    await sawCard.getByLabel("Facing").press("Enter");
    await expect(sawCard.getByLabel("Facing")).toHaveValue("45");
    const sawPosition = await sawCard.getByText(/^x -?\d+\.\d m, y -?\d+\.\d m$/).textContent();
    await page.getByRole("button", { name: "Clear events" }).click();
    await confirm.getByRole("button", { name: "Clear events" }).click();
    await expect(page.getByText("Nothing heard yet")).toBeVisible();
    await expect(activities(page)).toHaveCount(0);
    await expect(page.getByText("No events yet")).toBeVisible();
    await page.waitForTimeout(2500); // one more poll
    await expect(page.getByText("Nothing heard yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear events" })).toBeDisabled();
    expect(await storedSensors()).toEqual([saw, road, behind].sort());
    await page.reload();
    await expect(sawCard.getByLabel("Facing")).toHaveValue("45");
    await expect(sawCard.getByText(/^x -?\d+\.\d m, y -?\d+\.\d m$/)).toHaveText(sawPosition!);

    await page.goto(`${origin}/dashboard/sounds/`);
    for (const name of SEEDED) await expect(page.getByRole("switch", { name, exact: true })).toBeChecked();
    expect((await (await page.request.get(`${origin}/dashboard/api/sounds`)).json()).version).toBe(version);
  } finally {
    await service.stop();
  }
});
