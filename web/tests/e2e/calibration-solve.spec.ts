// Focused test of solving a calibration run (no browser, no service): the rules no journey reaches. Weak detections
// and invalid rounds never count, a pair needs two valid rounds with at least one in each order, and the two orders
// must agree within 15 cm. Facings come from the mutual bearings: the circular median each way, across 0/360, from
// at least two bearings that scatter by at most 15 degrees.
import { expect, test } from "@playwright/test";
import { type Participant, type ReportRound, parseReport, solve } from "../../src/calibration/solve.ts";

const FS = 48_000;
const C = 343;

// Two boards' rounds as they would report them for a true distance d: A beeps then B 500 ms later in even rounds,
// B then A in odd ones. Each board's stream starts somewhere of its own, and B's clock is unrelated to A's. angleA is
// A's bearing of B's beep and angleB B's of A's (by default 0: A faces right, B faces left).
type Round = { d: number; valid?: boolean; weak?: boolean; angleA?: number | null; angleB?: number | null };
function pair(rounds: Round[], sA = 0.05, sB = 0.08, fallback = false): [Participant, Participant] {
  const ra: ReportRound[] = [];
  const rb: ReportRound[] = [];
  rounds.forEach(({ d, valid = true, weak = false, angleA = 0, angleB = 0 }, r) => {
    const tA = r * 2 + (r % 2 ? 0.5 : 0); // when A beeps, true seconds
    const tB = r * 2 + (r % 2 ? 0 : 0.5);
    const inA = (t: number) => 12_345.6 + t * FS;
    const inB = (t: number) => 987_654.3 + (t + 7.25) * FS;
    const det = (emitter: string, own: boolean, position: number, angle: number | null = null) =>
      ({ emitter, own, position, snr_db: 40, weak, angle_deg: angle, angle_quality: angle === null ? null : 0.9 });
    ra.push({ round: r, valid, problems: valid ? [] : ["break"], detections: [
      det("A", true, inA(tA + sA / C)), det("B", false, inA(tB + d / C), angleA)] });
    rb.push({ round: r, valid: true, problems: [], detections: [
      det("B", true, inB(tB + sB / C)), det("A", false, inB(tA + d / C), angleB)] });
  });
  const report = (role: string, rs: ReportRound[], s: number, fb: boolean) => ({
    role, fs: FS, speed_of_sound: C, speed_of_sound_fallback: fb, emitter_offset_m: s, errors: [], rounds: rs,
  });
  return [
    { sensor_id: "a", role: "A", report: report("A", ra, sA, false) },
    { sensor_id: "b", role: "B", report: report("B", rb, sB, fallback) },
  ];
}

test("two-way ranging with emitter offsets places the second sensor straight to the right of the first", () => {
  const solution = solve(pair([{ d: 3 }, { d: 3 }, { d: 3 }, { d: 3 }]));
  expect(solution).toEqual({
    ok: true,
    distances: [{ a: "a", b: "b", distance_m: 3 }],
    positions: [{ sensor_id: "a", x_m: 0, y_m: 0, facing_deg: 90 }, { sensor_id: "b", x_m: 3, y_m: 0, facing_deg: 270 }],
    speed_of_sound_assumed: false,
  });
  // the median over the valid rounds, and a board that assumed the speed of sound says so
  const median = solve(pair([{ d: 2.98 }, { d: 3.02 }, { d: 3.0 }, { d: 3.1 }], 0.05, 0.08, true));
  expect(median.ok && median.distances[0].distance_m).toBe(3.01);
  expect(median.ok && median.speed_of_sound_assumed).toBe(true);
});

test("weak detections and invalid rounds never count, and a pair needs two valid rounds in both orders", () => {
  // the wild rounds are weak or invalid, so only the two good ones count
  const kept = solve(pair([{ d: 3 }, { d: 3 }, { d: 9, weak: true }, { d: 9, valid: false }]));
  expect(kept.ok && kept.distances[0].distance_m).toBe(3);
  const notRepeatable = { ok: false, sensors: ["a", "b"], reason: "not_repeatable" };
  // one valid round
  expect(solve(pair([{ d: 3 }, { d: 3, weak: true }, { d: 3, valid: false }, { d: 3, weak: true }])))
    .toEqual(notRepeatable);
  // only forward rounds
  expect(solve(pair([{ d: 3 }, { d: 3, weak: true }, { d: 3 }, { d: 3, valid: false }]))).toEqual(notRepeatable);
});

test("the forward and reverse orders must agree within 15 cm", () => {
  expect(solve(pair([{ d: 3 }, { d: 3.14 }, { d: 3 }, { d: 3.14 }])).ok).toBe(true);
  expect(solve(pair([{ d: 3 }, { d: 3.16 }, { d: 3 }, { d: 3.16 }])))
    .toEqual({ ok: false, sensors: ["a", "b"], reason: "not_repeatable" });
});

test("facings turn each board's median bearing of the other onto the line between them", () => {
  // A faces about 30 (it hears B about 60 clockwise of its forward); B faces about 273, its bearings of A either side
  // of its forward: the median over the four rounds, unwrapped across 0/360
  const turned = solve(pair([
    { d: 3, angleA: 58, angleB: 356 }, { d: 3, angleA: 61, angleB: 2 },
    { d: 3, angleA: 62, angleB: 354 }, { d: 3, angleA: 60, angleB: 358 },
  ]));
  expect(turned.ok && turned.positions.map((p) => p.facing_deg)).toEqual([29.5, 273]);
  // an invalid round's bearing never counts: two bearings are enough
  const kept = solve(pair([
    { d: 3, angleA: 60 }, { d: 3, angleA: null }, { d: 3, angleA: 60 }, { d: 3, angleA: 200, valid: false },
  ]));
  expect(kept.ok && kept.positions.map((p) => p.facing_deg)).toEqual([30, 270]);
  // a spread of about 13 degrees passes
  expect(solve(pair([{ d: 3, angleA: 42 }, { d: 3, angleA: 60 }, { d: 3, angleA: 78 }, { d: 3, angleA: 60 }])).ok)
    .toBe(true);
});

test("too few bearings either way, or bearings that disagree, fail the run naming the pair", () => {
  const noDirection = { ok: false, sensors: ["a", "b"], reason: "no_direction" };
  // B could tell only once
  expect(solve(pair([{ d: 3, angleB: null }, { d: 3, angleB: null }, { d: 3, angleB: null }, { d: 3, angleB: 10 }])))
    .toEqual(noDirection);
  // A's bearings scatter by about 18 degrees
  expect(solve(pair([{ d: 3, angleA: 35 }, { d: 3, angleA: 60 }, { d: 3, angleA: 85 }, { d: 3, angleA: 60 }])))
    .toEqual(noDirection);
  // a pair whose distance is not repeatable fails for that first
  expect(solve(pair([{ d: 3, angleA: null }, { d: 3.3, angleA: null }, { d: 3 }, { d: 3.3 }])))
    .toEqual({ ok: false, sensors: ["a", "b"], reason: "not_repeatable" });
});

test("a report is refused when a field the solver needs is missing or out of range", () => {
  const [a] = pair([{ d: 3 }]);
  expect(parseReport({ ...a.report })).toEqual(a.report);
  expect(parseReport({ ...a.report, speed_of_sound: 500 })).toBe("speed_of_sound must be from 300 to 380");
  expect(parseReport({ ...a.report, rounds: [{ round: 0, valid: true, problems: [], detections: [{ emitter: "A" }] }] }))
    .toBe("a detection needs emitter, own and weak");
});
