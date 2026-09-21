import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildAccountantPack } from '../src/finance/accountant-pack.js';
import { getGrantedScopes, historyCoversPeriod, historySearchQuery, nextCoverage, planOrdersSync, readCoverage, writeCoverage } from '../src/sync/history.js';
import { ORDERS_PAGE_QUERY, ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY } from '../src/shopify/queries.js';
import { syncOrders } from '../src/sync/orders.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_ORDER_1, ordersPage } from './fixtures/shopify-orders-sample.js';
import { makeMarketingData } from './fixtures/marketing-sample.js';

const NOW = new Date('2026-10-05T09:00:00Z');
const RETAIL_CFG = mergeConfig({});

test('read_all_orders readiness: recent windows need nothing; older windows are refused without the scope and allowed with it', () => {
  assert.deepEqual(planOrdersSync({ since: null, now: NOW }), { ok: true, mode: 'last_60_days', since: null, needsScope: false });
  assert.equal(planOrdersSync({ since: '2026-08-15', now: NOW }).mode, 'recent');
  const refused = planOrdersSync({ since: '2026-05-11', now: NOW, grantedScopes: ['read_orders', 'read_customers'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'READ_ALL_ORDERS_NOT_GRANTED');
  assert.match(refused.message, /nothing was fetched/);
  const ok = planOrdersSync({ since: '2026-05-11', now: NOW, grantedScopes: ['read_orders', 'read_all_orders'] });
  assert.deepEqual([ok.ok, ok.mode], [true, 'backfill']);
  assert.equal(planOrdersSync({ since: '11/05/2026', now: NOW }).reason, 'SINCE_MUST_BE_YYYY_MM_DD');
  assert.equal(planOrdersSync({ since: '2027-01-01', now: NOW }).reason, 'SINCE_IS_IN_THE_FUTURE');
});

test('the granted scopes come from the LIVE token, never from assumption', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: 'x', scope: 'read_orders,read_products' }) });
  assert.deepEqual(await getGrantedScopes({ shopDomain: 's', clientId: 'c', clientSecret: 'k' }, fetchImpl), ['read_orders', 'read_products']);
  await assert.rejects(getGrantedScopes({ shopDomain: 's', clientId: 'c', clientSecret: 'k' }, async () => ({ ok: false, status: 401 })), /HTTP 401/);
});

