// Turns a researcher's recordings into the 960-number summaries a detector trains on, in the browser, with the
// sensors' own model file and the sensor library's own downmix, resampling and 10 s fill, so a detector taught here
// sees what a sensor computes. Audio never leaves the page; only the summaries are sent.
import { resample } from "/dashboard/teach/resample.js";

export const RATE = 32000;
export const DIM = 960;
const MODEL_LEN = 10 * RATE; // the model's input; shorter audio is repeated to fill it
const RATIO_DB = /** @type {const} */ ([-3, 15]);
const MODEL_DIR = "/model/";
const FALLBACK_RATE = 48000;

/** @param {Uint8Array} b @param {number} at @param {string} text */
const has = (b, at, text) => [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));

/**
 * The sample rate a recording's decoder produces, read from its header (WAV, FLAC, MP3, Ogg Vorbis or Opus, M4A),
 * or null when it cannot be read. Decoding at that rate means the browser never resamples.
 * @param {ArrayBuffer} bytes
 * @returns {number | null}
 */
export function sourceRate(bytes) {
  const b = new Uint8Array(bytes);
  const v = new DataView(bytes);
  if (b.length < 12) return null;
  if (has(b, 0, "RIFF") && has(b, 8, "WAVE")) {
    for (let at = 12; at + 16 <= b.length; at += 8 + v.getUint32(at + 4, true) + (v.getUint32(at + 4, true) & 1)) {
      if (has(b, at, "fmt ")) return v.getUint32(at + 12, true);
    }
    return null;
  }
  if (has(b, 0, "fLaC") && b.length >= 21) return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  if (has(b, 0, "OggS") && b.length >= 28) {
    const packet = 27 + b[26];
    if (has(b, packet, "OpusHead")) return 48000; // Opus always decodes at 48 kHz
    if (b[packet] === 1 && has(b, packet + 1, "vorbis")) return v.getUint32(packet + 12, true);
    return null;
  }
  if (has(b, 4, "ftyp")) {
    // the audio sample entry: its 16.16 sample rate sits 28 bytes after the "mp4a" type
    for (let at = 8; at + 32 <= b.length; at++) if (has(b, at, "mp4a")) return v.getUint16(at + 28);
    return null;
  }
  let at = 0;
  if (has(b, 0, "ID3") && b.length >= 10) {
    at = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  }
  for (const end = Math.min(b.length - 3, at + 65536); at < end; at++) {
    if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[at + 1] >> 3) & 3; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5
    const index = (b[at + 2] >> 2) & 3;
    if (version === 1 || index === 3 || ((b[at + 1] >> 1) & 3) === 0) continue;
    const base = [44100, 48000, 32000][index];
    return version === 3 ? base : version === 2 ? base / 2 : base / 4;
  }
  return null;
}

const USED_SECONDS = 60;
const FIRST_PREFIX = 2 * 1024 * 1024;

/**
 * The first `size` bytes of a recording as a file the decoder accepts. A WAV's header is patched to the shorter
 * data; compressed formats decode a cut-off stream as far as it goes.
 * @param {ArrayBuffer} bytes
 * @param {number} size
 */
function prefix(bytes, size) {
  const part = bytes.slice(0, size);
  const b = new Uint8Array(part);
  if (size === bytes.byteLength || !(has(b, 0, "RIFF") && has(b, 8, "WAVE"))) return part;
  const v = new DataView(part);
  let align = 1;
  for (let at = 12; at + 8 <= size; at += 8 + v.getUint32(at + 4, true) + (v.getUint32(at + 4, true) & 1)) {
    if (has(b, at, "fmt ") && at + 22 <= size) align = Math.max(1, v.getUint16(at + 20, true)); // bytes per frame
    if (has(b, at, "data")) {
      v.setUint32(at + 4, Math.floor((size - at - 8) / align) * align, true);
      v.setUint32(4, size - 8, true);
      return part;
    }
  }
  return part;
}

/**
 * A recording's bytes -> mono audio at the recording's own rate: the browser's own decoder, channels averaged.
 * Only as much is decoded as the first 60 s needs (a growing prefix of the file), so a long field recording never
 * becomes gigabytes of audio in the page. Rejects when the browser cannot decode it.
 * @param {ArrayBuffer} bytes
 * @returns {Promise<{ audio: Float32Array, rate: number }>}
 */
