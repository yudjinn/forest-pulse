// Calibration runs: pressing Calibrate picks the sensors that can take part, they learn the run from their check-in
// replies, confirm ready once their stream flows, beep in scheduled slots and report what they heard; the service
// solves the layout (solve.ts) and, when every check passes, applies it in one batch as the measured layout.
//
// The run advances lazily, on whatever request touches it (a participant's check-in or report, a dashboard poll),
// never on a timer. Every transition is one conditional write on the run's status, so two requests advancing the
// same run at once make it happen once.
import type { Env } from "../env.ts";
import type { RouteContext } from "../router.ts";
import { json } from "../http.ts";
import { logLine } from "../log.ts";
import { badRequest, readBody } from "../api/intake.ts";
import { readPlan } from "../sensors/plan.ts";
import {
  type Distance, FATAL_ERRORS, type Participant, type Placement, type Report, type SolveFailure, parseReport, solve,
} from "./solve.ts";

export const MAX_PARTICIPANTS = 3;
const ROLES = ["A", "B", "C"];
// The sweeps, set by the service so they can be retuned without changing the boards: A rises, B falls, C rises then
// falls, over 1.5 to 3.5 kHz, 120 ms.
const PATTERNS: Record<string, { f_start_hz: number; f_mid_hz: number; f_end_hz: number; duration_ms: number }> = {
  A: { f_start_hz: 1500, f_mid_hz: 2500, f_end_hz: 3500, duration_ms: 120 },
  B: { f_start_hz: 3500, f_mid_hz: 2500, f_end_hz: 1500, duration_ms: 120 },
  C: { f_start_hz: 1500, f_mid_hz: 3500, f_end_hz: 1500, duration_ms: 120 },
};
const SLOT_MS = 500;
const ROUND_GAP_MS = 1000;
const ROUNDS = 4;
const READY_WAIT_MS = 20_000;
const START_AFTER_READY_MS = 4000;
const REPORT_AFTER_END_MS = 15_000;
const KEEP_RUNS = 20;
const ACTIVE = "('waiting', 'scheduled')";

type Status = "waiting" | "scheduled" | "calibrated" | "failed";
export type FailureReason = "not_ready" | "report_missing" | SolveFailure | (typeof FATAL_ERRORS)[number];

interface Schedule {
  slot_ms: number;
  round_gap_ms: number;
  rounds: number;
  patterns: typeof PATTERNS;
}

interface RunRow {
  id: string;
  status: Status;
  created_at: number;
  ready_deadline_at: number;
  schedule: string;
  start_at: number | null;
  ends_at: number | null;
  report_deadline_at: number | null;
  finished_at: number | null;
  result: string | null;
  failure: string | null;
}

interface ParticipantRow {
  sensor_id: string;
  role: string;
  seq: number;
  ready_at: number | null;
  dropped: number;
  report: string | null;
}

interface Run extends RunRow {
  participants: ParticipantRow[];
}

interface Result {
  distances: Distance[];
  positions: Placement[];
  speed_of_sound_assumed: boolean;
  // Participants that never confirmed ready and the run went ahead without (missing on runs stored before it).
  left_out?: string[];
}

// When the last slot ends: each round plays the order once, one slot each, and the next round starts round_gap_ms
// after the last slot of the one before ends (docs/device-api.md).
export function scheduleEnd(startAt: number, participants: number, s: Pick<Schedule, "slot_ms" | "round_gap_ms" | "rounds">) {
  return startAt + (s.rounds - 1) * (participants * s.slot_ms + s.round_gap_ms) + participants * s.slot_ms;
}

// ---- sensors ---------------------------------------------------------------------------------------------------

// The sensors that can take part now, in plan order: calibration-capable, online, on the plan and without a
// shared-name warning. The first three are a run's participants; the button counts all of them.
export async function eligibleSensors(db: D1Database, now: number): Promise<string[]> {
  const [plan, capable] = await Promise.all([
    readPlan(db, now),
    db.prepare("SELECT id FROM sensors WHERE calibration_capable = 1").all<{ id: string }>(),
  ]);
  const can = new Set(capable.results.map((r) => r.id));
  return plan.filter((s) => s.online && !s.shared_name && can.has(s.id)).map((s) => s.id);
}

