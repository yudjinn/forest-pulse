// Calibration journeys: simulated sensors (the sensor library with its simulated hooks, several instances in one
// process sharing one simulated room, calibration_sensors.py) take part in runs a researcher starts from the plan.
// Every journey here starts its own fresh service on the calibration pair, so they run one after another.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import { devVars, signIn } from "../fixtures/dashboard.ts";
import { asSensor, referenceClip, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { calibrationServicePorts, webRoot } from "../ports.ts";

test.describe.configure({ mode: "serial" });

const python = path.join(webRoot, "..", ".venv", "bin", "python");

const card = (page: Page, id: string) =>
  page.getByRole("list", { name: "Sensors" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: id }) });
const position = (page: Page, id: string) => card(page, id).getByText(/^x -?\d+\.\d m, y -?\d+\.\d m$/);
const measured = (page: Page) => page.getByRole("img", { name: /^Measured \d+\.\d\d m from / });
const facing = (page: Page, id: string) => card(page, id).getByLabel("Facing");
const locations = (page: Page) => page.getByRole("img", { name: /^Location, / });
// How far apart two directions are, degrees.
const offBy = (deg: number, truth: number) => Math.abs((((deg - truth) % 360) + 540) % 360 - 180);

// The simulated sensors' process: add and change boards by command; each command waits for its answer.
class SimulatedSensors {
  private readonly proc: ChildProcess;
  private readonly lines: Interface;
  readonly log: string;

  constructor(origin: string) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fp-calibration-"));
    this.log = path.join(dir, "sensors.log");
    this.proc = spawn(python, [path.join(webRoot, "tests", "e2e", "calibration_sensors.py"), origin,
      devVars().DEVICE_KEY, dir], { stdio: ["pipe", "pipe", openSync(this.log, "w")] });
    this.lines = createInterface({ input: this.proc.stdout! });
  }

  send(command: Record<string, unknown>): Promise<void> {
    const answer = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(command)}; see ${this.log}`)), 60_000);
      this.lines.once("line", (line) => {
        clearTimeout(timer);
        if (line === "ok") resolve();
        else reject(new Error(`${line} (log: ${this.log})`));
      });
    });
    this.proc.stdin!.write(JSON.stringify(command) + "\n");
    return answer;
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise((r) => this.proc.once("exit", r));
    await this.send({ stop: true }).catch(() => this.proc.kill());
    await exited;
  }
}

test("two sensors measure their distance and facings and appear as they stand; a failed run names the board or pair and changes nothing", async ({ browser }) => {
  test.setTimeout(300_000);
  const service = new SecondService(calibrationServicePorts);
  await service.start();
  const origin = service.url;
  const sensors = new SimulatedSensors(origin);
  try {
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();
    await signIn(page, "/dashboard/", origin);
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
    await expect(page.getByText(`Calibration failed: ${b} its beep wasn't heard`)).toBeVisible({ timeout: 40_000 });
    await asPlaced();

    // With its buzzer working, its stream starting 5 s late and its bearing code unable to tell where a sound came
    // from, the next run shows the boards getting ready and beeping, then fails naming the pair: the plan is as it
    // was.
    await sensors.send({ set: { id: b, muted: false, stream_delay_s: 5, bearing: "none" } });
    await expect(calibrate).toBeEnabled();
    await calibrate.click();
    await expect(page.getByText("Waiting for boards (1 of 2 ready)")).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("Waiting for boards (2 of 2 ready)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Beeping", { exact: true })).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(`Calibration failed: couldn't tell direction between ${a} and ${b}`))
      .toBeVisible({ timeout: 40_000 });
    await asPlaced();

    // With its bearing working, the next run places b straight to the right of a at the measured distance and turns
    // both the way they really face.
    await sensors.send({ set: { id: b, stream_delay_s: 0, bearing: "simulated" } });
    await expect(calibrate).toBeEnabled();
    await calibrate.click();
    await expect(page.getByText(/^Calibrated \d\d:\d\d$/)).toBeVisible({ timeout: 40_000 });
    await expect(measured(page)).toHaveCount(1);
    const label = (await measured(page).getAttribute("aria-label"))!;
    const [, metres] = label.match(/^Measured (\d+\.\d\d) m from /)!;
    expect(Math.abs(Number(metres) - 3)).toBeLessThanOrEqual(0.05);
    expect(label).toBe(`Measured ${metres} m from ${a} to ${b}`);
    await expect(page.getByText(`${metres} m`, { exact: true })).toBeVisible();
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
    await expect(locations(page)).toHaveAccessibleName(new RegExp(`^Location, \\d+\\.\\d m from ${a}, \\d+\\.\\d m from ${b}$`));
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
