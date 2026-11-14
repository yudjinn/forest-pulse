// Turning a calibration run's reports into a layout (docs/device-api.md, "Calibration report"). Distances come from
// two-way ranging on where each board heard each beep in its own continuous stream, so no clock enters the maths:
//   d(i, j) = c/2 * [(t_i(j) - t_i(i)) - (t_j(j) - t_j(i))] + (s_i + s_j)/2
// t_k(m): where board k heard board m's beep, seconds of k's own stream; c: the two boards' mean reported speed of
// sound; s: their emitter offsets. The layout is relative to the sensors: the first participant (plan order) at the
// origin, the second straight to its right, a third where the distances and the bearings put it (solveTriangle).
// The result is the mean of each buzzer's distance to the other board's array: exact when the buzzers sit square to the
// line between the boards, short or long by up to their offsets when one points toward or away from the other.
//
// Facings come from the pair's mutual bearings (each board's angle of the other's beep, clockwise from its forward):
// a's plan direction to b must be 90 (b is straight to its right) and b's to a 270, so
//   facing_a = 90 - angle_a(b),  facing_b = 270 - angle_b(a)   (mod 360)
// each the circular median over the board's valid rounds. Two sensors without both facings (too few bearings, or
// scattered) still calibrate their distance: the solution then has no facings (null), and the run keeps the facings
// set by hand and moves the second sensor along the plan's line from the first (calibration.ts).
//
// Three sensors: the three distances must make a triangle (the longest side shorter than the other two together) with
// no angle under 10 degrees. Positions and facings are then one least-squares fit over the three distances and the six
// median bearings, solved once with the third sensor on each side of the line from the first to the second; the side
// whose bearings fit better wins, unless the two fit within 20 percent of each other. Each sensor's angle between the
// other two, from its bearings, must agree with the angle the distances give within 20 degrees.

import { normaliseDeg } from "../location/geometry.ts";

export const FATAL_ERRORS = ["no_stream", "emit_failed", "own_beep_not_heard"] as const;
export type FatalError = (typeof FATAL_ERRORS)[number];
export const ROUND_PROBLEMS = ["break", "overrun", "clipped", "dropped"] as const;
// A pair needs this many valid rounds, at least one in each order, and the two orders' medians this close.
export const MIN_VALID_ROUNDS = 2;
export const MAX_ORDER_DISAGREEMENT_M = 0.4;
// Each way of a pair needs this many bearings, scattered (circular standard deviation) by at most this much.
export const MIN_BEARINGS = 2;
export const MAX_BEARING_SPREAD_DEG = 15;
// A triangle of three sensors needs every angle at least this large, and each sensor's bearings of the other two this
// close to the angle between them the distances give.
export const MIN_ANGLE_DEG = 10;
export const MAX_ANGLE_DISAGREEMENT_DEG = 20;
// The triangle fit's weights (one standard error each), and how much better one side's bearings must fit than the
// mirror image's (as a fraction of the worse one) to tell which side the third sensor is on.
const SIGMA_DISTANCE_M = 0.15;
const SIGMA_BEARING_DEG = 12;
const MIRROR_MARGIN = 0.2;
const MAX_ROUNDS = 16;
const MAX_DETECTIONS = 8;

export interface Detection {
  emitter: string;
  own: boolean;
  position: number;
  snr_db: number;
  weak: boolean;
  angle_deg: number | null;
  angle_quality: number | null;
}

export interface ReportRound {
  round: number;
  valid: boolean;
  problems: string[];
  detections: Detection[];
}

export interface Report {
  role: string;
  fs: number;
  speed_of_sound: number;
  speed_of_sound_fallback: boolean;
  emitter_offset_m: number;
  errors: string[];
  rounds: ReportRound[];
}

export interface Participant {
  sensor_id: string;
  role: string;
  report: Report;
}

export interface Distance {
  a: string;
  b: string;
  distance_m: number;
}

// Where a placed sensor stands and which way it faces (degrees clockwise from the plan's up, 0 to under 360; null:
// not measured, the facing on the plan stays).
export interface Placement {
  sensor_id: string;
  x_m: number;
  y_m: number;
  facing_deg: number | null;
}

