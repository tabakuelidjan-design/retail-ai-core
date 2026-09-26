import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './finance-dashboard-helpers.js';

// SYNTHETIC values only.
test('/api/sync-status needs a session and reports the Shopify sync health (not report/pack generation)', async () => {
  const a = await startApp({ deps: { syncStatus: async () => ({ available: true, lastSuccess: { finishedAt: '2026-09-26T10:02:00Z' }, stale: false, latestFailed: false }) } });
  try {
    const anon = a.client();
    assert.equal((await anon.get('/api/sync-status')).status, 401);
    const c = await a.authed();
    const r = await c.get('/api/sync-status');
    assert.equal(r.status, 200); assert.equal(r.data.sync.lastSuccess.finishedAt, '2026-09-26T10:02:00Z'); assert.equal(r.data.sync.latestFailed, false);
  } finally { await a.close(); }
});

test('/api/sync-status degrades to an honest unknown when the status source is missing or failing', async () => {
  const bare = await startApp();
  const failing = await startApp({ deps: { syncStatus: async () => { throw new Error('db down'); } } });
  try {
    assert.deepEqual((await (await bare.authed()).get('/api/sync-status')).data.sync, { available: false, reason: 'NOT_CONFIGURED' });
    assert.deepEqual((await (await failing.authed()).get('/api/sync-status')).data.sync, { available: false, reason: 'STATUS_UNAVAILABLE' });
  } finally { await bare.close(); await failing.close(); }
});

test('/api/sync-status is memoised 30 s (one status query per 30 s, not per page view), then refreshed', async () => {
  let calls = 0; let now = 1_000_000;
  const a = await startApp({ deps: { nowMs: () => now, syncStatus: async () => { calls += 1; return { available: true, n: calls }; } } });
  try {
    const c = await a.authed();
    const [r1, r2] = await Promise.all([c.get('/api/sync-status'), c.get('/api/sync-status')]);
    now += 29_000; const r3 = await c.get('/api/sync-status');
    assert.equal(calls, 1); assert.equal(r1.data.sync.n, 1); assert.equal(r2.data.sync.n, 1); assert.equal(r3.data.sync.n, 1);
    now += 2_000; const r4 = await c.get('/api/sync-status');
    assert.equal(calls, 2); assert.equal(r4.data.sync.n, 2);
  } finally { await a.close(); }
});

test('/api/sync-status: a failure is not memoised, the next page view retries', async () => {
  let calls = 0;
  const a = await startApp({ deps: { syncStatus: async () => { calls += 1; if (calls === 1) throw new Error('db down'); return { available: true }; } } });
  try {
    const c = await a.authed();
    assert.equal((await c.get('/api/sync-status')).data.sync.reason, 'STATUS_UNAVAILABLE');
    assert.equal((await c.get('/api/sync-status')).data.sync.available, true);
    assert.equal(calls, 2);
  } finally { await a.close(); }
});
