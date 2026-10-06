// LAB sensitivity analysis (Node, offline): Moonshine key-term boost versus Nordla utility. The result is a SENSITIVITY curve, not a validation: the chosen value is fixed afterwards and re-measured on the phone.
// usage: node tools/voice-bench/sweep-boost.mjs "0,3,4,5,6,7,8" "clean,babble-snr20,machine-snr10"   (0 = terms given with the default boost)
import { readFileSync, writeFileSync } from 'node:fs';
const D = new URL('../../data/local/voice-bench/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const lib = await import(`file:///${D}vendor/moonshine-wasm-0.1.5/dist/index.js`);
const names = ['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort', 'frontend.ort', 'streaming_config.json', 'tokenizer.bin'];
const files = new Map(names.map((n) => [n, new Uint8Array(readFileSync(`${D}models/tiny-streaming-en/quantized_26_08_21/${n}`))]));
const wav = (f) => { const b = readFileSync(f); let o = 12; while (o < b.length) { const id = b.toString('ascii', o, o + 4); const sz = b.readUInt32LE(o + 4); if (id === 'data') { const a = new Float32Array(sz / 2); for (let i = 0; i < a.length; i++) a[i] = b.readInt16LE(o + 8 + i * 2) / 32768; return a; } o += 8 + sz; } };
const TERMS = ['FOB', 'EXW', 'DDP', 'MOQ', 'USD', 'RoHS', 'CE', 'UN38.3', 'power bank', 'deposit', 'balance', 'lead time'];
const boosts = (process.argv[2] ?? '0,3,4,5,6,7,8').split(','); const conds = (process.argv[3] ?? 'clean,babble-snr20,machine-snr10').split(',');
const utter = JSON.parse(readFileSync(new URL('./corpus/utterances.json', import.meta.url), 'utf8')); const ids = [...utter.items.map((i) => i.id), ...utter.scenarioB.map((i) => i.id)];
const runs = []; const out = { tag: 'acc-sweep', mode: 'acc', engines: [], runs, errors: [], note: 'Node, Moonshine tiny-streaming-en, key-term boost sweep, LAB/CONTROLLED' };
for (const b of boosts) {
  const name = `moonshine-en@boost${b}`; out.engines.push(name); const options = b === '0' ? {} : { keyterm_boost: b }; const t = await lib.Transcriber.load({ files, modelArch: lib.ModelArch.TinyStreaming, options }); t.setKeyterms(TERMS);
  for (const cond of conds) for (const id of ids) { const pcm = wav(`${D}corpus/${cond}/${id}.wav`); const s = t.createStream({ updateInterval: 0.5 }); s.start(); const n = 1600; const buf = new Float32Array(pcm.length + 32000); buf.set(pcm); let snap; for (let o = 0; o < buf.length; o += n) { s.addAudio(buf.subarray(o, o + n), 16000); snap = s.transcribe(); } s.stop(); snap = s.transcribe(1); runs.push({ engine: name, cond, id, text: snap.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim(), nLines: snap.lines.length }); s.close(); }
  console.log('done boost', b, runs.length); t.close(); writeFileSync(`${D}results/acc-sweep.json`, JSON.stringify(out, null, 1));
}
out.finishedAt = new Date().toISOString(); writeFileSync(`${D}results/acc-sweep.json`, JSON.stringify(out, null, 1));