// Every failure names a pair: not_repeatable its distance, no_direction its bearings (fewer than 2, or scattered; three
// sensors only);
// with three sensors not_a_triangle the longest side, too_flat the side opposite the smallest angle, and
// bearings_disagree (bearings against the distances, or unable to tell the mirror image) the pair the fit fits worst.
export type SolveFailure = "not_repeatable" | "no_direction" | "not_a_triangle" | "too_flat" | "bearings_disagree";

export type Solution =
  | {
    ok: true;
    distances: Distance[];
    positions: Placement[];
    speed_of_sound_assumed: boolean;
  }
  | { ok: false; sensors: string[]; reason: SolveFailure };

// The layout from the scheduled participants' reports, in plan order (two or three). Fatal errors are the caller's to
// handle first.
export function solve(participants: Participant[]): Solution {
  if (participants.length >= 3) return solveTriangle(participants[0], participants[1], participants[2]);
  const [a, b] = participants;
  const pair = [a.sensor_id, b.sensor_id];
  const distance = pairDistance(a, b);
  if (distance === null) return { ok: false, sensors: pair, reason: "not_repeatable" };
  const measured = [facingFrom(bearings(a, b.role), 90), facingFrom(bearings(b, a.role), 270)];
  const [facingA, facingB] = measured.includes(null) ? [null, null] : measured;
  const d = round3(distance);
  return {
    ok: true,
    distances: [{ a: a.sensor_id, b: b.sensor_id, distance_m: d }],
    positions: [
      { sensor_id: a.sensor_id, x_m: 0, y_m: 0, facing_deg: facingA },
      { sensor_id: b.sensor_id, x_m: d, y_m: 0, facing_deg: facingB },
    ],
    speed_of_sound_assumed: participants.some((p) => p.report.speed_of_sound_fallback),
  };
}

// The board's angles of the emitter's beep: one per valid round where it heard that beep whole and could tell.
export function bearings(listener: Participant, emitter: string): number[] {
  return listener.report.rounds.filter((r) => r.valid).flatMap((r) => {
    const d = r.detections.find((x) => x.emitter === emitter && !x.own && !x.weak);
    return d && d.angle_deg !== null ? [d.angle_deg] : [];
  });
}

// The facing that makes the board's angles point along `planDeg`, to a tenth of a degree, or null when there are
// fewer than 2 angles or they scatter by more than 15 degrees.
export function facingFrom(angles: number[], planDeg: number): number | null {
  const bearing = medianBearing(angles);
  return bearing === null ? null : facing(planDeg - bearing);
}

// The circular median of the angles, or null when there are fewer than 2 or they scatter by more than 15 degrees.
function medianBearing(angles: number[]): number | null {
  if (angles.length < MIN_BEARINGS || circularSpreadDeg(angles) > MAX_BEARING_SPREAD_DEG) return null;
  return circularMedianDeg(angles);
}

const facing = (deg: number) => normaliseDeg(Math.round(normaliseDeg(deg) * 10) / 10);

// The median of angles on the circle: each angle taken as its signed difference from the circular mean, the
// ordinary median of those, added back. Meaningful for angles within a half circle of each other, as any that pass
// the spread check are.
export function circularMedianDeg(angles: number[]): number {
  const mean = circularMeanDeg(angles);
  return normaliseDeg(mean + median(angles.map((a) => signedDeg(a - mean))));
}

// The circular standard deviation, degrees: sqrt(-2 ln R), R the length of the mean unit vector.
export function circularSpreadDeg(angles: number[]): number {
  const [x, y] = meanVector(angles);
  const r = Math.min(1, Math.hypot(x, y));
  return r <= 0 ? Infinity : (Math.sqrt(-2 * Math.log(r)) * 180) / Math.PI;
}

function circularMeanDeg(angles: number[]): number {
  const [x, y] = meanVector(angles);
  return normaliseDeg((Math.atan2(y, x) * 180) / Math.PI);
}

function meanVector(angles: number[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const a of angles) {
    x += Math.cos((a * Math.PI) / 180);
    y += Math.sin((a * Math.PI) / 180);
  }
  return [x / angles.length, y / angles.length];
}

const signedDeg = (deg: number) => normaliseDeg(deg + 180) - 180;

// ---- three sensors ---------------------------------------------------------------------------------------------

type Point = [number, number];
// The sides, as indices into the three boards in plan order: a-b, a-c, b-c.
const SIDES = [[0, 1], [0, 2], [1, 2]] as const;

