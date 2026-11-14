// Focused test of solving a calibration run (no browser, no service): the rules no journey reaches. Weak detections
// and invalid rounds never count, a pair needs two valid rounds with at least one in each order, and the two orders
// must agree within 15 cm. Facings come from the mutual bearings: the circular median each way, across 0/360, from
// at least two bearings that scatter by at most 15 degrees. Three sensors: the triangle's geometry (both mirror
// images, too flat, impossible, bearings against the distances) and an outlier round the median rejects.
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

// Three boards' reports for boards standing at the given spots (plan metres, facings clockwise from up): round r plays
// A, B, C forward when r is even and reversed when odd, a slot each 500 ms apart. Every board hears every beep after
// its true distance (or the one given for that side), `extra(listener, emitter, round)` metres of distance added to
// chosen arrivals, and reports the bearing its true position and facing give (or what `angle` answers instead).
type Spot = { x: number; y: number; facing: number };
type Roles = "A" | "B" | "C";
function trio(at: Record<Roles, Spot>, { rounds = 4, sides = {}, angle, extra }: {
  rounds?: number;
  sides?: Partial<Record<"AB" | "AC" | "BC", number>>;
  angle?: (listener: Roles, emitter: Roles, truth: number, round: number) => number | null;
  extra?: (listener: Roles, emitter: Roles, round: number) => number;
} = {}): Participant[] {
  const roles: Roles[] = ["A", "B", "C"];
  const s = { A: 0.05, B: 0.08, C: 0.03 };
  const streamAt = { A: 12_345.6, B: 987_654.3, C: 55_555.5 };
  const distance = (l: Roles, e: Roles) => sides[[l, e].sort().join("") as "AB"]
    ?? Math.hypot(at[e].x - at[l].x, at[e].y - at[l].y);
  const truth = (l: Roles, e: Roles) =>
    ((((Math.atan2(at[e].x - at[l].x, at[e].y - at[l].y) * 180) / Math.PI - at[l].facing) % 360) + 360) % 360;
  return roles.map((l) => {
    const rs: ReportRound[] = [];
    for (let r = 0; r < rounds; r++) {
      const order = r % 2 ? [...roles].reverse() : roles;
      const beep = (e: Roles) => r * 2.5 + order.indexOf(e) * 0.5;
      const inL = (t: number) => streamAt[l] + t * FS;
      rs.push({ round: r, valid: true, problems: [], detections: roles.map((e) => {
        if (e === l) {
          return { emitter: e, own: true, position: inL(beep(e) + s[e] / C), snr_db: 40, weak: false,
            angle_deg: null, angle_quality: null };
        }
        const heard = beep(e) + (distance(l, e) + 2 * (extra?.(l, e, r) ?? 0)) / C;
        const a = angle ? angle(l, e, truth(l, e), r) : truth(l, e);
        return { emitter: e, own: false, position: inL(heard), snr_db: 40, weak: false,
          angle_deg: a, angle_quality: a === null ? null : 0.9 };
      }) });
    }
    return { sensor_id: l.toLowerCase(), role: l, report: {
      role: l, fs: FS, speed_of_sound: C, speed_of_sound_fallback: false, emitter_offset_m: s[l], errors: [], rounds: rs,
    } };
  });
}

// Sides of 3 m (a-b), 2.5 m (a-c) and 2 m (b-c), each board turned its own way, c above the line from a to b.
const triangle = {
  A: { x: 0, y: 0, facing: 30 }, B: { x: 3, y: 0, facing: 200 }, C: { x: 1.875, y: Math.sqrt(2.5 ** 2 - 1.875 ** 2), facing: 120 },
};
const below = { ...triangle, C: { ...triangle.C, y: -triangle.C.y } };

function expectPlaced(solution: ReturnType<typeof solve>, at: Record<Roles, Spot>, metres: number, degrees: number) {
  expect(solution.ok, JSON.stringify(solution)).toBe(true);
  if (!solution.ok) return;
  for (const p of solution.positions) {
    const truth = at[p.sensor_id.toUpperCase() as Roles];
    expect(Math.hypot(p.x_m - truth.x, p.y_m - truth.y), JSON.stringify(p)).toBeLessThanOrEqual(metres);
    expect(Math.abs((((p.facing_deg - truth.facing) % 360) + 540) % 360 - 180), JSON.stringify(p))
      .toBeLessThanOrEqual(degrees);
  }
}

