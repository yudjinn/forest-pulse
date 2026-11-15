// Calibration journeys: simulated sensors (the sensor library with its simulated hooks, several instances in one
// process sharing one simulated room, driven through calibration-sensors.ts) take part in runs a researcher starts
// from the plan.
// Every journey here starts its own fresh service on the calibration pair, so they run one after another.
import { expect, test, type Page } from "@playwright/test";
import { devVars, showDevices, signIn } from "../fixtures/dashboard.ts";
import { asSensor, referenceClip, sensorName, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { calibrationServicePorts } from "../ports.ts";
import { SimulatedSensors } from "./calibration-sensors.ts";

test.describe.configure({ mode: "serial" });

// A sensor's card, found by the sensor's own id shown beneath its name.
const card = (page: Page, id: string) =>
  page.getByRole("list", { name: "Sensors" }).getByRole("listitem").filter({ has: page.getByText(id, { exact: true }) });
const position = (page: Page, id: string) => card(page, id).getByText(/^x -?\d+\.\d m, y -?\d+\.\d m$/);
const measured = (page: Page) => page.getByRole("img", { name: /^Measured \d+\.\d\d m from / });
const facing = (page: Page, id: string) => card(page, id).getByLabel("Facing");
const locations = (page: Page) => page.getByRole("img", { name: /^Location, / });
// How far apart two directions are, degrees.
const offBy = (deg: number, truth: number) => Math.abs((((deg - truth) % 360) + 540) % 360 - 180);

test("two sensors measure their distance and facings and appear as they stand; a failed run names the board or pair and changes nothing", async ({ browser }) => {
  test.setTimeout(300_000);
  const service = new SecondService(calibrationServicePorts);
  await service.start();
  const origin = service.url;
  const sensors = new SimulatedSensors(origin, devVars().DEVICE_KEY);
  try {
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();
    await signIn(page, "/", origin);
    await showDevices(page);
    const calibrate = page.getByRole("button", { name: "Calibrate" });

    // One capable sensor, one whose library is too old to know about calibration, and one whose device app has not
    // provided every hook: nothing can be calibrated.
    const a = uniqueSensorId("cal-a");
    const old = uniqueSensorId("cal-old");
    const partial = uniqueSensorId("cal-partial");
    const b = uniqueSensorId("cal-b");
    // Boards turned 30 and 200 degrees, each buzzer beside its array square to the line between them (two-way
    // ranging measures from each buzzer to the other array).
    await sensors.send({
      add: { id: a, x_m: 0, y_m: 0, facing_deg: 30, emitter_ccw_deg: -60, clock_offset_s: 0.8, drift_ppm: 30 },
    });
    await sensors.send({ add: { id: partial, x_m: 0, y_m: -2, hooks: "incomplete" } });
    const [reply] = await asSensor(old, [{
      call: "checkin",
      fields: { instance_id: "old-library", sdk_version: "0.2.0", model: "mn10_as", sound_list_version: null, queued_events: 0 },
    }], devVars().DEVICE_KEY, origin);
    expect(reply.calibration).toBeUndefined();
    for (const id of [a, old, partial]) {
      await expect(card(page, id).getByText("Online", { exact: true })).toBeVisible({ timeout: 5000 });
    }
    await page.waitForTimeout(2500); // one more poll of the calibration state
    await expect(calibrate).toBeDisabled();

    // A second capable sensor 3 m to the right of the first, each turned its own way, with its own clock and a
    // buzzer that makes no sound: Calibrate is enabled.
    await sensors.send({
      add: { id: b, x_m: 3, y_m: 0, facing_deg: 200, emitter_ccw_deg: 110, clock_offset_s: -1.3, drift_ppm: -20,
        emitter_offset_m: 0.07, muted: true },
    });
    await expect(calibrate).toBeEnabled({ timeout: 5000 });
    // Calibration names the sensors as the plan does.
    const nameA = await sensorName(page.request, a);
    const nameB = await sensorName(page.request, b);

    // The researcher has placed both by hand, elsewhere and turned other ways.
    for (const [id, x_m, y_m, facing_deg] of [[a, -1, 1, 45], [b, 1, 2, 135]] as const) {
      const placed = await page.request.patch(`/dashboard/api/sensors/${encodeURIComponent(id)}`,
        { data: { x_m, y_m, facing_deg } });
      expect(placed.ok()).toBe(true);
    }
    const asPlaced = async () => {
      await expect(position(page, a)).toHaveText("x -1.0 m, y 1.0 m", { timeout: 3000 });
      await expect(position(page, b)).toHaveText("x 1.0 m, y 2.0 m", { timeout: 3000 });
      await expect(facing(page, a)).toHaveValue("45");
      await expect(facing(page, b)).toHaveValue("135");
      await expect(measured(page)).toHaveCount(0);
    };
    await asPlaced();

    // The run fails: b never hears its own beep. The failure names it, and the plan is as it was.
    await calibrate.click();
    await expect(page.getByText(/^Waiting for boards \(\d of 2 ready\)$/)).toBeVisible({ timeout: 5000 });
    await expect(calibrate).toBeDisabled();
    await expect(page.getByText(`Calibration failed: ${nameB} its beep wasn't heard`)).toBeVisible({ timeout: 40_000 });
    await asPlaced();

    // With its buzzer working, its stream starting 5 s late and its bearing code unable to tell where a sound came
    // from, the next run shows the boards getting ready and beeping, then calibrates the distance only: a stays
    // where it was placed, b moves to the measured distance along the line from a to where b was placed, and both
    // keep the facings set by hand.
    await sensors.send({ set: { id: b, muted: false, stream_delay_s: 5, bearing: "none" } });
    await expect(calibrate).toBeEnabled();
    await calibrate.click();
    await expect(page.getByText("Waiting for boards (1 of 2 ready)")).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("Waiting for boards (2 of 2 ready)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Beeping", { exact: true })).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/^Calibrated \d\d:\d\d$/)).toBeVisible({ timeout: 40_000 });
    await expect(measured(page)).toHaveCount(1);
    const [, only] = (await measured(page).getAttribute("aria-label"))!.match(/^Measured (\d+\.\d\d) m from /)!;
    expect(Math.abs(Number(only) - 3)).toBeLessThanOrEqual(0.05);
    await expect(position(page, a)).toHaveText("x -1.0 m, y 1.0 m", { timeout: 3000 });
    // along (2, 1) from a, the direction to where b was placed
    const along = (from: number, k: number) => (from + k * Number(only) / Math.sqrt(5)).toFixed(1);
    await expect(position(page, b)).toHaveText(`x ${along(-1, 2)} m, y ${along(1, 1)} m`);
    await expect(facing(page, a)).toHaveValue("45");
    await expect(facing(page, b)).toHaveValue("135");

    // With its bearing working, the next run, chosen quiet, places b straight to the right of a at the measured
    // distance and turns both the way they really face.
    await sensors.send({ set: { id: b, stream_delay_s: 0, bearing: "simulated" } });
    await expect(calibrate).toBeEnabled();
    await page.getByLabel("Calibration volume").selectOption("Quiet");
    await calibrate.click();
    await expect(page.getByText("Beeping", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Calibrated \d\d:\d\d$/)).toBeVisible({ timeout: 40_000 });
    await expect(measured(page)).toHaveCount(1);
    const label = (await measured(page).getAttribute("aria-label"))!;
    const [, metres] = label.match(/^Measured (\d+\.\d\d) m from /)!;
    expect(Math.abs(Number(metres) - 3)).toBeLessThanOrEqual(0.05);
    expect(label).toBe(`Measured ${metres} m from ${nameA} to ${nameB}`);
    await expect(page.getByText(`${metres} m`, { exact: true })).toBeVisible();
    const run = (await (await page.request.get("/dashboard/api/calibration")).json()).run as { volume: string };
    expect(run.volume).toBe("quiet");
    await expect(position(page, a)).toHaveText("x 0.0 m, y 0.0 m", { timeout: 3000 });
    await expect(position(page, b)).toHaveText(`x ${Number(metres).toFixed(1)} m, y 0.0 m`);
    for (const [id, truth] of [[a, 30], [b, 200]] as const) {
      await expect(facing(page, id)).not.toHaveValue(id === a ? "45" : "135");
      const deg = Number(await facing(page, id).inputValue());
      expect(offBy(deg, truth), `${id} faces ${deg}`).toBeLessThanOrEqual(5);
    }

    // A chainsaw at (1, 2) that both hear, each reporting the direction it really heard it from, appears where it
    // was.
    await sensors.send({ hear: { ids: [a, b], wav: referenceClip("chainsaw.wav"), x_m: 1, y_m: 2 } });
    await expect(locations(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(locations(page)).toHaveAccessibleName(new RegExp(`^Location, \\d+\\.\\d m from ${nameA}, \\d+\\.\\d m from ${nameB}$`));
    const { points } = await (await page.request.get("/dashboard/api/locations")).json() as
      { points: { x_m: number; y_m: number }[] };
    expect(points).toHaveLength(1);
    expect(Math.hypot(points[0].x_m - 1, points[0].y_m - 2), JSON.stringify(points[0])).toBeLessThanOrEqual(0.3);

    // Turning a by hand makes the layout manual again.
    await facing(page, a).fill("80");
    await facing(page, a).press("Enter");
    await expect(page.getByText(/^Calibrated \d\d:\d\d$/)).toBeHidden({ timeout: 5000 });
    await expect(measured(page)).toHaveCount(0);
    await context.close();
  } finally {
    await sensors.stop();
    await service.stop();
  }
});

