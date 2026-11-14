// Location journey: two sensors placed 3 m apart facing each other hear a chainsaw. One sensor alone shows the
// direction it heard it from; both at once, with crossing directions, show where it was, with the distance from each
// sensor, on the plan and on the activity; diverging directions show the lines and no point. Runs on its own fresh
// service, so no other journey's sensor hears the same sound in the same moment.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { devVars, signIn } from "../fixtures/dashboard.ts";
import { referenceClip, replay, silentWav, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { locationServicePorts, webRoot } from "../ports.ts";

const run = promisify(execFile);
const python = path.join(webRoot, "..", ".venv", "bin", "python");
const together = path.join(webRoot, "tests", "e2e", "location_replay.py");

const directions = (page: Page) => page.getByRole("img", { name: /^Direction from / });
const locations = (page: Page) => page.getByRole("img", { name: /^Location, / });
const logging = (page: Page) => page.getByRole("list", { name: "Activities" }).getByRole("listitem")
  .filter({ has: page.getByRole("heading", { name: "Logging", exact: true }) });

// Each sensor replays the chainsaw with its angle; their detections are held until all of them have one and until
// release() is called, then stamped with that moment, as sensors listening live would stamp them
// (location_replay.py). Starting the replays early, while the previous lines are still showing, keeps every chainsaw
// of the journey well within one activity's 60 s gap however long the replays take to start.
function chainsaw(origin: string, sensors: { id: string; angle: number }[]) {
  const barrier = mkdtempSync(path.join(os.tmpdir(), "fp-location-"));
  let failed: unknown = null;
  const runs = Promise.all(sensors.map((s, i) => {
    const config = path.join(barrier, `${i}.toml`);
    writeFileSync(config, [
      `server_url = ${JSON.stringify(origin)}`,
      `sensor_key = ${JSON.stringify(devVars().DEVICE_KEY)}`,
      `sensor_id = ${JSON.stringify(s.id)}`,
      `state_dir = ${JSON.stringify(path.join(barrier, `state-${i}`))}`,
      "checkin_interval = 1.0",
    ].join("\n") + "\n");
    return run(python, [together, barrier, String(i), "--config", config, "--angle", String(s.angle),
      referenceClip("chainsaw.wav")], { timeout: 120_000 });
  })).catch((e) => {
    failed = e;
  });
  return {
    // Waits until every sensor has heard it, lets them all report it now, and waits for the replays to finish.
    async release() {
      const deadline = Date.now() + 100_000;
      while (!sensors.every((_, i) => existsSync(path.join(barrier, `${i}.ready`)))) {
        if (failed) throw failed;
        if (Date.now() > deadline) throw new Error("the sensors never heard the chainsaw");
        await new Promise((r) => setTimeout(r, 50));
      }
      writeFileSync(path.join(barrier, "go"), "");
      await runs;
      if (failed) throw failed;
    },
  };
}

test("a sensor shows where it heard a sound from, and two sensors' crossing lines show where it was", async ({ browser }) => {
  test.setTimeout(300_000);
  const service = new SecondService(locationServicePorts);
  await service.start();
  try {
    const origin = service.url;
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();
    await signIn(page, "/dashboard/", origin);

    // Two sensors check in and are placed 3 m apart, facing each other: a at the origin facing right, b to its right.
    const a = uniqueSensorId("loc-a");
    const b = uniqueSensorId("loc-b");
    const silence = silentWav(1);
    await replay({ sensorId: a, wavs: [silence], serverUrl: origin });
    await replay({ sensorId: b, wavs: [silence], serverUrl: origin });
    for (const [id, x_m, facing_deg] of [[a, 0, 90], [b, 3, 270]] as const) {
      const placed = await page.request.patch(`/dashboard/api/sensors/${encodeURIComponent(id)}`,
        { data: { x_m, y_m: 0, facing_deg } });
      expect(placed.ok()).toBe(true);
    }
    await expect(page.getByText("x 3.0 m, y 0.0 m")).toBeVisible({ timeout: 3000 });

    // a alone hears it 45 degrees to its left (up and to the right on the plan): one line, no point, and the
    // activity has no location. The line goes 15 s after the sound.
    await chainsaw(origin, [{ id: a, angle: 315 }]).release();
    await expect(directions(page)).toHaveCount(1, { timeout: 3000 });
    await expect(directions(page)).toHaveAccessibleName(`Direction from ${a}`);
    await expect(logging(page)).toContainText(a, { timeout: 3000 });
    await page.waitForTimeout(2500); // one more poll
    await expect(locations(page)).toHaveCount(0);
    await expect(logging(page)).not.toContainText(" m from ");
    const crossingPair = chainsaw(origin, [{ id: a, angle: 315 }, { id: b, angle: 26.57 }]);
    await expect(directions(page)).toHaveCount(0, { timeout: 16_000 });

    // Both hear it at once, a up and to its right, b 26.57 degrees to its right: the lines cross at (1, 1),
    // 1.4 m from a and 2.2 m from b, on the plan and on the activity.
    await crossingPair.release();
    await expect(locations(page)).toHaveCount(1, { timeout: 3000 });
    await expect(locations(page)).toHaveAccessibleName(`Location, 1.4 m from ${a}, 2.2 m from ${b}`);
    await expect(directions(page)).toHaveCount(2);
    await expect(page.getByText("1.4 m", { exact: true })).toBeVisible();
    await expect(page.getByText("2.2 m", { exact: true })).toBeVisible();
    await expect(logging(page)).toContainText(`1.4 m from ${a}, 2.2 m from ${b}`, { timeout: 3000 });
    await expect(logging(page)).toContainText("3 events");
    const divergingPair = chainsaw(origin, [{ id: a, angle: 225 }, { id: b, angle: 135 }]);
    await expect(locations(page)).toHaveCount(0, { timeout: 16_000 });
    await expect(directions(page)).toHaveCount(0);

    // Both hear it pointing away from each other: the lines meet only behind the sensors, so two lines and no
    // point. The activity keeps its latest location.
    await divergingPair.release();
    await expect(directions(page)).toHaveCount(2, { timeout: 3000 });
    await expect(logging(page)).toContainText("5 events", { timeout: 3000 });
    await page.waitForTimeout(2500); // one more poll
    await expect(locations(page)).toHaveCount(0);
    await expect(directions(page)).toHaveCount(2);
    await expect(logging(page)).toContainText(`1.4 m from ${a}, 2.2 m from ${b}`);
    await context.close();
  } finally {
    await service.stop();
  }
});