// The check-in's calibration part: stores whether the sensor can take part, records its ready confirmation, and
// returns the run for its reply while it is a participant of the run in progress (null otherwise).
export async function calibrationCheckin(env: Env, sensorId: string, body: Record<string, unknown>, now: number) {
  const db = env.DB;
  const capable = body.calibration_capable === true ? 1 : 0;
  await db.prepare("UPDATE sensors SET calibration_capable = ?2 WHERE id = ?1 AND calibration_capable IS NOT ?2")
    .bind(sensorId, capable).run();
  let run = await activeRun(db);
  if (!run) return null;
  const me = run.participants.find((p) => p.sensor_id === sensorId);
  if (!me || me.dropped) return null;
  if (run.status === "waiting" && me.ready_at === null && body.calibration_ack === run.id) {
    await db.prepare(
      `UPDATE calibration_participants SET ready_at = ?3 WHERE run_id = ?1 AND sensor_id = ?2 AND ready_at IS NULL
         AND EXISTS (SELECT 1 FROM calibration_runs WHERE id = ?1 AND status = 'waiting')`,
    ).bind(run.id, sensorId, now).run();
    logLine("calibration_ready", { run: run.id, sensor: sensorId });
    run = (await loadRun(db, run.id))!;
  }
  run = await advance(env, run, now);
  const still = run.participants.find((p) => p.sensor_id === sensorId);
  if (!isActive(run.status) || !still || still.dropped) return null;
  const schedule = JSON.parse(run.schedule) as Schedule;
  const order = run.participants.filter((p) => !p.dropped).map((p) => p.role);
  return {
    run_id: run.id,
    role: still.role,
    order,
    patterns: Object.fromEntries(order.map((r) => [r, schedule.patterns[r]])),
    ...(run.start_at === null ? {} : { start_at: new Date(run.start_at).toISOString() }),
    slot_ms: schedule.slot_ms,
    round_gap_ms: schedule.round_gap_ms,
    rounds: schedule.rounds,
  };
}

// POST /api/v1/sensors/:sensor/calibration: a participant's report on the run named by run_id.
export async function postReport(request: Request, { env, params }: RouteContext): Promise<Response> {
  const now = Date.now();
  const sensor = params.sensor;
  const read = await readBody(request, sensor, now);
  if (read instanceof Response) return read;
  const { body } = read;
  if (typeof body.run_id !== "string") return badRequest("run_id missing", sensor);
  const run = await loadRun(env.DB, body.run_id);
  const me = run?.participants.find((p) => p.sensor_id === sensor);
  if (!run || !me) return json({ error: "no such calibration run for this sensor" }, 404);
  if (!isActive(run.status) || me.dropped) return json({ error: "the run has ended" }, 409);
  const report = parseReport(body);
  if (typeof report === "string") return badRequest(report, sensor);
  if (report.role !== me.role) return badRequest(`role must be ${me.role}`, sensor);
  await env.DB.prepare(
    "UPDATE calibration_participants SET report = ?3, reported_at = ?4 WHERE run_id = ?1 AND sensor_id = ?2 AND report IS NULL",
  ).bind(run.id, sensor, JSON.stringify(report), now).run();
  logLine("calibration_report", { run: run.id, sensor, errors: report.errors });
  await advance(env, (await loadRun(env.DB, run.id))!, now);
  return json({ accepted: true });
}

// ---- researchers -----------------------------------------------------------------------------------------------

