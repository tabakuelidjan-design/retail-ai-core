import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { createAssistant } from '../src/analytics-premium/server/assistant.js';
import { periodReport, resetPeriodCache, resolvePeriod, MAX_SPAN_DAYS } from '../src/analytics-premium/server/period-engine.js';
import { dayBucketsOfWindow } from '../src/metrics/windows.js';
import { makeData } from './fixtures/metrics-sample.js';

// Period selector. SYNTHETIC orders only. Expected figures are computed here from the raw synthetic orders with plain arithmetic (never through the engine).

const TZ = 'Europe/Brussels';
const NOW = new Date('2026-09-26T10:00:00Z'); // Saturday 2026-09-26 in Brussels
const localDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

function dataset() {
  const d = makeData();
  d.orders = []; d.orderLines = []; d.refunds = []; d.refundLines = [];
  // the detail routes only accept real-looking product ids (uuid): give the synthetic products uuid ids
  const uuid = { p1: '11111111-1111-4111-8111-111111111111', p2: '22222222-2222-4222-8222-222222222222', p3: '33333333-3333-4333-8333-333333333333', p4: '44444444-4444-4444-8444-444444444444' };
  for (const p of d.products) p.id = uuid[p.id]; for (const v of d.variants) v.product_id = uuid[v.product_id];
  d.products.find((p) => p.id === uuid.p1).product_type = 'Widgets';
  const gen = []; let i = 0;
  const add = (id, iso, q, price, disc, variant, channel, key) => {
    const tax = r2((q * price - disc) * 0.21 / 1.21);
    d.orders.push({ id, ordered_at: iso, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, channel_handle: channel, customer_key: key });
    d.orderLines.push({ id: `l-${id}`, order_id: id, variant_id: variant, title_snapshot: variant === 'v1' ? 'Fixture Widget' : 'Fixture Gadget', sku_snapshot: null, quantity: q, unit_price: price, discount_amount: disc, tax_amount: tax });
    gen.push({ id, iso, day: localDay(iso), q, price, disc, tax, ex: r2(q * price - disc - tax) });
  };
  for (let day = new Date('2026-06-12T12:00:00Z'); day <= new Date('2026-09-24T12:00:00Z'); day = new Date(day.getTime() + 2 * 86_400_000)) {
    i += 1;
    add(`g${i}`, day.toISOString(), (i % 3) + 1, 10 + (i % 5) * 5, i % 4 === 0 ? 2 : 0, i % 2 ? 'v1' : 'v2', i % 2 ? 'pos' : 'web', String.fromCharCode(97 + (i % 4)).repeat(64));
  }
  add('edge', '2026-06-30T22:30:00.000Z', 1, 20, 0, 'v1', 'pos', 'e'.repeat(64)); // 2026-07-01 00:30 in Brussels: belongs to July 1st, not June 30th
  const g10 = gen.find((g) => g.id === 'g10');
  d.refunds.push({ id: 'rf1', order_id: 'g10', amount: 10, refunded_at: '2026-08-20T09:00:00Z' });
  d.refundLines.push({ id: 'rfl1', refund_id: 'rf1', order_line_id: 'l-g10', quantity: 1, amount: 10, tax_amount: 1.74 });
  d.firstOrderAt = '2026-06-12T12:00:00Z';
  return { d, gen, refund: { day: '2026-08-20', ex: r2(10 - 1.74), tax: 1.74, amount: 10, orderDay: g10.day } };
}

async function setup() {
  resetPeriodCache();
  const { d, gen, refund } = dataset();
  const dir = await mkdtemp(path.join(tmpdir(), 'period-'));
  await writeFile(path.join(dir, 'dataset.json'), JSON.stringify({ version: 1, generated_at: '2026-09-26T09:00:00.000Z', time_zone: TZ, currency: 'EUR', data: d }));
  const inRange = (from, toExcl) => gen.filter((g) => g.day >= from && g.day < toExcl);
  const expected = (from, toExcl) => {
    const o = inRange(from, toExcl); const refunded = refund.day >= from && refund.day < toExcl;
    const gross = o.reduce((a, g) => a + g.q * g.price, 0); const disc = o.reduce((a, g) => a + g.disc, 0); const tax = o.reduce((a, g) => a + g.tax, 0);
    return { orders: o.length, units: o.reduce((a, g) => a + g.q, 0), gross: r2(gross), discounts: r2(disc), refunds: refunded ? refund.amount : 0,
      netEx: r2(o.reduce((a, g) => a + g.ex, 0) - (refunded ? refund.ex : 0)), tax: r2(tax - (refunded ? refund.tax : 0)) };
  };
  return { dir, expected, gen };
}
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const get = async (dir, q) => { const r = await periodReport(dir, q, { now: NOW }); assert.ok(r.ok, JSON.stringify(r)); return r.report; };
const kpisOf = (rep) => rep.explorer.last_30_days.kpis;

