// The sensors' own model, run off the page's thread so the dashboard keeps drawing while a recording is listened
// to. summaries.js sends it 10 s of 32 kHz audio and gets the 960-number summary back.
// This file is served from the dashboard, under the dashboard's own policy in _headers: a worker takes the policy
// of its own script, and the one that covers /model/ allows no scripts and no WebAssembly.
const MODEL_DIR = "/model/";
const MODEL_LEN = 320000;
const DIM = 960;

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

// ONNX Runtime's WebAssembly build and the model file, both from the site itself, loaded once.
function model() {
  loading ??= (async () => {
    const ort = /** @type {Runtime} */ (await import(`${MODEL_DIR}ort.wasm.min.mjs`));
    ort.env.wasm.wasmPaths = MODEL_DIR;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const session = await ort.InferenceSession.create(`${MODEL_DIR}mn10_as.onnx`, { executionProviders: ["wasm"] });
    return { ort, session };
  })();
  // A failed load is forgotten, so the next request tries again.
  loading.catch(() => { loading = null; });
  return loading;
}

// { id } loads the model; { id, audio } also summarises the audio. The reply carries the same id.
self.addEventListener("message", async (event) => {
  const { id, audio } = /** @type {{ id: number, audio?: Float32Array }} */ (event.data);
  try {
    const { ort, session } = await model();
    if (!audio) {
      self.postMessage({ id });
      return;
    }
    const out = await session.run({ audio: new ort.Tensor("float32", audio, [1, MODEL_LEN]) });
    const summary = out.embedding.data.slice(0, DIM);
    self.postMessage({ id, summary }, { transfer: [summary.buffer] });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
