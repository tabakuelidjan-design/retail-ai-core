// createRetailAccess: one cache entry per window, concurrent callers share ONE load, failures are not cached, TTL still applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetailAccess } from '../src/finance/retail-access.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('parallel ledgerData() calls trigger a single load and all get the same value', async () => {
  let loads = 0; const d = deferred();
  const r = createRetailAccess({ loadRetail: () => { loads += 1; return d.promise; } });
  const calls = [r.ledgerData(), r.ledgerData(), r.ledgerData()];
  d.resolve({ data: 1, ledger: 2 });
  const out = await Promise.all(calls);
  assert.equal(loads, 1);
  assert.ok(out.every((v) => v === out[0]));
});

test('a different sinceDate is not merged with the load in flight', async () => {
  const seen = [];
  const r = createRetailAccess({ loadRetail: async (s) => { seen.push(s ?? null); return { since: s }; } });
  await Promise.all([r.ledgerData(), r.ledgerData('2026-01-01')]);
  assert.deepEqual(seen.sort(), ['2026-01-01', null].sort());
});

test('a failed load is shared by the callers waiting on it but not cached: the next call retries', async () => {
  let loads = 0;
  const r = createRetailAccess({ loadRetail: async () => { loads += 1; if (loads === 1) throw new Error('boom'); return { ok: true }; } });
  const res = await Promise.allSettled([r.ledgerData(), r.ledgerData()]);
  assert.ok(res.every((x) => x.status === 'rejected'));
  assert.equal(loads, 1);
  assert.deepEqual(await r.ledgerData(), { ok: true });
  assert.equal(loads, 2);
});

test('two windows used alternately (quarter, then full history - as /api/actions does) are BOTH cached', async () => {
  const seen = [];
  const r = createRetailAccess({ loadRetail: async (s) => { seen.push(s ?? null); return { since: s }; } });
  for (let visit = 0; visit < 3; visit++) { await r.ledgerData('2026-07-01'); await r.ledgerData(); }
  assert.deepEqual(seen, ['2026-07-01', null]);
});

test('at most 4 windows are kept, the oldest is dropped first', async () => {
  const seen = [];
  const r = createRetailAccess({ loadRetail: async (s) => { seen.push(s); return { s }; } });
  for (const s of ['a', 'b', 'c', 'd', 'e']) await r.ledgerData(s);
  await r.ledgerData('e'); await r.ledgerData('b');
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);
  await r.ledgerData('a');
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e', 'a']);
});

test('the TTL cache still serves sequential calls, and clearCache forces a reload', async () => {
  let loads = 0; let now = 0;
  const r = createRetailAccess({ loadRetail: async () => { loads += 1; return { n: loads }; }, ttlMs: 1000, nowMs: () => now });
  await r.ledgerData(); await r.ledgerData();
  assert.equal(loads, 1);
  now = 2000; await r.ledgerData();
  assert.equal(loads, 2);
  r.clearCache(); await r.ledgerData();
  assert.equal(loads, 3);
});
