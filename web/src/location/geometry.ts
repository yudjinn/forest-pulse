// The geometry of where a sound came from: a direction line from a sensor, the point where two lines cross, and
// which earlier event a new one pairs with. Plan metres, x to the right, y up; directions in degrees clockwise from
// the plan's up. Kept free of Worker types so the focused test imports it directly.

// Two sensors' events pair when their corrected times are at most this far apart.
export const PAIR_WINDOW_MS = 3_000;

export interface Line {
  x_m: number;
  y_m: number;
  deg: number;
}

export interface Crossing {
  x_m: number;
  y_m: number;
  // Along each line from its sensor to the point, in metres.
  distance_a_m: number;
  distance_b_m: number;
}

// 0 to under 360.
export function normaliseDeg(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r >= 360 ? 0 : r;
}

// A sensor's line for an event: its facing plus the event's angle (an angle outside 0 to 360 is normalised).
export function directionDeg(facingDeg: number, angleDeg: number): number {
  return normaliseDeg(facingDeg + angleDeg);
}

const unit = (deg: number): [number, number] => {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
};

// Where two lines cross, when that point lies in front of both sensors; null when they are parallel, start at the
// same spot, or meet only behind one of them.
export function crossing(a: Line, b: Line): Crossing | null {
  const [ax, ay] = unit(a.deg);
  const [bx, by] = unit(b.deg);
  const det = ax * by - ay * bx;
  if (Math.abs(det) < 1e-9) return null;
  const wx = b.x_m - a.x_m;
  const wy = b.y_m - a.y_m;
  const t = (wx * by - wy * bx) / det;
  const s = (wx * ay - wy * ax) / det;
  if (!(t > 1e-9 && s > 1e-9)) return null;
  return { x_m: a.x_m + t * ax, y_m: a.y_m + t * ay, distance_a_m: t, distance_b_m: s };
}

export interface Candidate {
  id: number;
  angle_confidence: number | null;
  occurred_at: number;
}

// The partner a new event pairs with, from the candidates (same sound, other online sensors, within the pair
// window): the highest angle confidence, or the most recent when none has one (and among equal confidences).
export function choosePartner<C extends Candidate>(candidates: readonly C[]): C | null {
  let best: C | null = null;
  for (const c of candidates) {
    if (!best || rank(c, best) > 0) best = c;
  }
  return best;
}

function rank(a: Candidate, b: Candidate): number {
  const ca = a.angle_confidence ?? -1;
  const cb = b.angle_confidence ?? -1;
  return ca - cb || a.occurred_at - b.occurred_at || a.id - b.id;
}
