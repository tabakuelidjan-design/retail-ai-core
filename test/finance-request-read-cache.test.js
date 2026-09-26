// Request-scoped read cache: identical reads within one request hit the store once; writes invalidate; copies are independent;
// nothing leaks between requests; outside a request the store is untouched. Plus an end-to-end check on a real route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestReadCache } from '../src/finance/server/request-read-cache.js';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { startApp, invoiceBody } from './finance-dashboard-helpers.js';

function countingStore() {
  const calls = [];
  const rows = [{ id: 'a', n: 1 }];
  return {
    calls,
    newId: () => 'id-1',
    async listThings(filter) { calls.push(['listThings', filter]); return rows.map((r) => ({ ...r })); },
    async getThing(id) { calls.push(['getThing', id]); return rows.find((r) => r.id === id) ?? null; },
    async saveThing(t) { calls.push(['saveThing']); rows.push(t); return t; },
    async listBroken() { calls.push(['listBroken']); if (calls.filter((c) => c[0] === 'listBroken').length === 1) throw new Error('db down'); return []; },
  };
}

test('same read in the same request = one store call (also when concurrent); other arguments are separate', async () => {
  const raw = countingStore(); const c = createRequestReadCache(); const s = c.wrap(raw);
  await c.run(async () => {
    await Promise.all([s.listThings({ a: 1 }), s.listThings({ a: 1 })]);
    await s.listThings({ a: 1 }); await s.listThings({ a: 2 });
  });
  assert.deepEqual(raw.calls.map((x) => x[0]), ['listThings', 'listThings']);
});

test('a write empties the cache: the next read sees the new data', async () => {
  const raw = countingStore(); const c = createRequestReadCache(); const s = c.wrap(raw);
  await c.run(async () => {
    assert.equal((await s.listThings()).length, 1);
    await s.saveThing({ id: 'b', n: 2 });
    assert.equal((await s.listThings()).length, 2);
  });
  assert.deepEqual(raw.calls.map((x) => x[0]), ['listThings', 'saveThing', 'listThings']);
});

test('each caller gets its own copy: mutating one result does not change what the next caller reads', async () => {
  const raw = countingStore(); const c = createRequestReadCache(); const s = c.wrap(raw);
  await c.run(async () => {
    const first = await s.getThing('a'); first.n = 999;
    assert.equal((await s.getThing('a')).n, 1);
  });
});

test('a failed read is not cached; nothing is shared between two requests; outside a request nothing is cached', async () => {
  const raw = countingStore(); const c = createRequestReadCache(); const s = c.wrap(raw);
  await c.run(async () => {
    await assert.rejects(s.listBroken());
    assert.deepEqual(await s.listBroken(), []);
  });
  await c.run(() => s.listThings()); await c.run(() => s.listThings());
  await s.listThings(); await s.listThings();
  assert.equal(raw.calls.filter((x) => x[0] === 'listThings').length, 4);
  assert.equal(s.newId(), 'id-1');
});

test('end to end: a document page reads each document/payment list once per request instead of several times', async () => {
  const store = createMemoryStore();
  const counts = {};
  const counted = new Proxy(store, { get(t, p, r) { const v = Reflect.get(t, p, r); if (typeof v !== 'function' || typeof p !== 'string') return v; return (...a) => { counts[p] = (counts[p] ?? 0) + 1; return v.apply(t, a); }; } });
  const h = await startApp({ store: counted });
  try {
    const c = await h.authed();
    const created = await c.post('/api/documents', invoiceBody());
    assert.equal(created.status, 201);
    for (const k of Object.keys(counts)) delete counts[k];
    const page = await c.get(`/api/documents/${created.data.id}`);
    assert.equal(page.status, 200); assert.equal(page.data.id ?? page.data.doc?.id, created.data.id);
    assert.ok((counts.getDocument ?? 0) <= 1, `getDocument read ${counts.getDocument} times in one request`);
    assert.ok((counts.listPayments ?? 0) <= 1, `listPayments read ${counts.listPayments} times in one request`);
  } finally { await h.close(); }
});
