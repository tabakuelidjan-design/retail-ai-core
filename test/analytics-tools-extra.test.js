import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { resetPeriodCache } from '../src/analytics-premium/server/period-engine.js';
import { createToolLayer } from '../src/analytics-premium/server/tools/index.js';
import { searchCatalog } from '../src/analytics-premium/server/tools/analytics-tools-extra.js';
import { createOrchestrator } from '../src/analytics-premium/server/ai/orchestrator.js';
import { NOW, TZ, writeDataset } from './fixtures/analytics-dataset.js';
import { createFakeProvider } from './fixtures/fake-ai-provider.js';

// Phase 5 tools: get_discounts, get_refunds, get_shipping, get_vat, find_product. SYNTHETIC data. Same proof as Phase 1: same figure as Explorer, and as plain
// arithmetic on the raw orders.

const IDLE = '44444444-4444-4444-8444-444444444444';
const WIDGET = '11111111-1111-4111-8111-111111111111';
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const localDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

async function setup() {
  resetPeriodCache(); const dir = await writeDataset();
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir, now: () => NOW })); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; const api = async (p) => (await (await fetch(`http://127.0.0.1:${port}${p}`)).json());
  const raw = JSON.parse(readFileSync(path.join(dir, 'dataset.json'), 'utf8')).data;
  return { dir, api, raw, tools: createToolLayer({ reportsDir: dir, now: () => NOW }), close: () => new Promise((r) => server.close(r)) };
}
const qs = (p) => (p.period === 'custom' ? `period=custom&from=${p.from}&to=${p.to}` : `period=${p.period}`);
const val = (r, k) => r.values.find((v) => v.key === k)?.value;
const PERIODS = [{ period: 'last_30_days' }, { period: 'last_90_days' }, { period: 'previous_month' }, { period: 'this_month' }, { period: 'custom', from: '2026-08-01', to: '2026-08-31' }, { period: 'custom', from: '2026-07-01', to: '2026-07-31' }];

test('catalog: the five Phase 5 tools exist with strict schemas, and compareTo is optional', async () => {
  const s = await setup(); try {
    const cat = s.tools.catalog(); const byName = Object.fromEntries(cat.map((t) => [t.name, t]));
    for (const n of ['get_discounts', 'get_refunds', 'get_shipping', 'get_vat']) { assert.ok(byName[n], n); assert.equal(byName[n].inputSchema.additionalProperties, false); assert.deepEqual(Object.keys(byName[n].inputSchema.properties).sort(), ['compareTo', 'period']); assert.equal(byName[n].inputSchema.required, undefined); }
    assert.deepEqual(byName.find_product.inputSchema.required, ['query']); assert.equal(byName.find_product.inputSchema.properties.query.minLength, 2);
    assert.equal(cat.length, 13);
  } finally { await s.close(); }
});

