// Engine adapters for the isolated voice benchmark. Common contract: load() -> info; run(pcm16k, {realtime}) -> { text, lines, firstPartialMs, finalMs, passes, cpuMs, rtf }
// Times are wall-clock milliseconds measured with performance.now(). latency = (moment the final text is available) - (moment the LAST SPEECH sample of the clip was fed).
// Nothing here talks to Nordla. Models are loaded from /models (local files), never from a CDN.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rmsFrames = (pcm, sr = 16000, frame = 0.02) => { const n = Math.floor(sr * frame); const out = []; for (let i = 0; i + n <= pcm.length; i += n) { let s = 0; for (let j = 0; j < n; j++) s += pcm[i + j] * pcm[i + j]; out.push(Math.sqrt(s / n)); } return out; };
/** end of speech (seconds): last 20 ms frame above 12 % of the peak frame energy (simple, deterministic). */
export function speechEnd(pcm, sr = 16000) { const f = rmsFrames(pcm, sr); const peak = Math.max(...f); let last = 0; for (let i = 0; i < f.length; i++) if (f[i] > peak * 0.12) last = i; return (last + 1) * 0.02; }
export function speechStart(pcm, sr = 16000) { const f = rmsFrames(pcm, sr); const peak = Math.max(...f); for (let i = 0; i < f.length; i++) if (f[i] > peak * 0.12) return i * 0.02; return 0; }

// The pinned engine 0.1.5 expects ONE frontend.ort for tiny-streaming-en (manifest quantized_26_07_30); it does not know the Mandarin streaming model at all (see the report).
const MS_FILES = ['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort', 'frontend.ort', 'streaming_config.json', 'tokenizer.bin'];
let msLib = null;
export async function loadMoonshine(lang, onLog = () => {}, extraOptions = {}) {
  const t0 = performance.now(); msLib ??= await import('/vendor/moonshine-wasm-0.1.5/dist/index.js');
  const dir = lang === 'zh' ? 'tiny-streaming-zh/quantized_26_08_24' : 'tiny-streaming-en/quantized_26_08_21';
  const files = Object.fromEntries(MS_FILES.map((f) => [f, `/models/${dir}/${f}`]));
  const options = { ...(lang === 'zh' ? { max_tokens_per_second: '13.0' } : {}), ...extraOptions };
  const t = await msLib.Transcriber.loadFromUrls(files, { modelArch: msLib.ModelArch.TinyStreaming, options }); const loadMs = performance.now() - t0; onLog(`moonshine ${lang} loaded in ${Math.round(loadMs)} ms`);
  return {
    name: `moonshine-tiny-streaming-${lang}`, loadMs, raw: t,
    /** Feeds the clip at real-time pace in 100 ms chunks, then silence. */
    async run(pcm, { realtime = true, tailSilenceS = 2.0, chunkS = 0.1, keyterms = null } = {}) {
      if (keyterms) t.setKeyterms(keyterms);
      const stream = t.createStream({ updateInterval: 0.5 }); stream.start(); const sr = 16000; const n = Math.floor(sr * chunkS); const endS = speechEnd(pcm); const startS = speechStart(pcm);
      const total = Math.ceil(pcm.length / n) * n + Math.floor(tailSilenceS * sr); const buf = new Float32Array(total); buf.set(pcm);
      const wall0 = performance.now(); let feedEndAt = null; let firstPartialAt = null; const events = []; let passes = 0; let cpuMs = 0;
      for (let off = 0; off < total; off += n) {
        const audioT = off / sr; if (realtime) { const due = wall0 + audioT * 1000; const wait = due - performance.now(); if (wait > 1) await sleep(wait); }
        if (feedEndAt === null && audioT >= endS) feedEndAt = performance.now();
        const t1 = performance.now(); stream.addAudio(buf.subarray(off, off + n), sr); const snap = stream.transcribe(); const dt = performance.now() - t1; if (dt > 5) { passes++; cpuMs += dt; }
        const now = performance.now();
        for (const l of snap.lines) { if (l.text && l.text.trim() && firstPartialAt === null && audioT >= startS) firstPartialAt = now; if (l.isComplete && !events.find((e) => e.id === l.id)) events.push({ id: l.id, text: l.text, at: now }); }
      }
      stream.stop(); const snap2 = stream.transcribe(1); for (const l of snap2.lines) if (l.isComplete && !events.find((e) => e.id === l.id)) events.push({ id: l.id, text: l.text, at: performance.now() });
      const lines = snap2.lines.map((l) => ({ id: l.id, text: l.text, complete: l.isComplete })); const text = lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
      const lastComplete = events.length ? Math.max(...events.map((e) => e.at)) : null; stream.close();
      return { text, lines, firstPartialMs: firstPartialAt !== null ? Math.round(firstPartialAt - wall0 - startS * 1000) : null, finalMs: lastComplete !== null && feedEndAt !== null ? Math.round(lastComplete - feedEndAt) : null, passes, cpuMs: Math.round(cpuMs), audioS: +(pcm.length / sr).toFixed(2), rtf: +(cpuMs / 1000 / (pcm.length / sr)).toFixed(3) };
    },
  };
}

