// One-off LAB experiment (Node): does Moonshine's key-term biasing fix the domain words the recogniser gets wrong (CE, RoHS, FOB Shenzhen, lead time)? Uses only the approved engine and model.
import { readFileSync } from 'node:fs';
const D = new URL('../../data/local/voice-bench/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const lib = await import(`file:///${D}vendor/moonshine-wasm-0.1.5/dist/index.js`);
const names = ['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort', 'frontend.ort', 'streaming_config.json', 'tokenizer.bin'];
const files = new Map(names.map((n) => [n, new Uint8Array(readFileSync(`${D}models/tiny-streaming-en/quantized_26_08_21/${n}`))]));
const wav = (f) => { const b = readFileSync(f); let o = 12; while (o < b.length) { const id = b.toString('ascii', o, o + 4); const sz = b.readUInt32LE(o + 4); if (id === 'data') { const a = new Float32Array(sz / 2); for (let i = 0; i < a.length; i++) a[i] = b.readInt16LE(o + 8 + i * 2) / 32768; return a; } o += 8 + sz; } };
const TERMS = ['FOB', 'EXW', 'DDP', 'MOQ', 'USD', 'RoHS', 'CE', 'UN38.3', 'Shenzhen', 'lead time', 'deposit'];
const clips = [['clean', 'S3'], ['clean', 'S8'], ['clean', 'S4'], ['machine-snr10', 'S4'], ['clean', 'O7']];
for (const boost of [null, '1.0', '3.0', '6.0', '10.0']) {
  const options = boost ? { keyterm_boost: boost } : {}; const t = await lib.Transcriber.load({ files, modelArch: lib.ModelArch.TinyStreaming, options }); if (boost) t.setKeyterms(TERMS);
  const out = [];
  for (const [cond, id] of clips) { const pcm = wav(`${D}corpus/${cond}/${id}.wav`); const s = t.createStream({ updateInterval: 0.5 }); s.start(); const n = 1600; const buf = new Float32Array(pcm.length + 32000); buf.set(pcm); let snap; for (let o = 0; o < buf.length; o += n) { s.addAudio(buf.subarray(o, o + n), 16000); snap = s.transcribe(); } s.stop(); snap = s.transcribe(1); out.push(`${id}/${cond}: ${snap.lines.map((l) => l.text).join(' ')}`); s.close(); }
  console.log(`--- keyterm_boost=${boost ?? 'none (no terms)'}`); for (const o of out) console.log('  ', o); t.close();
}
