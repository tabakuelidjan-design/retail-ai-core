import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { createAssistant } from '../src/analytics-premium/server/assistant.js';
import { resetPeriodCache } from '../src/analytics-premium/server/period-engine.js';
import { createToolLayer, MAX_TOOL_CALLS_PER_QUESTION } from '../src/analytics-premium/server/tools/index.js';
import { sanitize, validate } from '../src/analytics-premium/server/tools/contract.js';
import { makeData } from './fixtures/metrics-sample.js';

// Nordla Tool Layer (Phase 1, Analytics). SYNTHETIC orders only. The proof that matters: every tool returns EXACTLY the figure the Explorer / Produits /
// Clients HTTP endpoints return for the same metric and the same period, and (independently) the figure obtained by plain arithmetic on the raw orders.

const TZ = 'Europe/Brussels';
const NOW = new Date('2026-09-26T10:00:00Z');
const localDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const P1 = '11111111-1111-4111-8111-111111111111';

function dataset() {
  const d = makeData();
  d.orders = []; d.orderLines = []; d.refunds = []; d.refundLines = [];
  const uuid = { p1: P1, p2: '22222222-2222-4222-8222-222222222222', p3: '33333333-3333-4333-8333-333333333333', p4: '44444444-4444-4444-8444-444444444444' };
  for (const p of d.products) p.id = uuid[p.id]; for (const v of d.variants) v.product_id = uuid[v.product_id];
  const gen = []; let i = 0;
  const add = (id, iso, q, price, disc, variant, channel, key) => {
    const tax = r2((q * price - disc) * 0.21 / 1.21);
    d.orders.push({ id, ordered_at: iso, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, channel_handle: channel, customer_key: key });
    d.orderLines.push({ id: `l-${id}`, order_id: id, variant_id: variant, title_snapshot: variant === 'v1' ? 'Fixture Widget' : 'Fixture Gadget', sku_snapshot: null, quantity: q, unit_price: price, discount_amount: disc, tax_amount: tax });
    gen.push({ id, day: localDay(iso), q, price, disc, tax, ex: r2(q * price - disc - tax) });
  };
  for (let day = new Date('2026-06-12T12:00:00Z'); day <= new Date('2026-09-24T12:00:00Z'); day = new Date(day.getTime() + 2 * 86_400_000)) {
    i += 1;
    add(`g${i}`, day.toISOString(), (i % 3) + 1, 10 + (i % 5) * 5, i % 4 === 0 ? 2 : 0, i % 2 ? 'v1' : 'v2', i % 2 ? 'pos' : 'web', String.fromCharCode(97 + (i % 4)).repeat(64));
  }
  d.refunds.push({ id: 'rf1', order_id: 'g10', amount: 10, refunded_at: '2026-08-20T09:00:00Z' });
  d.refundLines.push({ id: 'rfl1', refund_id: 'rf1', order_line_id: 'l-g10', quantity: 1, amount: 10, tax_amount: 1.74 });
  d.firstOrderAt = '2026-06-12T12:00:00Z';
  return { d, gen };
}

async function setup() {
  resetPeriodCache();
  const { d, gen } = dataset();
  const dir = await mkdtemp(path.join(tmpdir(), 'tools-'));
  await writeFile(path.join(dir, 'dataset.json'), JSON.stringify({ version: 1, generated_at: '2026-09-26T09:00:00.000Z', time_zone: TZ, currency: 'EUR', data: d }));
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir, now: () => NOW }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const api = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, data: await r.json() }; };
  return { dir, gen, api, port, tools: createToolLayer({ reportsDir: dir, now: () => NOW }), close: () => new Promise((r) => server.close(r)) };
}
const qs = (p) => (p.period === 'custom' ? `period=custom&from=${p.from}&to=${p.to}` : `period=${p.period}`);
const val = (res, key) => res.values.find((v) => v.key === key)?.value;
const PERIODS_UNDER_TEST = [{ period: 'last_7_days' }, { period: 'last_30_days' }, { period: 'last_90_days' }, { period: 'this_month' }, { period: 'previous_month' }, { period: 'this_week' }, { period: 'custom', from: '2026-07-01', to: '2026-07-31' }];