interface Fit {
  points: Point[];
  facings: number[];
  // The squared residuals, in standard errors: of the six bearings together, and per side (its distance and both of
  // its bearings).
  bearingCost: number;
  sideCost: number[];
}

// Three sensors placed by their three distances and six bearings, or the side that fails.
function solveTriangle(a: Participant, b: Participant, c: Participant): Solution {
  const boards = [a, b, c];
  const fail = (side: number, reason: SolveFailure): Solution =>
    ({ ok: false, sensors: SIDES[side].map((i) => boards[i].sensor_id), reason });
  const d: number[] = [];
  for (const [side, [i, j]] of SIDES.entries()) {
    const distance = pairDistance(boards[i], boards[j]);
    if (distance === null) return fail(side, "not_repeatable");
    d.push(distance);
  }
  const longest = d.indexOf(Math.max(...d));
  if (2 * d[longest] > d[0] + d[1] + d[2]) return fail(longest, "not_a_triangle");
  // The angle at a (opposite b-c), at b (opposite a-c) and at c (opposite a-b); the side opposite board k is 2 - k.
  const angles = [angleOpposite(d[2], d[0], d[1]), angleOpposite(d[1], d[0], d[2]), angleOpposite(d[0], d[1], d[2])];
  const flattest = angles.indexOf(Math.min(...angles));
  if (angles[flattest] < MIN_ANGLE_DEG) return fail(2 - flattest, "too_flat");

  // theta[l][e]: board l's median bearing of board e's beep.
  const theta: number[][] = [[], [], []];
  for (const [side, [i, j]] of SIDES.entries()) {
    for (const [l, e] of [[i, j], [j, i]]) {
      const m = medianBearing(bearings(boards[l], boards[e].role));
      if (m === null) return fail(side, "no_direction");
      theta[l][e] = m;
    }
  }

  const [above, below] = [1, -1].map((sign) => fitTriangle(d, theta, sign));
  const [best, mirror, sign] = above.bearingCost <= below.bearingCost ? [above, below, 1] : [below, above, -1];
  const worst = best.sideCost.indexOf(Math.max(...best.sideCost));
  if (best.bearingCost >= (1 - MIRROR_MARGIN) * mirror.bearingCost) return fail(worst, "bearings_disagree");
  // Each board's angle from one other board to the next, by its bearings and by the distances laid out on that side.
  const laid = layOut(d, sign);
  for (let l = 0; l < 3; l++) {
    const [j, k] = [0, 1, 2].filter((x) => x !== l);
    const heard = signedDeg(theta[l][k] - theta[l][j]);
    const measured = signedDeg(directionTo(laid[l], laid[k]) - directionTo(laid[l], laid[j]));
    if (Math.abs(signedDeg(heard - measured)) > MAX_ANGLE_DISAGREEMENT_DEG) return fail(worst, "bearings_disagree");
  }
  return {
    ok: true,
    distances: SIDES.map(([i, j], side) => ({ a: boards[i].sensor_id, b: boards[j].sensor_id, distance_m: round3(d[side]) })),
    positions: boards.map((p, i) => ({
      sensor_id: p.sensor_id, x_m: round3(best.points[i][0]), y_m: round3(best.points[i][1]), facing_deg: facing(best.facings[i]),
    })),
    speed_of_sound_assumed: boards.some((p) => p.report.speed_of_sound_fallback),
  };
}

// The triangle with the third board on one side (sign 1: above the line from the first to the second, -1: below),
// fitted to the distances and bearings: the second board's x, the third's x and y, and the three facings.
function fitTriangle(d: number[], theta: number[][], sign: number): Fit {
  // The third board's y is sign * exp(parameter), so the fit stays on its side of the line.
  const pointsOf = (p: number[]): Point[] => [[0, 0], [p[0], 0], [p[1], sign * Math.exp(p[2])]];
  const residuals = (p: number[]) => {
    const pts = pointsOf(p);
    return SIDES.flatMap(([i, j], side) => [
      (Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) - d[side]) / SIGMA_DISTANCE_M,
      signedDeg(directionTo(pts[i], pts[j]) - p[3 + i] - theta[i][j]) / SIGMA_BEARING_DEG,
      signedDeg(directionTo(pts[j], pts[i]) - p[3 + j] - theta[j][i]) / SIGMA_BEARING_DEG,
    ]);
  };
  const start = layOut(d, sign);
  const startFacing = (l: number) =>
    circularMeanDeg([0, 1, 2].filter((e) => e !== l).map((e) => directionTo(start[l], start[e]) - theta[l][e]));
  const p = leastSquares(residuals, [
    start[1][0], start[2][0], Math.log(Math.max(Math.abs(start[2][1]), 1e-3)), startFacing(0), startFacing(1), startFacing(2),
  ]);
  const r = residuals(p);
  const sq = (k: number) => r[k] * r[k];
  return {
    points: pointsOf(p),
    facings: p.slice(3),
    bearingCost: SIDES.reduce((sum, _, side) => sum + sq(3 * side + 1) + sq(3 * side + 2), 0),
    sideCost: SIDES.map((_, side) => sq(3 * side) + sq(3 * side + 1) + sq(3 * side + 2)),
  };
}

