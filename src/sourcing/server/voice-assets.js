// Field Voice assets: serves EXACTLY the Moonshine runtime and the English streaming model that were benchmarked (docs/CHINA-SOURCING-VOICE-BENCH-RESULTS.md), nothing else.
//   /voice/rt/<file>     the WebAssembly runtime (@moonshine-ai/moonshine-wasm 0.1.5, dist/)      <- <dir>/vendor/moonshine-wasm-0.1.5/dist/
//   /voice/model/<file>  tiny-streaming-en, quantized_26_08_21 (7 files, ~52 MB)                   <- <dir>/models/tiny-streaming-en/quantized_26_08_21/
//   /voice/status        { available, runtime, model, bytes }: lets the page say honestly whether voice can start.
// Every file is checked against the SHA-256 recorded when it was downloaded (<dir>/logs/download-manifest.json) before the first byte is sent; a missing manifest, an unknown file or a
// mismatch means the file is NOT served. Nothing is downloaded here, nothing is substituted, nothing leaves the machine. The files are public (MIT) and carry no secret.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const VOICE = Object.freeze({
  runtimeDir: 'vendor/moonshine-wasm-0.1.5/dist/', modelDir: 'models/tiny-streaming-en/quantized_26_08_21/',
  engine: 'moonshine-tiny-streaming-en', version: 'moonshine-wasm@0.1.5 / tiny-streaming-en quantized_26_08_21',
  modelFiles: ['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort', 'frontend.ort', 'streaming_config.json', 'tokenizer.bin'],
});
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.ort': 'application/octet-stream', '.bin': 'application/octet-stream' };
const extOf = (n) => n.slice(n.lastIndexOf('.'));
const SAFE = /^[a-z0-9_.-]+$/i;

export function createVoiceAssets({ dir, headers = {} }) {
  let manifest = null; let manifestError = null; const verified = new Map(); // path -> Promise<{ ok, size, sha }>
  async function loadManifest() {
    if (manifest || manifestError) return manifest;
    try { const m = JSON.parse(await readFile(join(dir, 'logs', 'download-manifest.json'), 'utf8')); manifest = new Map((m.files ?? []).map((f) => [f.file, f])); } catch (e) { manifestError = e; }
    return manifest;
  }
  const entryFor = (kind, name) => {
    if (!SAFE.test(name) || name.includes('..')) return null;
    if (kind === 'rt') return /\.(js|mjs|wasm)$/.test(name) ? `${VOICE.runtimeDir}${name}` : null;
    if (kind === 'model') return VOICE.modelFiles.includes(name) ? `${VOICE.modelDir}${name}` : null;
    return null;
  };
  function verify(rel) {
    if (!verified.has(rel)) verified.set(rel, (async () => {
      const entry = manifest?.get(rel); if (!entry) return { ok: false, reason: 'NOT_IN_MANIFEST' };
      const abs = join(dir, rel); let size; try { size = (await stat(abs)).size; } catch { return { ok: false, reason: 'MISSING' }; }
      if (size !== entry.bytes) return { ok: false, reason: 'SIZE_MISMATCH' };
      const sha = await new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(abs).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); });
      return sha === entry.sha256 ? { ok: true, size, sha, abs } : { ok: false, reason: 'HASH_MISMATCH' };
    })());
    return verified.get(rel);
  }
  async function status() {
    await loadManifest(); if (!manifest) return { available: false, reason: 'NO_MANIFEST' };
    const rels = [...VOICE.modelFiles.map((f) => `${VOICE.modelDir}${f}`), `${VOICE.runtimeDir}index.js`, `${VOICE.runtimeDir}moonshine.mjs`, `${VOICE.runtimeDir}moonshine.wasm`];
    let bytes = 0; for (const r of rels) { const v = await verify(r); if (!v.ok) return { available: false, reason: `${v.reason}: ${r.split('/').pop()}` }; bytes += v.size; }
    return { available: true, engine: VOICE.engine, version: VOICE.version, bytes, language: 'en' };
  }
  const send = (res, code, body, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers, ...extra }); res.end(JSON.stringify(body)); };
  /** @returns {Promise<boolean>} true when the request was a /voice/ one (handled) */
  async function handle(req, res, pathname) {
    if (!pathname.startsWith('/voice/')) return false;
    if (req.method !== 'GET') { send(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
    if (pathname === '/voice/status') { send(res, 200, await status()); return true; }
    const m = /^\/voice\/(rt|model)\/([^/]+)$/.exec(pathname); const rel = m && entryFor(m[1], m[2]);
    if (!rel) { send(res, 404, { error: 'NOT_FOUND' }); return true; }
    await loadManifest(); if (!manifest) { send(res, 404, { error: 'VOICE_NOT_INSTALLED' }); return true; }
    const v = await verify(rel); if (!v.ok) { send(res, v.reason === 'MISSING' || v.reason === 'NOT_IN_MANIFEST' ? 404 : 500, { error: `VOICE_ASSET_${v.reason}` }); return true; }
    res.writeHead(200, { 'content-type': TYPES[extOf(m[2])] ?? 'application/octet-stream', 'content-length': v.size, etag: `"${v.sha}"`, 'cache-control': 'private, max-age=86400', ...headers });
    createReadStream(v.abs).pipe(res); return true;
  }
  return { handle, status };
}
