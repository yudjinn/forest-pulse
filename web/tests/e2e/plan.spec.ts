// Sensor plan journey: sensors join the plan when they first check in, researchers place and turn them, and the plan
// shows each sensor's health. Runs on its own fresh service, so the first sensor here is the first one ever.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn } from "../fixtures/dashboard.ts";
import { replay, silentWav, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { planServicePorts } from "../ports.ts";

const card = (page: Page, id: string) =>
  page.getByRole("list", { name: "Sensors" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: id }) });
const POSITION = /^x -?\d+\.\d m, y -?\d+\.\d m$/;
const position = (c: Locator) => c.getByText(POSITION);

async function dragBy(page: Page, id: string, dx: number, dy: number) {
  const box = (await page.getByRole("button", { name: `Move ${id}`, exact: true }).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

test("sensors join the plan on first check-in, researchers place them, and the plan shows their health", async ({ browser }) => {
  test.setTimeout(180_000);
  const service = new SecondService(planServicePorts);
  await service.start();
  try {
    const context = await browser.newContext({ baseURL: service.url });
    const page = await context.newPage();
    await signIn(page, "/dashboard/", service.url);
    await expect(page.getByText("No sensors yet. Sensors appear here when they first check in.")).toBeVisible();

    // Two sensors check in for the first time: the first at the origin facing right, the next 3 m to its right
    // facing it.
    const silence = silentWav(1);
    const a = uniqueSensorId("plan-a");
    const b = uniqueSensorId("plan-b");
    await replay({ sensorId: a, wavs: [silence], serverUrl: service.url });
    await replay({ sensorId: b, wavs: [silence], serverUrl: service.url });
    const cardA = card(page, a);
    const cardB = card(page, b);
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
    await dragBy(page, b, -60, -40);
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
    await dragBy(page, a, 50, 30);
    await expect(page.getByText("Couldn't save, try again")).toBeVisible();
    await expect(position(cardA)).toHaveText("x 0.0 m, y 0.0 m");
    await page.unroute("**/dashboard/api/sensors/*");

    // The placement survives a reload.
    await page.reload();
    await expect(position(cardB)).toHaveText(moved);
    await expect(cardA.getByLabel("Facing")).toHaveValue("330");
    await expect(position(cardA)).toHaveText("x 0.0 m, y 0.0 m");
    await expect(page.getByText("Couldn't save, try again")).toBeHidden();

    // Removing b takes it off the plan, for the other researcher too; its next check-in brings it back where it was.
    await cardB.getByRole("button", { name: `Remove ${b}` }).click();
    await expect(cardB).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Move ${b}`, exact: true })).toHaveCount(0);
    await expect(card(other, b)).toHaveCount(0, { timeout: 3000 });
    await replay({ sensorId: b, wavs: [silence], serverUrl: service.url });
    await expect(position(cardB)).toHaveText(moved, { timeout: 3000 });
    await expect(cardB.getByLabel("Facing")).toHaveValue("270");

    // Two running devices under one name: the sensor warns that its name is shared.
    // c's two runs share one state folder, so the second starts with the sound list the first fetched and its first
    // check-in reports that list's version.
    const c = uniqueSensorId("plan-c");
    const cState = path.join(mkdtempSync(path.join(os.tmpdir(), "fp-plan-c-")), "state");
    await replay({ sensorId: c, wavs: [silence], serverUrl: service.url, stateDir: cState });
    await expect(card(page, c)).toHaveCount(1, { timeout: 3000 });
    await expect(card(page, c).getByText("Two devices share this name")).toBeHidden();
    await replay({ sensorId: c, wavs: [silence], serverUrl: service.url, stateDir: cState });
    await expect(card(page, c).getByText("Two devices share this name")).toBeVisible({ timeout: 3000 });
    await expect(card(page, c).getByText(/^Library \d+\.\d+\.\d+, model mn10_as, sound list \d+$/)).toBeVisible();
    await expect(cardA.getByText("Two devices share this name")).toBeHidden();

    // a stopped checking in long ago and shows offline; c just checked in and is online.
    await expect(cardA.getByText("Offline", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card(page, c).getByText("Online", { exact: true })).toBeVisible();

    // c has stopped too: it shows offline 10 s after its last check-in, give or take the plan's 2 s poll.
    const plan = await (await page.request.get("/dashboard/api/sensors")).json();
    const cLastCheckin = Date.parse(plan.sensors.find((s: { id: string }) => s.id === c).last_checkin_at);
    await expect(card(page, c).getByText("Offline", { exact: true })).toBeVisible({ timeout: 20_000 });
    const silentFor = Date.now() - cLastCheckin;
    expect(silentFor).toBeGreaterThanOrEqual(10_000);
    expect(silentFor).toBeLessThan(15_000);

    // A new sensor after one was removed takes its default spot from the last sensor still on the plan: c is
    // removed, so d goes 3 m to the right of b, not of c.
    await card(page, c).getByRole("button", { name: `Remove ${c}` }).click();
    await expect(card(page, c)).toHaveCount(0);
    const d = uniqueSensorId("plan-d");
    await replay({ sensorId: d, wavs: [silence], serverUrl: service.url });
    await expect(position(card(page, d))).toHaveText(`x ${(mx + 3).toFixed(1)} m, y ${my.toFixed(1)} m`, { timeout: 3000 });
    await expect(card(page, d).getByLabel("Facing")).toHaveValue("270");
    await context.close();
  } finally {
    await service.stop();
  }
});
