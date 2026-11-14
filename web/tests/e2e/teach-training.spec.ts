// Focused check: the training the teach request runs separates a known separable set of summaries, with the
// standardisation folded into the weights, so a sensor's plain weights . summary + bias scores raw summaries.
import { expect, test } from "@playwright/test";
import { DIM, trainDetector } from "../../src/teach/train.ts";

// Deterministic pseudo-random numbers (mulberry32), so the set is the same on every run.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rows like real summaries: every dimension with its own offset and spread (one constant), the two classes apart
// along a few dimensions only, by less than those dimensions' spread in raw units.
function summaries(rows: number, positive: boolean, next: () => number): Float32Array {
  const out = new Float32Array(rows * DIM);
  for (let r = 0; r < rows; r++) {
    for (let j = 0; j < DIM; j++) {
      const offset = 3 + (j % 7);
      const spread = j % 3 === 0 ? 0.01 : 2;
      const shift = j < 12 && j % 3 === 0 ? (positive ? 0.005 : -0.005) : 0; // tiny in raw units
      out[r * DIM + j] = j === DIM - 1 ? 1 : offset + shift + spread * (next() - 0.5) * 0.2;
    }
  }
  return out;
}

test("training separates a separable set and scores raw summaries with plain weights and bias", () => {
  const next = random(7);
  const positives = summaries(40, true, next);
  const negatives = summaries(400, false, next);
  const detector = trainDetector(positives, negatives);
  expect(detector.weights).toHaveLength(DIM);
  expect(detector.weights.every(Number.isFinite)).toBe(true);
  const confidence = (rows: Float32Array, i: number) => {
    let z = detector.bias;
    for (let j = 0; j < DIM; j++) z += detector.weights[j] * rows[i * DIM + j];
    return 1 / (1 + Math.exp(-z));
  };
  for (let i = 0; i < 40; i++) expect(confidence(positives, i)).toBeGreaterThan(0.5);
  for (let i = 0; i < 400; i++) expect(confidence(negatives, i)).toBeLessThan(0.5);

  // Rows it never saw, drawn the same way, are separated too.
  const heldPositives = summaries(20, true, next);
  const heldNegatives = summaries(20, false, next);
  for (let i = 0; i < 20; i++) {
    expect(confidence(heldPositives, i)).toBeGreaterThan(0.5);
    expect(confidence(heldNegatives, i)).toBeLessThan(0.5);
  }
});
