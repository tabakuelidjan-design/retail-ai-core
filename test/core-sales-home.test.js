// Core home sales tiles: the Analytics brief reshaped read-only, never a figure of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salesHomeFromBrief, loadSalesHome } from '../src/core-pilot/sales-home.js';
import { ROUTE_RULES } from '../src/identity/permissions.js';

const BRIEF = {
  generatedAt: '2026-11-20T10:00:00Z', currency: 'EUR',
  kpis: { netRevenue: { value: 864 }, orders: { value: 28 }, aov: { value: 30.84 } },
  series: {
    dates: ['2026-11-02', '2026-11-03', '2026-11-09', '2026-11-10'],
    netRevenue: [100, null, 50, 25], orders: [2, 1, 3, null], aov: [], grossMargin: [], // a null day stays null
  },
};
const SSO_OK = () => new Response(null, { status: 302, headers: { 'set-cookie': 'an_sid=abc123; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800' } });
const BASE = 'https://analytics.example';

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

test('no Analytics link or no ticket: NOT_CONNECTED, nothing is called', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return SSO_OK(); };
  assert.equal((await loadSalesHome({ publicUrl: '', ticket: 't', fetchImpl })).status, 'NOT_CONNECTED');
  assert.equal((await loadSalesHome({ publicUrl: BASE, ticket: '', fetchImpl })).status, 'NOT_CONNECTED');
  assert.equal(called, false);
});

test('signs in with the one-time ticket, then reads /api/brief with the session cookie only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(`${BASE}/sso?t=`)) { assert.equal(init.redirect, 'manual'); return SSO_OK(); }
    return new Response(JSON.stringify(BRIEF), { status: 200 });
  };
  const s = await loadSalesHome({ publicUrl: BASE, ticket: 'tk.1', fetchImpl });
  assert.equal(calls[0].url, `${BASE}/sso?t=tk.1`);
  assert.equal(calls[1].url, `${BASE}/api/brief`);
  assert.equal(calls[1].init.headers.cookie, 'an_sid=abc123', 'only the session cookie is sent, not the ticket');
  assert.equal(calls[1].init.headers.authorization, undefined, 'no access token is sent');
  assert.equal(s.status, 'AVAILABLE');
});

test('a ticket that does not open a session: UNAVAILABLE, the brief is not read', async () => {
  let briefCalled = false;
  const fetchImpl = async (url) => { if (url.includes('/api/brief')) briefCalled = true; return new Response('{}', { status: 401 }); };
  assert.equal((await loadSalesHome({ publicUrl: BASE, ticket: 't', fetchImpl })).status, 'UNAVAILABLE');
  assert.equal(briefCalled, false);
});

test('an Analytics 404 (no report yet): NOT_CONNECTED; a 500 or a network error: UNAVAILABLE', async () => {
  const sso = (url) => (url.includes('/sso?') ? SSO_OK() : null);
  assert.equal((await loadSalesHome({ publicUrl: BASE, ticket: 't', fetchImpl: async (u) => sso(u) ?? new Response('{}', { status: 404 }) })).status, 'NOT_CONNECTED');
  assert.equal((await loadSalesHome({ publicUrl: BASE, ticket: 't', fetchImpl: async (u) => sso(u) ?? new Response('{}', { status: 500 }) })).status, 'UNAVAILABLE');
  assert.equal((await loadSalesHome({ publicUrl: BASE, ticket: 't', fetchImpl: async () => { throw new Error('down'); } })).status, 'UNAVAILABLE');
});

test('a plain-http remote address is refused: UNAVAILABLE, the ticket is never sent in clear', async () => {
  let called = false;
  const s = await loadSalesHome({ publicUrl: 'http://analytics.example', ticket: 't', fetchImpl: async () => { called = true; return SSO_OK(); } });
  assert.equal(s.status, 'UNAVAILABLE');
  assert.equal(called, false);
});

test('the route is listed with the same rights as opening Analytics (read-only GET)', () => {
  const row = ROUTE_RULES.find((r) => r.path === '/api/core/sales');
  assert.ok(row, 'GET /api/core/sales is in the permission table');
  assert.equal(row.method, 'GET');
  assert.equal(row.access, 'module-open:analytics');
});
