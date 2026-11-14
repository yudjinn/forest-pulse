// Band-limited resampling through the spectrum, the same method as the sensor library's to_model_audio: keep the
// spectrum below the new Nyquist and transform back at the new length. The browser's own resampler rolls off well
// below 16 kHz, which changes the model's summary of quiet, hissy audio; this keeps the band the sensor keeps.
// Transforms of any length use Bluestein's method over a power-of-two FFT; chirps are cached per length.

/** @type {Map<number, { cos: Float64Array, sin: Float64Array }>} */
const twiddles = new Map();

/** In-place radix-2 FFT of a power-of-two length. @param {Float64Array} re @param {Float64Array} im */
function fft2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  let t = twiddles.get(n);
  if (!t) {
    t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) {
      t.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      t.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    twiddles.set(n, t);
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step];
        const wi = t.sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// The most recent chirps only: a page resamples many windows of one or two lengths (5 s at each source rate) and
// one-off lengths for short recordings, whose chirps are 8 to 18 MB each and must not accumulate.
const KEEP_CHIRPS = 2;
/** @type {Map<number, { m: number, cr: Float64Array, ci: Float64Array, br: Float64Array, bi: Float64Array }>} */
const chirps = new Map();

/** @param {number} n */
function chirp(n) {
  let c = chirps.get(n);
  if (c) {
    chirps.delete(n); // most recently used last
    chirps.set(n, c);
    return c;
  }
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const cr = new Float64Array(n);
  const ci = new Float64Array(n);
  const br = new Float64Array(m);
  const bi = new Float64Array(m);
  for (let j = 0; j < n; j++) {
    // exp(-i pi j^2 / n), with j^2 taken modulo 2n so the angle stays exact for long transforms
    const angle = (Math.PI * ((j * j) % (2 * n))) / n; // exact below 2^53, so for any audio length
    cr[j] = Math.cos(angle);
    ci[j] = -Math.sin(angle);
    br[j] = cr[j];
    bi[j] = -ci[j];
    if (j > 0) {
      br[m - j] = cr[j];
      bi[m - j] = -ci[j];
    }
  }
  fft2(br, bi);
  c = { m, cr, ci, br, bi };
  chirps.set(n, c);
  while (chirps.size > KEEP_CHIRPS) chirps.delete(/** @type {number} */ (chirps.keys().next().value));
  return c;
}

/** Forward DFT of any length, in place. @param {Float64Array} re @param {Float64Array} im */
function dft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) === 0) return fft2(re, im);
  const { m, cr, ci, br, bi } = chirp(n);
  const ar = new Float64Array(m);
  const ai = new Float64Array(m);
  for (let j = 0; j < n; j++) {
    ar[j] = re[j] * cr[j] - im[j] * ci[j];
    ai[j] = re[j] * ci[j] + im[j] * cr[j];
  }
  fft2(ar, ai);
  for (let k = 0; k < m; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k];
    ai[k] = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r;
  }
  // inverse FFT through the conjugate
  for (let k = 0; k < m; k++) ai[k] = -ai[k];
  fft2(ar, ai);
  for (let k = 0; k < n; k++) {
    const r = ar[k] / m;
    const i = -ai[k] / m;
    re[k] = r * cr[k] - i * ci[k];
    im[k] = r * ci[k] + i * cr[k];
  }
}

/** Python's round(): halves to even. @param {number} x */
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Mono audio at rateIn -> the same audio at rateOut, band-limited through the spectrum (numpy rfft and irfft
 * semantics, as the sensor library resamples each window).
 * @param {Float32Array} x
 * @param {number} rateIn
 * @param {number} rateOut
 * @returns {Float32Array}
 */
export function resample(x, rateIn, rateOut) {
  if (rateIn === rateOut) return x;
  const n = x.length;
  const nOut = roundHalfEven((n * rateOut) / rateIn);
  if (nOut === 0 || n === 0) return new Float32Array(0);
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  dft(re, im);
  const bins = Math.floor(n / 2) + 1; // what numpy's rfft returns
  const keep = Math.floor(nOut / 2) + 1;
  const yr = new Float64Array(nOut);
  const yi = new Float64Array(nOut);
  const at = (/** @type {number} */ k) => (k < bins ? [re[k], im[k]] : [0, 0]);
  yr[0] = at(0)[0]; // irfft ignores the imaginary part of the zero-frequency bin
  for (let k = 1; k < keep; k++) {
    const [r, i] = at(k);
    if (2 * k === nOut) {
      yr[k] = r; // and of the Nyquist bin of an even length
      continue;
    }
    yr[k] = r;
    yi[k] = i;
    yr[nOut - k] = r;
    yi[nOut - k] = -i;
  }
  // inverse transform through the conjugate; the output is real
  for (let k = 0; k < nOut; k++) yi[k] = -yi[k];
  dft(yr, yi);
  const out = new Float32Array(nOut);
  for (let k = 0; k < nOut; k++) out[k] = yr[k] / n; // 1/nOut from the inverse, times nOut/n
  return out;
}