test("three sensors are placed as a triangle, the third on the side of the line its bearings give", () => {
  const solution = solve(trio(triangle));
  expectPlaced(solution, triangle, 0.002, 0.1);
  expect(solution.ok && solution.distances).toEqual([
    { a: "a", b: "b", distance_m: 3 }, { a: "a", b: "c", distance_m: 2.5 }, { a: "b", b: "c", distance_m: 2 },
  ]);
  expect(solution.ok && solution.positions.slice(0, 2).map((p) => p.y_m)).toEqual([0, 0]);
  // the mirror image: the same distances, c below the line
  expectPlaced(solve(trio(below)), below, 0.002, 0.1);
  // bearings off by up to 6 degrees still place every board within 10 cm and 5 degrees
  const noise = [4, -6, 2, -3, 5, -1];
  expectPlaced(solve(trio(triangle, { angle: (l, e, t, r) => t + noise[(r * 3 + l.charCodeAt(0) + e.charCodeAt(0)) % 6] })),
    triangle, 0.1, 5);
});

test("an outlier round is rejected by the median when each order has three rounds", () => {
  // c hears b 1 m too far in one forward round of six
  const outlier = (l: Roles, e: Roles, r: number) => (l === "C" && e === "B" && r === 2 ? 1 : 0);
  const solution = solve(trio(triangle, { rounds: 6, extra: outlier }));
  expectPlaced(solution, triangle, 0.002, 0.1);
  expect(solution.ok && solution.distances[2].distance_m).toBe(2);
  // with two rounds in each order, as a run schedules, the same outlier makes the side not repeatable
  expect(solve(trio(triangle, { extra: outlier }))).toEqual({ ok: false, sensors: ["b", "c"], reason: "not_repeatable" });
});

test("a triangle too flat, impossible, or whose bearings contradict the distances fails naming the worst pair", () => {
  // c nearly on the line from a to b: the smallest angle is b's, and the side opposite it a-c is named
  const flat = { ...triangle, C: { x: 1.2, y: 0.15, facing: 120 } };
  expect(solve(trio(flat))).toEqual({ ok: false, sensors: ["a", "c"], reason: "too_flat" });
  // a-b longer than a-c and b-c together
  expect(solve(trio(triangle, { sides: { AB: 3, AC: 1.2, BC: 1.5 } })))
    .toEqual({ ok: false, sensors: ["a", "b"], reason: "not_a_triangle" });
  // a hears c 40 degrees from where it is: a's facing shares the error between both of a's bearings, so the pair the
  // fit fits worst holds a, here with b
  const offAtA = solve(trio(triangle, { angle: (l, e, t) => (l === "A" && e === "C" ? t + 40 : t) }));
  expect(offAtA).toEqual({ ok: false, sensors: ["a", "b"], reason: "bearings_disagree" });
  // every board hears the other two from the same direction: neither side of the line fits better, and b-c, between
  // the two largest angles, is fitted worst
  expect(solve(trio(triangle, { angle: () => 0 }))).toEqual({ ok: false, sensors: ["b", "c"], reason: "bearings_disagree" });
  // c can never tell where b is
  expect(solve(trio(triangle, { angle: (l, e, t) => (l === "C" && e === "B" ? null : t) })))
    .toEqual({ ok: false, sensors: ["b", "c"], reason: "no_direction" });
});

test("a report is refused when a field the solver needs is missing or out of range", () => {
  const [a] = pair([{ d: 3 }]);
  expect(parseReport({ ...a.report })).toEqual(a.report);
  expect(parseReport({ ...a.report, speed_of_sound: 500 })).toBe("speed_of_sound must be from 300 to 380");
  expect(parseReport({ ...a.report, rounds: [{ round: 0, valid: true, problems: [], detections: [{ emitter: "A" }] }] }))
    .toBe("a detection needs emitter, own and weak");
});
