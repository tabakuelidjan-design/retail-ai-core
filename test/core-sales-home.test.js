// Core home sales tiles: the Analytics brief reshaped read-only, never a figure of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salesHomeFromBrief, loadSalesHome } from '../src/core-pilot/sales-home.js';
import { ROUTE_RULES as PERMISSIONS } from '../src/identity/permissions.js';

const BRIEF = {
  generatedAt: '2026-11-20T10:00:00Z', currency: 'EUR',
  kpis: { netRevenue: { value: 864 }, orders: { value: 28 }, aov: { value: 30.84 } },
  series: {
    dates: ['2026-11-02', '2026-11-03', '2026-11-09', '2026-11-10'],
    netRevenue: [100, null, 50, 25], orders: [2, 1, 3, null], aov: [], grossMargin: [], // a null day stays null
  },
};

test('brief -> home: net sales and orders from the report, no comparison invented, weeks grouped Monday-first', () => {
  const s = salesHomeFromBrief(BRIEF);
  assert.equal(s.status, 'AVAILABLE');
  assert.deepEqual(s.values.map((v) => [v.key, v.value]), [['net_sales_ex_tax', 864], ['order_count', 28]]);
  assert.deepEqual(s.comparison, { rows: [] }, 'the brief holds no previous period: no delta');
  // 2 Nov 2026 is a Monday: the first week starts that day; its unknown day (3 Nov) adds nothing to the sales, its known orders count.
  assert.equal(s.weekly[0].week_start, '2026-11-02');
  assert.equal(s.weekly[0].net_sales_ex_tax, 100);
  assert.equal(s.weekly[0].order_count, 3);
  assert.equal(s.weekly[1].week_start, '2026-11-09');
  assert.equal(s.weekly[1].net_sales_ex_tax, 75, 'two days of the week, both known');
});

test('a week whose days are all unknown stays null, never zero', () => {
  const s = salesHomeFromBrief({ ...BRIEF, series: { dates: ['2026-11-02'], netRevenue: [null], orders: [null] } });
  assert.equal(s.weekly[0].net_sales_ex_tax, null);
  assert.equal(s.weekly[0].order_count, null);
});

test('no brief, or no net sales in it: NOT_CONNECTED, never a zero', () => {
  assert.equal(salesHomeFromBrief(null).status, 'NOT_CONNECTED');
  assert.equal(salesHomeFromBrief({ kpis: null }).status, 'NOT_CONNECTED');
});

test('not configured (no address or no token): NOT_CONNECTED without calling anything', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response('{}'); };
  assert.equal((await loadSalesHome({ env: {}, fetchImpl })).status, 'NOT_CONNECTED');
  assert.equal((await loadSalesHome({ env: { ANALYTICS_BRIEF_URL: 'https://a.example' }, fetchImpl })).status, 'NOT_CONNECTED');
  assert.equal(called, false);
});

test('reads /api/brief with the configured token as the Basic password, and reshapes it', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = { url, auth: init.headers.authorization }; return new Response(JSON.stringify(BRIEF), { status: 200 }); };
  const s = await loadSalesHome({ env: { ANALYTICS_BRIEF_URL: 'https://analytics.example', ANALYTICS_BRIEF_TOKEN: 'tok-123' }, fetchImpl });
  assert.equal(seen.url, 'https://analytics.example/api/brief');
  assert.equal(seen.auth, `Basic ${Buffer.from('nordla:tok-123').toString('base64')}`);
  assert.equal(s.status, 'AVAILABLE');
});

test('an Analytics 404 (no report yet): NOT_CONNECTED; a 500 or a network error: UNAVAILABLE', async () => {
  const env = { ANALYTICS_BRIEF_URL: 'https://analytics.example', ANALYTICS_BRIEF_TOKEN: 't' };
  assert.equal((await loadSalesHome({ env, fetchImpl: async () => new Response('{}', { status: 404 }) })).status, 'NOT_CONNECTED');
  assert.equal((await loadSalesHome({ env, fetchImpl: async () => new Response('{}', { status: 500 }) })).status, 'UNAVAILABLE');
  assert.equal((await loadSalesHome({ env, fetchImpl: async () => { throw new Error('down'); } })).status, 'UNAVAILABLE');
});

test('a plain-http remote address is refused: UNAVAILABLE, the token is never sent in clear', async () => {
  let called = false;
  const s = await loadSalesHome({ env: { ANALYTICS_BRIEF_URL: 'http://analytics.example', ANALYTICS_BRIEF_TOKEN: 't' }, fetchImpl: async () => { called = true; return new Response('{}'); } });
  assert.equal(s.status, 'UNAVAILABLE');
  assert.equal(called, false);
});

test('the route is listed with the same rights as opening Analytics (read-only GET)', () => {
  const row = PERMISSIONS.find((r) => r.path === '/api/core/sales');
  assert.ok(row, 'GET /api/core/sales is in the permission table');
  assert.equal(row.method, 'GET');
  assert.equal(row.access, 'module-open:analytics');
});