// POST /dashboard/api/calibration: starts a run with the sensors that can take part, at most 3, roles in plan order.
export async function startCalibration(_request: Request, { env }: RouteContext): Promise<Response> {
  const db = env.DB;
  const now = Date.now();
  const current = await activeRun(db);
  if (current && isActive((await advance(env, current, now)).status)) {
    return json({ error: "A calibration is already running" }, 409);
  }
  const sensors = (await eligibleSensors(db, now)).slice(0, MAX_PARTICIPANTS);
  if (sensors.length < 2) return json({ error: "Fewer than 2 sensors can take part" }, 409);
  const id = crypto.randomUUID();
  const schedule: Schedule = { slot_ms: SLOT_MS, round_gap_ms: ROUND_GAP_MS, rounds: ROUNDS, patterns: PATTERNS };
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO calibration_runs (id, status, created_at, ready_deadline_at, schedule)
       SELECT ?1, 'waiting', ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM calibration_runs WHERE status IN ${ACTIVE})`,
    ).bind(id, now, now + READY_WAIT_MS, JSON.stringify(schedule)),
    ...sensors.map((sensor, i) => db.prepare(
      `INSERT INTO calibration_participants (run_id, sensor_id, role, seq)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM calibration_runs WHERE id = ?1)`,
    ).bind(id, sensor, ROLES[i], i)),
    // The latest 20 runs are kept, and the applied one while the layout is measured.
    db.prepare(
      `DELETE FROM calibration_participants WHERE run_id NOT IN
         (SELECT id FROM calibration_runs ORDER BY created_at DESC, rowid DESC LIMIT ?1)
       AND run_id NOT IN (SELECT run_id FROM measured_layout)`,
    ).bind(KEEP_RUNS),
    db.prepare(
      `DELETE FROM calibration_runs WHERE id NOT IN
         (SELECT id FROM calibration_runs ORDER BY created_at DESC, rowid DESC LIMIT ?1)
       AND id NOT IN (SELECT run_id FROM measured_layout)`,
    ).bind(KEEP_RUNS),
  ]);
  if (!inserted.meta.changes) return json({ error: "A calibration is already running" }, 409);
  logLine("calibration_run", { run: id, status: "waiting", sensors });
  return json({ run: runState((await loadRun(db, id))!, now) }, 201);
}

// GET /dashboard/api/calibration: whether Calibrate can be pressed (and which sensors can take part, in plan
// order), the latest run, and the measured layout.
export async function calibrationState(_request: Request, { env }: RouteContext): Promise<Response> {
  const db = env.DB;
  const now = Date.now();
  const active = await activeRun(db);
  if (active) await advance(env, active, now);
  const [eligible, latest, layout] = await Promise.all([
    eligibleSensors(db, now),
    db.prepare("SELECT id FROM calibration_runs ORDER BY created_at DESC, rowid DESC LIMIT 1").first<{ id: string }>(),
    db.prepare(
      `SELECT m.sensor_id, r.id AS run_id, r.finished_at, r.result FROM measured_layout m
       JOIN calibration_runs r ON r.id = m.run_id`,
    ).all<{ sensor_id: string; run_id: string; finished_at: number; result: string }>(),
  ]);
  const run = latest ? await loadRun(db, latest.id) : null;
  const measured = layout.results[0];
  const result = measured ? JSON.parse(measured.result) as Result : null;
  return json({
    now,
    eligible: eligible.length,
    eligible_sensors: eligible,
    running: run !== null && isActive(run.status),
    run: run && runState(run, now),
    layout: measured && result ? {
      run_id: measured.run_id,
      measured_at: measured.finished_at,
      sensors: layout.results.map((r) => r.sensor_id),
      distances: result.distances,
      speed_of_sound_assumed: result.speed_of_sound_assumed,
      left_out: result.left_out ?? [],
    } : null,
  });
}

// What the dashboard shows of a run: waiting for boards (N of M ready), beeping from the first slot, or its result.
function runState(run: Run, now: number) {
  const result = run.result ? JSON.parse(run.result) as Result : null;
  return {
    id: run.id,
    state: run.status === "waiting" || (run.status === "scheduled" && now < (run.start_at ?? 0))
      ? "waiting"
      : run.status === "scheduled" ? "beeping" : run.status,
    ready: run.participants.filter((p) => p.ready_at !== null).length,
    participants: run.participants.length,
    finished_at: run.finished_at,
    failure: run.failure ? JSON.parse(run.failure) as { sensors: string[]; reason: FailureReason } : null,
    speed_of_sound_assumed: result?.speed_of_sound_assumed ?? false,
  };
}

// ---- the run ---------------------------------------------------------------------------------------------------

const isActive = (s: Status) => s === "waiting" || s === "scheduled";

async function activeRun(db: D1Database): Promise<Run | null> {
  const row = await db.prepare(
    `SELECT id FROM calibration_runs WHERE status IN ${ACTIVE} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).first<{ id: string }>();
  return row ? loadRun(db, row.id) : null;
}

async function loadRun(db: D1Database, id: string): Promise<Run | null> {
  const [run, participants] = await db.batch<unknown>([
    db.prepare("SELECT * FROM calibration_runs WHERE id = ?").bind(id),
    db.prepare(
      `SELECT sensor_id, role, seq, ready_at, dropped, report FROM calibration_participants WHERE run_id = ?
       ORDER BY seq`,
    ).bind(id),
  ]);
  const row = run.results[0] as RunRow | undefined;
  return row ? { ...row, participants: participants.results as ParticipantRow[] } : null;
}

