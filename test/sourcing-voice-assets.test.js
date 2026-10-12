// FIELD VOICE - serving the benchmarked runtime + model, and the SCOPE of the extra privileges it needs: cross-origin isolation (WebAssembly threads) for the page, eval/WebAssembly only for the
// voice worker and the /voice/ files. Fake files stand in for the 66 MB (the real ones are exercised by the voice e2e).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { startSourcingServer } from '../src/sourcing/server/index.js';
import { freePort } from './e2e/cdp.js';

const RT = 'vendor/moonshine-wasm-0.1.5/dist/'; const MD = 'models/tiny-streaming-en/quantized_26_08_21/';
const FILES = { [`${RT}index.js`]: 'export const ok = 1;', [`${RT}moonshine.mjs`]: 'export default () => 1;', [`${RT}moonshine.wasm`]: 'WASM-BYTES', ...Object.fromEntries(['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort', 'frontend.ort', 'streaming_config.json', 'tokenizer.bin'].map((f) => [`${MD}${f}`, `model:${f}`])) };
function install(voiceDir, { manifest = true, tamper = null } = {}) {
  const entries = [];
  for (const [rel, body] of Object.entries(FILES)) { const abs = join(voiceDir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body); entries.push({ file: rel, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }); }
  if (manifest) { mkdirSync(join(voiceDir, 'logs'), { recursive: true }); writeFileSync(join(voiceDir, 'logs', 'download-manifest.json'), JSON.stringify({ files: entries })); }
  if (tamper) writeFileSync(join(voiceDir, tamper), 'TAMPERED-BYTES!');
}
async function boot(opts) {
  const root = mkdtempSync(join(tmpdir(), 'nordla-voice-')); const voiceDir = join(root, 'voice'); install(voiceDir, opts); const port = await freePort();
  const srv = await startSourcingServer({ env: { SOURCING_TOKEN: 'voice-test-token-0123456789-abcdef', SOURCING_VOICE_DIR: voiceDir }, log: () => {}, port, dir: join(root, 'data'), fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<x/>' }), ecb: async () => ({ date: '2026-10-06', perEur: { USD: 1.08 } }) });
  return { base: `http://127.0.0.1:${port}`, close: async () => { await new Promise((r) => srv.server.close(r)); rmSync(root, { recursive: true, force: true }); } };
}

test('/voice/status reports availability from the hash-checked manifest', async () => {
  const s = await boot(); try { const j = await (await fetch(`${s.base}/voice/status`)).json(); assert.equal(j.available, true); assert.equal(j.engine, 'moonshine-tiny-streaming-en'); assert.equal(j.language, 'en'); assert.ok(j.bytes > 0); } finally { await s.close(); }
});

test('without the benchmark download manifest NOTHING is served and the status says so (no silent substitute)', async () => {
  const s = await boot({ manifest: false }); try { assert.equal((await (await fetch(`${s.base}/voice/status`)).json()).available, false); assert.equal((await fetch(`${s.base}/voice/model/encoder.ort`)).status, 404); } finally { await s.close(); }
});

test('exact files are served with their SHA-256 as ETag, the right types and the isolation headers', async () => {
  const s = await boot(); try {
    const w = await fetch(`${s.base}/voice/rt/moonshine.wasm`); assert.equal(w.status, 200); assert.equal(w.headers.get('content-type'), 'application/wasm'); assert.equal(await w.text(), 'WASM-BYTES');
    assert.equal(w.headers.get('etag'), `"${createHash('sha256').update('WASM-BYTES').digest('hex')}"`); assert.equal(w.headers.get('cross-origin-embedder-policy'), 'require-corp'); assert.equal(w.headers.get('cross-origin-resource-policy'), 'same-origin');
    const m = await fetch(`${s.base}/voice/model/tokenizer.bin`); assert.equal(m.status, 200); assert.equal(await m.text(), 'model:tokenizer.bin');
    assert.match((await fetch(`${s.base}/voice/rt/index.js`)).headers.get('content-type'), /javascript/);
  } finally { await s.close(); }
});

test('only the benchmarked files: unknown names, other models, traversal and non-GET are refused', async () => {
  const s = await boot(); try {
    for (const p of ['/voice/model/other.ort', '/voice/model/tiny.ort', '/voice/rt/foo.txt', '/voice/rt/..%2f..%2fpackage.json', '/voice/rt/', '/voice/model/encoder.ort/x', '/voice/anything', '/voice/rt/stt-worker.js.map']) assert.equal((await fetch(`${s.base}${p}`)).status, 404, p);
    assert.equal((await fetch(`${s.base}/voice/status`, { method: 'POST' })).status, 405);
  } finally { await s.close(); }
});

test('a file that does not match its recorded SHA-256 is NOT served (and the status turns unavailable)', async () => {
  const s = await boot({ tamper: `${MD}encoder.ort` }); try { const r = await fetch(`${s.base}/voice/model/encoder.ort`); assert.ok([500, 404].includes(r.status)); assert.match(JSON.stringify(await r.json()), /VOICE_ASSET/); assert.equal((await (await fetch(`${s.base}/voice/status`)).json()).available, false); } finally { await s.close(); }
});

test('SCOPE: the page is cross-origin isolated but KEEPS a strict CSP (no eval, no wasm-eval); only the voice worker and /voice/ files may eval / compile WebAssembly', async () => {
  const s = await boot(); try {
    const page = await fetch(`${s.base}/`); const csp = page.headers.get('content-security-policy');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin'); assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp'); const scriptSrc = /script-src ([^;]*)/.exec(csp)[1]; assert.equal(scriptSrc, "'self'", csp); assert.ok(!/unsafe-eval/.test(csp), csp);
    for (const p of ['/app.js', '/voice.js', '/voice-worklet.js', '/core/case.js']) { const c = (await fetch(`${s.base}${p}`)).headers.get('content-security-policy'); assert.ok(c && !/unsafe-eval/.test(c), `${p}: ${c}`); }
    const worker = await fetch(`${s.base}/voice-engine-worker.js`); assert.equal(worker.status, 200); const wc = worker.headers.get('content-security-policy'); assert.ok(/'unsafe-eval'/.test(wc) && /'wasm-unsafe-eval'/.test(wc), wc); assert.equal(worker.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.ok(/'unsafe-eval'/.test((await fetch(`${s.base}/voice/rt/index.js`)).headers.get('content-security-policy')));
    assert.ok(/connect-src 'self'/.test(wc), 'the voice worker can reach nothing but this origin');
  } finally { await s.close(); }
});

test('API responses carry the isolation headers too, and the existing routes still answer (no regression)', async () => {
  const s = await boot(); try { const h = await fetch(`${s.base}/api/health`, { headers: { 'x-sourcing-token': 'voice-test-token-0123456789-abcdef' } }); assert.equal(h.status, 200); assert.equal(h.headers.get('cross-origin-embedder-policy'), 'require-corp'); assert.equal((await fetch(`${s.base}/shell-manifest.json`)).status, 200);
    const m = await (await fetch(`${s.base}/shell-manifest.json`)).json(); assert.ok(m.files.includes('/voice.js') && m.files.includes('/voice-worklet.js') && m.files.includes('/voice-engine-worker.js'), 'the voice modules are part of the offline shell'); assert.ok(!m.files.some((f) => f.startsWith('/voice/')), 'the 66 MB are not in the shell cache'); } finally { await s.close(); }
});
