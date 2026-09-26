// Finance static files: compression, ETag/304, versioned immutable URLs, index.html revalidated. Real http server, synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { startApp } from './finance-dashboard-helpers.js';
import { pickEncoding } from '../src/finance/server/static-assets.js';

/** Raw GET (node:http, so nothing is decompressed or cached behind our back). */
function get(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + path, { headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); }).on('error', reject);
  });
}
const decode = (r) => (r.headers['content-encoding'] === 'br' ? brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.body) : r.body);

test('pickEncoding prefers br, then gzip, honours q=0 and wildcards', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip, deflate'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(''), null);
  assert.equal(pickEncoding('*'), 'br');
});

test('scripts and styles are compressed (br or gzip) with the exact same content, and keep the security headers', async () => {
  const h = await startApp();
  try {
    const source = await readFile(new URL('../src/finance/ui/app.js', import.meta.url));
    const b = await get(h.base, '/app.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(b.status, 200); assert.equal(b.headers['content-encoding'], 'br'); assert.ok(b.body.length < source.length / 2);
    assert.deepEqual(decode(b), source);
    assert.equal(b.headers.vary, 'Accept-Encoding');
    assert.match(b.headers['content-security-policy'], /default-src 'self'/); assert.equal(b.headers['x-content-type-options'], 'nosniff');
    const g = await get(h.base, '/style.css', { 'accept-encoding': 'gzip' });
    assert.equal(g.headers['content-encoding'], 'gzip'); assert.deepEqual(decode(g), await readFile(new URL('../src/finance/ui/style.css', import.meta.url)));
    const plain = await get(h.base, '/app.js');
    assert.equal(plain.headers['content-encoding'], undefined); assert.deepEqual(plain.body, source);
  } finally { await h.close(); }
});

test('index.html is revalidated and versions every local script/style by content hash; a current ?v= is immutable, a stale one is not', async () => {
  const h = await startApp();
  try {
    const idx = await get(h.base, '/');
    assert.equal(idx.headers['cache-control'], 'no-cache');
    const html = decode(idx).toString('utf8');
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 10);
    for (const r of refs) assert.match(r, /\?v=[0-9a-f]{20}$/, `unversioned reference ${r}`);
    const appRef = refs.find((r) => r.startsWith('/app.js?v='));
    const cur = await get(h.base, appRef);
    assert.equal(cur.status, 200); assert.equal(cur.headers['cache-control'], 'public, max-age=31536000, immutable');
    const stale = await get(h.base, '/app.js?v=00000000000000000000');
    assert.equal(stale.status, 200); assert.equal(stale.headers['cache-control'], 'no-cache');
    const shared = refs.find((r) => r.startsWith('/nordla-icon.js?v='));
    assert.equal((await get(h.base, shared)).headers['cache-control'], 'public, max-age=31536000, immutable');
  } finally { await h.close(); }
});

test('ETag + If-None-Match answers 304 without a body, whatever the encoding; fonts/icons are revalidated, not compressed', async () => {
  const h = await startApp();
  try {
    const first = await get(h.base, '/views-workspace.js', { 'accept-encoding': 'br' });
    assert.match(first.headers.etag, /^"[0-9a-f]{20}-br"$/);
    const again = await get(h.base, '/views-workspace.js', { 'accept-encoding': 'gzip', 'if-none-match': first.headers.etag });
    assert.equal(again.status, 304); assert.equal(again.body.length, 0);
    assert.equal((await get(h.base, '/views-workspace.js', { 'if-none-match': '"ffffffffffffffffffff"' })).status, 200);
    const font = await get(h.base, '/nordla-assets/fonts/lora-latin.woff2', { 'accept-encoding': 'br' });
    assert.equal(font.status, 200); assert.equal(font.headers['content-encoding'], undefined); assert.equal(font.headers['cache-control'], 'no-cache'); assert.ok(font.headers.etag);
    assert.equal((await get(h.base, '/nordla-assets/fonts/lora-latin.woff2', { 'if-none-match': font.headers.etag })).status, 304);
    const idx = await get(h.base, '/');
    assert.equal((await get(h.base, '/', { 'if-none-match': idx.headers.etag })).status, 304);
  } finally { await h.close(); }
});

test('unknown paths are still 404 and API data is still never cached', async () => {
  const h = await startApp();
  try {
    assert.equal((await get(h.base, '/nope.js')).status, 404);
    assert.equal((await get(h.base, '/../server/app.js')).status, 404);
    const c = await h.authed();
    const s = await c.get('/api/settings');
    assert.equal(s.status, 200); assert.equal(s.headers.get('cache-control'), 'no-store');
  } finally { await h.close(); }
});
