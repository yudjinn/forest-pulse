// Rehearsal of the teaching moment: the presenter's teaching pack, taught through the Teach page as on stage, makes
// the sensors report both of the player's boreal owls as Boreal owl, and not its tawny owl. The pack's recordings
// are by recordists the player's samples do not use.
// It runs on its own fresh service: teaching changes the sound list for every sensor. The pack is not in the
// repository (demo-kit/teaching_pack.py builds it on the presenting laptop), so on a machine without it the journey
// is skipped with the command that builds it.
import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/dashboard.ts";
import { replay, uniqueSensorId } from "../fixtures/sensor.ts";
import { SecondService } from "../fixtures/service.ts";
import { rehearsalServicePorts } from "../ports.ts";
import { buildTeachingPack, playerSample, teachingPack, teachingPackFolder, teachThePack } from "./rehearsal-steps.ts";

test("the teaching pack teaches Boreal owl on stage: the player's boreal owls are reported, its tawny owl is not",
  async ({ page, context }) => {
    const pack = teachingPack();
    test.skip(pack === null, `no teaching pack at ${teachingPackFolder}; build it with ${buildTeachingPack}`);
    test.setTimeout(300_000);
    const service = new SecondService(rehearsalServicePorts);
    await service.start();
    try {
      const origin = service.url;
      await signIn(page, "/dashboard/sounds/", origin);
      await teachThePack(page, origin, "Boreal owl", pack!);
      const sounds = await (await page.request.get(`${origin}/dashboard/api/sounds`)).json();

      // The phone plays each owl to its own sensor, as the speaker does near the boards on stage.
      const log = await context.newPage();
      await log.goto(`${origin}/dashboard/`);
      const heard: Record<string, string> = {};
      for (const sample of ["boreal-owl-1.wav", "boreal-owl-2.wav", "tawny-owl.wav"]) {
        const sensorId = uniqueSensorId(`rehearsal-${sample.replace(".wav", "")}`);
        const output = await replay({ sensorId, wavs: [playerSample(sample)], serverUrl: origin });
        expect(output).toMatch(new RegExp(`sound list ${sounds.version}: .*Boreal owl`));
        expect(output).toMatch(/^done: 0 event\(s\) still queued$/m);
        heard[sample] = sensorId;
      }
      for (const sample of ["boreal-owl-1.wav", "boreal-owl-2.wav"]) {
        await expect(log.getByRole("row").filter({ hasText: heard[sample] }).filter({ hasText: "Boreal owl" }).first())
          .toBeVisible({ timeout: 5000 });
      }
      await log.waitForTimeout(2500); // one more poll of the log
      await expect(log.getByRole("row").filter({ hasText: heard["tawny-owl.wav"] }).filter({ hasText: "Boreal owl" }))
        .toHaveCount(0);
    } finally {
      await service.stop();
    }
  });
