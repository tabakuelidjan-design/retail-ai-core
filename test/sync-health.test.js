import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countsOf, finishRun, latestSyncStatus, recordStartupFailure, startRun } from '../src/sync/run-log.js';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';

// SYNTHETIC ids and counts only.
const M = 'merchant-1';
const at = (iso) => new Date(iso);

test('a successful sync run is recorded with counts only (no free text, no credentials)', async () => {
  const sb = createFakeSupabase();
  const id = await startRun(sb, { merchantId: M, mode: 'all', now: at('2026-09-26T10:00:00Z') });
  assert.ok(id);
  await finishRun(sb, id, { ok: true, now: at('2026-09-26T10:01:40Z'), summaries: { orders: { ordersUpserted: 53, refundsUpserted: 2, orderLinesUpserted: 65, errors: [], note: 'secret-looking text' }, catalog: { productsUpserted: 175, errors: [] } } });
  const [row] = sb._tables.get('sync_runs');
  assert.equal(row.status, 'SUCCESS'); assert.equal(row.finished_at, '2026-09-26T10:01:40.000Z');
  assert.deepEqual(row.summary.orders, { ordersUpserted: 53, orderLinesUpserted: 65, refundsUpserted: 2, errors: 0 });
  assert.equal(JSON.stringify(row.summary).includes('secret'), false);
  assert.deepEqual(countsOf({ x: { errors: ['a', 'b'] } }), { x: { errors: 2 } });
});

test('sync status: last success, last attempt and staleness are factual and separate', async () => {
  const sb = createFakeSupabase();
  assert.deepEqual(await latestSyncStatus(sb, M, { now: at('2026-09-26T12:00:00Z') }), { available: false, reason: 'NO_SYNC_RECORDED' });

  const ok = await startRun(sb, { merchantId: M, mode: 'all', now: at('2026-09-26T10:00:00Z') });
  await finishRun(sb, ok, { ok: true, now: at('2026-09-26T10:02:00Z'), summaries: { orders: { ordersUpserted: 3, errors: [] } } });
  let s = await latestSyncStatus(sb, M, { now: at('2026-09-26T10:20:00Z'), staleAfterMinutes: 60 });
  assert.equal(s.lastAttempt.status, 'SUCCESS'); assert.equal(s.ageMinutes, 18); assert.equal(s.stale, false); assert.equal(s.latestFailed, false);

  // a later FAILED attempt: the last successful sync is kept and the failure is shown, the data is not pretended to be current
  const bad = await startRun(sb, { merchantId: M, mode: 'all', now: at('2026-09-26T10:15:00Z') });
  await finishRun(sb, bad, { ok: false, error: new Error('Shopify 429\nstack line').message, summaries: {}, now: at('2026-09-26T10:15:30Z') });
  s = await latestSyncStatus(sb, M, { now: at('2026-09-26T10:20:00Z') });
  assert.equal(s.lastAttempt.status, 'FAILED'); assert.equal(s.lastAttempt.error, 'Shopify 429'); assert.equal(s.latestFailed, true);
  assert.equal(s.lastSuccess.finishedAt, '2026-09-26T10:02:00.000Z', 'the previous good sync is still reported');

  // stale: nothing succeeded for longer than the allowed age
  s = await latestSyncStatus(sb, M, { now: at('2026-09-26T13:00:00Z'), staleAfterMinutes: 60 });
  assert.equal(s.stale, true);

  // a run that never finished is reported as interrupted, not running forever
  await startRun(sb, { merchantId: M, mode: 'orders', now: at('2026-09-26T13:00:00Z') });
  s = await latestSyncStatus(sb, M, { now: at('2026-09-26T14:00:00Z') });
  assert.equal(s.lastAttempt.status, 'INTERRUPTED'); assert.equal(s.latestFailed, true);
});

test('only order-refreshing syncs count as the last successful Shopify sync', async () => {
  const sb = createFakeSupabase();
  const c = await startRun(sb, { merchantId: M, mode: 'catalog', now: at('2026-09-26T10:00:00Z') });
  await finishRun(sb, c, { ok: true, summaries: {}, now: at('2026-09-26T10:01:00Z') });
  const s = await latestSyncStatus(sb, M, { now: at('2026-09-26T10:05:00Z') });
  assert.equal(s.lastSuccess, null); assert.equal(s.stale, true, 'a catalog-only sync does not make the sales data current');
});

test('logging failures never break a sync', async () => {
  const broken = { insert: async () => { throw new Error('db down'); }, update: async () => { throw new Error('db down'); } };
  assert.equal(await startRun(broken, { merchantId: M, mode: 'all' }), null);
  await finishRun(broken, 'id', { ok: true, summaries: {} }); // must not throw
  await finishRun(broken, null, { ok: true, summaries: {} });
});

const get = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString('utf8')) })); }).on('error', reject));

test('/api/sync-status exposes sync and report generation as two separate facts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'an-'));
  const ok = createAnalyticsPremiumApp({ reportsDir: dir, syncStatus: async () => ({ available: true, lastSuccess: { finishedAt: '2026-09-26T10:02:00Z' } }), reportStatus: () => ({ lastSuccessAt: '2026-09-26T10:03:00Z', lastStatus: 'SUCCESS' }) });
  const failing = createAnalyticsPremiumApp({ reportsDir: dir, syncStatus: async () => { throw new Error('boom'); } });
  const bare = createAnalyticsPremiumApp({ reportsDir: dir });
  for (const [app, check] of [[ok, (j) => { assert.equal(j.sync.lastSuccess.finishedAt, '2026-09-26T10:02:00Z'); assert.equal(j.report.lastSuccessAt, '2026-09-26T10:03:00Z'); }],
    [failing, (j) => assert.deepEqual(j.sync, { available: false, reason: 'STATUS_UNAVAILABLE' })],
    [bare, (j) => { assert.deepEqual(j.sync, { available: false, reason: 'NOT_CONFIGURED' }); assert.equal(j.report, null); }]]) {
    const server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { const r = await get(server.address().port, '/api/sync-status'); assert.equal(r.status, 200); check(r.json); } finally { await new Promise((r) => server.close(r)); }
  }
});

test('a sync that fails before it knows the merchant (bad Shopify credentials) still leaves a FAILED trace and keeps the last good sync', async () => {
  const sb = createFakeSupabase();
  await sb.upsert('merchants', [{ source_system: 'shopify', source_id: 'gid://shop/1', name: 'M' }], { onConflict: 'source_system,source_id' });
  const merchant = sb._tables.get('merchants')[0].id;
  const ok = await startRun(sb, { merchantId: merchant, mode: 'all', now: at('2026-09-26T10:00:00Z') });
  await finishRun(sb, ok, { ok: true, summaries: {}, now: at('2026-09-26T10:01:00Z') });
  assert.ok(await recordStartupFailure(sb, { mode: 'all', error: 'Shopify token exchange HTTP 400', now: at('2026-09-26T10:15:00Z') }));
  const s = await latestSyncStatus(sb, merchant, { now: at('2026-09-26T10:16:00Z') });
  assert.equal(s.lastAttempt.status, 'FAILED'); assert.equal(s.latestFailed, true); assert.equal(s.lastSuccess.finishedAt, '2026-09-26T10:01:00.000Z');
  // no merchant / several merchants: nothing is guessed
  assert.equal(await recordStartupFailure(createFakeSupabase(), { mode: 'all', error: 'x' }), null);
});