export async function decode(bytes) {
  const header = sourceRate(bytes);
  const rate = header && header >= 8000 && header <= 384000 ? header : FALLBACK_RATE;
  const context = new OfflineAudioContext(1, 1, rate);
  /** @type {AudioBuffer} */
  let decoded;
  for (let size = Math.min(bytes.byteLength, FIRST_PREFIX); ; size = Math.min(bytes.byteLength, size * 4)) {
    try {
      decoded = await context.decodeAudioData(prefix(bytes, size));
    } catch (e) {
      if (size === bytes.byteLength) throw e;
      size = bytes.byteLength / 4; // a cut-off file this format cannot decode (an M4A indexed at its end): all of it
      continue;
    }
    if (decoded.duration >= USED_SECONDS || size === bytes.byteLength) break;
  }
  const length = Math.min(decoded.length, USED_SECONDS * rate);
  const audio = new Float32Array(length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < length; i++) audio[i] += ch[i];
  }
  if (decoded.numberOfChannels > 1) for (let i = 0; i < length; i++) audio[i] /= decoded.numberOfChannels;
  return { audio, rate };
}

/**
 * The windows teaching uses, at the model's 32 kHz: the first 60 s in 5 s windows, a recording shorter than 5 s as
 * one window, none for a recording shorter than 1 s. Each window is resampled on its own, as a sensor does.
 * @param {Float32Array} audio mono
 * @param {number} rate
 * @returns {Float32Array[]}
 */
export function windows(audio, rate) {
  const window = 5 * rate;
  const clip = audio.subarray(0, 60 * rate);
  if (clip.length < rate) return [];
  if (clip.length < window) return [toModelRate(clip, rate)];
  const out = [];
  for (let i = 0; i + window <= clip.length; i += window) out.push(toModelRate(clip.subarray(i, i + window), rate));
  return out;
}

/** Mono audio at any rate -> 32 kHz, as the sensor library resamples. @param {Float32Array} x @param {number} rate */
export function toModelRate(x, rate) {
  return resample(x, rate, RATE);
}

/**
 * The window over a random stretch of the background, the window louder by a random -3 to +15 dB (RMS).
 * @param {Float32Array} window 32 kHz
 * @param {Float32Array} background 32 kHz, at least as long as the window
 * @param {() => number} random uniform in [0, 1)
 */
export function mixOver(window, background, random = Math.random) {
  const ratio = RATIO_DB[0] + (RATIO_DB[1] - RATIO_DB[0]) * random();
  const offset = Math.floor(random() * (background.length - window.length + 1));
  let w2 = 0;
  let b2 = 0;
  for (let i = 0; i < window.length; i++) {
    w2 += window[i] * window[i];
    b2 += background[offset + i] * background[offset + i];
  }
  const gain = Math.sqrt(w2 / window.length / (b2 / window.length + 1e-12)) / 10 ** (ratio / 20);
  const out = new Float32Array(window.length);
  for (let i = 0; i < window.length; i++) out[i] = window[i] + gain * background[offset + i];
  return out;
}

/** Repeat or trim to exactly the model's 10 s, as the sensor library does. @param {Float32Array} audio */
function fill(audio) {
  if (audio.length >= MODEL_LEN) return audio.slice(audio.length - MODEL_LEN);
  const out = new Float32Array(MODEL_LEN);
  for (let i = 0; i < MODEL_LEN; i += audio.length) out.set(audio.subarray(0, Math.min(audio.length, MODEL_LEN - i)), i);
  return out;
}

/**
 * @typedef {{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> }} Session
 * @typedef {{
 *   env: { wasm: { wasmPaths: string, numThreads: number, proxy: boolean } },
 *   InferenceSession: { create(url: string, options: object): Promise<Session> },
 *   Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown,
 * }} Runtime
 */

/** @type {Promise<{ ort: Runtime, session: Session }> | null} */
let loading = null;

// ONNX Runtime's WebAssembly build and the model file, both from the site itself, loaded once per page.
function model() {
  loading ??= (async () => {
    const ort = /** @type {Runtime} */ (await import(`${MODEL_DIR}ort.wasm.min.mjs`));
    ort.env.wasm.wasmPaths = MODEL_DIR;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const session = await ort.InferenceSession.create(`${MODEL_DIR}mn10_as.onnx`, { executionProviders: ["wasm"] });
    return { ort, session };
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** Starts loading the model; resolves once it can run, rejects if it cannot load. */
export async function loadModel() {
  await model();
}

/**
 * One summary: mono 32 kHz audio of any length > 0 -> the model's 960-number embedding.
 * @param {Float32Array} audio
 * @returns {Promise<Float32Array>}
 */
export async function summarise(audio) {
  const { ort, session } = await model();
  const out = await session.run({ audio: new ort.Tensor("float32", fill(audio), [1, MODEL_LEN]) });
  return out.embedding.data.slice(0, DIM);
}