test('catalog: 8 typed tools with JSON-Schema inputs, provider-neutral (no provider names, no network) and Phase-5 tools absent', async () => {
  const s = await setup();
  try {
    const cat = s.tools.catalog();
    assert.deepEqual(cat.map((t) => t.name), ['get_sales_metrics', 'compare_sales', 'get_top_products', 'get_product_metrics', 'get_customers', 'get_customer_metrics', 'get_channels', 'get_categories']);
    for (const t of cat) { assert.ok(t.description.length > 20); assert.equal(t.inputSchema.type, 'object'); assert.equal(t.inputSchema.additionalProperties, false); assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name'], 'the catalog carries no code and no data'); }
    for (const absent of ['find_product', 'get_vat', 'get_shipping', 'get_discounts', 'get_orders', 'get_refunds']) assert.ok(!s.tools.has(absent), `${absent} is Phase 5`);
    const src = readdirSync(new URL('../src/analytics-premium/server/tools/', import.meta.url)).map((f) => readFileSync(new URL(`../src/analytics-premium/server/tools/${f}`, import.meta.url), 'utf8')).join('\n');
    assert.ok(!/openai|anthropic|claude|kimi|gpt-|gemini|mistral/i.test(src), 'no provider is named in the tool layer');
    assert.ok(!/\bfetch\(|node:http|node:https|XMLHttpRequest/.test(src), 'the tool layer makes no network call');
    assert.ok(MAX_TOOL_CALLS_PER_QUESTION >= 1);
  } finally { await s.close(); }
});

test('the tool layer computes no KPI itself: it imports no ledger / sales / windows engine and only reuses the period engine and the read layers', () => {
  const src = readFileSync(new URL('../src/analytics-premium/server/tools/analytics-tools.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['../../../report/explorer.js', '../customers.js', '../explorer.js', '../period-engine.js', '../products.js', './contract.js'].sort());
  assert.ok(!/computeSalesMetrics\(|buildLedger\(|buildExplorer\(|windowFacts\(|aggregate\(/.test(src));
});

test('every tool answers with the common contract: ok, tool, args, period, values, comparison, completeness, source, freshness, privacy', async () => {
  const s = await setup();
  try {
    const calls = [['get_sales_metrics', {}], ['compare_sales', { periodA: { period: 'last_30_days' }, periodB: { period: 'previous_month' } }], ['get_top_products', { limit: 3 }], ['get_product_metrics', { productId: P1 }],
      ['get_customers', { limit: 3 }], ['get_channels', {}], ['get_categories', {}]];
    for (const [name, args] of calls) {
      const r = await s.tools.call(name, args);
      assert.equal(r.ok, true, `${name}: ${JSON.stringify(r).slice(0, 200)}`); assert.equal(r.tool, name); assert.deepEqual(r.args, args);
      assert.ok(r.period.from && r.period.to && r.period.days && r.period.timeZone === TZ, `${name} period`);
      assert.ok(Array.isArray(r.values)); for (const v of r.values) { assert.ok('key' in v && 'value' in v && 'unit' in v); }
      assert.ok('comparison' in r);
      assert.ok(['COMPLETE', 'PARTIAL'].includes(r.completeness.status) && Array.isArray(r.completeness.reasons) && Array.isArray(r.completeness.missing));
      assert.equal(r.source.engine, 'nordla-analytics'); assert.ok(r.source.view && r.source.datasetGeneratedAt);
      assert.equal(r.freshness.dataAsOf, '2026-09-26T09:00:00.000Z'); assert.equal(r.freshness.ageMinutes, 60); assert.equal(r.freshness.stale, false);
      assert.equal(r.privacy.aggregatesOnly, true);
    }
    const cid = (await s.tools.call('get_customers', { limit: 1 })).items[0].ref;
    const c = await s.tools.call('get_customer_metrics', { customerId: cid }); assert.equal(c.ok, true); assert.equal(c.tool, 'get_customer_metrics');
  } finally { await s.close(); }
});

test('SAME FIGURE AS EXPLORER: get_sales_metrics equals /api/explorer for every metric, on 7 different periods, comparison included', async () => {
  const s = await setup();
  try {
    for (const p of PERIODS_UNDER_TEST) {
      const t = await s.tools.call('get_sales_metrics', { period: p });
      assert.equal(t.ok, true, JSON.stringify(p));
      const ex = (await s.api(`/api/explorer?${qs(p)}`)).data;
      for (const k of ['net_sales_ex_tax', 'gross_sales', 'discounts', 'refunds', 'order_count', 'units_sold', 'aov_ex_tax']) assert.equal(val(t, k), ex.kpis[k], `${JSON.stringify(p)} ${k}`);
      assert.equal(t.period.from, ex.period.start); assert.equal(t.period.to, ex.period.end);
      if (ex.comparison_view?.kpis && ex.comparison_coverage.sufficient) {
        assert.deepEqual(t.comparison.rows.map((r) => [r.key, r.current, r.previous, r.delta_abs, r.delta_pct]), ex.comparison_view.kpis.map((r) => [r.key, r.current, r.previous, r.delta_abs, r.delta_pct]), `${JSON.stringify(p)} comparison`);
        assert.deepEqual(t.comparison.reference, { from: ex.period.previous.start, to: ex.period.previous.end });
      } else { assert.equal(t.comparison, null); assert.ok(t.completeness.reasons.some((r) => r.code === 'COMPARISON_HISTORY_INSUFFICIENT'), `${JSON.stringify(p)} says why there is no comparison`); }
    }
  } finally { await s.close(); }
});

test('SAME FIGURE, independent proof: the tool equals plain arithmetic on the raw synthetic orders (never through the engine)', async () => {
  const s = await setup();
  try {
    const t = await s.tools.call('get_sales_metrics', { period: { period: 'custom', from: '2026-07-01', to: '2026-07-31' } });
    const o = s.gen.filter((g) => g.day >= '2026-07-01' && g.day < '2026-08-01');
    assert.equal(val(t, 'order_count'), o.length); assert.equal(val(t, 'units_sold'), o.reduce((a, g) => a + g.q, 0)); assert.equal(val(t, 'gross_sales'), r2(o.reduce((a, g) => a + g.q * g.price, 0)));
    assert.equal(val(t, 'discounts'), r2(o.reduce((a, g) => a + g.disc, 0))); assert.equal(val(t, 'net_sales_ex_tax'), r2(o.reduce((a, g) => a + g.ex, 0)));
  } finally { await s.close(); }
});

test('compare_sales: for A = a period and B = its previous equivalent window it equals the engine\'s own comparison; the convention is the engine\'s (ratio, null without a baseline)', async () => {
  const s = await setup();
  try {
    const ex = (await s.api('/api/explorer?period=last_30_days')).data; const pv = ex.period.previous;
    const t = await s.tools.call('compare_sales', { periodA: { period: 'last_30_days' }, periodB: { period: 'custom', from: pv.start, to: pv.end } });
    assert.equal(t.ok, true);
    for (const k of ['net_sales_ex_tax', 'order_count', 'aov_ex_tax', 'units_sold']) {
      const mine = t.comparison.rows.find((r) => r.key === k); const theirs = ex.comparison_view.kpis.find((r) => r.key === k);
      assert.deepEqual([mine.current, mine.previous, mine.delta_abs, mine.delta_pct], [theirs.current, theirs.previous, theirs.delta_abs, theirs.delta_pct], k);
    }
    // two arbitrary periods: both sides equal the Explorer figures of each period
    const jul = await s.tools.call('compare_sales', { periodA: { period: 'custom', from: '2026-09-01', to: '2026-09-25' }, periodB: { period: 'custom', from: '2026-07-01', to: '2026-07-25' } });
    const a = (await s.api('/api/explorer?period=custom&from=2026-09-01&to=2026-09-25')).data.kpis; const b = (await s.api('/api/explorer?period=custom&from=2026-07-01&to=2026-07-25')).data.kpis;
    const row = jul.comparison.rows.find((r) => r.key === 'net_sales_ex_tax'); assert.equal(row.current, a.net_sales_ex_tax); assert.equal(row.previous, b.net_sales_ex_tax);
    assert.equal(row.delta_abs, r2(a.net_sales_ex_tax - b.net_sales_ex_tax)); assert.equal(row.delta_pct, Math.round(((a.net_sales_ex_tax - b.net_sales_ex_tax) / b.net_sales_ex_tax) * 10000) / 10000);
    assert.equal(jul.comparison.basis, 'periodB'); assert.equal(jul.comparison.reference.from, '2026-07-01');
    // no baseline: a reference period with no sales gives a null percentage, never a made-up one
    const none = await s.tools.call('compare_sales', { periodA: { period: 'last_30_days' }, periodB: { period: 'yesterday' } });
    assert.equal(none.comparison.rows.find((r) => r.key === 'net_sales_ex_tax').delta_pct, null);
  } finally { await s.close(); }
});

test('SAME FIGURE AS PRODUITS: get_top_products (revenue / units / growth / decline) and get_product_metrics equal /api/products and /api/products/detail', async () => {
  const s = await setup();
  try {
    for (const p of [{ period: 'last_30_days' }, { period: 'last_90_days' }, { period: 'custom', from: '2026-07-01', to: '2026-07-31' }]) {
      const api = (await s.api(`/api/products?${qs(p)}`)).data;
      const t = await s.tools.call('get_top_products', { period: p, limit: 20 });
      assert.equal(t.ok, true);
      assert.deepEqual(t.items.map((i) => [i.ref, i.label, i.values.find((v) => v.key === 'net_sales_ex_tax').value, i.values.find((v) => v.key === 'units_sold').value]), api.list.filter((r) => r.units_sold || r.net_sales_ex_tax).map((r) => [r.id, r.title, r.net_sales_ex_tax, r.units_sold]), 'the Produits list, minus catalogue products with no sale in the period');
      const byUnits = await s.tools.call('get_top_products', { period: p, sort: 'units', limit: 20 });
      const u = byUnits.items.map((i) => i.values.find((v) => v.key === 'units_sold').value); assert.deepEqual(u, [...u].sort((x, y) => y - x));
      const g = await s.tools.call('get_top_products', { period: p, sort: 'growth' });
      if (g.ok) assert.deepEqual(g.items.map((i) => i.label), api.growth.slice(0, 5).map((r) => r.title));
      const first = t.items[0]; const detail = (await s.api(`/api/products/detail?id=${first.ref}&${qs(p)}`)).data.product;
      const m = await s.tools.call('get_product_metrics', { productId: first.ref, period: p });
      assert.equal(m.ok, true);
      for (const k of ['net_sales_ex_tax', 'units_sold', 'share', 'revenue_per_unit', 'previous_net_sales_ex_tax']) assert.equal(val(m, k), detail[k] ?? null, `${JSON.stringify(p)} ${k}`);
    }
    const top = (await s.tools.call('get_top_products', {})).items; assert.equal(top.length, Math.min(5, (await s.api('/api/products?period=last_30_days')).data.list.length), 'default limit is 5');
  } finally { await s.close(); }
});

test('SAME FIGURE AS CLIENTS: get_customers and get_customer_metrics equal /api/customers and /api/customers/detail; only pseudonymous labels appear', async () => {
  const s = await setup();
  try {
    for (const p of [{ period: 'last_30_days' }, { period: 'last_90_days' }]) {
      const api = (await s.api(`/api/customers?${qs(p)}`)).data;
      const t = await s.tools.call('get_customers', { period: p, limit: 20 });
      assert.equal(t.ok, true);
      assert.equal(val(t, 'active_customers'), api.kpis.active); assert.equal(val(t, 'identified_share'), api.coverage.identified_share);
      const expected = api.list.filter((c) => c.active).map((c) => [c.id, c.label, c.net_sales_ex_tax, c.order_count]);
      assert.deepEqual(t.items.map((i) => [i.ref, i.label, i.values[0].value, i.values[1].value]).sort(), expected.sort());
      for (const i of t.items) assert.match(i.label, /^#[A-F0-9]{4,12}$/);
      const one = t.items[0]; const detail = (await s.api(`/api/customers/detail?id=${one.ref}&${qs(p)}`)).data.customer;
      const m = await s.tools.call('get_customer_metrics', { customerId: one.ref, period: p });
      for (const k of ['net_sales_ex_tax', 'order_count', 'aov_ex_tax', 'previous_net_sales_ex_tax', 'first_order_date', 'last_order_date', 'recency_days']) assert.equal(val(m, k), detail[k] ?? null, k);
    }
    const t = await s.tools.call('get_customers', {});
    assert.ok(t.completeness.reasons.some((r) => r.code === 'CUSTOMERS_PARTIALLY_IDENTIFIED') || t.completeness.status === 'COMPLETE');
  } finally { await s.close(); }
});

test('SAME FIGURE AS EXPLORER: get_channels and get_categories equal the Explorer lists', async () => {
  const s = await setup();
  try {
    for (const p of [{ period: 'last_30_days' }, { period: 'last_90_days' }]) {
      const ex = (await s.api(`/api/explorer?${qs(p)}`)).data;
      const ch = await s.tools.call('get_channels', { period: p });
      assert.deepEqual(ch.items.map((i) => [i.label, i.values[0].value, i.values[1].value, i.values[2].value]), ex.channels.map((c) => [c.name, c.net_sales_ex_tax, c.order_count, c.share]));
      const ca = await s.tools.call('get_categories', { period: p });
      assert.deepEqual(ca.items.map((i) => [i.label, i.values[0].value, i.values[1].value, i.values[2].value]), ex.categories.map((c) => [c.name ?? null, c.net_sales_ex_tax, c.units_sold, c.share]));
    }
  } finally { await s.close(); }
});

test('structured errors, never an estimate: UNKNOWN_TOOL, INVALID_ARGUMENT, INVALID_PERIOD, PERIOD_IN_FUTURE, INSUFFICIENT_HISTORY, NOT_FOUND, NO_DATA, DATA_UNAVAILABLE', async () => {
  const s = await setup();
  try {
    const code = (r) => { assert.equal(r.ok, false); assert.ok(r.error.message.length > 5); return r.error.code; };
    assert.equal(code(await s.tools.call('get_vat', {})), 'UNKNOWN_TOOL');
    assert.equal(code(await s.tools.call('get_top_products', { limit: 500 })), 'INVALID_ARGUMENT');
    assert.equal(code(await s.tools.call('get_top_products', { sort: 'cheapest' })), 'INVALID_ARGUMENT');
    assert.equal(code(await s.tools.call('get_sales_metrics', { period: { period: 'next_week' } })), 'INVALID_ARGUMENT');
    assert.equal(code(await s.tools.call('get_sales_metrics', { period: { period: 'custom' } })), 'INVALID_PERIOD');
    assert.equal(code(await s.tools.call('get_sales_metrics', { period: { period: 'custom', from: '2026-09-01', to: '2026-12-31' } })), 'PERIOD_IN_FUTURE');
    const early = await s.tools.call('get_sales_metrics', { period: { period: 'custom', from: '2026-01-01', to: '2026-05-31' } });
    assert.equal(code(early), 'INSUFFICIENT_HISTORY'); assert.equal(early.historyStart, '2026-06-12');
    assert.equal(code(await s.tools.call('compare_sales', { periodA: { period: 'last_30_days' }, periodB: { period: 'custom', from: '2026-01-01', to: '2026-05-31' } })), 'INSUFFICIENT_HISTORY');
    assert.equal(code(await s.tools.call('get_product_metrics', { productId: '99999999-9999-4999-8999-999999999999' })), 'NOT_FOUND');
    assert.equal(code(await s.tools.call('get_product_metrics', { productId: 'not-an-id' })), 'INVALID_ARGUMENT');
    assert.equal(code(await s.tools.call('get_customer_metrics', { customerId: 'ABCD1234' })), 'NOT_FOUND');
    for (const name of ['get_top_products', 'get_customers', 'get_channels', 'get_categories']) assert.equal(code(await s.tools.call(name, { period: { period: 'yesterday' } })), 'NO_DATA', `${name}: no sales yesterday -> NO_DATA, not an empty guess`);
    const y = await s.tools.call('get_sales_metrics', { period: { period: 'yesterday' } }); assert.equal(y.ok, true); assert.equal(val(y, 'order_count'), 0, 'zero sales is a real answer, not an error');
    const empty = createToolLayer({ reportsDir: await mkdtemp(path.join(tmpdir(), 'empty-')), now: () => NOW });
    resetPeriodCache(); assert.equal(code(await empty.call('get_sales_metrics', {})), 'DATA_UNAVAILABLE');
  } finally { await s.close(); }
});

test('completeness is explicit: today is partial, history before the business started is flagged, missing comparison says why, costs are never estimated', async () => {
  const s = await setup();
  try {
    const m = await s.tools.call('get_sales_metrics', { period: { period: 'this_month' } });
    assert.equal(m.completeness.status, 'PARTIAL'); assert.ok(m.completeness.reasons.some((r) => r.code === 'PERIOD_INCLUDES_TODAY')); assert.equal(m.freshness.includesToday, true);
    const start = await s.tools.call('get_sales_metrics', { period: { period: 'custom', from: '2026-06-01', to: '2026-06-20' } });
    const r = start.completeness.reasons.find((x) => x.code === 'PERIOD_STARTS_BEFORE_HISTORY'); assert.ok(r); assert.equal(r.detail.historyStart, '2026-06-12');
    const noCmp = await s.tools.call('get_sales_metrics', { period: { period: 'last_90_days' } });
    assert.equal(noCmp.comparison, null); assert.ok(noCmp.completeness.reasons.some((x) => x.code === 'COMPARISON_HISTORY_INSUFFICIENT' && x.detail.sufficient === false));
    const ok = await s.tools.call('get_sales_metrics', { period: { period: 'last_30_days' } });
    assert.notEqual(ok.comparison, null); assert.equal(ok.comparison.basis, 'previous_equivalent_period');
    // a value the engine cannot give is reported missing, never invented
    const gp = ok.values.find((v) => v.key === 'gross_profit');
    if (gp) assert.ok(typeof gp.value === 'number'); else assert.deepEqual(ok.completeness.missing, ['gross_profit', 'gross_margin']);
    const stale = createToolLayer({ reportsDir: s.dir, now: () => new Date('2026-09-27T09:00:00Z') });
    assert.equal((await stale.call('get_sales_metrics', {})).freshness.stale, true, 'data older than the threshold is flagged stale');
  } finally { await s.close(); }
});

test('privacy: results carry aggregated facts and pseudonymous ids only; sanitize drops forbidden fields and redacts e-mails, IBANs and phone numbers', async () => {
  const s = await setup();
  try {
    for (const [name, args] of [['get_customers', { limit: 20 }], ['get_top_products', { limit: 20 }], ['get_sales_metrics', {}]]) {
      const json = JSON.stringify(await s.tools.call(name, args));
      assert.ok(!/[a-e]{64}/.test(json), 'no customer key'); assert.ok(!/@[\w-]+\./.test(json), 'no e-mail'); assert.ok(!/customer_key|"email"|"phone"|"address"|"iban"/i.test(json));
    }
    const { value, redactions } = sanitize({ label: 'Widget', note: 'write to jean.dupont@example.com', bank: 'BE68 5390 0754 7034', tel: '+32 470 12 34 56', email: 'x@y.be', nested: [{ customer_key: 'abc', ok: 1, phoneText: 'call +32 81 12 34 56' }], safe: 'Coque iPhone 15 Pro Max 25 EUR' });
    assert.equal(value.note, 'write to [redacted]'); assert.equal(value.bank, '[redacted]'); assert.ok(!('tel' in value) && !('email' in value)); assert.ok(!('customer_key' in value.nested[0])); assert.equal(value.nested[0].phoneText, 'call [redacted]');
    assert.equal(value.safe, 'Coque iPhone 15 Pro Max 25 EUR', 'ordinary product names are untouched'); assert.equal(value.label, 'Widget'); assert.ok(redactions >= 6);
  } finally { await s.close(); }
});

test('input validation subset behaves: required, enums, integer bounds, additionalProperties:false, patterns', () => {
  const sch = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] }, n: { type: 'integer', minimum: 1, maximum: 3 }, id: { type: 'string', pattern: '^[0-9]{2}$' } } };
  assert.equal(validate(sch, { a: 'x', n: 2, id: '12' }), null);
  assert.match(validate(sch, {}), /required/); assert.match(validate(sch, { a: 'z' }), /one of/); assert.match(validate(sch, { a: 'x', n: 0 }), />= 1/); assert.match(validate(sch, { a: 'x', n: 1.5 }), /integer/);
  assert.match(validate(sch, { a: 'x', extra: 1 }), /not allowed/); assert.match(validate(sch, { a: 'x', id: 'zz' }), /format/); assert.match(validate(sch, 'nope'), /object/);
});

test('the existing assistant and /api/ask are untouched: the keyword fallback still answers, the tool layer is only reachable through the optional AI orchestrator', async () => {
  const s = await setup();
  try {
    const src = readFileSync(new URL('../src/analytics-premium/server/assistant.js', import.meta.url), 'utf8');
    assert.match(src, /aiProvider \? createOrchestrator\(/, 'the tool layer is only reached through the optional AI orchestrator (Phase 2); without an aiProvider the keyword path runs alone');
    const ask = createAssistant({ reportsDir: s.dir, now: () => NOW });
    const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: s.dir, now: () => NOW, ask })); await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const post = async (question) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) }); return { status: r.status, data: await r.json() }; };
      const a = await post('Combien de commandes ces 30 derniers jours ?'); assert.equal(a.status, 200);
      const t = await s.tools.call('get_sales_metrics', { period: { period: 'last_30_days' } });
      assert.equal(a.data.figures.find((f) => f.id === 'order_count').value, val(t, 'order_count'), 'the fallback and the tool layer give the same figure');
      assert.equal((await post('zzz qqq')).status, 422, 'a question outside the keywords is still refused by the fallback');
    } finally { await new Promise((r) => server.close(r)); }
  } finally { await s.close(); }
});