test('presets resolve to exact local days in Europe/Brussels (today = 2026-09-26)', () => {
  const R = (period) => { const r = resolvePeriod({ period }, { now: NOW, timeZone: TZ }); return [r.localStart, r.localEnd, r.days, r.includesToday]; };
  assert.deepEqual(R('last_7_days'), ['2026-09-19', '2026-09-26', 7, false]);
  assert.deepEqual(R('last_30_days'), ['2026-08-27', '2026-09-26', 30, false]);
  assert.deepEqual(R('last_90_days'), ['2026-06-28', '2026-09-26', 90, false]);
  assert.deepEqual(R('this_week'), ['2026-09-21', '2026-09-27', 6, true], 'Monday through today, today included');
  assert.deepEqual(R('this_month'), ['2026-09-01', '2026-09-27', 26, true]);
  assert.deepEqual(R('previous_month'), ['2026-08-01', '2026-09-01', 31, false]);
  assert.deepEqual(R('this_year'), ['2026-01-01', '2026-09-27', 269, true]);
  assert.deepEqual(R('yesterday'), ['2026-09-25', '2026-09-26', 1, false]);
  const c = resolvePeriod({ period: 'custom', from: '2026-07-01', to: '2026-07-18' }, { now: NOW, timeZone: TZ }); assert.deepEqual([c.localStart, c.localEnd, c.days], ['2026-07-01', '2026-07-19', 18]);
});

test('timezone: "today" is the Brussels day, not the UTC day (22:30 UTC on the 25th is already the 26th in Brussels)', () => {
  const lateUtc = new Date('2026-09-25T22:30:00Z');
  assert.equal(resolvePeriod({ period: 'last_7_days' }, { now: lateUtc, timeZone: TZ }).localEnd, '2026-09-26');
  assert.equal(resolvePeriod({ period: 'last_7_days' }, { now: lateUtc, timeZone: 'UTC' }).localEnd, '2026-09-25');
  assert.equal(resolvePeriod({ period: 'this_month' }, { now: new Date('2026-08-31T22:30:00Z'), timeZone: TZ }).localStart, '2026-09-01', 'Aug 31 22:30 UTC is already September 1st in Brussels');
});

test('invalid periods are refused with a precise code', () => {
  const bad = (q) => resolvePeriod(q, { now: NOW, timeZone: TZ }).code;
  assert.equal(bad({ period: 'custom', from: '2026-02-30', to: '2026-03-01' }), 'INVALID_DATE');
  assert.equal(bad({ period: 'custom', from: '2026-09-01' }), 'INVALID_DATE');
  assert.equal(bad({ period: 'custom', from: 'x', to: 'y' }), 'INVALID_DATE');
  assert.equal(bad({ period: 'custom', from: '2026-09-10', to: '2026-09-01' }), 'PERIOD_ORDER');
  assert.equal(bad({ period: 'custom', from: '2026-09-01', to: '2026-09-27' }), 'PERIOD_IN_FUTURE');
  assert.equal(bad({ period: 'custom', from: '2020-01-01', to: '2026-09-01' }), 'PERIOD_TOO_LONG');
  assert.equal(bad({ period: 'bogus' }), 'INVALID_PERIOD');
  assert.equal(bad({ period: 'last_n_days', days: 0 }), 'INVALID_PERIOD');
  assert.equal(resolvePeriod({ period: 'custom', from: '2026-09-26', to: '2026-09-26' }, { now: NOW, timeZone: TZ }).days, 1, 'today is a valid end date');
  assert.ok(MAX_SPAN_DAYS >= 1095);
});

