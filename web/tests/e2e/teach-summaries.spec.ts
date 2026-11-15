// Focused check: the browser's summaries match the sensor's. The teach page's own module decodes the sensor
// library's reference clips with the browser's decoder and runs the site's model file through ONNX Runtime's
// WebAssembly build; each embedding must match the library's expected one (cosine similarity above 0.999).
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/dashboard.ts";
import { referenceClip } from "../fixtures/sensor.ts";

const CLIPS = ["chainsaw.wav", "hall.wav", "rain.wav"];

test("the browser computes the same summaries as the sensor library", async ({ page }) => {
  test.setTimeout(120_000);
  const expected = JSON.parse(readFileSync(referenceClip("expected.json"), "utf8")) as
    Record<string, { embedding: number[] }>;
  await page.route("**/dashboard/teach/reference/*", (route) =>
    route.fulfill({ body: readFileSync(referenceClip(route.request().url().split("/").pop()!)), contentType: "audio/wav" }));
  await signIn(page);

  const got = await page.evaluate(async (clips) => {
    const module = "/dashboard/teach/summaries.js";
    const m = await import(module);
    const out: Record<string, number[]> = {};
    for (const name of clips) {
      const { audio: native, rate } = await m.decode(await (await fetch(`/dashboard/teach/reference/${name}`)).arrayBuffer());
      const r0 = performance.now();
      const audio = m.toModelRate(native, rate);
      console.log(`${name}: ${rate} Hz, resampled in ${(performance.now() - r0).toFixed(0)} ms`);
      const t0 = performance.now();
      out[name] = Array.from(await m.summarise(audio));
      console.log(`${name}: ${(performance.now() - t0).toFixed(0)} ms`);
    }
    return out;
  }, CLIPS);

  for (const name of CLIPS) {
    const a = got[name];
    const b = expected[name].embedding;
    expect(a).toHaveLength(960);
    const dot = a.reduce((s, v, i) => s + v * b[i], 0);
    const cos = dot / (Math.hypot(...a) * Math.hypot(...b));
    expect(cos, `${name}: cosine similarity with the sensor's embedding`).toBeGreaterThan(0.999);
  }
});
