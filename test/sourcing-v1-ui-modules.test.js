// The phone app is split into small modules (P3). The service worker caches the shell from /shell-manifest.json, so a module the server forgets to list or to serve would break the
// OFFLINE cold start. These tests walk the real import graph the browser walks: every import of every UI/core module must resolve to a served file that is in the manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sourcing');
const uiDir = join(SRC, 'ui'); const coreDir = join(SRC, 'core');

async function withServer(fn) {
  const app = createSourcingApp({ token: 'ui-modules-token-0123456789abcdef', store: createMemoryStore(), uiDir, coreDir });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); }
}
const importsOf = (src) => [...src.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
const resolveUrl = (from, spec) => (spec.startsWith('/') ? spec : new URL(spec, `http://x${from}`).pathname);

test('every module reachable from the app entry is served and listed in the offline shell manifest', async () => {
  await withServer(async (base) => {
    const manifest = await (await fetch(`${base}/shell-manifest.json`)).json(); const listed = new Set(manifest.files);
    const seen = new Set(); const queue = ['/app.js'];
    while (queue.length) {
      const url = queue.pop(); if (seen.has(url)) continue; seen.add(url);
      const r = await fetch(base + url); assert.equal(r.status, 200, `${url} must be served`); assert.ok(listed.has(url), `${url} must be in the shell manifest (offline cold start)`);
      for (const spec of importsOf(await r.text())) queue.push(resolveUrl(url, spec));
    }
    for (const must of ['/dom.js', '/state.js', '/draft.js', '/numbers.js', '/screens/decision.js', '/screens/quick.js', '/screens/money.js', '/core/extract/index.js', '/core/conversation.js', '/core/field-progress.js']) assert.ok(seen.has(must) || listed.has(must), `${must} is part of the shell`);
    assert.ok(seen.size > 40, `walked ${seen.size} modules`);
  });
});

test('every .js file in the UI folders and the core folders is in the manifest (nothing is forgotten by the offline cache)', async () => {
  await withServer(async (base) => {
    const listed = new Set((await (await fetch(`${base}/shell-manifest.json`)).json()).files);
    const walk = (dir, prefix) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : /\.js$/.test(e.name) ? [`${prefix}${e.name}`] : []));
    for (const f of [...walk(uiDir, '/'), ...walk(coreDir, '/core/')]) assert.ok(listed.has(f), `${f} missing from the shell manifest`);
  });
});

test('the server refuses to serve anything outside the UI/core module patterns (no path traversal, no non-js files)', async () => {
  await withServer(async (base) => {
    for (const p of ['/screens/../../server/app.js', '/..%2fserver%2fapp.js', '/screens/x.json', '/screens/nope.js', '/core/../server/app.js', '/server.js']) { const r = await fetch(base + p); assert.ok([404, 400].includes(r.status), `${p} -> ${r.status}`); }
  });
});

test('the app controller stays small and the former monolith is split by responsibility (guard against re-growing it)', () => {
  const lines = (f) => readFileSync(join(uiDir, f), 'utf8').split('\n').length;
  assert.ok(lines('app.js') < 520, 'app.js should stay a controller'); for (const f of ['dom.js', 'state.js', 'draft.js', 'numbers.js', 'screens/decision.js', 'screens/money.js']) assert.ok(lines(f) > 3, f);
  assert.match(readFileSync(join(uiDir, 'draft.js'), 'utf8'), /INVARIANT/, 'the recording-safe rendering invariant is documented where draft preservation lives');
});