// The three boards placed by the distances alone: the first at the origin, the second to its right, the third on
// the given side.
function layOut(d: number[], sign: number): Point[] {
  const x = (d[0] * d[0] + d[1] * d[1] - d[2] * d[2]) / (2 * d[0]);
  return [[0, 0], [d[0], 0], [x, sign * Math.sqrt(Math.max(0, d[1] * d[1] - x * x))]];
}

// The angle of a triangle opposite the side `opposite`, between the sides s and t, degrees.
function angleOpposite(opposite: number, s: number, t: number): number {
  const cos = (s * s + t * t - opposite * opposite) / (2 * s * t);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

// The plan direction from p to q, degrees clockwise from up.
const directionTo = (p: Point, q: Point) => normaliseDeg((Math.atan2(q[0] - p[0], q[1] - p[1]) * 180) / Math.PI);

// Levenberg-Marquardt: the parameters that minimise the sum of the squared residuals, from a start near them.
function leastSquares(f: (p: number[]) => number[], start: number[]): number[] {
  const sumSq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);
  let p = start;
  let r = f(p);
  let cost = sumSq(r);
  let lambda = 1e-3;
  for (let iteration = 0; iteration < 100; iteration++) {
    // The Jacobian by forward differences, then the normal equations J'J and J'r.
    const columns = p.map((_, n) => {
      const h = 1e-6 * Math.max(1, Math.abs(p[n]));
      const rh = f(p.map((v, m) => (m === n ? v + h : v)));
      return rh.map((v, k) => (v - r[k]) / h);
    });
    const jtj = columns.map((x) => columns.map((y) => x.reduce((s, v, k) => s + v * y[k], 0)));
    const jtr = columns.map((x) => x.reduce((s, v, k) => s + v * r[k], 0));
    let stepped = false;
    while (!stepped && lambda < 1e12) {
      const damped = jtj.map((row, x) => row.map((v, y) => (x === y ? v * (1 + lambda) + 1e-12 : v)));
      const next = p.map((v, n) => v + linearSolve(damped, jtr.map((g) => -g))[n]);
      const nextR = f(next);
      const nextCost = sumSq(nextR);
      if (nextCost < cost) {
        const gain = cost - nextCost;
        [p, r, cost, stepped] = [next, nextR, nextCost, true];
        lambda /= 3;
        if (gain < 1e-12 * (1 + cost)) return p;
      } else {
        lambda *= 4;
      }
    }
    if (!stepped) return p;
  }
  return p;
}

// x with A x = b, by Gaussian elimination with partial pivoting (A small and positive definite here).
function linearSolve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    if (Math.abs(m[col][col]) < 1e-15) return new Array(n).fill(0);
    for (let row = col + 1; row < n; row++) {
      const k = m[row][col] / m[col][col];
      for (let c = col; c <= n; c++) m[row][c] -= k * m[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let v = m[row][n];
    for (let c = row + 1; c < n; c++) v -= m[row][c] * x[c];
    x[row] = v / m[row][row];
  }
  return x;
}

