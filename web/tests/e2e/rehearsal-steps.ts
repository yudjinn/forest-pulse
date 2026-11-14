// Steps of the stage rehearsal, shared by the local rehearsal journey and the live one: find the presenter's teaching
// pack on this laptop and teach it through the Teach page, as the presenter does on stage.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { webRoot } from "../ports.ts";

const repoRoot = path.resolve(webRoot, "..");

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
