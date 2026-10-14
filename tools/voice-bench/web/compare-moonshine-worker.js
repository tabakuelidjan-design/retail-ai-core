// FIELD COMPARISON (LAB): the Moonshine tiny-streaming-en engine in a Worker, same files and configuration as the benchmark (and as Field Voice). It receives 16 kHz mono samples and answers with partial text,
// FINAL lines (with the engine's own start/duration) and the time each pass took. Nothing here talks to Nordla.
const RATE = 16000; const FILES = ['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort', 'frontend.ort', 'streaming_config.json', 'tokenizer.bin'];
let tr = null; let st = null; let emitted = null;
const collect = (snap) => { const finals = []; let partial = ''; for (const l of snap.lines ?? []) { if (l.isComplete) { if (!emitted.has(l.id)) { emitted.add(l.id); finals.push({ text: String(l.text ?? ''), startTime: Number.isFinite(l.startTime) ? l.startTime : null, duration: Number.isFinite(l.duration) ? l.duration : null }); } } else partial = String(l.text ?? ''); } return { finals, partial }; };
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') { const t0 = performance.now(); const lib = await import('/vendor/moonshine-wasm-0.1.5/dist/index.js'); tr = await lib.Transcriber.loadFromUrls(Object.fromEntries(FILES.map((f) => [f, `/models/tiny-streaming-en/quantized_26_08_21/${f}`])), { modelArch: lib.ModelArch.TinyStreaming, options: {} }); self.postMessage({ type: 'ready', loadMs: Math.round(performance.now() - t0) }); }
    else if (m.type === 'start') { st = tr.createStream({ updateInterval: 0.5 }); st.start(); emitted = new Set(); self.postMessage({ type: 'started' }); }
    else if (m.type === 'audio') { if (!st) return; const t0 = performance.now(); st.addAudio(m.pcm, RATE); const r = collect(st.transcribe()); self.postMessage({ type: 'result', seq: m.seq, passMs: Math.round((performance.now() - t0) * 10) / 10, ...r }); }
    else if (m.type === 'flush') { let r = { finals: [], partial: '' }; if (st) { st.stop(); r = collect(st.transcribe(1)); st.close(); st = null; } self.postMessage({ type: 'flushed', ...r }); }
  } catch (e) { self.postMessage({ type: 'error', where: m.type, message: String(e?.message ?? e) }); }
};
