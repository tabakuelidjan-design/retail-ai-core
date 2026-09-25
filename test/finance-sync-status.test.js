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
