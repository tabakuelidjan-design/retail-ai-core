// Field Voice engine, OFF the main thread: the benchmarked Moonshine runtime (@moonshine-ai/moonshine-wasm 0.1.5) with the English streaming model (tiny-streaming-en, quantized_26_08_21).
// It receives 16 kHz mono samples and answers with partial text and FINAL lines. It stores nothing, sends nothing anywhere and keeps no audio after a pass. The server serves this script with its own
// Content-Security-Policy (the runtime needs eval + WebAssembly); the page itself keeps the strict one. Files come from /voice/ (hash-checked by the server).
const RATE = 16000;
const MODEL_FILES = ['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort', 'frontend.ort', 'streaming_config.json', 'tokenizer.bin'];
let tr = null; let st = null; let emitted = null;
const post = (m) => self.postMessage(m);
const collect = (snap) => {
  const finals = []; let partial = '';
  for (const l of snap.lines ?? []) { if (l.isComplete) { if (!emitted.has(l.id)) { emitted.add(l.id); finals.push({ text: String(l.text ?? ''), startTime: Number.isFinite(l.startTime) ? l.startTime : null, duration: Number.isFinite(l.duration) ? l.duration : null }); } } else partial = String(l.text ?? ''); }
  return { finals, partial };
};
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      const lib = await import('/voice/rt/index.js');
      tr = await lib.Transcriber.loadFromUrls(Object.fromEntries(MODEL_FILES.map((f) => [f, `/voice/model/${f}`])), { modelArch: lib.ModelArch.TinyStreaming, options: {} });
      post({ type: 'ready' });
    } else if (m.type === 'start') {
      st = tr.createStream({ updateInterval: 0.5 }); st.start(); emitted = new Set(); post({ type: 'started' });
    } else if (m.type === 'audio') {
      if (!st) return; st.addAudio(m.pcm, RATE); const r = collect(st.transcribe()); post({ type: 'result', seq: m.seq, ...r });
    } else if (m.type === 'flush') {
      let r = { finals: [], partial: '' }; if (st) { st.stop(); r = collect(st.transcribe(1)); st.close(); st = null; } post({ type: 'flushed', ...r });
    }
  } catch (e) { post({ type: 'error', where: m.type, message: String(e?.message ?? e) }); }
};