test('7, 30, 90 days, current month, previous month, custom: every headline figure equals the plain-arithmetic expectation, and the parts add up', async () => {
  const { dir, expected } = await setup();
  for (const q of [{ period: 'last_7_days' }, { period: 'last_30_days' }, { period: 'last_90_days' }, { period: 'this_month' }, { period: 'previous_month' }, { period: 'this_year' }, { period: 'custom', from: '2026-07-01', to: '2026-07-18' }, { period: 'custom', from: '2026-08-10', to: '2026-08-25' }]) {
    const rep = await get(dir, q); const p = rep.period_info; const k = kpisOf(rep); const e = expected(p.start, addDays(p.end, 1));
    const label = JSON.stringify(q);
    assert.equal(k.order_count, e.orders, `${label} orders`); assert.equal(k.units_sold, e.units, `${label} units`);
    assert.equal(k.net_sales_ex_tax, e.netEx, `${label} net ex VAT`); assert.equal(k.gross_sales, e.gross, `${label} gross`);
    assert.equal(k.discounts, e.discounts, `${label} discounts`); assert.equal(k.refunds, e.refunds, `${label} refunds`); assert.equal(r2(k.tax), e.tax, `${label} VAT`);
    assert.equal(k.aov_ex_tax, e.orders ? r2(e.netEx / e.orders) : null, `${label} AOV`);
    const ex = rep.explorer.last_30_days;
    assert.equal(ex.series.daily.length, p.days, `${label}: one bucket per day of the period`);
    assert.equal(r2(ex.series.daily.reduce((a, d) => a + d.net_sales_ex_tax, 0)), e.netEx, `${label}: daily series sums to the KPI`);
    assert.equal(ex.series.daily[0].date, p.start); assert.equal(ex.series.daily.at(-1).date, p.end);
    assert.equal(r2(ex.series.weekly.reduce((a, w) => a + w.net_sales_ex_tax, 0)), e.netEx, `${label}: weekly series sums to the KPI`);
    assert.equal(r2(ex.categories.reduce((a, c) => a + c.net_sales_ex_tax, 0)), e.netEx, `${label}: categories sum to the KPI`);
    assert.equal(r2(ex.channels.reduce((a, c) => a + c.net_sales_ex_tax, 0)), e.netEx, `${label}: channels sum to the KPI`);
    assert.equal(rep.products_workspace.last_30_days.list.reduce((a, r) => a + r.units_sold, 0), e.units, `${label}: product list units`);
    assert.equal(rep.customers_workspace.last_30_days.period.start, p.start);
  }
});

test('the period really changes the data: different periods give different figures, not just a different label', async () => {
  const { dir } = await setup();
  const seen = new Set();
  for (const q of [{ period: 'last_7_days' }, { period: 'last_30_days' }, { period: 'last_90_days' }, { period: 'previous_month' }]) seen.add(kpisOf(await get(dir, q)).net_sales_ex_tax);
  assert.equal(seen.size, 4);
});

test('Europe/Brussels: an order at 22:30 UTC on June 30th belongs to July 1st (and is counted once, on that day only)', async () => {
  const { dir, expected, gen } = await setup();
  const edge = gen.find((g) => g.id === 'edge'); assert.equal(edge.day, '2026-07-01', 'plain Intl arithmetic: 22:30 UTC = 00:30 the next day in Brussels');
  const july1 = kpisOf(await get(dir, { period: 'custom', from: '2026-07-01', to: '2026-07-01' })); const june30 = kpisOf(await get(dir, { period: 'custom', from: '2026-06-30', to: '2026-06-30' }));
  assert.equal(july1.order_count, expected('2026-07-01', '2026-07-02').orders); assert.equal(june30.order_count, expected('2026-06-30', '2026-07-01').orders);
  assert.ok(gen.filter((g) => g.day === '2026-06-30').every((g) => g.id !== 'edge'));
  assert.ok(july1.order_count >= 1 && june30.order_count >= 1, 'each day has its own order(s); the near-midnight order is not double counted on June 30th');
  const both = kpisOf(await get(dir, { period: 'custom', from: '2026-06-30', to: '2026-07-01' })); assert.equal(both.order_count, july1.order_count + june30.order_count, 'counted once across adjacent days');
});