let tfLib = null; let asr = null;
export async function loadWhisper(onLog = () => {}) {
  const t0 = performance.now(); tfLib ??= await import('/vendor/transformers-4.3.0/transformers.min.js'); const { pipeline, env } = tfLib;
  env.allowLocalModels = true; env.allowRemoteModels = false; env.localModelPath = '/models/'; env.useBrowserCache = false; env.backends.onnx.wasm.wasmPaths = { mjs: '/vendor/ort-web-1.31.0-dev.20260914/ort-wasm-simd-threaded.mjs', wasm: '/vendor/ort-web-1.31.0-dev.20260914/ort-wasm-simd-threaded.wasm' };
  asr ??= await pipeline('automatic-speech-recognition', 'whisper-tiny-onnx', { dtype: 'int8', device: 'wasm' }); const loadMs = performance.now() - t0; onLog(`whisper tiny loaded in ${Math.round(loadMs)} ms`);
  return {
    name: 'whisper-tiny-int8', loadMs,
    /** Not a streaming engine: energy end-pointing (0.6 s of silence) then one pass over the utterance. */
    async run(pcm, { realtime = true, language = 'english', endSilenceS = 0.6 } = {}) {
      const endS = speechEnd(pcm); const wall0 = performance.now(); if (realtime) await sleep((endS + endSilenceS) * 1000); const feedEndAt = wall0 + endS * 1000;
      const t1 = performance.now(); const out = await asr(pcm, { language, task: 'transcribe', chunk_length_s: 30 }); const cpuMs = performance.now() - t1; const doneAt = performance.now(); const text = (out.text || '').replace(/\s+/g, ' ').trim();
      return { text, lines: [{ id: '0', text, complete: true }], firstPartialMs: null, finalMs: Math.round(doneAt - feedEndAt), passes: 1, cpuMs: Math.round(cpuMs), audioS: +(pcm.length / 16000).toFixed(2), rtf: +(cpuMs / 1000 / (pcm.length / 16000)).toFixed(3) };
    },
  };
}

const wavCache = new Map();
export async function fetchWav(url) { if (wavCache.has(url)) return wavCache.get(url); const a = await fetchWav1(url); wavCache.set(url, a); return a; }
async function fetchWav1(url) { const b = await (await fetch(url)).arrayBuffer(); const v = new DataView(b); let o = 12; while (o < b.byteLength) { const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)); const sz = v.getUint32(o + 4, true); if (id === 'data') { const n = sz / 2; const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = v.getInt16(o + 8 + i * 2, true) / 32768; return a; } o += 8 + sz; } throw new Error('no data chunk'); }
export const envReport = async () => {
  const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  let storage = null; try { const e = await navigator.storage.estimate(); storage = { usageMB: Math.round(e.usage / 1e5) / 10, quotaMB: Math.round(e.quota / 1e5) / 10 }; } catch { /* n/a */ }
  return { ua: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined', wasmSimd: simd, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory ?? null, audioWorklet: typeof AudioWorkletNode !== 'undefined', getUserMedia: !!navigator.mediaDevices?.getUserMedia, mediaRecorder: typeof MediaRecorder !== 'undefined', cacheApi: typeof caches !== 'undefined', secureContext: self.isSecureContext, storage, batteryApi: !!navigator.getBattery };
};
