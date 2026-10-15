// China Sourcing: the server keeps a durable copy of every photo of a case (until now photos lived only on the phone). Store + HTTP routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { createFilePhotoStore, createMemoryPhotoStore, MAX_PHOTO_BYTES, parsePhotoKey } from '../src/sourcing/store/photo-store.js';
import { newCase } from '../src/sourcing/core/case.js';

const TOKEN = 'photo-store-token-0123456789-abcdefgh';
const jpeg = (n) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(n, 7)]).toString('base64')}`;
const sha = (dataUrl) => createHash('sha256').update(Buffer.from(dataUrl.split(',')[1], 'base64')).digest('hex');

for (const [name, make] of [['memory', async () => ({ store: createMemoryPhotoStore() })], ['file', async () => { const dir = await mkdtemp(join(tmpdir(), 'photos-')); return { store: createFilePhotoStore(dir), dir }; }]]) {
  test(`${name} store: a photo is kept byte for byte, listed with its hash, never written over, never in another case`, async () => {
    const { store, dir } = await make();
    try {
      const a = jpeg(5000); const b = jpeg(6000);
      assert.deepEqual(await store.put('case-1', 'photo:case-1.0', a), { status: 'STORED', key: 'photo:case-1.0', sha256: sha(a), size: 5003 });
      assert.equal((await store.put('case-1', 'photo:case-1.0', a)).status, 'UNCHANGED', 'the same bytes again: nothing written');
      await assert.rejects(store.put('case-1', 'photo:case-1.0', b), (e) => e.code === 'PHOTO_CONFLICT' && e.server.sha256 === sha(a) && e.sent.sha256 === sha(b));
      assert.equal((await store.get('case-1', 'photo:case-1.0')).dataUrl, a, 'the first version is kept');
      await store.put('case-1', 'docphoto:case-1.doc-1', b);
      assert.deepEqual((await store.list('case-1')).map((p) => [p.key, p.sha256]), [['docphoto:case-1.doc-1', sha(b)], ['photo:case-1.0', sha(a)]]);
      await assert.rejects(store.put('case-1', 'photo:case-2.0', a), { code: 'PHOTO_KEY_INVALID' }, 'a key of another case');
      await assert.rejects(store.put('../x', 'photo:../x.0', a), (e) => ['PHOTO_KEY_INVALID', 'CASE_ID_INVALID'].includes(e.code));
      await assert.rejects(store.put('case-1', 'photo:case-1.9', 'data:text/html;base64,PGh0bWw+'), { code: 'PHOTO_INVALID' }, 'only images');
      await assert.rejects(store.put('case-1', 'photo:case-1.9', jpeg(MAX_PHOTO_BYTES)), { code: 'PHOTO_TOO_BIG' });
      assert.deepEqual(await store.list('case-2'), []); assert.equal(await store.get('case-2', 'photo:case-2.0'), null);
      if (dir) assert.ok((await readdir(join(dir, 'case-1'))).every((f) => !f.includes(':') && !f.endsWith('.tmp')), 'portable file names, no temp file left');
    } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
  });
}

test('photo keys: only photo:/docphoto: keys of the named case', () => {
  assert.deepEqual(parsePhotoKey('photo:a-1.0', 'a-1'), { kind: 'photo', caseId: 'a-1', suffix: '0' });
  for (const k of ['photo:a-1', 'img:a-1.0', 'photo:a/1.0', 'photo:b.0']) assert.equal(parsePhotoKey(k, 'a-1'), null, k);
});

async function serve(photos = createMemoryPhotoStore()) {
  const store = createMemoryStore();
  const app = createSourcingApp({ token: TOKEN, store, photos, uiDir: fileURLToPath(new URL('../src/sourcing/ui/', import.meta.url)), coreDir: fileURLToPath(new URL('../src/sourcing/core/', import.meta.url)) });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, opts = {}) => { const r = await fetch(base + path, { ...opts, headers: { 'x-sourcing-token': opts.token ?? TOKEN, 'content-type': 'application/json' } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  return { call, store, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

test('routes: a photo is accepted only under a case the server holds, behind the token; list and read back; no delete route', async () => {
  const s = await serve();
  try {
    const p = jpeg(3000); const url = `/api/cases/case-1/photos/${encodeURIComponent('photo:case-1.0')}`;
    assert.equal((await s.call(url, { method: 'PUT', body: JSON.stringify({ dataUrl: p }), token: 'wrong-token-0123456789-abcdefghij' })).status, 401);
    assert.equal((await s.call(url, { method: 'PUT', body: JSON.stringify({ dataUrl: p }) })).body.error, 'CASE_NOT_ON_SERVER');
    assert.equal((await s.call('/api/cases/case-1', { method: 'PUT', body: JSON.stringify(newCase({ id: 'case-1', name: 'x', now: new Date('2026-10-15T08:00:00Z') })) })).status, 200);
    assert.equal((await s.call(url, { method: 'PUT', body: JSON.stringify({ dataUrl: p }) })).body.status, 'STORED');
    const list = await s.call('/api/cases/case-1/photos'); assert.deepEqual(list.body.photos.map((x) => x.key), ['photo:case-1.0']);
    assert.equal((await s.call(url)).body.dataUrl, p);
    const other = await s.call(url, { method: 'PUT', body: JSON.stringify({ dataUrl: jpeg(3001) }) });
    assert.equal(other.status, 409); assert.equal(other.body.error, 'PHOTO_CONFLICT'); assert.equal(other.body.server.sha256, sha(p));
    assert.equal((await s.call(url, { method: 'DELETE' })).status, 405, 'no photo is deleted through the API');
    assert.equal((await s.call(url)).body.dataUrl, p, 'still there');
    assert.equal((await s.call(`/api/cases/case-1/photos/${encodeURIComponent('photo:case-9.0')}`)).body.error, 'PHOTO_KEY_INVALID');
  } finally { await s.close(); }
});
