// Live rehearsal of calibration, step by step: three simulated boards (the sensor library with its simulated hooks,
// calibration-sensors.ts) check in to the live site under rehearsal names, a researcher presses Calibrate, the run
// ends Calibrated with the triangle the boards stand in, and the rehearsal then switches its boards off and removes
// them. It runs only against the live site (FP_REHEARSAL_ORIGIN, with the live sensor key and password from
// .dev-secrets.local); the local calibration journeys cover the same run on a fresh service, so without the origin it
// is skipped.
// A run takes the first three capable sensors on the plan and replaces the plan's measured layout, so the rehearsal
// refuses to start while another capable sensor is online or the plan is a measured layout: every other sensor's
// placement and the measured layout are never touched. Its boards send no sound events, so it never clears events.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sensorName, uniqueSensorId } from "../fixtures/sensor.ts";
import { SimulatedSensors } from "./calibration-sensors.ts";
import { demoStep, liveOrigin, rehearsalSecrets, signInWith } from "./rehearsal-steps.ts";

// A failed live run must not leave the live password or session in a trace.
test.use({ trace: "off" });

interface PlanSensor { id: string; x_m: number; y_m: number; facing_deg: number; online: boolean }
interface CalibrationState {
  running: boolean;
  eligible_sensors: string[];
  layout: { measured_at: number; sensors: string[]; distances: { a: string; b: string; distance_m: number }[] } | null;
}

async function read<T>(request: APIRequestContext, origin: string, what: string): Promise<T> {
  const res = await request.get(`${origin}/dashboard/api/${what}`);
  expect(res.status(), `GET /dashboard/api/${what}`).toBe(200);
  return res.json() as Promise<T>;
}

// A sensor's card, found by the sensor's own id shown beneath its name.
const card = (page: Page, id: string) => page.getByRole("list", { name: "Sensors" }).getByRole("listitem")
  .filter({ has: page.getByText(id, { exact: true }) });
const measured = (page: Page) => page.getByRole("img", { name: /^Measured \d+\.\d\d m from / });
const placement = (list: PlanSensor[]) => list.map((s) => ({ id: s.id, x_m: s.x_m, y_m: s.y_m, facing_deg: s.facing_deg }));
// How far apart two directions are, degrees.
const offBy = (deg: number, truth: number) => Math.abs((((deg - truth) % 360) + 540) % 360 - 180);

