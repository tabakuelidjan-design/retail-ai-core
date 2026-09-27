import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildWindows } from '../src/metrics/windows.js';
import { buildExplorer } from '../src/report/explorer.js';
import { buildCustomersWorkspace, safeCustomerIds } from '../src/report/customers-workspace.js';
import { loadCustomers, loadCustomerDetail } from '../src/analytics-premium/server/customers.js';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { CONFIG, makeData } from './fixtures/metrics-sample.js';

const NOW = new Date('2026-09-21T09:00:00Z');
const UI = new URL('../src/analytics-premium/ui/', import.meta.url);
const KEY_A = 'a4b7'.padEnd(64, 'e'); // o1 + o3 (index 1 then 2): new in the window, 2 orders
const KEY_B = 'b1c2'.padEnd(64, '0'); // o2 (index 3): returning, earlier orders outside the history
const KEY_C = 'c9d8'.padEnd(64, '1'); // o4 in the PREVIOUS 30 days only: no purchase in the current period

function build(mutate) {
  const data = makeData();
  const o = (id) => data.orders.find((x) => x.id === id);
  Object.assign(o('o1'), { customer_key: KEY_A, journey_ready: true, customer_order_index: 1, channel_name: 'Online Store' });
  Object.assign(o('o3'), { customer_key: KEY_A, journey_ready: true, customer_order_index: 2, channel_name: 'Point of Sale' });
  Object.assign(o('o2'), { customer_key: KEY_B, journey_ready: true, customer_order_index: 3, channel_name: 'Point of Sale' });
  data.orders.push({ id: 'o4', ordered_at: '2026-08-10T10:00:00Z', status: 'PAID', currency: 'EUR', taxes_included: false, customer_key: KEY_C, journey_ready: true, customer_order_index: 1, channel_name: 'Online Store' });
  data.orderLines.push({ id: 'l5', order_id: 'o4', variant_id: 'v2', title_snapshot: 'Fixture Gadget', sku_snapshot: null, quantity: 3, unit_price: 10, discount_amount: 0, tax_amount: 6.3 });
  if (mutate) mutate(data, o);
  const ledger = buildLedger(data, { config: CONFIG });
  const windows = buildWindows(NOW, 'UTC');
  const ws = buildCustomersWorkspace({ ledger, data, windows, now: NOW, config: CONFIG, timeZone: 'UTC' });
  const ex = buildExplorer({ ledger, data, windows, now: NOW, config: CONFIG, dailySeries: [], timeZone: 'UTC' });
  return { ws, ex, data };
}
const row = (ws, id) => ws.list.find((r) => r.id === id);

test('clients: the list holds every identified customer of the history, with period figures matching Explorer', () => {
  const { ws, ex } = build();
  assert.deepEqual(ws.list.map((r) => r.id).sort(), ['A4B7', 'B1C2', 'C9D8']);
  const a = row(ws, 'A4B7');
  assert.equal(a.active, true);
  assert.equal(a.order_count, 2);
  // same revenue as Explorer's own top-customer row for this customer
  const exA = ex.customers.top.find((r) => r.label === '#A4B7');
  assert.equal(a.net_sales_ex_tax, exA.net_sales_ex_tax);
  assert.equal(a.aov_ex_tax, Math.round((a.net_sales_ex_tax / 2) * 100) / 100);
  // default order: most recent last purchase first
  assert.deepEqual(ws.list.map((r) => r.id), ['A4B7', 'B1C2', 'C9D8']);
});

test('clients: active / new / returning use exactly Explorer\'s definitions', () => {
  const { ws, ex } = build();
  const active = ws.list.filter((r) => r.active);
  assert.equal(active.length, ex.customers.kpis.active);
  assert.equal(active.filter((r) => r.period_status === 'new').length, ex.customers.kpis.new);
  assert.equal(active.filter((r) => r.period_status === 'returning').length, ex.customers.kpis.returning);
  assert.equal(active.filter((r) => r.period_status === 'unknown').length, ex.customers.kpis.unknown);
  assert.equal(row(ws, 'A4B7').period_status, 'new');
  assert.equal(row(ws, 'B1C2').period_status, 'returning');
  assert.equal(row(ws, 'C9D8').period_status, null); // not active: no period status is invented
});

