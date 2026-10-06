// Voice benchmark: downloads ONLY the artefacts the owner approved (2026-10-06), verifies each size against the published size, and logs size + SHA-256.
// Nothing is added to package.json. Files go to data/local/voice-bench/ (git-ignored). Run once: node tools/voice-bench/download.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, createWriteStream, statSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
const ROOT = new URL('../../data/local/voice-bench/', import.meta.url); const P = (p) => new URL(p, ROOT);
const MS = 'https://download.moonshine.ai/model';
const mk = (base, files) => files.map(([n, size]) => ({ url: `${base}/${n}`, size }));
const ITEMS = [
  // --- B. Moonshine engine @moonshine-ai/moonshine-wasm 0.1.5 (MIT), pinned; files from the npm CDN mirror for that exact version
  ...mk('https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-wasm@0.1.5/dist', [['moonshine.wasm', 13155937], ['moonshine.mjs', 156457], ['index.js', 1733], ['enums.js', 2058], ['errors.js', 4712], ['events.js', 2105], ['module.js', 4053], ['stream.js', 6681], ['transcriber.js', 10646], ['mic-transcriber.js', 13397], ['microphone-transcriber.js', 5859], ['stt-worker.js', 7573], ['stt-worker-host.js', 7826], ['stt-worker-protocol.js', 352], ['asset-downloader.js', 7398], ['types.js', 2373], ['agent-flow.js', 25486], ['text-to-speech.js', 32049], ['tts-worker.js', 2669], ['tts-worker-host.js', 4440], ['tts-worker-protocol.js', 343], ['voice-clone.js', 8568], ['embedding-model.js', 5457], ['grapheme-to-phonemizer.js', 2095], ['intent-recognizer.js', 3733]]).map((i) => ({ ...i, dest: `vendor/moonshine-wasm-0.1.5/dist/${i.url.split('/').pop()}` })),
  { url: 'https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-wasm@0.1.5/package.json', size: 1555, dest: 'vendor/moonshine-wasm-0.1.5/package.json' },
  // --- B. models (MIT, owner-approved): streaming only
  ...mk(`${MS}/tiny-streaming-zh/quantized_26_08_24`, [['adapter.ort', 1318472], ['cross_kv.ort', 1288120], ['decoder_kv.ort', 19717336], ['encoder.ort', 7772792], ['frontend.model.ort', 27608], ['frontend.weights.ort', 2090728], ['streaming_config.json', 509], ['tokenizer.bin', 74587]]).map((i) => ({ ...i, dest: `models/tiny-streaming-zh/quantized_26_08_24/${i.url.split('/').pop()}` })),
  ...mk(`${MS}/tiny-streaming-en/quantized_26_08_21`, [['adapter.ort', 1319664], ['cross_kv.ort', 1287544], ['decoder_kv.ort', 32583720], ['encoder.ort', 7675440], ['frontend.model.ort', 23344], ['frontend.weights.ort', 2093464], ['streaming_config.json', 509], ['tokenizer.bin', 249974]]).map((i) => ({ ...i, dest: `models/tiny-streaming-en/quantized_26_08_21/${i.url.split('/').pop()}` })),
  // --- C. control: Whisper tiny ONNX int8 (Apache-2.0 / MIT) + Transformers.js 4.3.0 (Apache-2.0) + its pinned ONNX Runtime Web (MIT)
  ...[['onnx/encoder_model_int8.onnx', 10124977], ['onnx/decoder_model_merged_int8.onnx', 30719241], ['tokenizer.json', 2480466], ['tokenizer_config.json', 282683], ['config.json', 2243], ['generation_config.json', 3772], ['preprocessor_config.json', 339]].map(([n, size]) => ({ url: `https://huggingface.co/onnx-community/whisper-tiny/resolve/main/${n}`, size, dest: `models/whisper-tiny-onnx/${n}` })),
  { url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js', size: 581935, dest: 'vendor/transformers-4.3.0/transformers.min.js' },
  { url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.wasm', size: 14264838, dest: 'vendor/ort-web-1.31.0-dev.20260914/ort-wasm-simd-threaded.wasm' },
  { url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.mjs', size: 24381, dest: 'vendor/ort-web-1.31.0-dev.20260914/ort-wasm-simd-threaded.mjs' },
];
const only = process.argv[2]; const log = []; let bytes = 0;
for (const it of ITEMS) {
  if (only && !it.dest.includes(only)) continue;
  const f = P(it.dest); mkdirSync(dirname(f.pathname.replace(/^\//, '')), { recursive: true });
  const path = decodeURIComponent(f.pathname.replace(/^\//, ''));
  if (!existsSync(path) || statSync(path).size !== it.size) {
    const r = await fetch(it.url, { redirect: 'follow' }); if (!r.ok) { log.push({ ...it, ok: false, status: r.status }); console.log('FAIL', r.status, it.url); continue; }
    await pipeline(Readable.fromWeb(r.body), createWriteStream(path));
  }
  const buf = readFileSync(path); const sha = createHash('sha256').update(buf).digest('hex'); const size = buf.length; bytes += size;
  const ok = size === it.size; log.push({ file: it.dest, url: it.url, expectedBytes: it.size, bytes: size, sizeMatches: ok, sha256: sha }); console.log(ok ? 'OK  ' : 'SIZE', size, it.dest);
}
writeFileSync(P('logs/download-manifest.json'), JSON.stringify({ at: new Date().toISOString(), totalBytes: bytes, files: log }, null, 1));
console.log('total bytes', bytes, (bytes / 1e6).toFixed(2), 'MB; mismatches', log.filter((x) => x.sizeMatches === false || x.ok === false).length);
