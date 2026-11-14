// Warnings journey: simulated boards that heard a chainsaw get a researcher's warning and play the alarm, and the
// Logging card says what each board did; a lost reply retried never sends twice, a second Send waits while one is on
// its way, an old card offers none, and Clear events removes the warnings with the events.
// It runs on its own fresh service: it needs a plan of its own and clears every event.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { devVars, signIn } from "../fixtures/dashboard.ts";
import { asSensor, referenceClip, sensorName, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { warningsServicePorts, webRoot } from "../ports.ts";

const run = promisify(execFile);
const python = path.join(webRoot, "..", ".venv", "bin", "python");
const stateDir = path.join(webRoot, ".wrangler", `e2e-${warningsServicePorts.appPort}`);

// The simulated boards' process (warnings_sensors.py lists the commands); each command waits for its answer.
class Boards {
  private readonly proc: ChildProcess;
  private readonly lines: Interface;
  private queue: Promise<unknown> = Promise.resolve();
  readonly log: string;

  constructor(origin: string, sensorKey: string) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fp-warnings-"));
    this.log = path.join(dir, "sensors.log");
    this.proc = spawn(python, [path.join(webRoot, "tests", "e2e", "warnings_sensors.py"), origin, dir], {
      stdio: ["pipe", "pipe", openSync(this.log, "w")],
      env: { ...process.env, FP_SENSOR_KEY: sensorKey },
    });
    this.lines = createInterface({ input: this.proc.stdout! });
  }

  // Commands run one at a time, in the order sent; the answer's JSON, if any.
  send(command: Record<string, unknown>): Promise<any> {
    const answer = this.queue.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(command)}; see ${this.log}`)), 60_000);
      this.lines.once("line", (line) => {
        clearTimeout(timer);
        if (line === "ok") resolve(undefined);
        else if (line.startsWith("ok ")) resolve(JSON.parse(line.slice(3)));
        else reject(new Error(`${line} (log: ${this.log})`));
      });
      this.proc.stdin!.write(JSON.stringify(command) + "\n");
    }));
    this.queue = answer.catch(() => undefined);
    return answer;
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise((r) => this.proc.once("exit", r));
    await this.send({ stop: true }).catch(() => this.proc.kill());
    await exited;
  }
}

const loggingCards = (page: Page) => page.getByRole("list", { name: "Activities" }).getByRole("listitem")
  .filter({ has: page.getByRole("heading", { name: "Logging", exact: true }) });
const planCard = (page: Page, id: string) =>
  page.getByRole("list", { name: "Sensors" }).getByRole("listitem").filter({ has: page.getByText(id, { exact: true }) });
const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

async function stored(sql: string): Promise<number> {
  const { stdout } = await run(path.join(webRoot, "node_modules", ".bin", "wrangler"), [
    "d1", "execute", "DB", "--local", "--persist-to", stateDir, "--json", "--command", sql,
  ], { cwd: webRoot, timeout: 60_000 });
  return Object.values(JSON.parse(stdout)[0].results[0] as Record<string, number>)[0];
}

test("boards that heard the logging play the warning's alarm and the card reports every outcome; Clear events removes warnings", async ({ page, playwright }) => {
  test.setTimeout(240_000);
  const service = new SecondService(warningsServicePorts);
  await service.start();
  const origin = service.url;
  const key = devVars().DEVICE_KEY;
  const boards = new Boards(origin, key);
  try {
    // Only signed-in researchers can send.
    const anonymous = await playwright.request.newContext();
    const refused = await anonymous.post(`${origin}/dashboard/api/warnings`, { data: { request_id: "r", event_id: 1 } });
    expect(refused.status()).toBe(401);
    await anonymous.dispose();

    await signIn(page, "/dashboard/", origin);

    // Logging heard 6 minutes ago: its card offers no Send warning.
    const early = uniqueSensorId("warn-early");
    const [posted] = await asSensor(early, [{ call: "post_events", events: [{
      event_id: "early-1", detected_at: new Date(Date.now() - 6 * 60_000).toISOString(), sound_id: "chainsaw",
      confidence: 0.9,
    }] }], key, origin);
    expect(posted.results[0].status).toBe("accepted");
    await expect(loggingCards(page)).toHaveCount(1, { timeout: 5000 });
    await expect(loggingCards(page).getByRole("button")).toHaveCount(0);

    // Four boards hear a chainsaw now: two with a buzzer, one that will lose power, one whose hooks have no buzzer.
    const [a, b, off, mute] = ["warn-a", "warn-b", "warn-off", "warn-mute"].map(uniqueSensorId);
    for (const [i, id] of [a, b, off, mute].entries()) {
      await boards.send({ add: { id, x_m: 3 * i, buzzer: id !== mute } });
    }
    for (const id of [a, b, off, mute]) {
      await expect(planCard(page, id).getByText("Online", { exact: true })).toBeVisible({ timeout: 10_000 });
    }
    await boards.send({ hear: { ids: [a, b, off, mute], wav: referenceClip("chainsaw.wav") } });
    const [na, nb, nOff, nMute] = await Promise.all([a, b, off, mute].map((id) => sensorName(page.request, id, origin)));
    const card = loggingCards(page).filter({ hasText: nMute });
    for (const name of [na, nb, nOff, nMute]) await expect(card).toContainText(name, { timeout: 10_000 });
    await expect(loggingCards(page)).toHaveCount(2);
    await expect(card.getByRole("button", { name: "Send warning" })).toBeVisible();

    // One board loses power and shows offline before the Send.
    await boards.send({ power_off: { id: off } });
    await expect(planCard(page, off).getByText("Offline", { exact: true })).toBeVisible({ timeout: 20_000 });

    // The first Send reaches the service but its reply is lost: the card says so, and pressing again (the same
    // request) never sends a second warning.
    const sentAt = Date.now();
    const during = boards.send({ hear_during_alarm: { ids: [a, b], wav: referenceClip("chainsaw.wav") } });
    await page.route(`${origin}/dashboard/api/warnings`, async (route) => {
      await route.fetch();
      await route.abort();
    }, { times: 1 });
    await card.getByRole("button", { name: "Send warning" }).click();
    await expect(card.getByText("Couldn't send the warning. Try again.")).toBeVisible();
    await card.getByRole("button", { name: /^Send (warning|again)$/ }).click();
    await expect(card.getByText("Couldn't send the warning. Try again.")).toBeHidden();
    const line = card.getByText(/^Warning sent \d{2}:\d{2}:\d{2} · /);
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(`on its way to ${[na, nb].sort(byName).join(", ")}`);

    // A Send while the warning is on its way waits.
    await card.getByRole("button", { name: "Send again" }).click();
    await expect(card.getByText("A warning is on its way")).toBeVisible();

    // Both buzzers played the alarm; every board has its outcome.
    await during;
    await expect(line).toContainText(`played on ${[na, nb].sort(byName).join(", ")}`, { timeout: 15_000 });
    await expect(line).toContainText(`not delivered to ${nOff} (offline)`);
    await expect(line).toContainText(`no buzzer on ${nMute}`);
    await expect(line).not.toContainText("on its way");
    await expect(card.getByText("A warning is on its way")).toBeHidden();
    await expect(line).toHaveCount(1);
    for (const id of [a, b]) {
      const tones: number[][] = await boards.send({ tones: { id } });
      expect(tones.map((t) => t.slice(1))).toEqual([
        ...Array.from({ length: 16 }, () => [[3500, 3500, 3500, 120], [2500, 2500, 2500, 120]]).flat(),
        [3500, 3500, 3500, 120],
      ]);
      expect(tones[32][0]).toBeGreaterThan(4.6);
      expect(tones[32][0]).toBeLessThan(5.2);
    }

    // The chainsaw the two boards heard while their alarm sounded never became an event, then or afterwards.
    await page.waitForTimeout(4000);
    const events = (await (await page.request.get(`${origin}/dashboard/api/events`)).json()).events as
      { sensor_id: string; occurred_at: string }[];
    expect(events.filter((e) => e.sensor_id === a || e.sensor_id === b).length).toBeGreaterThan(0);
    expect(events.filter((e) => (e.sensor_id === a || e.sensor_id === b) && Date.parse(e.occurred_at) >= sentAt))
      .toEqual([]);

    // Clear events removes the cards and their warnings.
    expect(await stored("SELECT COUNT(*) AS n FROM warning_targets")).toBe(4);
    await page.getByRole("button", { name: "Clear events" }).click();
    await page.getByRole("dialog", { name: "Clear events?" }).getByRole("button", { name: "Clear events" }).click();
    await expect(page.getByText("Nothing heard yet")).toBeVisible();
    await expect(loggingCards(page)).toHaveCount(0);
    await expect(page.getByText(/^Warning sent/)).toHaveCount(0);
    expect(await stored("SELECT (SELECT COUNT(*) FROM warnings) + (SELECT COUNT(*) FROM warning_targets) AS n"))
      .toBe(0);
  } finally {
    await boards.stop();
    await service.stop();
  }
});
