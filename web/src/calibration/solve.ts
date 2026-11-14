// Turning a calibration run's reports into a layout (docs/device-api.md, "Calibration report"). Distances come from
// two-way ranging on where each board heard each beep in its own continuous stream, so no clock enters the maths:
//   d(i, j) = c/2 * [(t_i(j) - t_i(i)) - (t_j(j) - t_j(i))] + (s_i + s_j)/2
// t_k(m): where board k heard board m's beep, seconds of k's own stream; c: the two boards' mean reported speed of
// sound; s: their emitter offsets. The layout is relative to the sensors: the first participant (plan order) at the
// origin, the second straight to its right. A third participant's beeps are scheduled and not used yet.
// The result is the mean of each buzzer's distance to the other board's array: exact when the buzzers sit square to the
// line between the boards, short or long by up to their offsets when one points toward or away from the other.
//
// Facings come from the pair's mutual bearings (each board's angle of the other's beep, clockwise from its forward):
// a's plan direction to b must be 90 (b is straight to its right) and b's to a 270, so
//   facing_a = 90 - angle_a(b),  facing_b = 270 - angle_b(a)   (mod 360)
// each the circular median over the board's valid rounds.

import { normaliseDeg } from "../location/geometry.ts";

export const FATAL_ERRORS = ["no_stream", "emit_failed", "own_beep_not_heard"] as const;
export type FatalError = (typeof FATAL_ERRORS)[number];
export const ROUND_PROBLEMS = ["break", "overrun", "clipped", "dropped"] as const;
// A pair needs this many valid rounds, at least one in each order, and the two orders' medians this close.
export const MIN_VALID_ROUNDS = 2;
export const MAX_ORDER_DISAGREEMENT_M = 0.15;
// Each way of a pair needs this many bearings, scattered (circular standard deviation) by at most this much.
export const MIN_BEARINGS = 2;
export const MAX_BEARING_SPREAD_DEG = 15;
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

// Where a placed sensor stands and which way it faces (degrees clockwise from the plan's up, 0 to under 360).
export interface Placement {
  sensor_id: string;
  x_m: number;
  y_m: number;
  facing_deg: number;
}

export type SolveFailure = "not_repeatable" | "no_direction";

export type Solution =
  | {
    ok: true;
    distances: Distance[];
    positions: Placement[];
    speed_of_sound_assumed: boolean;
  }
  | { ok: false; sensors: string[]; reason: SolveFailure };

// The layout from the scheduled participants' reports, in plan order. Fatal errors are the caller's to handle first.
export function solve(participants: Participant[]): Solution {
  const [a, b] = participants;
  const pair = [a.sensor_id, b.sensor_id];
  const distance = pairDistance(a, b);
  if (distance === null) return { ok: false, sensors: pair, reason: "not_repeatable" };
  const facingA = facingFrom(bearings(a, b.role), 90);
  const facingB = facingFrom(bearings(b, a.role), 270);
  if (facingA === null || facingB === null) return { ok: false, sensors: pair, reason: "no_direction" };
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
  if (angles.length < MIN_BEARINGS || circularSpreadDeg(angles) > MAX_BEARING_SPREAD_DEG) return null;
  return normaliseDeg(Math.round(normaliseDeg(planDeg - circularMedianDeg(angles)) * 10) / 10);
}

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

// The pair's distance: the median over its valid rounds, or null when it is not repeatable (fewer than 2 valid
// rounds, an order with none, or the orders' medians more than 15 cm apart, or not a positive distance).
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

const round3 = (v: number) => Math.round(v * 1000) / 1000;

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