test("calibration on the live site: three rehearsal boards calibrate into their triangle and leave every other sensor as it was",
  async ({ browser }) => {
    test.skip(liveOrigin === null, "the calibration rehearsal runs only against the live site (FP_REHEARSAL_ORIGIN)");
    test.setTimeout(300_000);
    const origin = liveOrigin!;
    const seen = { timeout: 10_000 };

    // The sensors' state and log go in one folder, removed at the end unless the run failed.
    const scratch = mkdtempSync(path.join(os.tmpdir(), "fp-calibration-rehearsal-"));
    const tmpdir = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    const { password, key } = rehearsalSecrets();
    const [a, b, c] = ["rehearsal-cal-a", "rehearsal-cal-b", "rehearsal-cal-c"].map(uniqueSensorId);
    const mine = new Set([a, b, c]);
    // Each rehearsal board's name as the live plan gives it, looked up once it is online.
    const names: Record<string, string> = {};
    // Sides of 3 m (a-b), 2.5 m (a-c) and 2 m (b-c), c above the line from a to b, each board turned its own way with
    // its own clock, buzzers 2 cm from their arrays (as the local triangle journey).
    const cY = Math.sqrt(2.5 ** 2 - 1.875 ** 2);
    const truth: Record<string, { x: number; y: number; facing: number }> = {
      [a]: { x: 0, y: 0, facing: 30 }, [b]: { x: 3, y: 0, facing: 200 }, [c]: { x: 1.875, y: cY, facing: 120 },
    };
    const boards = [
      { id: a, emitter_ccw_deg: 45, clock_offset_s: 0.4, drift_ppm: 15 },
      { id: b, emitter_ccw_deg: 160, clock_offset_s: -0.9, drift_ppm: -25 },
      { id: c, emitter_ccw_deg: 280, clock_offset_s: 1.6, drift_ppm: 10 },
    ];
    let sensors: SimulatedSensors | null = null;
    const context = await browser.newContext();
    const page = await context.newPage();
    const request = page.request;
    let passed = false;
    console.log(`calibration rehearsal on ${origin}: sensors ${[...mine].join(", ")}`);
    try {
      await demoStep("sign in", "the dashboard after signing in", () => signInWith(page, origin, password));

      const before = await demoStep("record the starting state",
        "no calibration running, no other calibration-capable sensor online, and the plan not a measured layout",
        async () => {
          const state = await read<CalibrationState>(request, origin, "calibration");
          expect(Array.isArray(state.eligible_sensors), "the live site lists who can calibrate (deploy first)").toBe(true);
          expect(state.running, "a calibration is running").toBe(false);
          expect(state.eligible_sensors, "calibration-capable sensors online; switch them off first").toEqual([]);
          expect(state.layout, state.layout
            ? `the plan is a measured layout from ${new Date(state.layout.measured_at).toISOString()}; a run would replace it`
            : "").toBeNull();
          const plan = (await read<{ sensors: PlanSensor[] }>(request, origin, "sensors")).sensors;
          console.log(`calibration rehearsal start: plan ${
            plan.map((s) => `${s.id} at x ${s.x_m} m, y ${s.y_m} m facing ${s.facing_deg}`).join("; ") || "empty"}`);
          return plan;
        });

      await demoStep("three rehearsal boards check in and can take part",
        `${a}, ${b} and ${c} online on the plan, the only sensors that can take part, and Calibrate enabled`, async () => {
          sensors = new SimulatedSensors(origin, key);
          for (const { id, ...board } of boards) {
            const t = truth[id];
            await sensors.send({ add: { id, x_m: t.x, y_m: t.y, facing_deg: t.facing, emitter_offset_m: 0.02, ...board } });
          }
          for (const id of mine) await expect(card(page, id).getByText("Online", { exact: true })).toBeVisible(seen);
          await expect(page.getByRole("button", { name: "Calibrate" })).toBeEnabled(seen);
          const state = await read<CalibrationState>(request, origin, "calibration");
          expect(state.eligible_sensors, "the sensors that can take part").toEqual([a, b, c]);
          for (const id of mine) names[id] = await sensorName(request, id, origin);
        });

      await demoStep("Calibrate", "the boards beeping, then the run calibrated", async () => {
        await page.getByRole("button", { name: "Calibrate" }).click();
        await expect(page.getByText("Beeping", { exact: true })).toBeVisible({ timeout: 40_000 });
        await expect(page.getByText(/^Calibrated \d\d:\d\d$/)).toBeVisible({ timeout: 60_000 });
      });

      await demoStep("the plan shows the triangle as the boards stand",
        "the three measured sides within 5 cm, each board within 10 cm and 5 degrees of where it stands", async () => {
          const state = await read<CalibrationState>(request, origin, "calibration");
          expect(state.layout?.sensors, "the sensors the run placed").toEqual([a, b, c]);
          await expect(measured(page)).toHaveCount(3);
          for (const [p, q] of [[a, b], [a, c], [b, c]]) {
            const side = page.getByRole("img", { name: new RegExp(`^Measured \\d+\\.\\d\\d m from ${names[p]} to ${names[q]}$`) });
            const [, metres] = (await side.getAttribute("aria-label"))!.match(/^Measured (\d+\.\d\d) m/)!;
            console.log(`calibration rehearsal measured ${metres} m from ${p} to ${q}`);
            const length = Math.hypot(truth[q].x - truth[p].x, truth[q].y - truth[p].y);
            expect(Math.abs(Number(metres) - length), `${p} to ${q}`).toBeLessThanOrEqual(0.05);
          }
          const plan = (await read<{ sensors: PlanSensor[] }>(request, origin, "sensors")).sensors;
          for (const id of mine) {
            const s = plan.find((p) => p.id === id)!;
            const t = truth[id];
            await expect(card(page, id).getByText(`x ${s.x_m.toFixed(1)} m, y ${s.y_m.toFixed(1)} m`)).toBeVisible();
            expect(Math.hypot(s.x_m - t.x, s.y_m - t.y), `${id} at ${s.x_m}, ${s.y_m}`).toBeLessThanOrEqual(0.1);
            expect(offBy(s.facing_deg, t.facing), `${id} faces ${s.facing_deg}`).toBeLessThanOrEqual(5);
          }
        });

      await demoStep("switch the rehearsal boards off and remove them from the plan",
        "their cards gone and the plan no longer calibrated", async () => {
          // Off first: a removed sensor comes back on the plan at its next check-in.
          await sensors!.stop();
          for (const id of mine) {
            await card(page, id).getByRole("button", { name: `Remove ${names[id]}` }).click();
            await expect(card(page, id)).toHaveCount(0, seen);
          }
          await expect(page.getByText(/^Calibrated /)).toBeHidden(seen);
          await expect(measured(page)).toHaveCount(0);
        });

      await demoStep("the site is as it was",
        "every other sensor where it was, no measured layout, and no event or activity from the rehearsal boards",
        async () => {
          // A board joining the plan meanwhile is not the rehearsal's doing; every sensor there before is compared.
          const plan = (await read<{ sensors: PlanSensor[] }>(request, origin, "sensors")).sensors;
          const there = new Set(before.map((s) => s.id));
          expect(placement(plan.filter((s) => there.has(s.id))), "the sensors on the plan before").toEqual(placement(before));
          expect(plan.filter((s) => mine.has(s.id)).map((s) => s.id), "rehearsal boards on the plan").toEqual([]);
          expect((await read<CalibrationState>(request, origin, "calibration")).layout, "the measured layout").toBeNull();
          // Clearing events would also remove the real boards' events, so a rehearsal event fails the run instead.
          const { events } = await read<{ events: { sensor_id: string }[] }>(request, origin, "events");
          expect(events.filter((e) => mine.has(e.sensor_id)), "events from the rehearsal boards").toEqual([]);
          const { activities } = await read<{ activities: { sensors: string[] }[] }>(request, origin, "activities");
          expect(activities.filter((x) => x.sensors.some((s) => mine.has(s))), "activities").toEqual([]);
        });
      passed = true;
    } finally {
      await undoLeftovers(request, origin, mine, sensors);
      await context.close();
      if (tmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpdir;
      if (passed) rmSync(scratch, { recursive: true, force: true });
      else console.log(`calibration rehearsal kept the boards' log under ${scratch}`);
    }
  });

// After a failed step: switches the rehearsal boards off and removes any still on the plan. Each undo is reported;
// none of them hides the step's failure.
async function undoLeftovers(request: APIRequestContext, origin: string, mine: Set<string>,
  sensors: SimulatedSensors | null) {
  try {
    await sensors?.stop();
  } catch (e) {
    console.log(`calibration rehearsal could not stop its boards: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const { sensors: plan } = await read<{ sensors: PlanSensor[] }>(request, origin, "sensors");
    for (const s of plan.filter((p) => mine.has(p.id))) {
      expect((await request.delete(`${origin}/dashboard/api/sensors/${encodeURIComponent(s.id)}`)).ok()).toBe(true);
      console.log(`calibration rehearsal undid: ${s.id} on the plan`);
    }
  } catch (e) {
    console.log(`calibration rehearsal could not remove its boards: ${e instanceof Error ? e.message : e}`);
  }
}
