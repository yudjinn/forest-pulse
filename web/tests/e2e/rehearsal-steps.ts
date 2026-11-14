// Steps of the stage rehearsal: where it runs, signing in, the presenter's teaching pack taught through the Teach page
// as on stage, and sensors hearing one sound at the same moment.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { devVars } from "../fixtures/dashboard.ts";
import { webRoot } from "../ports.ts";

const repoRoot = path.resolve(webRoot, "..");
const run = promisify(execFile);
const python = path.join(repoRoot, ".venv", "bin", "python");

// The live site's address when the rehearsal runs against it (FP_REHEARSAL_ORIGIN=https://forestpulse.paxid.com);
// otherwise it runs on a fresh local service.
export const liveOrigin = process.env.FP_REHEARSAL_ORIGIN?.replace(/\/+$/, "") || null;
// With FP_REQUIRE_TEACHING_PACK=1 a missing pack fails the rehearsal instead of skipping it, so a run without the pack
// cannot pass as proof. The live rehearsal always requires it.
export const packRequired = process.env.FP_REQUIRE_TEACHING_PACK === "1" || liveOrigin !== null;

// The dashboard password and sensor key for where the rehearsal runs: the live ones from the untracked
// .dev-secrets.local at the repository root, read literally (never through a shell, which would expand them), or the
// local dev ones.
export function rehearsalSecrets(): { password: string; key: string } {
  if (liveOrigin === null) return { password: devVars().DASHBOARD_PASSWORD, key: devVars().DEVICE_KEY };
  const file = path.join(repoRoot, ".dev-secrets.local");
  const vars = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) vars.set(line.slice(0, at).trim(), line.slice(at + 1).replace(/\r$/, ""));
  }
  const password = vars.get("DASHBOARD_PASSWORD");
  const key = vars.get("DEVICE_KEY");
  if (!password || !key) throw new Error(`${file} has no DASHBOARD_PASSWORD or DEVICE_KEY`);
  return { password, key };
}

// Opens a dashboard page signed out, signs in with `password` and waits to be back on that page.
export async function signInWith(page: Page, origin: string, password: string, dashboardPath = "/dashboard/") {
  await page.goto(origin + dashboardPath);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(origin + dashboardPath);
}

// One step of the demo script. Its result is printed as it ends, and a failure names the step and what it expected.
export async function demoStep<T>(name: string, expected: string, body: () => Promise<T>): Promise<T> {
  return test.step(name, async () => {
    try {
      const result = await body();
      console.log(`rehearsal step ok: ${name}`);
      return result;
    } catch (e) {
      console.log(`rehearsal step FAILED: ${name}: expected ${expected}`);
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Rehearsal step "${name}" failed: expected ${expected}.\n${reason}`, { cause: e });
    }
  });
}

// The pack folder: $FP_TEACHING_PACK, else where demo-kit/teaching_pack.py writes it by default.
export const teachingPackFolder = process.env.FP_TEACHING_PACK || path.join(os.homedir(), "Desktop", "Boreal owl teaching pack");
// The script's committed report: every size tried and the chosen pack's credits.
export const teachingPackReport = path.join(repoRoot, "demo-kit", "teaching_pack.json");
export const buildTeachingPack =
  "uv run --project experiments/efficientat-chainsaw python demo-kit/teaching_pack.py (from the repository root)";

export interface TeachingPack {
  folder: string;
  // Absolute paths of the pack's clips, in the report's order.
  files: string[];
  size: number;
}

// The pack on this laptop, or null when it has not been built here. A folder that is not the reported pack fails.
export function teachingPack(): TeachingPack | null {
  if (!existsSync(teachingPackFolder)) return null;
  const report = JSON.parse(readFileSync(teachingPackReport, "utf8"));
  const expected: string[] = report.pack.map((clip: { file: string }) => clip.file);
  expect(report.chosen_size, "the committed report chose a pack size").toBe(expected.length);
  const present = readdirSync(teachingPackFolder).filter((f) => !f.startsWith(".")).sort();
  expect(present, `${teachingPackFolder} holds exactly the reported pack; rebuild it with ${buildTeachingPack}`)
    .toEqual([...expected].sort());
  return { folder: teachingPackFolder, files: expected.map((f) => path.join(teachingPackFolder, f)), size: expected.length };
}

// Teaches a sound from the pack through the Teach page, reached from the Sounds page as on stage, and waits for it
// to be listed switched on. The page must be signed in on `origin`.
export async function teachThePack(page: Page, origin: string, name: string, pack: TeachingPack) {
  await page.goto(`${origin}/dashboard/sounds/`);
  await page.getByRole("link", { name: "Teach a new sound" }).click();
  await expect(page).toHaveURL(`${origin}/dashboard/teach/`);
  await page.getByLabel("Name").fill(name);
  await expect(page.getByLabel("Category")).toHaveValue("wildlife");
  await page.getByLabel("Recordings").setInputFiles(pack.files);
  // Recordings are summarised in turn in the browser, 12 windows clean and mixed for each 60 s clip.
  for (const file of pack.files) {
    await expect(page.getByRole("listitem").filter({ hasText: path.basename(file) }))
      .toContainText("Ready", { timeout: 60_000 });
  }
  await page.getByRole("button", { name: "Teach" }).click();
  await expect(page).toHaveURL(`${origin}/dashboard/sounds/`, { timeout: 60_000 });
  await expect(page.getByRole("switch", { name, exact: true })).toBeChecked();
}

// A player sample: the recordings the presenter's phone plays to the sensors on stage.
export const playerSample = (file: string) => path.join(webRoot, "bucket", "player", file);

export interface ListeningSensor {
  id: string;
  angle: number;
  // The sensor's state folder, kept across its replays so it stays one device.
  stateDir: string;
}

// Each sensor replays `wav` with its angle; their detections are held until all of them have one and until release()
// is called, then stamped with that moment, as sensors listening live would stamp them (location_replay.py).
export function hearTogether(origin: string, key: string, sensors: ListeningSensor[], wav: string) {
  const barrier = mkdtempSync(path.join(os.tmpdir(), "fp-rehearsal-"));
  const together = path.join(webRoot, "tests", "e2e", "location_replay.py");
  let failed: unknown = null;
  const runs = Promise.all(sensors.map((s, i) => {
    const config = path.join(barrier, `${i}.toml`);
    writeFileSync(config, [
      `server_url = ${JSON.stringify(origin)}`,
      `sensor_key = ${JSON.stringify(key)}`,
      `sensor_id = ${JSON.stringify(s.id)}`,
      `state_dir = ${JSON.stringify(s.stateDir)}`,
      "checkin_interval = 1.0",
    ].join("\n") + "\n");
    return run(python, [together, barrier, String(i), "--config", config, "--angle", String(s.angle), wav],
      { timeout: 120_000 });
  })).catch((e) => {
    failed = e;
  });
  return {
    // Waits until every sensor has heard it, lets them all report it now, and waits for the replays to finish.
    async release() {
      const deadline = Date.now() + 100_000;
      while (!sensors.every((_, i) => existsSync(path.join(barrier, `${i}.ready`)))) {
        if (failed) throw failed;
        if (Date.now() > deadline) throw new Error("the sensors never heard the sound");
        await new Promise((r) => setTimeout(r, 50));
      }
      writeFileSync(path.join(barrier, "go"), "");
      await runs;
      if (failed) throw failed;
    },
  };
}
