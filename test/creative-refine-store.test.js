import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createLayerStore } from '../src/creative-runtime/index.js';

// THE SHARED LAYERS AS A WORKING STATE (`// ST-N`): every candidate ever paid for is kept (numbering and bounds never reuse an index), a REFINE rejects one without losing it, gives its layer an allowance, works on a
// copy, and the whole state is plain JSON that resumes elsewhere. Pure.

const sha = (b) => createHash('sha256').update(b).digest('hex');
const A = new Uint8Array([1, 2, 3]); const B = new Uint8Array([4, 5, 6]); const C = new Uint8Array([7, 8, 9]);
const cand = (index, bytes, provenance = null) => ({ index, bytes, provenance });

test('ST-1 candidates are kept in order; a rejected one stays counted but is never offered again', () => {
  const s = createLayerStore();
  assert.deepEqual(s.candidates('k'), []); assert.equal(s.count('k'), 0); assert.equal(s.allowance('k'), 0); assert.deepEqual(s.rejected('k'), []); assert.equal(s.size(), 0); assert.deepEqual(s.keys(), []);
  s.add('k', cand(1, A)); s.add('k', cand(2, B)); s.add('j', cand(1, C));
  assert.equal(s.count('k'), 2); assert.deepEqual(s.candidates('k').map((c) => c.index), [1, 2]); assert.deepEqual(s.keys(), ['k', 'j']); assert.equal(s.size(), 2);
  assert.equal(s.reject('k', sha(A)), true);
  assert.equal(s.count('k'), 2, 'a rejected candidate still counts: its index is never reused'); assert.deepEqual(s.candidates('k').map((c) => c.index), [2]); assert.deepEqual(s.rejected('k'), [sha(A)]); assert.equal(s.candidates('j').length, 1);
  assert.equal(s.reject('k', sha(A)), true, 'rejecting twice is harmless'); assert.deepEqual(s.rejected('k'), [sha(A)]);
  assert.equal(s.reject('k', sha(C)), false, 'only a candidate of this layer can be rejected'); assert.equal(s.reject('nope', sha(A)), false); assert.deepEqual(s.rejected('k'), [sha(A)]);
  s.reject('k', sha(B)); assert.deepEqual(s.candidates('k'), []); assert.deepEqual(s.rejected('k').sort(), [sha(A), sha(B)].sort());
});

test('ST-2 the allowance of a layer is what a REFINE may still pay for there; the largest asked wins; a plain rejection gives none', () => {
  const s = createLayerStore(); s.add('k', cand(1, A)); s.add('k', cand(2, B));
  assert.equal(s.reject('k', sha(A)), true); assert.equal(s.allowance('k'), 0, 'no allowance unless one is given');
  s.reject('k', sha(B), 2); assert.equal(s.allowance('k'), 2); s.reject('k', sha(A), 1); assert.equal(s.allowance('k'), 2, 'the largest allowance is kept'); s.reject('k', sha(A), 3); assert.equal(s.allowance('k'), 3);
  assert.equal(s.allowance('other'), 0);
  const t = createLayerStore(); t.add('k', cand(1, A)); t.reject('k', 'x'.repeat(64), 5); assert.equal(t.allowance('k'), 0, 'an unknown candidate gives no allowance');
});

test('ST-3 a copy is independent of the original in both directions, and keeps the rejections and the allowances', () => {
  const s = createLayerStore(); s.add('k', cand(1, A, { request_id: 'r1' })); s.add('k', cand(2, B)); s.reject('k', sha(A), 2);
  const f = s.fork();
  assert.notEqual(f, s); assert.equal(f.count('k'), 2); assert.deepEqual(f.candidates('k').map((c) => c.index), [2]); assert.deepEqual(f.rejected('k'), [sha(A)]); assert.equal(f.allowance('k'), 2);
  f.add('k', cand(3, C)); f.reject('k', sha(B), 4); f.add('z', cand(1, A));
  assert.equal(s.count('k'), 2); assert.deepEqual(s.candidates('k').map((c) => c.index), [2]); assert.equal(s.allowance('k'), 2); assert.deepEqual(s.rejected('k'), [sha(A)]); assert.equal(s.size(), 1);
  s.add('k', cand(9, C)); assert.equal(f.count('k'), 3);
  assert.deepEqual(f.candidates('k').map((c) => c.index), [3]);
});

test('ST-4 the whole state is plain JSON and resumes exactly, bytes and provenance included', () => {
  const s = createLayerStore(); s.add('k', cand(1, A, { request_id: 'r1', region: 'test' })); s.add('k', cand(2, B)); s.add('j', cand(1, C)); s.reject('k', sha(A), 2);
  const json = JSON.parse(JSON.stringify(s.export()));
  assert.equal(json.schema, 'layer-store@1'); assert.deepEqual(Object.keys(json).sort(), ['allowance', 'entries', 'rejected', 'schema']); assert.deepEqual(json.allowance, { k: 2 }); assert.deepEqual(json.rejected, { k: [sha(A)] });
  assert.equal(json.entries.k[0].bytes_b64, Buffer.from(A).toString('base64')); assert.deepEqual(json.entries.k[0].provenance, { request_id: 'r1', region: 'test' }); assert.equal(json.entries.k[1].provenance, null); assert.deepEqual(json.entries.k.map((c) => c.index), [1, 2]);
  const r = createLayerStore(json);
  assert.equal(r.count('k'), 2); assert.deepEqual(r.candidates('k').map((c) => [c.index, [...c.bytes]]), [[2, [4, 5, 6]]]); assert.deepEqual(r.candidates('j').map((c) => [...c.bytes]), [[7, 8, 9]]); assert.equal(r.allowance('k'), 2); assert.deepEqual(r.rejected('k'), [sha(A)]);
  assert.deepEqual(r.export(), json, 'a resumed state exports the same JSON'); assert.ok(r.candidates('j')[0].bytes instanceof Uint8Array);
  assert.deepEqual(createLayerStore(null).export(), { schema: 'layer-store@1', entries: {}, rejected: {}, allowance: {} }); assert.deepEqual(createLayerStore({}).keys(), []);
  assert.deepEqual(createLayerStore({ schema: 'layer-store@1', entries: { k: [{ index: 1, bytes_b64: Buffer.from(A).toString('base64') }] } }).candidates('k')[0].provenance, null);
  assert.ok(Object.isFrozen(s));
});