// Moves the run on as far as `now` allows and returns it as it then stands.
async function advance(env: Env, run: Run, now: number): Promise<Run> {
  const db = env.DB;
  const taking = run.participants.filter((p) => !p.dropped);
  const fatal = taking.map((p) => ({ p, report: p.report ? JSON.parse(p.report) as Report : null }))
    .map(({ p, report }) => ({ p, code: report?.errors.find((e) => (FATAL_ERRORS as readonly string[]).includes(e)) }))
    .find((x) => x.code);
  if (fatal) return fail(db, run, [fatal.p.sensor_id], fatal.code as FailureReason, now);

  if (run.status === "waiting") {
    const ready = taking.filter((p) => p.ready_at !== null);
    const lastReady = Math.max(0, ...ready.map((p) => p.ready_at as number));
    if (ready.length === taking.length) return schedule(db, run, lastReady + START_AFTER_READY_MS, false, now);
    if (now < run.ready_deadline_at) return run;
    if (ready.length >= 2) return schedule(db, run, Math.max(lastReady, now) + START_AFTER_READY_MS, true, now);
    return fail(db, run, [taking.find((p) => p.ready_at === null)!.sensor_id], "not_ready", now);
  }

  if (run.status === "scheduled") {
    const missing = taking.filter((p) => p.report === null);
    if (missing.length === 0) {
      const solution = solve(taking.map((p) => ({ sensor_id: p.sensor_id, role: p.role, report: JSON.parse(p.report!) })));
      if (!solution.ok) return fail(db, run, solution.sensors, solution.reason, now);
      const { ok: _, ...result } = solution;
      const leftOut = run.participants.filter((p) => p.dropped).map((p) => p.sensor_id);
      return apply(db, run, { ...result, left_out: leftOut }, now);
    }
    if (now >= (run.report_deadline_at ?? Infinity)) return fail(db, run, [missing[0].sensor_id], "report_missing", now);
  }
  return run;
}

async function schedule(db: D1Database, run: Run, startAt: number, dropUnready: boolean, now: number) {
  const going = run.participants.filter((p) => !p.dropped && (!dropUnready || p.ready_at !== null));
  const endsAt = scheduleEnd(startAt, going.length, JSON.parse(run.schedule) as Schedule);
  const [, scheduled] = await db.batch([
    db.prepare(
      `UPDATE calibration_participants SET dropped = 1 WHERE run_id = ?1 AND ready_at IS NULL AND ?2
         AND EXISTS (SELECT 1 FROM calibration_runs WHERE id = ?1 AND status = 'waiting')`,
    ).bind(run.id, dropUnready ? 1 : 0),
    db.prepare(
      `UPDATE calibration_runs SET status = 'scheduled', start_at = ?2, ends_at = ?3, report_deadline_at = ?4
       WHERE id = ?1 AND status = 'waiting'`,
    ).bind(run.id, startAt, endsAt, endsAt + REPORT_AFTER_END_MS),
  ]);
  if (scheduled.meta.changes) {
    logLine("calibration_run", {
      run: run.id, status: "scheduled", start_at: new Date(startAt).toISOString(),
      sensors: going.map((p) => p.sensor_id),
      ...(dropUnready ? { dropped: run.participants.filter((p) => p.ready_at === null).map((p) => p.sensor_id) } : {}),
    });
  }
  return (await loadRun(db, run.id))!;
}

async function fail(db: D1Database, run: Run, sensors: string[], reason: FailureReason, now: number) {
  const failed = await db.prepare(
    `UPDATE calibration_runs SET status = 'failed', finished_at = ?2, failure = ?3 WHERE id = ?1 AND status IN ${ACTIVE}
     RETURNING id`,
  ).bind(run.id, now, JSON.stringify({ sensors, reason })).first();
  if (failed) logLine("calibration_run", { run: run.id, status: "failed", sensors, reason });
  return (await loadRun(db, run.id))!;
}

// One batch: every placed sensor's position and facing, the measured layout, and the run as calibrated. Each
// statement holds only while the run is still scheduled, so a second request applying it at once changes nothing.
async function apply(db: D1Database, run: Run, solution: Result, now: number) {
  const still = "EXISTS (SELECT 1 FROM calibration_runs WHERE id = ?1 AND status = 'scheduled')";
  const replies = await db.batch([
    ...solution.positions.map((p) => db.prepare(
      `UPDATE sensor_placements SET x_m = ?3, y_m = ?4, facing_deg = ?5 WHERE sensor_id = ?2 AND removed = 0
         AND ${still}`,
    ).bind(run.id, p.sensor_id, p.x_m, p.y_m, p.facing_deg)),
    db.prepare(`DELETE FROM measured_layout WHERE ${still}`).bind(run.id),
    ...solution.positions.map((p) => db.prepare(
      `INSERT INTO measured_layout (sensor_id, run_id) SELECT ?2, ?1 WHERE ${still}`,
    ).bind(run.id, p.sensor_id)),
    db.prepare(
      "UPDATE calibration_runs SET status = 'calibrated', finished_at = ?2, result = ?3 WHERE id = ?1 AND status = 'scheduled'",
    ).bind(run.id, now, JSON.stringify(solution)),
  ]);
  if (replies[replies.length - 1].meta.changes) {
    logLine("calibration_run", { run: run.id, status: "calibrated", distances: solution.distances,
      facings: solution.positions.map((p) => ({ sensor: p.sensor_id, facing_deg: p.facing_deg })),
      speed_of_sound_assumed: solution.speed_of_sound_assumed, left_out: solution.left_out });
  }
  return (await loadRun(db, run.id))!;
}