test('clients: an untrusted order index gives the neutral unknown state, never a guess', () => {
  const { ws, ex } = build((data, o) => { o('o2').journey_ready = false; });
  assert.equal(row(ws, 'B1C2').period_status, 'unknown');
  assert.equal(ex.customers.kpis.unknown, 1);
  const { ws: w2 } = build((data, o) => { o('o2').journey_ready = false; });
  assert.equal(buildDetail(w2, 'B1C2').earlier_history.status, 'unknown');
});

function buildDetail(ws, id) { return ws.details[id]; }

test('clients: labels are short pseudonymous prefixes, extended only on a collision, and the full key never leaves the report block', () => {
  const ids = safeCustomerIds(['abcd1111', 'abcd2222', 'ffff0000']);
  assert.equal(ids.get('ffff0000'), 'FFFF');
  assert.equal(ids.get('abcd1111'), 'ABCD1');
  assert.equal(ids.get('abcd2222'), 'ABCD2');
  const { ws } = build();
  const json = JSON.stringify(ws);
  for (const k of [KEY_A, KEY_B, KEY_C]) assert.ok(!json.includes(k));
  assert.ok(!/[0-9a-f]{16,}/i.test(json.replace(/https?:\/\/\S+?"/g, '"')));
  for (const r of ws.list) assert.match(r.label, /^#[0-9A-F]{4,12}$/);
});

test('clients: customer detail - period metrics, available history, orders, channels and products', () => {
  const { ws } = build();
  const a = ws.details.A4B7;
  assert.equal(a.known_orders, 2);
  assert.equal(a.orders.length, 2);
  assert.deepEqual(a.orders.map((o) => o.date), ['2026-09-12', '2026-09-10']); // newest first
  assert.deepEqual(a.orders.map((o) => o.channel), ['Point of Sale', 'Online Store']);
  assert.equal(a.orders[1].refunded, true); // o1 carries a refund
  assert.equal(a.known_net_sales_ex_tax, Math.round(a.orders.reduce((s, o) => s + o.net_sales_ex_tax, 0) * 100) / 100);
  assert.equal(a.first_order_date, '2026-09-10');
  assert.equal(a.last_order_date, '2026-09-12');
  assert.equal(a.recency_days, 8); // 2026-09-12T15:00Z -> 2026-09-21T09:00Z = 8.75 days, floored (Explorer's recency rule)
  assert.equal(a.earlier_history.status, 'none');
  const widget = a.products.find((p) => p.title === 'Fixture Widget');
  assert.equal(widget.units, 3); // 2 on o1 + 1 on o3
  assert.equal(widget.refunded_units, 1);
  const b = ws.details.B1C2;
  assert.deepEqual(b.earlier_history, { status: 'outside_history', orders_before: 2 });
});

test('clients: zero / one-order edge cases', () => {
  const { ws } = build();
  const b = ws.details.B1C2;
  assert.equal(b.known_orders, 1);
  assert.equal(b.orders.length, 1);
  // previous-period-only customer: 0 now, a real previous base, reported as "no purchase in the period"
  const c = row(ws, 'C9D8');
  assert.equal(c.active, false);
  assert.equal(c.order_count, 0);
  assert.equal(c.aov_ex_tax, null);
  assert.equal(c.previous_order_count, 1);
  assert.equal(c.evolution.status, 'no_current_purchase');
  assert.equal(c.evolution.delta_pct, -1);
  assert.deepEqual(ws.watch.lapsed.map((x) => x.id), ['C9D8']);
  // a new customer has no previous base: no percentage, never +infinity
  assert.equal(row(ws, 'A4B7').evolution.status, 'no_previous_purchase');
  assert.equal(row(ws, 'A4B7').evolution.delta_pct, null);
  // no identified customer at all: empty, never approximated
  const { ws: none } = build((data) => { for (const x of data.orders) delete x.customer_key; });
  assert.deepEqual(none.list, []);
  assert.deepEqual(none.top, []);
  assert.deepEqual(none.details, {});
  assert.equal(none.history.identified_share, 0);
});

test('clients: own purchase rhythm stays insufficient below the approved interval gate', () => {
  const { ws } = build();
  assert.equal(ws.watch.own_rhythm.status, 'insufficient');
  assert.equal(ws.watch.own_rhythm.intervals, 1); // A4B7: 2 orders -> 1 gap
  assert.equal(ws.watch.own_rhythm.required_intervals, CONFIG.customers.minIntervals);
  assert.deepEqual(ws.watch.both_periods, []);
});

async function reportDir() {
  const { ws, ex } = build();
  const dir = await mkdtemp(path.join(tmpdir(), 'ap-customers-'));
  const report = { generated_at: '2026-09-21T09:00:00Z', currency: 'EUR', explorer: { last_30_days: ex }, customers_workspace: { last_30_days: ws } };
  await writeFile(path.join(dir, 'report-2026-09-21.json'), JSON.stringify(report));
  return dir;
}

test('clients api: list payload reuses Explorer coverage/KPIs and never ships histories or keys', async () => {
  const dir = await reportDir();
  const d = await loadCustomers(dir);
  const { ex } = build();
  assert.equal(d.available, true);
  assert.deepEqual(d.coverage, ex.customers.coverage);
  assert.deepEqual(d.kpis, ex.customers.kpis);
  assert.equal(d.value.gated, true);
  assert.equal(d.value.min_customers, CONFIG.customers.minCustomers);
  assert.equal('details' in d, false);
  const json = JSON.stringify(d);
  assert.ok(!json.includes('"orders":[{'));
  for (const k of [KEY_A, KEY_B, KEY_C]) assert.ok(!json.includes(k));
});

test('clients api: detail is loaded per customer and rejects invalid or unknown ids', async () => {
  const dir = await reportDir();
  const ok = await loadCustomerDetail(dir, 'A4B7');
  assert.equal(ok.customer.label, '#A4B7');
  assert.equal(ok.customer.orders.length, 2);
  assert.deepEqual(await loadCustomerDetail(dir, '../../etc'), { error: 'INVALID_CUSTOMER_ID' });
  assert.deepEqual(await loadCustomerDetail(dir, KEY_A), { error: 'INVALID_CUSTOMER_ID' }); // a full key is never a valid lookup
  assert.deepEqual(await loadCustomerDetail(dir, 'FFFF'), { error: 'CUSTOMER_NOT_FOUND' });
  const old = await mkdtemp(path.join(tmpdir(), 'ap-customers-old-'));
  await writeFile(path.join(old, 'report-2026-09-20.json'), JSON.stringify({ generated_at: 'x', explorer: {} }));
  assert.equal((await loadCustomers(old)).available, false);
});

test('clients route: served by the app, reachable from the navigation, with its own page files', async () => {
  const dir = await reportDir();
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await fetch(`${base}/api/customers`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).list.length, 3);
    assert.equal((await fetch(`${base}/api/customers/detail?id=B1C2`)).status, 200);
    assert.equal((await fetch(`${base}/api/customers/detail?id=zz`)).status, 400);
    assert.equal((await fetch(`${base}/api/customers/detail?id=ABCDEF`)).status, 404);
    assert.equal((await fetch(`${base}/customers.js`)).status, 200);
    assert.equal((await fetch(`${base}/customers.css`)).status, 200);
  } finally { server.close(); }
  const app = await readFile(new URL('app.js', UI), 'utf8');
  assert.ok(app.includes("['customers', 'clients', 'nav.customers', '#/customers']"));
  assert.match(app, /customers: \{ key: 'customers', load: loadCustomersIfNeeded, render: renderCustomersPage \}/);
  const html = await readFile(new URL('index.html', UI), 'utf8');
  assert.ok(html.includes('/customers.js') && html.includes('/customers.css'));
});

test('clients ui: every cl.* string exists in FR, NL and EN, and no unsupported customer concept is labelled', async () => {
  const src = await readFile(new URL('customers.js', UI), 'utf8');
  const used = new Set([...src.matchAll(/\bt\('(cl\.[^']+)'/g)].map((m) => m[1]));
  for (const f of ['all', 'active', 'new', 'returning', 'unknown', 'inactive']) used.add(`cl.filter.${f}`);
  for (const s of ['new', 'returning', 'unknown', 'inactive']) used.add(`cl.status.${s}`);
  for (const l of ['fr', 'nl', 'en']) {
    const dict = await readFile(new URL(`lang-${l}.js`, UI), 'utf8');
    const keys = new Set([...dict.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
    for (const k of used) assert.ok(keys.has(k), `${l} is missing ${k}`);
    const cl = dict.split('\n').filter((x) => /^\s*'cl\./.test(x)).join('\n');
    assert.ok(!/fidèle|à risque|dormant|churn|\bVIP\b|loyal|trouw|at risk|lifetime|CLV/i.test(cl), `${l}: unsupported customer concept in cl.* copy`);
  }
  // official icons only, and never the loyalty / risk / dormant ones on this page
  assert.ok(!/clientFidele|clientARisque|clientDormant|cohorte/.test(src));
});