test("three sensors calibrate into a triangle on the side of the line they stand; a third board that never gets ready is left out", async ({ browser }) => {
  test.setTimeout(300_000);
  const service = new SecondService(calibrationServicePorts);
  await service.start();
  const origin = service.url;
  const sensors = new SimulatedSensors(origin, devVars().DEVICE_KEY);
  try {
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();
    await signIn(page, "/", origin);
    await showDevices(page);
    const calibrate = page.getByRole("button", { name: "Calibrate" });

    // Sides of 3 m (a-b), 2.5 m (a-c) and 2 m (b-c), c above the line from a to b, each board turned its own way with
    // its own clock. No buzzer can sit square to both of its board's sides, so two-way ranging is off by up to the
    // buzzers' offsets; they are 2 cm from their arrays here, well inside the 10 cm the layout must keep.
    const [a, b, c] = ["tri-a", "tri-b", "tri-c"].map(uniqueSensorId);
    const cY = Math.sqrt(2.5 ** 2 - 1.875 ** 2);
    const truth: Record<string, { x: number; y: number; facing: number }> = {
      [a]: { x: 0, y: 0, facing: 30 }, [b]: { x: 3, y: 0, facing: 200 }, [c]: { x: 1.875, y: cY, facing: 120 },
    };
    const boards = [
      { id: a, emitter_ccw_deg: 45, clock_offset_s: 0.4, drift_ppm: 15 },
      { id: b, emitter_ccw_deg: 160, clock_offset_s: -0.9, drift_ppm: -25 },
      { id: c, emitter_ccw_deg: 280, clock_offset_s: 1.6, drift_ppm: 10 },
    ];
    for (const { id, ...board } of boards) {
      const t = truth[id];
      await sensors.send({ add: { id, x_m: t.x, y_m: t.y, facing_deg: t.facing, emitter_offset_m: 0.02, ...board } });
    }
    for (const id of [a, b, c]) {
      await expect(card(page, id).getByText("Online", { exact: true })).toBeVisible({ timeout: 5000 });
    }
    // The researcher has placed them by hand, nowhere near where they stand.
    for (const [id, x_m, y_m] of [[a, -2, 2], [b, -1, 2], [c, 0, 2]] as const) {
      const placed = await page.request.patch(`/dashboard/api/sensors/${encodeURIComponent(id)}`,
        { data: { x_m, y_m, facing_deg: 0 } });
      expect(placed.ok()).toBe(true);
    }
    await expect(position(page, c)).toHaveText("x 0.0 m, y 2.0 m", { timeout: 3000 });
    // Calibration names the sensors as the plan does.
    const names: Record<string, string> = {};
    for (const id of [a, b, c]) names[id] = await sensorName(page.request, id);

    // What the plan holds for a sensor: its card's position and facing, and the plan feed's exact coordinates behind
    // the card's rounded ones.
    const onPlan = async (id: string) => {
      const { sensors: plan } = await (await page.request.get("/dashboard/api/sensors")).json() as
        { sensors: { id: string; x_m: number; y_m: number; facing_deg: number }[] };
      const s = plan.find((p) => p.id === id)!;
      await expect(position(page, id)).toHaveText(`x ${s.x_m.toFixed(1)} m, y ${s.y_m.toFixed(1)} m`, { timeout: 3000 });
      return { x: s.x_m, y: s.y_m, facing: Number(await facing(page, id).inputValue()) };
    };
    const asTheyStand = async (ids: string[]) => {
      for (const id of ids) {
        const t = truth[id];
        const s = await onPlan(id);
        expect(Math.hypot(s.x - t.x, s.y - t.y), `${id} at ${s.x}, ${s.y}`).toBeLessThanOrEqual(0.1);
        expect(offBy(s.facing, t.facing), `${id} faces ${s.facing}`).toBeLessThanOrEqual(5);
      }
    };
    const sidesDrawn = async (pairs: [string, string][]) => {
      await expect(measured(page)).toHaveCount(pairs.length);
      for (const [p, q] of pairs) {
        const side = page.getByRole("img", { name: new RegExp(`^Measured \\d+\\.\\d\\d m from ${names[p]} to ${names[q]}$`) });
        const [, metres] = (await side.getAttribute("aria-label"))!.match(/^Measured (\d+\.\d\d) m/)!;
        const length = Math.hypot(truth[q].x - truth[p].x, truth[q].y - truth[p].y);
        expect(Math.abs(Number(metres) - length), `${p} to ${q}`).toBeLessThanOrEqual(0.05);
        await expect(side.getByText(`${metres} m`, { exact: true })).toBeVisible();
      }
    };
    const run = async (done: RegExp | string) => {
      await expect(calibrate).toBeEnabled({ timeout: 5000 });
      await calibrate.click();
      await expect(page.getByText("Beeping", { exact: true })).toBeVisible({ timeout: 40_000 });
      await expect(page.getByText(done)).toBeVisible({ timeout: 40_000 });
    };

    // The run places all three where they stand, c above the line, and draws the three measured sides.
    await run(/^Calibrated \d\d:\d\d$/);
    await sidesDrawn([[a, b], [a, c], [b, c]]);
    await asTheyStand([a, b, c]);
    expect((await onPlan(c)).y).toBeGreaterThan(0);

    // With c moved to the other side of the line, the same distances, the next run puts it below the line.
    truth[c] = { ...truth[c], y: -cY };
    await sensors.send({ set: { id: c, y_m: -cY } });
    await run(/^Calibrated \d\d:\d\d$/);
    await sidesDrawn([[a, b], [a, c], [b, c]]);
    await asTheyStand([a, b, c]);
    expect((await onPlan(c)).y).toBeLessThan(0);

    // With no board able to tell direction (single-mic boards) and facings typed by hand, the run measures the three
    // distances only: a stays, b moves along the line to where it was, c keeps its side of the line, and every board
    // keeps its typed facing.
    const typed: Record<string, number> = { [a]: 10, [b]: 20, [c]: 30 };
    for (const id of [a, b, c]) {
      await facing(page, id).fill(String(typed[id]));
      await facing(page, id).press("Enter");
      await expect(facing(page, id)).toHaveValue(String(typed[id]));
      await sensors.send({ set: { id, bearing: "none" } });
    }
    await expect(page.getByText(/^Calibrated/)).toHaveCount(0, { timeout: 5000 });
    await run(/^Calibrated \d\d:\d\d$/);
    await sidesDrawn([[a, b], [a, c], [b, c]]);
    for (const id of [a, b, c]) {
      const s = await onPlan(id);
      expect(Math.hypot(s.x - truth[id].x, s.y - truth[id].y), `${id} at ${s.x}, ${s.y}`).toBeLessThanOrEqual(0.1);
      expect(s.facing).toBe(typed[id]);
    }
    for (const id of [a, b, c]) await sensors.send({ set: { id, bearing: "simulated" } });

    // c's audio never starts: it reports no stream before it is ever ready, so it is left out as soon as a and b are
    // ready, and the run goes ahead with them, solved as a pair; c stays where it was.
    const cStill = await onPlan(c);
    await sensors.send({ set: { id: c, stream_delay_s: 60 } });
    await expect(calibrate).toBeEnabled({ timeout: 5000 });
    await calibrate.click();
    await expect(page.getByText(new RegExp(`^Calibrated \\d\\d:\\d\\d, ${names[c]} left out$`))).toBeVisible({ timeout: 60_000 });
    await sidesDrawn([[a, b]]);
    expect(await onPlan(c)).toEqual(cStill);
    await sensors.send({ set: { id: c, stream_delay_s: 0 } });

    // c loses power just before the press, still shown online: it never gets ready, so the run goes ahead with a and
    // b, solved as a pair, and says c was left out; c stays where the last run put it.
    const cBefore = await onPlan(c);
    await expect(calibrate).toBeEnabled({ timeout: 5000 });
    await sensors.send({ power_off: { id: c } });
    await calibrate.click();
    await expect(page.getByText("Waiting for boards (2 of 3 ready)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(new RegExp(`^Calibrated \\d\\d:\\d\\d, ${names[c]} left out$`))).toBeVisible({ timeout: 60_000 });
    await sidesDrawn([[a, b]]);
    await asTheyStand([a, b]);
    expect(await onPlan(c)).toEqual(cBefore);
    await context.close();
  } finally {
    await sensors.stop();
    await service.stop();
  }
});
