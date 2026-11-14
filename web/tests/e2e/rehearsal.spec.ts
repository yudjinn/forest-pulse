// Rehearsal of the whole demo script, step by step, as the presenter runs it on stage: the phone's player plays, a
// sensor hears a chainsaw and the dashboard shows a Logging activity with its direction, two sensors hearing it at
// once show where it was, the teaching pack is taught through the Teach page, and the player's boreal owls are then
// reported while its tawny owl is not. It ends by undoing everything it did, so the audience starts clean.
// It runs on its own fresh local service (teaching changes the sound list for every sensor), or against the live site
// when FP_REHEARSAL_ORIGIN is set, with the live sensor key and password from .dev-secrets.local. On the live site it
// uses its own sensors and a fresh sound name, never the stage's, and leaves every other sensor where it was.
// The pack is not in the repository (demo-kit/teaching_pack.py builds it on the presenting laptop); without it the
// journey is skipped, unless FP_REQUIRE_TEACHING_PACK=1 or the run is live, when it fails.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { replay, silentWav, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { rehearsalServicePorts } from "../ports.ts";
import {
  buildTeachingPack, demoStep, hearTogether, liveOrigin, packRequired, playerSample, rehearsalSecrets, signInWith,
  teachingPack, teachingPackFolder, teachThePack,
} from "./rehearsal-steps.ts";

// The name the presenter teaches on stage. The rehearsal never teaches it, and fails if it is already listed: the
// stage teach would then replace that sound instead of teaching a new one.
const STAGE_NAME = "Boreal owl";
// The event log's reply holds at most this many events, newest first (the service's log limit).
const LOG_LIMIT = 200;

// A failed live run must not leave the live password or session in a trace.
test.use({ trace: liveOrigin ? "off" : "retain-on-failure" });

interface Sound { id: string; name: string; enabled: boolean; taught: boolean; kind: string }
interface PlanSensor { id: string; x_m: number; y_m: number; facing_deg: number }
interface LogEvent { id: number; sensor_id: string; sound_name: string; occurred_at: string }

async function read<T>(request: APIRequestContext, origin: string, what: string): Promise<T> {
  const res = await request.get(`${origin}/dashboard/api/${what}`);
  expect(res.status(), `GET /dashboard/api/${what}`).toBe(200);
  return res.json() as Promise<T>;
}

const sensorCard = (page: Page, id: string) => page.getByRole("list", { name: "Sensors" }).getByRole("listitem")
  .filter({ has: page.getByRole("heading", { name: id }) });
// The Logging activity a rehearsal sensor is part of; the live log may hold others.
const logging = (page: Page, sensorId: string) => page.getByRole("list", { name: "Activities" }).getByRole("listitem")
  .filter({ has: page.getByRole("heading", { name: "Logging", exact: true }) }).filter({ hasText: sensorId });
const logRows = (page: Page, sensorId: string, sound: string) =>
  page.getByRole("row").filter({ hasText: sensorId }).filter({ hasText: sound });