test('the extra tools compute nothing: they import only the period engine (catalogue), the Produits read layer, the engine\'s own pct/absDelta and the shared tool code', () => {
  const src = readFileSync(new URL('../src/analytics-premium/server/tools/analytics-tools-extra.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../../../report/explorer.js', '../period-engine.js', '../products.js', './analytics-tools.js', './contract.js']);
  assert.ok(!/computeSalesMetrics\(|buildLedger\(|buildExplorer\(|windowFacts\(|aggregate\(|\bfetch\(/.test(src));
});

test('SAME FIGURE AS EXPLORER: get_discounts, get_refunds, get_shipping and get_vat equal /api/explorer on 6 periods', async () => {
  const s = await setup(); try {
    for (const p of PERIODS) {
      const ex = (await s.api(`/api/explorer?${qs(p)}`)).kpis; const period = p;
      const d = await s.tools.call('get_discounts', { period }); assert.equal(d.ok, true, JSON.stringify(p));
      assert.equal(val(d, 'discounts'), ex.discounts, `${JSON.stringify(p)} discounts`); assert.equal(val(d, 'gross_sales'), ex.gross_sales); assert.equal(val(d, 'net_sales_ex_tax'), ex.net_sales_ex_tax);
      const r = await s.tools.call('get_refunds', { period }); assert.equal(val(r, 'refunds_products'), ex.refunds, `${JSON.stringify(p)} refunds`);
      assert.equal(val(r, 'refunds_total'), r2(ex.refunds + ex.shipping.refunds_incl_tax), 'products + shipping refunds (no other refunds in this data)');
      const sh = await s.tools.call('get_shipping', { period }); const x = ex.shipping;
      for (const [key, field] of [['shipping_orders', 'orders_with_shipping'], ['shipping_charged_incl_tax', 'charged_incl_tax'], ['shipping_net_ex_tax', 'net_ex_tax'], ['shipping_refunds_incl_tax', 'refunds_incl_tax'], ['shipping_net_ex_tax_after_refunds', 'net_ex_tax_after_refunds'], ['shipping_tax_after_refunds', 'tax_after_refunds'], ['shipping_orders_without_data', 'orders_without_shipping_data']]) assert.equal(val(sh, key), x[field], `${JSON.stringify(p)} ${key}`);
      const v = await s.tools.call('get_vat', { period }); assert.equal(val(v, 'vat_products'), ex.tax, `${JSON.stringify(p)} vat`); assert.equal(val(v, 'vat_shipping'), x.tax_after_refunds);
      assert.equal(val(v, 'vat_total'), r2(ex.tax + x.tax_after_refunds)); assert.equal(val(v, 'net_sales_ex_tax_with_shipping'), ex.total_net_sales_ex_tax_with_shipping);
      assert.equal(d.period.from, (await s.api(`/api/explorer?${qs(p)}`)).period.start);
    }
  } finally { await s.close(); }
});

test('SAME FIGURE, independent proof: discounts, refunds and VAT equal plain arithmetic on the raw synthetic orders', async () => {
  const s = await setup(); try {
    const within = (from, to) => s.raw.orders.filter((o) => { const d = localDay(o.ordered_at); return d >= from && d <= to; });
    for (const [from, to, refund] of [['2026-07-01', '2026-07-31', 0], ['2026-08-01', '2026-08-31', 10]]) {
      const ids = new Set(within(from, to).map((o) => o.id)); const lines = s.raw.orderLines.filter((l) => ids.has(l.order_id));
      const p = { period: 'custom', from, to };
      assert.equal(val(await s.tools.call('get_discounts', { period: p }), 'discounts'), r2(lines.reduce((a, l) => a + l.discount_amount, 0)), `discounts ${from}`);
      assert.equal(val(await s.tools.call('get_refunds', { period: p }), 'refunds_products'), refund, `refunds ${from}`);
      const vat = await s.tools.call('get_vat', { period: p }); assert.equal(val(vat, 'vat_products'), r2(lines.reduce((a, l) => a + l.tax_amount, 0) - (refund ? 1.74 : 0)), `vat ${from}`);
    }
  } finally { await s.close(); }
});

test('compareTo: both periods\' figures and their differences with the engine\'s convention (ratio, null without a baseline); each side equals the tool called alone', async () => {
  const s = await setup(); try {
    const a = { period: 'custom', from: '2026-08-01', to: '2026-08-31' }; const b = { period: 'custom', from: '2026-07-01', to: '2026-07-31' };
    const cmp = await s.tools.call('get_refunds', { period: a, compareTo: b }); assert.equal(cmp.ok, true); assert.equal(cmp.comparison.basis, 'compareTo'); assert.equal(cmp.comparison.reference.from, '2026-07-01');
    const alone = await s.tools.call('get_refunds', { period: b });
    const row = cmp.comparison.rows.find((r) => r.key === 'refunds_products'); assert.equal(row.current, 10); assert.equal(row.previous, val(alone, 'refunds_products')); assert.equal(row.delta_abs, 10); assert.equal(row.delta_pct, null, 'no baseline: no invented percentage');
    const disc = await s.tools.call('get_discounts', { period: a, compareTo: b }); const dr = disc.comparison.rows.find((r) => r.key === 'discounts');
    assert.equal(dr.previous, val(await s.tools.call('get_discounts', { period: b }), 'discounts')); assert.equal(dr.delta_abs, r2(dr.current - dr.previous)); assert.equal(dr.delta_pct, Math.round(((dr.current - dr.previous) / dr.previous) * 10000) / 10000);
    assert.equal((await s.tools.call('get_vat', { period: a })).comparison, null, 'no compareTo, no comparison');
    const early = await s.tools.call('get_discounts', { period: a, compareTo: { period: 'custom', from: '2026-01-01', to: '2026-03-01' } });
    assert.equal(early.ok, false); assert.equal(early.error.code, 'INSUFFICIENT_HISTORY'); assert.equal(early.which, 'compareTo');
  } finally { await s.close(); }
});

test('shipping is only as complete as the orders\' shipping data: the engine\'s partial coverage becomes SHIPPING_DATA_PARTIAL (and VAT says so too)', async () => {
  const s = await setup(); try {
    for (const name of ['get_shipping', 'get_vat']) {
      const r = await s.tools.call(name, {}); const reason = r.completeness.reasons.find((x) => x.code === 'SHIPPING_DATA_PARTIAL');
      assert.ok(reason, name); assert.equal(reason.detail.ordersWithoutShippingData, 15); assert.equal(r.completeness.status, 'PARTIAL');
    }
    assert.equal((await s.tools.call('get_discounts', {})).completeness.reasons.some((x) => x.code === 'SHIPPING_DATA_PARTIAL'), false, 'a discounts answer is not flagged for shipping');
  } finally { await s.close(); }
});

test('find_product tells "no such product" from "the product exists but has no sale in the period" from "sold in the period"', async () => {
  const s = await setup(); try {
    const sold = await s.tools.call('find_product', { query: 'fixture widget' });
    assert.equal(sold.ok, true); assert.deepEqual(sold.items.map((i) => [i.ref, i.label, i.status]), [[WIDGET, 'Fixture Widget', 'SOLD_IN_PERIOD']]);
    const products = await s.api('/api/products?period=last_30_days'); const row = products.list.find((r) => r.id === WIDGET);
    assert.equal(sold.items[0].values.find((v) => v.key === 'net_sales_ex_tax').value, row.net_sales_ex_tax, 'same figure as Produits'); assert.equal(sold.items[0].values.find((v) => v.key === 'units_sold').value, row.units_sold);
    assert.equal(sold.completeness.reasons.some((r) => r.code === 'PRODUCT_HAS_NO_SALES_IN_PERIOD'), false);
    const idle = await s.tools.call('find_product', { query: 'FIXTURE   idle' });
    assert.equal(idle.ok, true); assert.deepEqual(idle.items.map((i) => [i.ref, i.status, i.values.length]), [[IDLE, 'NO_SALES_IN_PERIOD', 0]]);
    assert.ok(idle.completeness.reasons.some((r) => r.code === 'PRODUCT_HAS_NO_SALES_IN_PERIOD' && r.detail.count === 1));
    const none = await s.tools.call('find_product', { query: 'licorne volante' });
    assert.equal(none.ok, false); assert.equal(none.error.code, 'NOT_FOUND'); assert.equal(none.reason, 'NOT_IN_CATALOG'); assert.match(none.error.message, /catalogue/);
    const many = await s.tools.call('find_product', { query: 'fixture', limit: 2 }); assert.equal(many.items.length, 2); assert.equal(val(many, 'matches'), 4); assert.equal(val(many, 'items_returned'), 2);
    assert.equal((await s.tools.call('find_product', { query: 'x' })).error.code, 'INVALID_ARGUMENT'); assert.equal((await s.tools.call('find_product', {})).error.code, 'INVALID_ARGUMENT');
    // the same distinction from get_product_metrics
    const idleMetrics = await s.tools.call('get_product_metrics', { productId: IDLE }); assert.equal(idleMetrics.error.code, 'NOT_FOUND'); assert.equal(idleMetrics.reason, 'NO_SALES_IN_PERIOD');
    assert.equal((await s.tools.call('get_product_metrics', { productId: '99999999-9999-4999-8999-999999999999' })).reason, 'UNKNOWN_PRODUCT');
    // a product that did not sell in one period but sold in another
    const wPeriod = await s.tools.call('find_product', { query: 'widget', period: { period: 'yesterday' } }); assert.equal(wPeriod.items[0].status, 'NO_SALES_IN_PERIOD', 'yesterday: no sale');
  } finally { await s.close(); }
});

test('catalogue search: accents, case, word order, prefix ranking, handle fallback', () => {
  const products = [{ id: 'a', title: 'Coque personnalisée – Samsung Galaxy A54', handle: 'coque-samsung-a54' }, { id: 'b', title: 'Écouteurs Bluetooth', handle: 'ecouteurs-bluetooth' }, { id: 'c', title: 'Gourde isotherme', handle: 'bouteille-thermos' }, { id: 'd', title: 'Écouteurs', handle: 'ecouteurs' }];
  assert.deepEqual(searchCatalog(products, 'ecouteurs').map((p) => p.id), ['d', 'b'], 'the exact title ranks first');
  assert.deepEqual(searchCatalog(products, 'GALAXY samsung').map((p) => p.id), ['a']); assert.deepEqual(searchCatalog(products, 'thermos').map((p) => p.id), ['c'], 'the handle is searched too');
  assert.deepEqual(searchCatalog(products, 'licorne'), []); assert.deepEqual(searchCatalog(products, '  '), []); assert.deepEqual(searchCatalog(products, 'coque personnalisee').map((p) => p.id), ['a']);
});

test('orchestrator: a missing product is an honest refusal with its reason, an unsold one is a limitation; nothing personal in results', async () => {
  resetPeriodCache(); const dir = await writeDataset({ dirty: true }); const provider = createFakeProvider({ planner: ({ question }) => ({ toolCalls: [{ tool: 'find_product', args: { query: question } }] }) });
  const ask = createOrchestrator({ provider, tools: createToolLayer({ reportsDir: dir, now: () => NOW }), timeoutMs: 400 });
  const none = await ask({ question: 'licorne volante' });
  assert.equal(none.status, 'CANNOT_ANSWER'); assert.equal(none.reason, 'NO_DATA'); assert.deepEqual(none.limitations.map((l) => [l.code, l.params.reason, l.severity]), [['NOT_FOUND', 'NOT_IN_CATALOG', 'blocking']]);
  const idle = await ask({ question: 'fixture idle' }); assert.equal(idle.status, 'OK'); assert.ok(idle.limitations.some((l) => l.code === 'PRODUCT_HAS_NO_SALES_IN_PERIOD' && l.severity === 'info' && l.params.count === 1));
  assert.ok(idle.summary.calls[0].items.some((i) => i.status === 'NO_SALES_IN_PERIOD'));
  const gadget = await ask({ question: 'fixture gadget' }); assert.ok(!JSON.stringify(gadget).includes('jean.dupont'), 'a product title carrying an e-mail is redacted in the result');
});