test('comparison: the previous period is the immediately preceding period of the SAME length (7 -> 7, 30 -> 30, custom 18 -> 18)', async () => {
  const { dir } = await setup();
  for (const [q, days, prevStart, prevEnd] of [[{ period: 'last_7_days' }, 7, '2026-09-12', '2026-09-18'], [{ period: 'last_30_days' }, 30, '2026-07-28', '2026-08-26'], [{ period: 'custom', from: '2026-07-01', to: '2026-07-18' }, 18, '2026-06-13', '2026-06-30']]) {
    const rep = await get(dir, q); const p = rep.period_info;
    assert.equal(p.days, days); assert.deepEqual(p.previous, { start: prevStart, end: prevEnd }, JSON.stringify(q));
    const prevDays = Math.round((new Date(`${p.previous.end}T00:00:00Z`) - new Date(`${p.previous.start}T00:00:00Z`)) / 86_400_000) + 1; assert.equal(prevDays, days);
    assert.equal(addDays(p.previous.end, 1), p.start, 'the previous period ends the day before this one starts');
    const k = kpisOf(rep); assert.ok(k.previous && k.delta, 'a comparison is offered');
    assert.equal(rep.explorer.last_30_days.comparison_coverage.sufficient, true);
  }
});

test('comparison values are computed over that same-length previous period', async () => {
  const { dir, expected } = await setup();
  const rep = await get(dir, { period: 'custom', from: '2026-07-01', to: '2026-07-18' });
  const prev = expected('2026-06-13', '2026-07-01'); const k = kpisOf(rep);
  assert.equal(k.previous.order_count, prev.orders); assert.equal(k.previous.net_sales_ex_tax, prev.netEx); assert.equal(k.previous.units_sold, prev.units);
  const cmp = rep.explorer.last_30_days.comparison; assert.equal(cmp.blocks.reduce((a, b) => a + b.days, 0), 18, 'the day-by-day comparison covers exactly the 18 days');
  assert.equal(rep.explorer.last_30_days.comparison_view.aligned_days.length, 18);
});

test('insufficient history: the previous period is not fully inside the business history -> no percentage, factual coverage instead', async () => {
  const { dir } = await setup();
  for (const q of [{ period: 'last_90_days' }, { period: 'this_year' }, { period: 'custom', from: '2026-06-12', to: '2026-06-30' }]) {
    const rep = await get(dir, q); const ex = rep.explorer.last_30_days; const cov = ex.comparison_coverage;
    assert.equal(cov.sufficient, false, JSON.stringify(q)); assert.equal(cov.history_start, '2026-06-12'); assert.ok(cov.previous_days_with_history < cov.previous_days);
    assert.equal(ex.kpis.previous, null); assert.equal(ex.kpis.delta, null); assert.equal(ex.comparison, null); assert.equal(rep.period_info.previous, null);
    assert.equal(rep.products_workspace.last_30_days.kpis.comparison_available, false);
    assert.equal(rep.customers_workspace.last_30_days.period.previous_start, null);
  }
  const ok = await get(dir, { period: 'last_30_days' }); assert.equal(ok.explorer.last_30_days.comparison_coverage.sufficient, true);
});

test('no result on the period: zeros, one bucket per day, no crash, no invented comparison', async () => {
  const { dir } = await setup();
  const rep = await get(dir, { period: 'custom', from: '2026-01-01', to: '2026-01-31' });
  const ex = rep.explorer.last_30_days; const k = ex.kpis;
  assert.deepEqual([k.order_count, k.units_sold, k.net_sales_ex_tax, k.discounts, k.refunds, k.tax], [0, 0, 0, 0, 0, 0]);
  assert.equal(k.aov_ex_tax, null); assert.equal(ex.series.daily.length, 31); assert.equal(ex.channels.length, 0); assert.equal(ex.categories.length, 0); assert.equal(ex.top_products.length, 0); assert.equal(k.previous, null);
  assert.equal(rep.products_workspace.last_30_days.list.length, 0); assert.equal(rep.customers_workspace.last_30_days.list.filter((c) => c.active).length, 0);
});

test('dayBucketsOfWindow: one bucket per local day of any window, DST-safe', () => {
  const b = dayBucketsOfWindow({ localStart: '2026-10-24', localEnd: '2026-10-28', timeZone: TZ });
  assert.deepEqual(b.map((x) => x.localStart), ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  assert.equal((b[1].end - b[1].start) / 3_600_000, 25, 'the 25th of October 2026 has 25 hours in Brussels (DST ends)');
});

// ---------- HTTP ----------
const get2 = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString('utf8')) })); }).on('error', reject));
async function serve(dir) { const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir, now: () => NOW })); await new Promise((r) => server.listen(0, '127.0.0.1', r)); return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }; }

