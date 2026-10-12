// FIELD COMPARISON (LAB): Whisper tiny int8 (the benchmark's control) in a Worker. Not a streaming engine: the page cuts the live audio into utterances (energy end-pointing) and posts each one; every utterance
// is transcribed in ONE pass. Same models and runtime files as the benchmark. Nothing here talks to Nordla.
let asr = null;
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      const t0 = performance.now(); const { pipeline, env } = await import('/vendor/transformers-4.3.0/transformers.min.js');
      env.allowLocalModels = true; env.allowRemoteModels = false; env.localModelPath = '/models/'; env.useBrowserCache = false; env.backends.onnx.wasm.wasmPaths = { mjs: '/vendor/ort-web-1.31.0-dev.20260914/ort-wasm-simd-threaded.mjs', wasm: '/vendor/ort-web-1.31.0-dev.20260914/ort-wasm-simd-threaded.wasm' };
      asr = await pipeline('automatic-speech-recognition', 'whisper-tiny-onnx', { dtype: 'int8', device: 'wasm' }); self.postMessage({ type: 'ready', loadMs: Math.round(performance.now() - t0) });
    } else if (m.type === 'run') {
      const t0 = performance.now(); const out = await asr(m.pcm, { language: 'english', task: 'transcribe', chunk_length_s: 30 }); self.postMessage({ type: 'done', id: m.id, text: String(out.text ?? '').replace(/\s+/g, ' ').trim(), passMs: Math.round(performance.now() - t0), audioSec: Math.round((m.pcm.length / 16000) * 100) / 100 });
    }
  } catch (e) { self.postMessage({ type: 'error', where: m.type, id: m.id, message: String(e?.message ?? e) }); }
};
