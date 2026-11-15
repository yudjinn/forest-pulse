// Trains a sound detector from summaries: logistic regression on the model's 960-number embeddings, the method the
// experiment chose (balanced classes, L2 regularisation with C = 0.1 on standardised summaries, as scikit-learn's
// LogisticRegression with class_weight="balanced"), with the standardisation folded into the weights and bias so a
// sensor needs only weights . embedding + bias. Plain TypeScript with no Worker APIs: the teach request runs it, and
// scripts may import it to train exactly as teaching on the dashboard does.

export const DIM = 960;
export const C = 0.1;

export interface Detector {
  weights: number[];
  bias: number;
  iterations: number;
}

// Rows are concatenated summaries of `dim` numbers each.
export function trainDetector(positives: Float32Array, negatives: Float32Array, dim = DIM, c = C): Detector {
  const np = positives.length / dim;
  const nn = negatives.length / dim;
  if (!Number.isInteger(np) || !Number.isInteger(nn) || np === 0 || nn === 0) {
    throw new Error("trainDetector needs whole rows of both classes");
  }
  const n = np + nn;
  const row = (i: number) => (i < np ? positives.subarray(i * dim, (i + 1) * dim) : negatives.subarray((i - np) * dim, (i - np + 1) * dim));

  // Standardise every dimension over all rows (population variance; a constant dimension keeps scale 1).
  const mean = new Float64Array(dim);
  const scale = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const r = row(i);
    for (let j = 0; j < dim; j++) mean[j] += r[j];
  }
  for (let j = 0; j < dim; j++) mean[j] /= n;
  for (let i = 0; i < n; i++) {
    const r = row(i);
    for (let j = 0; j < dim; j++) scale[j] += (r[j] - mean[j]) ** 2;
  }
  for (let j = 0; j < dim; j++) {
    const s = Math.sqrt(scale[j] / n);
    scale[j] = s < 10 * Number.EPSILON ? 1 : s;
  }
  const z = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    const r = row(i);
    for (let j = 0; j < dim; j++) z[i * dim + j] = (r[j] - mean[j]) / scale[j];
  }

  // Balanced class weights, as scikit-learn: n / (2 * class count).
  const weightPos = n / (2 * np);
  const weightNeg = n / (2 * nn);
  const margins = new Float64Array(n);

  // The objective scikit-learn minimises, divided by C * n (same minimum):
  // mean over rows of weight * log(1 + exp(-y * (z . beta + b))) + ||beta||^2 / (2 C n). theta = [beta..., b].
  const objective = (theta: Float64Array, grad: Float64Array): number => {
    grad.fill(0);
    let f = 0;
    for (let i = 0; i < n; i++) {
      let m = theta[dim];
      const off = i * dim;
      for (let j = 0; j < dim; j++) m += z[off + j] * theta[j];
      margins[i] = m;
    }
    for (let i = 0; i < n; i++) {
      const y = i < np ? 1 : -1;
      const w = i < np ? weightPos : weightNeg;
      const t = -y * margins[i];
      f += w * (t > 0 ? t + Math.log1p(Math.exp(-t)) : Math.log1p(Math.exp(t)));
      const g = (-y * w) / (1 + Math.exp(-t)); // d loss / d margin
      if (g === 0) continue;
      const off = i * dim;
      for (let j = 0; j < dim; j++) grad[j] += g * z[off + j];
      grad[dim] += g;
    }
    f /= n;
    const l2 = 1 / (c * n);
    for (let j = 0; j <= dim; j++) grad[j] /= n;
    for (let j = 0; j < dim; j++) {
      f += 0.5 * l2 * theta[j] * theta[j];
      grad[j] += l2 * theta[j];
    }
    return f;
  };

  const { theta, iterations } = lbfgs(objective, dim + 1);
  const weights = new Array<number>(dim);
  let bias = theta[dim];
  for (let j = 0; j < dim; j++) {
    weights[j] = theta[j] / scale[j];
    bias -= (theta[j] * mean[j]) / scale[j];
  }
  return { weights, bias, iterations };
}

// Limited-memory BFGS with a backtracking (Armijo) line search, from zero. The objective is smooth and strictly
// convex, so this reaches the same minimum as scikit-learn's solver.
function lbfgs(
  objective: (theta: Float64Array, grad: Float64Array) => number,
  size: number,
  { memory = 10, maxIterations = 1000, gradientTolerance = 1e-6 } = {},
): { theta: Float64Array; iterations: number } {
  let theta = new Float64Array(size);
  let grad = new Float64Array(size);
  let f = objective(theta, grad);
  const s: Float64Array[] = [];
  const y: Float64Array[] = [];
  const rho: number[] = [];
  const dot = (a: Float64Array, b: Float64Array) => {
    let r = 0;
    for (let i = 0; i < size; i++) r += a[i] * b[i];
    return r;
  };
  const maxAbs = (a: Float64Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  let iteration = 0;
  for (; iteration < maxIterations && maxAbs(grad) > gradientTolerance; iteration++) {
    // Two-loop recursion: direction = -H * grad.
    const q = Float64Array.from(grad);
    const alpha: number[] = [];
    for (let k = s.length - 1; k >= 0; k--) {
      alpha[k] = rho[k] * dot(s[k], q);
      for (let i = 0; i < size; i++) q[i] -= alpha[k] * y[k][i];
    }
    const gamma = s.length ? dot(s[s.length - 1], y[y.length - 1]) / dot(y[y.length - 1], y[y.length - 1]) : 1 / Math.sqrt(dot(grad, grad));
    for (let i = 0; i < size; i++) q[i] *= gamma;
    for (let k = 0; k < s.length; k++) {
      const beta = rho[k] * dot(y[k], q);
      for (let i = 0; i < size; i++) q[i] += (alpha[k] - beta) * s[k][i];
    }
    const direction = q.map((v) => -v);
    let slope = dot(grad, direction);
    if (slope >= 0) {
      // not a descent direction (numerical trouble): restart from steepest descent
      s.length = y.length = rho.length = 0;
      for (let i = 0; i < size; i++) direction[i] = -grad[i] / Math.sqrt(dot(grad, grad));
      slope = dot(grad, direction);
    }
    let step = 1;
    const next = new Float64Array(size);
    const nextGrad = new Float64Array(size);
    let nextF = Infinity;
    for (let tries = 0; tries < 60; tries++, step /= 2) {
      for (let i = 0; i < size; i++) next[i] = theta[i] + step * direction[i];
      nextF = objective(next, nextGrad);
      if (nextF <= f + 1e-4 * step * slope) break;
    }
    if (!(nextF < f)) break; // no further progress possible at this precision
    const sk = next.map((v, i) => v - theta[i]);
    const yk = nextGrad.map((v, i) => v - grad[i]);
    const sy = dot(sk, yk);
    if (sy > 1e-12) {
      s.push(sk);
      y.push(yk);
      rho.push(1 / sy);
      if (s.length > memory) {
        s.shift();
        y.shift();
        rho.shift();
      }
    }
    const done = f - nextF <= 1e-14 * Math.max(1, Math.abs(f));
    theta = next;
    grad = nextGrad;
    f = nextF;
    if (done) {
      iteration++;
      break;
    }
  }
  return { theta, iterations: iteration };
}