// The pair's distance: the median over its valid rounds, or null when it is not repeatable (fewer than 2 valid
// rounds, an order with none, or the orders' medians more than 40 cm apart, or not a positive distance).
export function pairDistance(a: Participant, b: Participant): number | null {
  const forward: number[] = [];
  const reverse: number[] = [];
  for (const ra of a.report.rounds) {
    const rb = b.report.rounds.find((r) => r.round === ra.round);
    if (!rb || !ra.valid || !rb.valid) continue;
    const aOwn = heard(ra, a.role, true);
    const aOther = heard(ra, b.role, false);
    const bOwn = heard(rb, b.role, true);
    const bOther = heard(rb, a.role, false);
    if (aOwn === null || aOther === null || bOwn === null || bOther === null) continue;
    const c = (a.report.speed_of_sound + b.report.speed_of_sound) / 2;
    const ta = (p: number) => p / a.report.fs;
    const tb = (p: number) => p / b.report.fs;
    const d = (c / 2) * ((ta(aOther) - ta(aOwn)) - (tb(bOwn) - tb(bOther)))
      + (a.report.emitter_offset_m + b.report.emitter_offset_m) / 2;
    (ra.round % 2 === 0 ? forward : reverse).push(d);
  }
  if (forward.length + reverse.length < MIN_VALID_ROUNDS || !forward.length || !reverse.length) return null;
  if (Math.abs(median(forward) - median(reverse)) > MAX_ORDER_DISAGREEMENT_M) return null;
  const d = median([...forward, ...reverse]);
  return d > 0 ? d : null;
}

// Where this board heard the role's beep in the round: a whole (not weak) detection, or null.
function heard(r: ReportRound, emitter: string, own: boolean): number | null {
  const d = r.detections.find((x) => x.emitter === emitter && x.own === own && !x.weak);
  return d ? d.position : null;
}

export function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// To the millimetre, never -0.
const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

// A report body as the sensor sent it, checked and reduced to its known fields, or why it is refused.
export function parseReport(body: Record<string, unknown>): Report | string {
  const { role, fs, speed_of_sound, speed_of_sound_fallback, emitter_offset_m, errors, rounds } = body;
  if (typeof role !== "string" || role.length === 0 || role.length > 8) return "role missing";
  if (!finite(fs) || fs <= 0) return "fs must be a positive number";
  if (!finite(speed_of_sound) || speed_of_sound < 300 || speed_of_sound > 380) {
    return "speed_of_sound must be from 300 to 380";
  }
  if (typeof speed_of_sound_fallback !== "boolean") return "speed_of_sound_fallback must be true or false";
  if (!finite(emitter_offset_m) || emitter_offset_m < 0 || emitter_offset_m > 1) {
    return "emitter_offset_m must be from 0 to 1";
  }
  if (!stringList(errors, 10)) return "errors must be a list of codes";
  if (!Array.isArray(rounds) || rounds.length > MAX_ROUNDS) return `rounds must be a list of at most ${MAX_ROUNDS}`;
  const parsed: ReportRound[] = [];
  for (const raw of rounds) {
    if (!isObject(raw)) return "a round is not a JSON object";
    const { round, valid, problems, detections } = raw;
    if (!Number.isSafeInteger(round) || (round as number) < 0) return "round must be a whole number";
    if (typeof valid !== "boolean") return "valid must be true or false";
    if (!stringList(problems, 10)) return "problems must be a list of codes";
    if (!Array.isArray(detections) || detections.length > MAX_DETECTIONS) {
      return `detections must be a list of at most ${MAX_DETECTIONS}`;
    }
    const ds: Detection[] = [];
    for (const d of detections) {
      if (!isObject(d)) return "a detection is not a JSON object";
      if (typeof d.emitter !== "string" || typeof d.own !== "boolean" || typeof d.weak !== "boolean") {
        return "a detection needs emitter, own and weak";
      }
      if (!finite(d.position) || !finite(d.snr_db)) return "a detection needs a position and snr_db";
      const angle = d.angle_deg ?? null;
      const quality = d.angle_quality ?? null;
      if ((angle !== null && !finite(angle)) || (quality !== null && !finite(quality))) {
        return "angle_deg and angle_quality must be numbers or null";
      }
      ds.push({
        emitter: d.emitter.slice(0, 8), own: d.own, position: d.position, snr_db: d.snr_db, weak: d.weak,
        angle_deg: angle, angle_quality: quality,
      });
    }
    parsed.push({ round: round as number, valid, problems: problems as string[], detections: ds });
  }
  return {
    role, fs, speed_of_sound, speed_of_sound_fallback, emitter_offset_m, errors: errors as string[], rounds: parsed,
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringList = (v: unknown, max: number) =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length <= 40);
