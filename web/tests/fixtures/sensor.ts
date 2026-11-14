// Sensor-side helpers for journeys: the sensor library's replay command and its HTTP client, run from the
// repository's Python environment (.venv, made by scripts/worktree-setup.sh) against the local service.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type APIRequestContext } from "@playwright/test";
import { baseURL, webRoot } from "../ports.ts";
import { devVars } from "./dashboard.ts";

const run = promisify(execFile);
const repoRoot = path.resolve(webRoot, "..");
const python = path.join(repoRoot, ".venv", "bin", "python");
export const referenceClip = (name: string) =>
  path.join(repoRoot, "sensor-sdk", "forestpulse_sensor", "data", "reference", name);

// A sensor id no other journey or run uses.
export function uniqueSensorId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// The name researchers see for a sensor, read from the plan of the service at origin (the request's own base URL
// when empty): "Sensor N" while it is on the plan, its own id otherwise. Journeys look a name up here, never assume a
// number: on the shared service the numbers depend on which journeys ran first.
export async function sensorName(request: APIRequestContext, id: string, origin = ""): Promise<string> {
  const res = await request.get(`${origin}/dashboard/api/sensors`);
  expect(res.status(), "GET /dashboard/api/sensors").toBe(200);
  const { sensors } = await res.json() as { sensors: { id: string; name: string }[] };
  return sensors.find((s) => s.id === id)?.name ?? id;
}

export interface ReplayOptions {
  sensorId: string;
  wavs: string[];
  angle?: number;
  key?: string;
  // Keep the sensor's queue and sound list across replays by passing the same directory.
  stateDir?: string;
  serverUrl?: string;
  // Moves the library's wall clock by this many seconds (negative is behind): a sensor whose clock is wrong.
  clockShiftS?: number;
}

// Runs `python -m forestpulse_sensor.replay --config <toml>` and returns its output once the sensor has stopped.
export async function replay(o: ReplayOptions): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fp-replay-"));
  const config = path.join(dir, "sensor.toml");
  writeFileSync(config, [
    `server_url = ${JSON.stringify(o.serverUrl ?? baseURL)}`,
    `sensor_key = ${JSON.stringify(o.key ?? devVars().DEVICE_KEY)}`,
    `sensor_id = ${JSON.stringify(o.sensorId)}`,
    `state_dir = ${JSON.stringify(o.stateDir ?? path.join(dir, "state"))}`,
    "checkin_interval = 1.0",
  ].join("\n") + "\n");
  const command = o.clockShiftS === undefined
    ? ["-m", "forestpulse_sensor.replay"]
    : [path.join(webRoot, "tests", "fixtures", "shifted_clock.py"), String(o.clockShiftS)];
  const args = [...command, "--config", config];
  if (o.angle !== undefined) args.push("--angle", String(o.angle));
  const { stdout, stderr } = await run(python, [...args, ...o.wavs], { timeout: 90_000 });
  return stdout + stderr;
}

export type SensorCall =
  | { call: "checkin"; fields?: Record<string, unknown> }
  | { call: "sounds" }
  | { call: "post_events"; events: unknown[] };

// Makes the calls in order through the library's own client (forestpulse_sensor.api.Api), one reply per call.
export async function asSensor(sensorId: string, calls: SensorCall[], key = devVars().DEVICE_KEY,
  serverUrl = baseURL): Promise<any[]> {
  const child = run(python, [path.join(webRoot, "tests", "fixtures", "sensor_client.py"), serverUrl, key, sensorId],
    { timeout: 30_000 });
  child.child.stdin!.end(JSON.stringify(calls));
  return JSON.parse((await child).stdout);
}

// A silent 16-bit mono WAV: a replay that hears nothing, so only already-queued events are delivered.
export function silentWav(seconds = 2, rate = 48_000): string {
  const frames = seconds * rate;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * 2, 40);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "fp-silence-")), "silence.wav");
  writeFileSync(file, buf);
  return file;
}
