// Sensor plan journey: sensors join the plan when they first check in and are named Sensor 1, 2, 3, researchers
// place and turn them, the plan shows each sensor's health and flags sensors behind on the sound list, and removing
// and returning sensors frees and reuses their numbers. Runs on its own fresh service, so the first sensor here is
// the first one ever, and changing its sound list touches no other journey.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn } from "../fixtures/dashboard.ts";
import { asSensor, referenceClip, replay, silentWav, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { planServicePorts } from "../ports.ts";

const sensorList = (page: Page) => page.getByRole("list", { name: "Sensors" });
// A sensor's card, found by the sensor's own id shown beneath its name.
const card = (page: Page, id: string) =>
  sensorList(page).getByRole("listitem").filter({ has: page.getByText(id, { exact: true }) });
// A sensor's marker: "Move Sensor N", with ", outdated sound list" after it while the sensor is outdated.
const marker = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^Move ${name}(, outdated sound list)?$`) });
// The event log's rows whose sensor column reads exactly this.
const logRows = (page: Page, sensor: string) =>
  page.getByRole("row").filter({ has: page.getByRole("cell", { name: sensor, exact: true }) });
const POSITION = /^x -?\d+\.\d m, y -?\d+\.\d m$/;
const position = (c: Locator) => c.getByText(POSITION);
// The sensor's last check-in as the service recorded it, in ms since the epoch.
async function lastCheckin(page: Page, id: string): Promise<number> {
  const plan = await (await page.request.get("/dashboard/api/sensors")).json();
  return Date.parse(plan.sensors.find((s: { id: string }) => s.id === id).last_checkin_at);
}

async function dragBy(page: Page, name: string, dx: number, dy: number) {
  const box = (await marker(page, name).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

test("sensors join the plan on first check-in, researchers place them, and the plan shows their health", async ({ browser }) => {
  test.setTimeout(240_000);
  const service = new SecondService(planServicePorts);
  await service.start();
  try {
    const context = await browser.newContext({ baseURL: service.url });
    const page = await context.newPage();
    await signIn(page, "/dashboard/", service.url);
    await expect(page.getByText("No sensors yet. Sensors appear here when they first check in.")).toBeVisible();

    // Two sensors check in for the first time: Sensor 1 at the origin facing right, Sensor 2 3 m to its right facing
    // it. Sensor 2 hears a chainsaw: the event log and its Logging activity name it Sensor 2.
    const silence = silentWav(1);
    const a = uniqueSensorId("plan-a");
    const b = uniqueSensorId("plan-b");
    await replay({ sensorId: a, wavs: [silence], serverUrl: service.url });
    await replay({ sensorId: b, wavs: [referenceClip("chainsaw.wav")], serverUrl: service.url });
    const cardA = card(page, a);
    const cardB = card(page, b);
    await expect(cardA.getByRole("heading")).toHaveText("Sensor 1", { timeout: 3000 });
    await expect(cardB.getByRole("heading")).toHaveText("Sensor 2");
    await expect(logRows(page, "Sensor 2").first()).toContainText("Chainsaw", { timeout: 3000 });
    const logging = page.getByRole("list", { name: "Activities" }).getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: "Logging", exact: true }) });
    await expect(logging.getByText("Sensor 2", { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(position(cardA)).toHaveText("x 0.0 m, y 0.0 m", { timeout: 3000 });
    await expect(cardA.getByLabel("Facing")).toHaveValue("90");
    await expect(position(cardB)).toHaveText("x 3.0 m, y 0.0 m", { timeout: 3000 });
    await expect(cardB.getByLabel("Facing")).toHaveValue("270");
    await expect(page.getByText("No sensors yet. Sensors appear here when they first check in.")).toBeHidden();

    // Each card shows the sensor's health: online, its last check-in and its versions. A sensor that stopped before
    // checking in with a sound list has none to report yet; the sound-list version is proven on c below. b checked
    // in last, so it is still online here however long the replays took.
    await expect(cardB.getByText("Online", { exact: true })).toBeVisible();
    await expect(cardB.getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeVisible();
    await expect(cardB.getByText(/^Library \d+\.\d+\.\d+, model mn10_as, sound list (\d+|unknown)$/)).toBeVisible();

    // A second researcher watches the same plan.
    const other = await context.newPage();
    await other.goto("/dashboard/");
    await expect(position(card(other, b))).toHaveText("x 3.0 m, y 0.0 m", { timeout: 3000 });

    // Drag b up and to the left; type a facing past the range into a, which is normalised.
    await dragBy(page, "Sensor 2", -60, -40);
    await expect(position(cardB)).not.toHaveText("x 3.0 m, y 0.0 m");
    const moved = (await position(cardB).textContent())!;
    const [, mx, my] = moved.match(/^x (-?[\d.]+) m, y (-?[\d.]+) m$/)!.map(Number);
    expect(mx).toBeLessThan(3);
    expect(my).toBeGreaterThan(0);
    await cardA.getByLabel("Facing").fill("-30");
    await cardA.getByLabel("Facing").press("Enter");
    await expect(cardA.getByLabel("Facing")).toHaveValue("330");

    // The other dashboard follows within about 2 s.
    await expect(position(card(other, b))).toHaveText(moved, { timeout: 3000 });
    await expect(card(other, a).getByLabel("Facing")).toHaveValue("330", { timeout: 3000 });

    // A save that fails says so and leaves the sensor where it was.
    await page.route("**/dashboard/api/sensors/*", (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 503 }) : route.fallback());
    await dragBy(page, "Sensor 1", 50, 30);
    await expect(page.getByText("Couldn't save, try again")).toBeVisible();
    await expect(position(cardA)).toHaveText("x 0.0 m, y 0.0 m");
    await page.unroute("**/dashboard/api/sensors/*");

    // The placement survives a reload.
    await page.reload();
    await expect(position(cardB)).toHaveText(moved);
    await expect(cardA.getByLabel("Facing")).toHaveValue("330");
    await expect(position(cardA)).toHaveText("x 0.0 m, y 0.0 m");
    await expect(page.getByText("Couldn't save, try again")).toBeHidden();

    // Removing b takes it off the plan, for the other researcher too; its next check-in brings it back where it was,
    // still Sensor 2 because no other sensor took that number meanwhile.
    await cardB.getByRole("button", { name: "Remove Sensor 2" }).click();
    await expect(cardB).toHaveCount(0);
    await expect(marker(page, "Sensor 2")).toHaveCount(0);
    await expect(card(other, b)).toHaveCount(0, { timeout: 3000 });
    await replay({ sensorId: b, wavs: [silence], serverUrl: service.url });
    await expect(position(cardB)).toHaveText(moved, { timeout: 3000 });
    await expect(cardB.getByLabel("Facing")).toHaveValue("270");
    await expect(cardB.getByRole("heading")).toHaveText("Sensor 2");

    // Two running devices under one name: the sensor warns that its name is shared.
    // c's two runs share one state folder, so the second starts with the sound list the first fetched and its first
    // check-in reports that list's version. The warning needs both runs inside the 10 s shared-name window, so a
    // failure says how far apart they checked in.
    const c = uniqueSensorId("plan-c");
    const cState = path.join(mkdtempSync(path.join(os.tmpdir(), "fp-plan-c-")), "state");
    await replay({ sensorId: c, wavs: [silence], serverUrl: service.url, stateDir: cState });
    await expect(card(page, c)).toHaveCount(1, { timeout: 3000 });
    await expect(card(page, c).getByText("Two devices share this id")).toBeHidden();

    // Three sensors on the plan: the cards read Sensor 1 to Sensor 3 in order, each with its own id beneath and a
    // marker of the same name.
    await expect(sensorList(page).getByRole("heading")).toHaveText(["Sensor 1", "Sensor 2", "Sensor 3"]);
    await expect(sensorList(page).getByRole("listitem")).toContainText([a, b, c]);
    for (const [id, name] of [[a, "Sensor 1"], [b, "Sensor 2"], [c, "Sensor 3"]]) {
      await expect(card(page, id).getByRole("heading")).toHaveText(name);
      await expect(marker(page, name)).toHaveText(name);
    }
    const firstRunCheckin = await lastCheckin(page, c);
    await replay({ sensorId: c, wavs: [silence], serverUrl: service.url, stateDir: cState });
    const runsApart = (await lastCheckin(page, c)) - firstRunCheckin;
    await expect(card(page, c).getByText("Two devices share this id"),
      `c's runs last checked in ${runsApart} ms apart; the shared-name window is 10 s`).toBeVisible({ timeout: 3000 });
    await expect(card(page, c).getByText(/^Library \d+\.\d+\.\d+, model mn10_as, sound list \d+$/)).toBeVisible();
    await expect(cardA.getByText("Two devices share this id")).toBeHidden();

    // a stopped checking in long ago and shows offline; c just checked in and is online, with the current sound list.
    await expect(cardA.getByText("Offline", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card(page, c).getByText("Online", { exact: true })).toBeVisible();
    await expect(card(page, c).getByText("Updating", { exact: true })).toBeHidden();
    await expect(card(page, c).getByText("Outdated sound list")).toBeHidden();
    await expect(marker(page, "Sensor 3")).toHaveAccessibleName("Move Sensor 3");

    // The sound list changes (a switch; the Sounds page's own switch is the sounds journey's). c last reported the
    // old list and is still online: it is updating.
    const old: number = (await (await page.request.get("/dashboard/api/sounds")).json()).version;
    expect((await page.request.patch("/dashboard/api/sounds/gunshot", { data: { enabled: false } })).ok()).toBe(true);
    await expect(card(page, c).getByText("Updating", { exact: true })).toBeVisible({ timeout: 3000 });

    // c has stopped too: it shows offline 10 s after its last check-in, give or take the plan's 2 s poll.
    const cLastCheckin = await lastCheckin(page, c);
    await expect(card(page, c).getByText("Offline", { exact: true })).toBeVisible({ timeout: 20_000 });
    const silentFor = Date.now() - cLastCheckin;
    expect(silentFor).toBeGreaterThanOrEqual(10_000);
    expect(silentFor).toBeLessThan(15_000);
    // Offline while behind, c is outdated: on its card, and as a warning on its marker.
    await expect(card(page, c).getByText("Outdated sound list")).toBeVisible({ timeout: 3000 });
    await expect(card(page, c).getByText("Updating", { exact: true })).toBeHidden();
    await expect(marker(page, "Sensor 3")).toHaveAccessibleName("Move Sensor 3, outdated sound list");

    // a checks in with the current list, then three times reporting the old list without fetching the new one:
    // updating after the first and second such check-in, outdated after the third, though it is online.
    const current: number = (await (await page.request.get("/dashboard/api/sounds")).json()).version;
    expect(current).toBe(old + 1);
    await asSensor(a, [{ call: "checkin", fields: { sound_list_version: current } }], undefined, service.url);
    await expect(cardA.getByText("Online", { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(cardA.getByText("Updating", { exact: true })).toBeHidden();
    await expect(cardA.getByText("Outdated sound list")).toBeHidden();
    const behind = { call: "checkin" as const, fields: { sound_list_version: old } };
    for (const nth of ["first", "second"]) {
      await asSensor(a, [behind], undefined, service.url);
      await expect(cardA.getByText("Updating", { exact: true }), `after the ${nth} behind check-in`)
        .toBeVisible({ timeout: 3000 });
      await expect(marker(page, "Sensor 1")).toHaveAccessibleName("Move Sensor 1");
    }
    await asSensor(a, [behind], undefined, service.url);
    await expect(cardA.getByText("Outdated sound list")).toBeVisible({ timeout: 3000 });
    await expect(cardA.getByText("Online", { exact: true })).toBeVisible();
    await expect(marker(page, "Sensor 1")).toHaveAccessibleName("Move Sensor 1, outdated sound list");

    // A new sensor after one was removed takes its default spot from the last sensor still on the plan and the
    // lowest free number: c is removed, so d goes 3 m to the right of b, not of c, and is Sensor 3.
    await card(page, c).getByRole("button", { name: "Remove Sensor 3" }).click();
    await expect(card(page, c)).toHaveCount(0);
    const d = uniqueSensorId("plan-d");
    await replay({ sensorId: d, wavs: [silence], serverUrl: service.url });
    await expect(position(card(page, d))).toHaveText(`x ${(mx + 3).toFixed(1)} m, y ${my.toFixed(1)} m`, { timeout: 3000 });
    await expect(card(page, d).getByLabel("Facing")).toHaveValue("270");
    await expect(card(page, d).getByRole("heading")).toHaveText("Sensor 3");

    // Removing Sensor 2 frees its number, and its events show its own id. A new board takes the number; the removed
    // board checking in again finds it taken and becomes Sensor 4, and its events read Sensor 4.
    await cardB.getByRole("button", { name: "Remove Sensor 2" }).click();
    await expect(cardB).toHaveCount(0);
    await expect(logRows(page, b).first()).toContainText("Chainsaw", { timeout: 3000 });
    await expect(logRows(page, "Sensor 2")).toHaveCount(0);
    await expect(logging.getByText(b, { exact: true })).toBeVisible();
    const e = uniqueSensorId("plan-e");
    await replay({ sensorId: e, wavs: [silence], serverUrl: service.url });
    await expect(card(page, e).getByRole("heading")).toHaveText("Sensor 2", { timeout: 3000 });
    await replay({ sensorId: b, wavs: [silence], serverUrl: service.url });
    await expect(cardB.getByRole("heading")).toHaveText("Sensor 4", { timeout: 3000 });
    await expect(logRows(page, "Sensor 4").first()).toContainText("Chainsaw", { timeout: 3000 });
    await expect(logRows(page, b)).toHaveCount(0);

    // A sensor on the plan keeps its number: with Sensor 3 removed, the Sensor 4 board checking in again is still
    // Sensor 4. The plan lists sensors by number, not by when they joined.
    await card(page, d).getByRole("button", { name: "Remove Sensor 3" }).click();
    await expect(card(page, d)).toHaveCount(0);
    const sensor4Checkin = await lastCheckin(page, b);
    await replay({ sensorId: b, wavs: [silence], serverUrl: service.url });
    expect(await lastCheckin(page, b)).toBeGreaterThan(sensor4Checkin);
    await page.waitForTimeout(2500); // one more poll of the plan
    await expect(cardB.getByRole("heading")).toHaveText("Sensor 4");
    await expect(sensorList(page).getByRole("heading")).toHaveText(["Sensor 1", "Sensor 2", "Sensor 4"]);
    await expect(sensorList(page).getByRole("listitem")).toContainText([a, e, b]);
    await context.close();
  } finally {
    await service.stop();
  }
});