test('HTTP: Explorer, Produits, Clients and their details follow ?period; invalid dates give 4xx codes; no parameter keeps the old 30-day report', async () => {
  const { dir, expected } = await setup(); const s = await serve(dir);
  try {
    const ex = await get2(s.port, '/api/explorer?period=custom&from=2026-07-01&to=2026-07-18'); assert.equal(ex.status, 200);
    assert.equal(ex.json.kpis.order_count, expected('2026-07-01', '2026-07-19').orders); assert.deepEqual([ex.json.period.start, ex.json.period.end, ex.json.period.days], ['2026-07-01', '2026-07-18', 18]);
    const pr = await get2(s.port, '/api/products?period=last_90_days'); assert.equal(pr.status, 200); assert.equal(pr.json.period_info.days, 90);
    const cu = await get2(s.port, '/api/customers?period=last_90_days'); assert.equal(cu.status, 200);
    const pid = pr.json.list.find((r) => r.units_sold > 0).id; const pd = await get2(s.port, `/api/products/detail?id=${pid}&period=last_90_days`); assert.equal(pd.status, 200);
    const cid = cu.json.list.find((c) => c.active).id; assert.equal((await get2(s.port, `/api/customers/detail?id=${cid}&period=last_90_days`)).status, 200);
    for (const [q, status, code] of [['period=custom&from=2026-09-10&to=2026-09-01', 400, 'PERIOD_ORDER'], ['period=custom&from=2026-02-30&to=2026-03-01', 400, 'INVALID_DATE'], ['period=custom&from=2026-09-01&to=2027-01-01', 422, 'PERIOD_IN_FUTURE'], ['period=custom&from=2019-01-01&to=2026-09-01', 422, 'PERIOD_TOO_LONG'], ['period=bogus', 400, 'INVALID_PERIOD']]) {
      const r = await get2(s.port, `/api/explorer?${q}`); assert.equal(r.status, status, q); assert.equal(r.json.error.code, code);
    }
  } finally { await s.close(); }
});

test('HTTP: without a dataset snapshot the default 30 days is still served from the report, other periods say the data is not ready', async () => {
  resetPeriodCache();
  const dir = await mkdtemp(path.join(tmpdir(), 'period-'));
  await writeFile(path.join(dir, 'report-2026-09-25.json'), JSON.stringify({ generated_at: '2026-09-25T10:00:00Z', currency: 'EUR', explorer: { last_30_days: { kpis: { order_count: 3 } } }, sales: { last_30_days: {} } }));
  const s = await serve(dir);
  try {
    assert.equal((await get2(s.port, '/api/explorer?period=last_30_days')).json.kpis.order_count, 3);
    const r = await get2(s.port, '/api/explorer?period=last_90_days'); assert.equal(r.status, 404); assert.equal(r.json.error.code, 'DATASET_UNAVAILABLE');
  } finally { await s.close(); }
});