test("the demo script: a chainsaw's direction and location, the teaching pack taught, owls told apart, a clean slate",
  async ({ browser }) => {
    const pack = teachingPack();
    if (!packRequired) test.skip(pack === null, `no teaching pack at ${teachingPackFolder}; build it with ${buildTeachingPack}`);
    expect(pack, `a teaching pack at ${teachingPackFolder}; build it with ${buildTeachingPack}`).not.toBeNull();
    test.setTimeout(liveOrigin ? 600_000 : 300_000);
    // Live polls and replays cross the internet; locally they do not.
    const seen = { timeout: liveOrigin ? 10_000 : 5000 };

    // Every temporary file of the run (sensor configs holding the sensor key, sensor state) goes in one folder that
    // is removed at the end.
    const scratch = mkdtempSync(path.join(os.tmpdir(), "fp-rehearsal-run-"));
    const tmpdir = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    const service = liveOrigin ? null : new SecondService(rehearsalServicePorts);
    await service?.start();
    const origin = liveOrigin ?? service!.url;
    const { password, key } = rehearsalSecrets();
    const name = `Rehearsal owl ${Date.now().toString(36)}`;
    const ids = { a: uniqueSensorId("rehearsal-a"), b: uniqueSensorId("rehearsal-b"), c: uniqueSensorId("rehearsal-c") };
    const mine = new Set(Object.values(ids));
    const stateDir = (id: string) => path.join(mkdtempSync(path.join(os.tmpdir(), "fp-rehearsal-")), id);
    const states = { a: stateDir(ids.a), b: stateDir(ids.b), c: stateDir(ids.c) };
    const context = await browser.newContext();
    const page = await context.newPage();
    const request = page.request;
    console.log(`rehearsal on ${origin}: sensors ${[...mine].join(", ")}; taught name "${name}"`);
    try {
      await demoStep("sign in", "the dashboard after signing in", () => signInWith(page, origin, password));

      // A taught sound already listed (one left by an interrupted rehearsal, or "Boreal owl" itself) would be known to
      // the boards before the stage teach.
      const before = await demoStep("record the starting state",
        `no taught sound listed, "${STAGE_NAME}" included`, async () => {
          const sounds = await read<{ sounds: Sound[]; version: number }>(request, origin, "sounds");
          expect(sounds.sounds.filter((s) => s.taught).map((s) => s.name), "taught sounds").toEqual([]);
          expect(sounds.sounds.map((s) => s.name.toLowerCase()), `"${STAGE_NAME}" is free for the stage teach`)
            .not.toContain(STAGE_NAME.toLowerCase());
          const plan = (await read<{ sensors: PlanSensor[] }>(request, origin, "sensors")).sensors;
          console.log(`rehearsal start: sound list version ${sounds.version}, ${sounds.sounds.length} sounds; plan: ${
            plan.map((s) => `${s.id} at x ${s.x_m} m, y ${s.y_m} m facing ${s.facing_deg}`).join("; ") || "empty"}`);
          return { sounds, plan };
        });

      await demoStep("the phone's player lists every sample and plays one", "every sample listed, Chainsaw 1 playing",
        async () => {
          const phone = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
          try {
            const p = await phone.newPage();
            await signInWith(p, origin, password, "/dashboard/player/");
            const { samples } = await read<{ samples: { name: string }[] }>(p.request, origin, "player/samples");
            expect(samples.length).toBe(6);
            for (const s of samples) await expect(p.getByRole("button", { name: s.name, exact: true })).toBeVisible();
            await p.getByRole("button", { name: "Chainsaw 1", exact: true }).tap();
            await expect(p.getByRole("listitem").filter({ hasText: "Chainsaw 1" })).toContainText("Playing", seen);
            await p.getByRole("button", { name: "Stop" }).tap();
            await expect(p.getByText("Playing")).toHaveCount(0);
          } finally {
            await phone.close();
          }
        });

      // Clear of every other sensor: a at x0 facing right, b 3 m to its right facing it.
      const x0 = Math.ceil(Math.max(0, ...before.plan.map((s) => s.x_m))) + 6;
      await demoStep("two rehearsal sensors check in and are placed on the plan",
        `${ids.a} at x ${x0} m facing right and ${ids.b} 3 m to its right facing it`, async () => {
          const silence = silentWav(1);
          await replay({ sensorId: ids.a, wavs: [silence], key, serverUrl: origin, stateDir: states.a });
          await replay({ sensorId: ids.b, wavs: [silence], key, serverUrl: origin, stateDir: states.b });
          for (const [id, x_m, facing_deg] of [[ids.a, x0, 90], [ids.b, x0 + 3, 270]] as const) {
            const placed = await request.patch(`${origin}/dashboard/api/sensors/${encodeURIComponent(id)}`,
              { data: { x_m, y_m: 0, facing_deg } });
            expect(placed.ok(), `placing ${id}`).toBe(true);
          }
          await expect(sensorCard(page, ids.a).getByText(`x ${x0.toFixed(1)} m, y 0.0 m`)).toBeVisible(seen);
          await expect(sensorCard(page, ids.b).getByText(`x ${(x0 + 3).toFixed(1)} m, y 0.0 m`)).toBeVisible(seen);
        });

      const chainsaw = playerSample("chainsaw-1.wav");
      await demoStep("a sensor hears a chainsaw", `a Logging activity from ${ids.a} and its direction on the plan`,
        async () => {
          await hearTogether(origin, key, [{ id: ids.a, angle: 315, stateDir: states.a }], chainsaw).release();
          await expect(logging(page, ids.a)).toBeVisible(seen);
          // The sample can be heard more than once, each time with its own line.
          await expect(page.getByRole("img", { name: `Direction from ${ids.a}`, exact: true }).first()).toBeVisible(seen);
        });

      await demoStep("two sensors hear the chainsaw at once",
        `its location 1.4 m from ${ids.a} and 2.2 m from ${ids.b}, on the plan and on the activity`, async () => {
          await hearTogether(origin, key, [
            { id: ids.a, angle: 315, stateDir: states.a },
            { id: ids.b, angle: 26.57, stateDir: states.b },
          ], chainsaw).release();
          // Both events of a pair can be located, so the same point can be drawn more than once.
          await expect(page.getByRole("img", { name: `Location, 1.4 m from ${ids.a}, 2.2 m from ${ids.b}` }).first())
            .toBeVisible(seen);
          await expect(logging(page, ids.a)).toContainText(`1.4 m from ${ids.a}, 2.2 m from ${ids.b}`, seen);
        });

      const taught = await demoStep(`teach "${name}" from the teaching pack on the Teach page`,
        "the new sound listed as a taught detector, switched on, and the sound list one version on", async () => {
          await teachThePack(page, origin, name, pack!);
          const sounds = await read<{ sounds: Sound[]; version: number }>(request, origin, "sounds");
          const sound = sounds.sounds.find((s) => s.name === name);
          expect(sound).toMatchObject({ kind: "detector", taught: true, enabled: true });
          expect(sounds.version).toBe(before.sounds.version + 1);
          return { sound: sound!, version: sounds.version };
        });

      await demoStep("the player's owls are played to the sensors",
        `both boreal owls reported as "${name}" and the tawny owl not`, async () => {
          const heard = [
            { id: ids.a, sample: "boreal-owl-1.wav", state: states.a },
            { id: ids.b, sample: "boreal-owl-2.wav", state: states.b },
            { id: ids.c, sample: "tawny-owl.wav", state: states.c },
          ];
          for (const h of heard) {
            const output = await replay({ sensorId: h.id, wavs: [playerSample(h.sample)], key, serverUrl: origin,
              stateDir: h.state });
            expect(output).toMatch(new RegExp(`sound list ${taught.version}: .*${name}`));
            expect(output).toMatch(/^done: 0 event\(s\) still queued$/m);
          }
          await page.goto(`${origin}/dashboard/`);
          await expect(logRows(page, ids.a, name).first()).toBeVisible(seen);
          await expect(logRows(page, ids.b, name).first()).toBeVisible(seen);
          await page.waitForTimeout(2500); // one more poll of the log
          await expect(logRows(page, ids.c, name)).toHaveCount(0);
        });

      await demoStep(`delete "${name}" on the Sounds page`, "it leaves the list after its confirmation", async () => {
        await page.goto(`${origin}/dashboard/sounds/`);
        await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
        await page.getByRole("dialog", { name: `Delete ${name}?` }).getByRole("button", { name: "Delete", exact: true })
          .click();
        await expect(page.getByRole("switch", { name, exact: true })).toHaveCount(0, seen);
      });

      await demoStep("remove the rehearsal sensors from the plan", "their cards gone from the plan", async () => {
        await page.goto(`${origin}/dashboard/`);
        for (const id of mine) {
          await sensorCard(page, id).getByRole("button", { name: `Remove ${id}` }).click();
          await expect(sensorCard(page, id)).toHaveCount(0, seen);
        }
      });

      const cleared = await demoStep("clear events", "the event log cleared after its confirmation", async () => {
        const { events } = await read<{ events: LogEvent[] }>(request, origin, "events");
        reportOthers(events.filter((e) => !mine.has(e.sensor_id)), events.length >= LOG_LIMIT);
        await page.getByRole("button", { name: "Clear events" }).click();
        await page.getByRole("dialog", { name: "Clear events?" }).getByRole("button", { name: "Clear events" }).click();
        await expect(page.getByRole("dialog", { name: "Clear events?" })).toBeHidden(seen);
        return new Set(events.map((e) => e.id));
      });

      await demoStep("the site is as it was, ready for the stage",
        "the sound list as at the start with no taught sound, no events from before clearing, other sensors untouched",
        async () => {
          const sounds = await read<{ sounds: Sound[] }>(request, origin, "sounds");
          expect(sounds.sounds.filter((s) => s.taught).map((s) => s.name), "taught sounds").toEqual([]);
          const shape = (list: Sound[]) => list.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled }));
          expect(shape(sounds.sounds), "the sound list").toEqual(shape(before.sounds.sounds));
          // A real board may send events after the clear; those stay.
          const { events } = await read<{ events: LogEvent[] }>(request, origin, "events");
          expect(events.filter((e) => cleared.has(e.id) || mine.has(e.sensor_id)), "the event log").toEqual([]);
          const { activities } = await read<{ activities: { sensors: string[] }[] }>(request, origin, "activities");
          expect(activities.filter((a) => a.sensors.some((s) => mine.has(s))), "the activities").toEqual([]);
          const plan = (await read<{ sensors: PlanSensor[] }>(request, origin, "sensors")).sensors;
          const placement = (list: PlanSensor[]) => list.map((s) => ({ id: s.id, x_m: s.x_m, y_m: s.y_m, facing_deg: s.facing_deg }));
          expect(placement(plan), "the plan").toEqual(placement(before.plan));
        });
    } finally {
      await undoLeftovers(request, origin, name, mine);
      await context.close();
      await service?.stop();
      if (tmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpdir;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

// What the rehearsal clears besides its own events: the event log from every other sensor, by sensor, with its time
// span, so a run on the live site records what the real boards had sent. The log reply holds only the newest events,
// so when it is full the counts are lower bounds.
function reportOthers(events: LogEvent[], full: boolean) {
  const by = new Map<string, LogEvent[]>();
  for (const e of events) by.set(e.sensor_id, [...(by.get(e.sensor_id) ?? []), e]);
  if (by.size === 0) console.log("rehearsal clears no events from other sensors");
  for (const [sensor, list] of by) {
    const times = list.map((e) => e.occurred_at).sort();
    console.log(`rehearsal clears ${full ? "at least " : ""}${list.length} event(s) from ${sensor}, ${
      full ? "the newest from " : ""}${times[0]} to ${times[times.length - 1]}`);
  }
}

// After a failed step: removes what the rehearsal left behind, its taught sound and its sensors, and clears events if
// any of its own are still logged. Each undo is reported; none of them hides the step's failure.
async function undoLeftovers(request: APIRequestContext, origin: string, name: string, mine: Set<string>) {
  const attempt = async (what: string, undo: () => Promise<boolean>) => {
    try {
      if (await undo()) console.log(`rehearsal undid: ${what}`);
    } catch (e) {
      console.log(`rehearsal could not undo ${what}: ${e instanceof Error ? e.message : e}`);
    }
  };
  await attempt(`the taught sound "${name}"`, async () => {
    const { sounds } = await read<{ sounds: Sound[] }>(request, origin, "sounds");
    const left = sounds.find((s) => s.name === name);
    if (!left) return false;
    expect((await request.delete(`${origin}/dashboard/api/sounds/${encodeURIComponent(left.id)}`)).ok()).toBe(true);
    return true;
  });
  await attempt("the rehearsal sensors on the plan", async () => {
    const { sensors } = await read<{ sensors: PlanSensor[] }>(request, origin, "sensors");
    const left = sensors.filter((s) => mine.has(s.id));
    for (const s of left) {
      expect((await request.delete(`${origin}/dashboard/api/sensors/${encodeURIComponent(s.id)}`)).ok()).toBe(true);
    }
    return left.length > 0;
  });
  await attempt("the rehearsal's events", async () => {
    const { events } = await read<{ events: LogEvent[] }>(request, origin, "events");
    if (!events.some((e) => mine.has(e.sensor_id))) return false;
    reportOthers(events.filter((e) => !mine.has(e.sensor_id)), events.length >= LOG_LIMIT);
    expect((await request.delete(`${origin}/dashboard/api/events`)).ok()).toBe(true);
    return true;
  });
}
