// Focused test of where a sound came from (no browser, no service): the direction from a sensor's facing and the
// event's angle, where two lines cross, and which earlier event a new one pairs with.
import { expect, test } from "@playwright/test";
import { choosePartner, crossing, directionDeg } from "../../src/location/geometry.ts";

const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);

test("a direction is the sensor's facing plus the event's angle, normalised to 0 to under 360", () => {
  expect(directionDeg(90, 315)).toBe(45);
  expect(directionDeg(270, 135)).toBe(45);
  expect(directionDeg(0, -30)).toBe(330);
  expect(directionDeg(350, 730)).toBe(0);
});

test("two lines cross in front of both sensors at the right point and distances, in every direction", () => {
  // Facing each other 3 m apart, both turned up: they meet at (1, 1).
  const hit = crossing({ x_m: 0, y_m: 0, deg: 45 }, { x_m: 3, y_m: 0, deg: 360 - (Math.atan2(2, 1) * 180) / Math.PI })!;
  close(hit.x_m, 1);
  close(hit.y_m, 1);
  close(hit.distance_a_m, Math.SQRT2);
  close(hit.distance_b_m, Math.sqrt(5));

  // The same point heard from four sides, each pair crossing where expected.
  const target = { x: -2, y: 5 };
  const from = [{ x: 0, y: 0 }, { x: -6, y: 1 }, { x: 4, y: 9 }, { x: -2, y: 12 }];
  const lines = from.map((s) => ({
    x_m: s.x, y_m: s.y, deg: ((Math.atan2(target.x - s.x, target.y - s.y) * 180) / Math.PI + 360) % 360,
  }));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = crossing(lines[i], lines[j])!;
      close(p.x_m, target.x);
      close(p.y_m, target.y);
      close(p.distance_a_m, Math.hypot(target.x - from[i].x, target.y - from[i].y));
      close(p.distance_b_m, Math.hypot(target.x - from[j].x, target.y - from[j].y));
    }
  }
});

test("parallel lines, lines that meet behind a sensor, and sensors on one spot give no point", () => {
  // Parallel, side by side and along one line.
  expect(crossing({ x_m: 0, y_m: 0, deg: 0 }, { x_m: 3, y_m: 0, deg: 0 })).toBeNull();
  expect(crossing({ x_m: 0, y_m: 0, deg: 90 }, { x_m: 3, y_m: 0, deg: 270 })).toBeNull();
  expect(crossing({ x_m: 0, y_m: 0, deg: 0 }, { x_m: 3, y_m: 0, deg: 180 })).toBeNull();
  // Diverging: the lines meet at (1.5, -1.5), behind both sensors.
  expect(crossing({ x_m: 0, y_m: 0, deg: 315 }, { x_m: 3, y_m: 0, deg: 45 })).toBeNull();
  // In front of one sensor only.
  expect(crossing({ x_m: 0, y_m: 0, deg: 45 }, { x_m: 3, y_m: 0, deg: 45 + 90 })).toBeNull();
  // Both at one spot.
  expect(crossing({ x_m: 1, y_m: 1, deg: 0 }, { x_m: 1, y_m: 1, deg: 90 })).toBeNull();
});

test("with three or more sensors the partner is the highest angle confidence, else the most recent", () => {
  const t = 1_700_000_000_000;
  expect(choosePartner([])).toBeNull();
  // Confidence wins over recency.
  expect(choosePartner([
    { id: 1, angle_confidence: 0.4, occurred_at: t + 2000 },
    { id: 2, angle_confidence: 0.9, occurred_at: t },
    { id: 3, angle_confidence: 0.6, occurred_at: t + 1000 },
  ])?.id).toBe(2);
  // None gives a confidence: the most recent by corrected time, whatever the delivery order.
  expect(choosePartner([
    { id: 7, angle_confidence: null, occurred_at: t + 500 },
    { id: 5, angle_confidence: null, occurred_at: t + 2500 },
    { id: 6, angle_confidence: null, occurred_at: t },
  ])?.id).toBe(5);
  // One with a confidence ranks above those without; equal confidences go to the most recent.
  expect(choosePartner([
    { id: 1, angle_confidence: null, occurred_at: t + 2000 },
    { id: 2, angle_confidence: 0.1, occurred_at: t },
  ])?.id).toBe(2);
  expect(choosePartner([
    { id: 1, angle_confidence: 0.5, occurred_at: t },
    { id: 2, angle_confidence: 0.5, occurred_at: t + 100 },
  ])?.id).toBe(2);
});
