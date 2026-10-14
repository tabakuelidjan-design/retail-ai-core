import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Analyses Phase 0, defect D: the Analytics UI asserted "Data up to date" and "revenue comes from real, verified orders" unconditionally,
// while nothing verified either. Now the health card is DERIVED from the real sync status and the report's own exclusion counters;
// a statement that cannot be proven is not made. (The full Data Health model is Phase 1; this is the honest minimum.) SYNTHETIC data only.
const ui = (f) => readFileSync(new URL(`../src/analytics-premium/ui/${f}`, import.meta.url), 'utf8');
// the page loads health-state.js as a classic script (global NordlaHealth): evaluate it the same way
const sandbox = { self: {} }; vm.runInNewContext(ui('health-state.js'), sandbox);
const NordlaHealth = sandbox.self.NordlaHealth;
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects built inside the vm realm have another Object prototype

const okSync = { available: true, stale: false, latestFailed: false, lastSuccess: { finishedAt: '2026-10-03T09:00:00Z' } };

test('H1. healthState is derived from the sync status: ok / stale / failed / unknown / no source - never a blanket "up to date"', () => {
  assert.deepEqual([NordlaHealth.healthState(okSync).state, NordlaHealth.healthState(okSync).tone], ['OK', 'ok']);
  assert.deepEqual([NordlaHealth.healthState({ ...okSync, stale: true }).state, NordlaHealth.healthState({ ...okSync, stale: true }).tone], ['STALE', 'warn']);
  assert.deepEqual([NordlaHealth.healthState({ ...okSync, latestFailed: true }).state, NordlaHealth.healthState({ ...okSync, latestFailed: true }).tone], ['FAILED', 'bad']);
  assert.equal(NordlaHealth.healthState(null).state, 'UNKNOWN'); assert.equal(NordlaHealth.healthState({ available: false }).state, 'UNKNOWN');
  assert.equal(NordlaHealth.healthState({ reason: 'NO_SALES_SOURCE' }).state, 'NO_SOURCE');
  assert.equal(NordlaHealth.healthState({ ...okSync, lastSuccess: null }).state, 'UNKNOWN', 'an ok flag without a last success proves nothing');
});

test('H2. a failed or stale sync can never read as healthy, whatever the report says', () => {
  for (const s of [{ ...okSync, stale: true }, { ...okSync, latestFailed: true }, { available: false }, null]) assert.notEqual(NordlaHealth.healthState(s).valueKey, 'health.syncOk');
  assert.equal(NordlaHealth.healthState(okSync).valueKey, 'health.syncOk');
});

test('H3. exclusions are surfaced: every non-zero counter becomes a note, zero counters make no noise, unknown stays unknown', () => {
  assert.deepEqual(plain(NordlaHealth.exclusionNotes(undefined)), { known: false, items: [] });
  assert.deepEqual(plain(NordlaHealth.exclusionNotes({ test: 0, status: 0, cancelled: 0, otherCurrency: 0, refundsOnExcludedOrders: 0 })), { known: true, items: [] });
  const n = NordlaHealth.exclusionNotes({ test: 2, status: 1, cancelled: 3, otherCurrency: 4, refundsOnExcludedOrders: 5 });
  assert.deepEqual(plain(n.items.map((i) => [i.key, i.count])), [['test', 2], ['status', 1], ['cancelled', 3], ['otherCurrency', 4], ['refundsOnExcludedOrders', 5]]);
});

test('H4. the false claims are gone from all three languages and the new state keys exist in all three', () => {
  for (const l of ['fr', 'nl', 'en']) {
    const t = ui(`lang-${l}.js`);
    assert.ok(!t.includes("'health.upToDate'"), `${l}: health.upToDate removed`); assert.ok(!t.includes("'wc.dataReliable'"), `${l}: wc.dataReliable removed`);
    for (const k of ['health.syncOk', 'health.syncStale', 'health.syncFailed', 'health.unknown', 'health.noSource', 'health.excluded.test', 'health.excluded.status', 'health.excluded.cancelled', 'health.excluded.otherCurrency', 'health.excluded.refundsOnExcludedOrders', 'wc.dataBasis']) assert.ok(t.includes(`'${k}'`), `${l}: ${k}`);
  }
});

test('H5. app.js does not assert freshness or verification: the card uses healthState, the claim keys are not referenced, no dead "view sources" button', () => {
  const app = ui('app.js');
  assert.ok(!app.includes('health.upToDate') && !app.includes('wc.dataReliable'));
  assert.match(app, /NordlaHealth\.healthState/);
  const card = app.slice(app.indexOf('function healthCard'), app.indexOf('// ---------- "Ce qui a changé"'));
  assert.ok(!/viewSources/.test(card), 'a button with no handler is a placeholder that looks like a feature');
  assert.ok(/\/health-state\.js/.test(ui('index.html')), 'the module is loaded by the page');
});

test('H6. the brief carries the report\'s exclusion counters (nothing is hidden from the page)', async () => {
  const { loadBrief } = await import('../src/analytics-premium/server/brief.js'); const { bindReportsTenant, unbindReportsTenant, tenantStamp } = await import('../src/analytics-premium/server/tenant.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'brief-')); const merchant = '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
  bindReportsTenant(dir, merchant);
  try {
    await writeFile(path.join(dir, 'report-2026-10-03.json'), JSON.stringify({ tenant: tenantStamp(merchant), generated_at: '2026-10-03T08:00:00Z', currency: 'EUR', order_history: { orders_excluded: { test: 1, status: 0, cancelled: 2, otherCurrency: 0, refundsOnExcludedOrders: 1 } }, sales: { last_30_days: { net_sales_ex_tax: 10, order_count: 1, aov_ex_tax: 10, daily_series: [] } }, products: {} }));
    const brief = await loadBrief(dir);
    assert.deepEqual(brief.dataNotes.exclusions, { test: 1, status: 0, cancelled: 2, otherCurrency: 0, refundsOnExcludedOrders: 1 });
  } finally { unbindReportsTenant(dir); }
});