test('a backfill widens ONLY the date window: same query text, no extra fields, no customer PII added', async () => {
  const seen = [];
  const shopify = { async graphql(query, vars) { seen.push({ query, vars }); return ordersPage([FAKE_ORDER_1]); } };
  await syncOrders({ shopify, supabase: createFakeSupabase() }, { merchantId: 'm1', since: '2026-05-11' });
  await syncOrders({ shopify, supabase: createFakeSupabase() }, { merchantId: 'm1', now: NOW });
  assert.equal(seen[0].vars.searchQuery, historySearchQuery('2026-05-11')); // widened window
  assert.match(seen[1].vars.searchQuery, /^created_at:>=2026-08-06$/); // default: last 60 days
  assert.equal(seen[0].query, seen[1].query); // identical selection
  assert.equal(seen[0].query, ORDERS_PAGE_QUERY);
  assert.ok(!/customer\s*\{/.test(seen[0].query));
  assert.ok(!/\b(email|phone|firstName|lastName|address1|displayName)\b/.test(ORDERS_PAGE_QUERY + ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY.replace('customer { id }', '')));
});

test('coverage marker: completeFrom only moves earlier and only for a backfill; lastSyncedAt always updates', () => {
  const backfill = { mode: 'backfill', since: '2026-05-11' };
  const a = nextCoverage(null, { plan: backfill, now: NOW, storeCreatedOn: '2026-05-11' });
  assert.deepEqual([a.completeFrom, a.storeCreatedOn, a.lastSyncedAt], ['2026-05-11', '2026-05-11', '2026-10-05T09:00:00.000Z']);
  const b = nextCoverage(a, { plan: { mode: 'last_60_days', since: null }, now: new Date('2026-10-20T00:00:00Z') });
  assert.equal(b.completeFrom, '2026-05-11'); // a normal sync never claims older history
  assert.equal(b.lastSyncedAt, '2026-10-20T00:00:00.000Z');
  const c = nextCoverage(a, { plan: { mode: 'backfill', since: '2026-06-01' }, now: NOW });
  assert.equal(c.completeFrom, '2026-05-11'); // a later backfill never shrinks coverage
  assert.equal(nextCoverage(null, { plan: { mode: 'last_60_days' }, now: NOW }).completeFrom, null);
});

test('history covers a period when the backfill reaches its start, or the day the store was created', () => {
  const cov = { completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11' };
  assert.equal(historyCoversPeriod(cov, '2026-07-01'), true);
  assert.equal(historyCoversPeriod(cov, '2026-04-01'), true); // the period starts before the store existed: nothing to miss
  assert.equal(historyCoversPeriod({ completeFrom: '2026-08-15', storeCreatedOn: '2026-05-11' }, '2026-07-01'), false);
  assert.equal(historyCoversPeriod(null, '2026-07-01'), false);
  assert.equal(historyCoversPeriod({ completeFrom: null }, '2026-07-01'), false);
});

test('the marker file is written atomically and the previous one is kept as a backup', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cov-')), 'sub', 'sync-coverage.json');
  assert.equal(await readCoverage(path), null);
  await writeCoverage({ completeFrom: '2026-05-11', lastSyncedAt: 'a' }, path);
  await writeCoverage({ completeFrom: '2026-05-11', lastSyncedAt: 'b' }, path);
  assert.equal((await readCoverage(path)).lastSyncedAt, 'b');
  assert.equal(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).lastSyncedAt, 'a');
  assert.equal(existsSync(`${path}.tmp`), false);
});

function dataAllRates() { const d = makeMarketingData(); d.orderLines = d.orderLines.map((l) => ({ ...l, tax_rate_bp: 2100 })); return d; }
const packFor = (retailHistory, period = { start: '2026-08-01', end: '2026-09-30' }) => {
  const data = dataAllRates();
  return buildAccountantPack({ ledger: buildLedger(data, { config: RETAIL_CFG }), rawOrders: data.orders, docs: [], period, timeZone: 'UTC', now: NOW, config: RETAIL_CFG, today: '2026-10-05', retailHistory });
};

test('HOW A CLOSED QUARTER BECOMES COMPLETE: PARTIAL before the backfill, COMPLETE after it (with rates captured and a recent sync)', () => {
  const before = packFor(null);
  assert.equal(before.completeness.status, 'PARTIAL');
  assert.ok(before.completeness.reasons.some((r) => r.startsWith('RETAIL_HISTORY_STARTS_2026-09-10_AFTER_PERIOD_START')));
  const after = packFor({ completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-10-05T08:00:00.000Z' });
  assert.equal(after.completeness.status, 'COMPLETE');
  assert.deepEqual(after.completeness.reasons, []);
  assert.equal(after.retail.vat_by_rate.status, 'COMPLETE');
});

test('it stays PARTIAL when the backfill does not reach the period, the last sync predates the period end, or the period is open', () => {
  assert.equal(packFor({ completeFrom: '2026-08-20', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-10-05T08:00:00.000Z' }).completeness.status, 'PARTIAL');
  const stale = packFor({ completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-09-25T08:00:00.000Z' });
  assert.equal(stale.completeness.status, 'PARTIAL');
  assert.ok(stale.completeness.reasons.includes('RETAIL_LAST_SYNC_BEFORE_PERIOD_END'));
  const data = dataAllRates();
  const open = buildAccountantPack({ ledger: buildLedger(data, { config: RETAIL_CFG }), rawOrders: data.orders, docs: [], period: { start: '2026-08-01', end: '2026-09-30' }, timeZone: 'UTC', now: NOW, config: RETAIL_CFG, today: '2026-09-25', retailHistory: { completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-09-25T08:00:00.000Z' } });
  assert.ok(open.completeness.reasons.includes('PERIOD_NOT_CLOSED'));
});