// ---------- assistant aligned with the selected period ----------
test('"Parle à Nordla" answers for the period selected in the page, and for a period named in the question', async () => {
  const { dir, expected } = await setup();
  const ask = createAssistant({ reportsDir: dir, now: () => NOW });
  const sel = await ask({ question: 'Quel est mon chiffre d’affaires ?', selected: { period: 'custom', from: '2026-07-01', to: '2026-07-18' } });
  assert.equal(sel.status, 200); assert.equal(sel.body.figures[0].value, expected('2026-07-01', '2026-07-19').netEx); assert.deepEqual([sel.body.period.start, sel.body.period.end], ['2026-07-01', '2026-07-18']);
  const named = await ask({ question: 'Combien de commandes le mois dernier ?', selected: { period: 'last_7_days' } });
  assert.equal(named.body.figures[0].value, expected('2026-08-01', '2026-09-01').orders, 'the period in the question wins over the selected one');
  const days45 = await ask({ question: 'Quel est mon chiffre d’affaires sur 45 jours ?' }); assert.equal(days45.body.period.days, 45);
  const top90 = await ask({ question: 'Quel est mon meilleur produit ?', selected: { period: 'last_90_days' } }); assert.equal(top90.status, 200);
  const bad = await ask({ question: 'Quel est mon chiffre d’affaires ?', selected: { period: 'custom', from: '2026-09-10', to: '2026-09-01' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'PERIOD_ORDER'); assert.equal(bad.body.figures, undefined);
});

// ---------- UI: persistence and filters (real period.js in a vm with stubs) ----------
function loadPeriodUi() {
  const store = new Map();
  const ctx = { sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }, window: { addEventListener() {} },
    prState: { query: 'coque', filter: 'up', sort: 'name', selected: 'p1' }, clState: { query: 'a', filter: 'active', recency: 'd0_30', sort: 'revenue', selected: 'c1' },
    exGranularity: 'week', exChannelMetric: 'orders', cachedExplorer: { x: 1 }, cachedProducts: { x: 1 }, cachedCustomers: { x: 1 }, prDetails: new Map([['p1', {}]]), clDetails: new Map([['c1', {}]]),
    NORDLA_I18N: { getLang: () => 'fr' }, t: (k) => k, h: () => ({}), NordlaIcon: {}, icon: () => ({}), document: { addEventListener() {}, removeEventListener() {} } };
  vm.runInNewContext(`${readFileSync(new URL('../src/analytics-premium/ui/period.js', import.meta.url), 'utf8')}\nthis.__api = { periodState, periodQueryOf, periodQuery, customRangeError, setPeriod, resetUiState, uiStateSave, uiStateRestore, periodErrorKey, isIsoDate, DEFAULT_PERIOD };`, ctx);
  return { ctx, ...ctx.__api, store };
}

test('UI query strings and client-side range checks', () => {
  const u = loadPeriodUi();
  assert.equal(u.periodQueryOf({ key: 'last_90_days' }), 'period=last_90_days');
  assert.equal(u.periodQueryOf({ key: 'custom', from: '2026-07-01', to: '2026-07-18' }), 'period=custom&from=2026-07-01&to=2026-07-18');
  assert.equal(u.periodQueryOf({ key: 'custom', from: '2026-07-01' }), 'period=last_30_days', 'an incomplete custom range never reaches the server');
  assert.equal(u.periodQueryOf({ key: 'nonsense' }), 'period=last_30_days');
  assert.equal(u.customRangeError('2026-09-10', '2026-09-01'), 'period.err.PERIOD_ORDER'); assert.equal(u.customRangeError('', '2026-09-01'), 'period.err.INVALID_DATE'); assert.equal(u.customRangeError('2026-02-30', '2026-03-01'), 'period.err.INVALID_DATE'); assert.equal(u.customRangeError('2026-07-01', '2026-07-18'), null);
  assert.equal(u.periodErrorKey('PERIOD_ORDER'), 'period.err.PERIOD_ORDER'); assert.equal(u.periodErrorKey('WHATEVER'), 'period.err.GENERIC');
});

test('changing the period keeps the filters, sort and search, but drops the period-bound data and the open detail', () => {
  const u = loadPeriodUi();
  u.setPeriod({ key: 'last_90_days' });
  assert.equal(u.periodState.key, 'last_90_days');
  assert.deepEqual({ ...u.ctx.prState }, { query: 'coque', filter: 'up', sort: 'name', selected: null }); assert.deepEqual({ ...u.ctx.clState }, { query: 'a', filter: 'active', recency: 'd0_30', sort: 'revenue', selected: null });
  assert.equal(u.ctx.exGranularity, 'week'); assert.equal(u.ctx.exChannelMetric, 'orders');
  assert.deepEqual([u.ctx.cachedExplorer, u.ctx.cachedProducts, u.ctx.cachedCustomers], [null, null, null]); assert.equal(u.ctx.prDetails.size, 0); assert.equal(u.ctx.clDetails.size, 0);
  u.setPeriod({ key: 'custom', from: '2026-07-01', to: '2026-07-18' });
  assert.equal(u.periodQuery(), 'period=custom&from=2026-07-01&to=2026-07-18'); assert.equal(u.ctx.prState.filter, 'up');
});

test('the period, filters, sort and search survive navigation and reload (sessionStorage) and are restored', () => {
  const u = loadPeriodUi();
  u.setPeriod({ key: 'custom', from: '2026-07-01', to: '2026-07-18' }); u.uiStateSave();
  const saved = u.store.get('nordla.analytics.ui'); assert.ok(saved);
  const v = loadPeriodUi(); v.ctx.prState.query = ''; v.ctx.prState.filter = 'all'; v.ctx.clState.sort = 'recent'; v.ctx.exGranularity = 'day'; v.store.set('nordla.analytics.ui', saved);
  v.uiStateRestore();
  assert.deepEqual({ ...v.periodState }, { key: 'custom', from: '2026-07-01', to: '2026-07-18' });
  assert.equal(v.ctx.prState.query, 'coque'); assert.equal(v.ctx.prState.filter, 'up'); assert.equal(v.ctx.prState.sort, 'name'); assert.equal(v.ctx.clState.sort, 'revenue'); assert.equal(v.ctx.exGranularity, 'week');
  const corrupt = loadPeriodUi(); corrupt.store.set('nordla.analytics.ui', '{not json'); corrupt.uiStateRestore(); assert.equal(corrupt.periodState.key, 'last_30_days', 'a corrupt entry is ignored');
  const forged = loadPeriodUi(); forged.store.set('nordla.analytics.ui', JSON.stringify({ period: { key: 'custom', from: '2026-09-10', to: '2026-09-01' } })); forged.uiStateRestore(); assert.equal(forged.periodState.key, 'last_30_days', 'an invalid stored range is never applied');
});

test('an explicit reset puts the period and every filter back', () => {
  const u = loadPeriodUi();
  u.setPeriod({ key: 'last_90_days' }); u.resetUiState();
  assert.equal(u.periodState.key, 'last_30_days'); assert.deepEqual({ ...u.ctx.prState }, { query: '', filter: 'all', sort: 'revenue', selected: null }); assert.deepEqual({ ...u.ctx.clState }, { query: '', filter: 'all', recency: 'all', sort: 'recent', selected: null });
  assert.equal(u.ctx.exGranularity, 'day'); assert.equal(u.ctx.exChannelMetric, 'revenue');
});

test('UI wiring: the three workspaces send the period, details use it, errors are shown, and Brief / What changed stay locked', () => {
  const ui = (f) => readFileSync(new URL(`../src/analytics-premium/ui/${f}`, import.meta.url), 'utf8');
  assert.match(ui('explorer.js'), /fetch\(`\/api\/explorer\?\$\{periodQuery\(\)\}`\)/); assert.match(ui('products.js'), /fetch\(`\/api\/products\?\$\{periodQuery\(\)\}`\)/); assert.match(ui('customers.js'), /fetch\(`\/api\/customers\?\$\{periodQuery\(\)\}`\)/);
  assert.match(ui('products.js'), /detail\?id=\$\{encodeURIComponent\(id\)\}&\$\{periodQuery\(\)\}/); assert.match(ui('customers.js'), /detail\?id=\$\{encodeURIComponent\(id\)\}&\$\{periodQuery\(\)\}/);
  for (const f of ['explorer.js', 'products.js', 'customers.js']) { assert.match(ui(f), /periodPicker: \(\) => route\(\)/); assert.match(ui(f), /periodErrorKey\(d\.periodError\)/); assert.doesNotMatch(ui(f), /periodLocked: true/); }
  assert.match(ui('app.js'), /opts\.periodPicker\s*\?\s*periodPicker\(opts\.periodPicker\)/); assert.match(ui('app.js'), /period-pill locked/);
  assert.ok(ui('index.html').indexOf('/period.js') < ui('index.html').indexOf('/app.js'));
  const menu = ui('period.js'); for (const k of ['last_7_days', 'last_30_days', 'last_90_days', 'this_week', 'this_month', 'previous_month', 'this_year']) assert.ok(menu.includes(`'${k}'`), k);
  assert.match(menu, /period\.p\.custom/); assert.match(menu, /type: 'date'/); assert.doesNotMatch(menu, /innerHTML/);
  for (const lang of ['fr', 'nl', 'en']) { const src = ui(`lang-${lang}.js`); for (const k of ['period.p.last_90_days', 'period.p.custom', 'period.from', 'period.to', 'period.err.PERIOD_ORDER', 'period.err.INVALID_DATE', 'period.empty', 'cmp.insufficientHistory']) assert.match(src, new RegExp(`'${k.replace(/\./g, '\\.')}'`), `${lang} ${k}`); }
});
