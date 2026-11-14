// Service core journey: the sensor contract (docs/device-api.md) holds against the service, acting as sensors
// through the sensor library, and the dashboard tells a researcher when it has lost the service.
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { devVars, signIn } from "../fixtures/dashboard.ts";
import { asSensor, referenceClip, replay, silentWav, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService, secondServiceURL } from "../fixtures/service.ts";
import { webRoot } from "../ports.ts";

const seedSounds = JSON.parse(readFileSync(
  path.join(webRoot, "..", "sensor-sdk", "forestpulse_sensor", "data", "seed_sounds.json"), "utf8"));

const iso = (ms: number) => new Date(ms).toISOString();
const pad = (n: number) => String(n).padStart(2, "0");
const clockTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function logRows(page: Page, sensorId: string) {
  const res = await page.request.get("/dashboard/api/events");
  expect(res.status()).toBe(200);
  return ((await res.json()).events as any[]).filter((e) => e.sensor_id === sensorId);
}

function event(id: string, fields: Record<string, unknown> = {}) {
  return { event_id: id, detected_at: iso(Date.now() - 1000), sound_id: "chainsaw", confidence: 0.91, ...fields };
}

test("sensors get the contract's replies: sound list, duplicates, dropped, rejected, version, clock offset", async ({ page, request }) => {
  await signIn(page);
  const sensorId = uniqueSensorId("contract");

  // Check-in and the sound list: the seeded list, verbatim from the library's built-in one, at its version.
  const [checkin, sounds] = await asSensor(sensorId, [
    { call: "checkin", fields: { instance_id: "i-1", sdk_version: "0.1.0", model: "mn10_as", sound_list_version: null, queued_events: 0 } },
    { call: "sounds" },
  ]);
  expect(checkin.sound_list_version).toBe(seedSounds.version);
  expect(Math.abs(Date.parse(checkin.server_time) - Date.now())).toBeLessThan(5000);
  expect(sounds).toEqual(seedSounds);

  // One fixed batch posted twice through the library's client: accepted, then duplicate; one log row.
  const batch = [event("fixed-1", { angle_deg: 400, angle_confidence: 0.8 })];
  const [first, second] = await asSensor(sensorId, [
    { call: "post_events", events: batch },
    { call: "post_events", events: batch },
  ]);
  expect(first).toEqual({ results: [{ event_id: "fixed-1", status: "accepted" }], sound_list_version: seedSounds.version });
  expect(second).toEqual({ results: [{ event_id: "fixed-1", status: "duplicate" }], sound_list_version: seedSounds.version });
  const rows = await logRows(page, sensorId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sound_name: "Chainsaw", angle_deg: 40 }); // stored modulo 360

  // Unknown sounds are dropped, malformed events rejected with a reason, each in order.
  const [mixed] = await asSensor(sensorId, [{ call: "post_events", events: [
    event("owl-1", { sound_id: "boreal-owl" }),
    { event_id: "bad-1", sound_id: "chainsaw", confidence: 0.9 },
    event("bad-2", { confidence: 7 }),
    "not an event",
    event("ok-2"),
  ] }]);
  expect(mixed.sound_list_version).toBe(seedSounds.version);
  expect(mixed.results.map((r: any) => [r.event_id, r.status])).toEqual([
    ["owl-1", "dropped"], ["bad-1", "rejected"], ["bad-2", "rejected"], [null, "rejected"], ["ok-2", "accepted"],
  ]);
  for (const r of mixed.results.filter((r: any) => r.status === "rejected")) expect(r.reason).toBeTruthy();

  // A request malformed as a whole: more than 100 events, or not JSON.
  const [tooMany] = await asSensor(sensorId, [
    { call: "post_events", events: Array.from({ length: 101 }, (_, i) => event(`many-${i}`)) },
  ]);
  expect(tooMany.error).toBe("BadRequest");
  const notJson = await request.post(`/api/v1/sensors/${sensorId}/events`, {
    headers: { Authorization: `Bearer ${devVars().DEVICE_KEY}`, "Content-Type": "application/json" },
    data: "{not json",
  });
  expect(notJson.status()).toBe(400);

  // A wrong key gets the unauthorised reply on every endpoint.
  const refused = await asSensor(sensorId, [{ call: "checkin" }, { call: "sounds" }, { call: "post_events", events: [] }], "wrong-key");
  expect(refused.map((r) => r.error)).toEqual(["KeyRejected", "KeyRejected", "KeyRejected"]);

  // A sensor that never checked in can post events; its clock runs an hour behind, so its event's time is
  // corrected by the offset measured on the request.
  const lateId = uniqueSensorId("behind");
  const behind = 3600_000;
  const sentAt = Date.now() - behind;
  const res = await request.post(`/api/v1/sensors/${lateId}/events`, {
    headers: { Authorization: `Bearer ${devVars().DEVICE_KEY}` },
    data: { sent_at: iso(sentAt), events: [event("late-1", { detected_at: iso(sentAt - 2000) })] },
  });
  expect(await res.json()).toEqual({ results: [{ event_id: "late-1", status: "accepted" }], sound_list_version: seedSounds.version });
  const [late] = await logRows(page, lateId);
  const expected = Date.now() - 2000;
  expect(Math.abs(Date.parse(late.occurred_at) - expected)).toBeLessThan(3000);
  // The visible row shows the corrected time, not the sensor's clock.
  const times = [-2000, -1000, 0, 1000, 2000].map((d) => clockTime(expected + d));
  const lateRow = page.getByRole("row").filter({ hasText: lateId });
  await expect(lateRow).toHaveCount(1, { timeout: 3000 });
  expect(times).toContain((await lateRow.getByRole("cell").first().textContent()) ?? "");
});

test("a replay with a wrong key is refused, then delivered once the key is fixed", async ({ page }) => {
  await signIn(page);
  const sensorId = uniqueSensorId("key");
  const stateDir = path.join(mkdtempSync(path.join(os.tmpdir(), "fp-key-")), "state");

  const refused = await replay({ sensorId, wavs: [referenceClip("chainsaw.wav")], key: "wrong-key", stateDir });
  expect(refused).toContain("sensor key rejected");
  const queued = Number(refused.match(/done: (\d+) event\(s\) still queued/)?.[1]);
  expect(queued).toBeGreaterThan(0);
  expect(await logRows(page, sensorId)).toHaveLength(0);

  const fixed = await replay({ sensorId, wavs: [silentWav()], stateDir });
  expect(fixed).toContain("0 event(s) still queued");
  const rows = await logRows(page, sensorId);
  expect(rows).toHaveLength(queued);
  expect(rows.map((r) => r.sound_name)).toContain("Chainsaw");
  await expect(page.getByRole("row").filter({ hasText: sensorId }).first()).toBeVisible();
});

test("the dashboard shows when it has lost the service, and clears it when the service is back", async ({ page }) => {
  const service = new SecondService();
  await service.start();
  try {
    await signIn(page, "/dashboard/", secondServiceURL);
    await expect(page.getByText("No events yet")).toBeVisible(); // the first poll has landed
    const lost = page.getByText(/^Connection lost, last update \d{2}:\d{2}:\d{2}$/);
    await expect(lost).toBeHidden();

    const stoppedAt = Date.now();
    await service.stop();
    await expect(lost).toBeVisible({ timeout: Math.max(1000, 6500 - (Date.now() - stoppedAt)) });

    await service.start();
    await expect(lost).toBeHidden({ timeout: 6000 });
  } finally {
    await service.stop();
  }
});
