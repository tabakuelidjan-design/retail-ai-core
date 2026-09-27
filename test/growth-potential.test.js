// Growth > Potentiel produits: decision engine (business cases + honest states), payload, tenant isolation, route, UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mergeConfig } from '../src/metrics/config.js';
import { classifyProduct, buildProductPotential, marginTier, stockState, STATUSES, FILTERS, WATCH_GROUP } from '../src/growth/products/potential.js';
import { productPotentialFacts } from '../src/growth/products/facts.js';
import { createProductPotentialSource } from '../src/growth/server/products.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { makeDemandData, NOW, TZ, CONFIG } from './fixtures/demand-sample.js';
import { growthDom, potentialPayload, all, text, hasClass, title, navState } from './growth-dom.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const cfg = mergeConfig();

/** One product's merged facts: by default a product that deserves a push (rising, covered, verified cost, no refunds). */
function fact(over = {}) {
  return {
    key: 'p1', title: 'Produit test', imageUrl: null, category: 'Cat', matched: true,
    units: 20, netSales: 400, evolution: 1.3333, observableWeeks: 8, velocity8: 2.5,
    trend: { direction: 'UP', recent_units: 14, prior_units: 6, weeks_each_side: 4 },
    inventory: { stock_quality: 'UNVERIFIED', stock_units: 40, snapshot_at: '2026-09-21T06:00:00Z' },
    cover: { status: 'CALCULATED', weeks: 16, days: 112 },
    grossProfit: { status: 'CALCULATED', cost_confidence: 'VERIFIED', margin_pct: 0.5 },
    refundRate: 0, unitsRefunded: 0, topRank: 20,
    ...over,
  };
}
const classify = (over) => classifyProduct(fact(over), cfg);
const build = (facts) => buildProductPotential(facts, { config: cfg, currency: 'EUR', window: { start: '2026-07-27T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z', weeks: 8, historyDays: 400 }, dataQuality: {} });

// ---------- mandatory business cases ----------
test('potential case 1: strong growth + sufficient stock + reliable costs -> À pousser (increase visibility)', () => {
  const c = classify();
  assert.equal(c.status, 'push');
  assert.equal(c.action, 'increaseVisibility');
  assert.deepEqual(c.reasons, []);
});

test('potential case 2: strong growth (or a best seller) with a short cover -> Réassort avant promotion, never À pousser', () => {
  const c = classify({ cover: { status: 'CALCULATED', weeks: 0.7, days: 5 } });
  assert.equal(c.status, 'restock');
  assert.equal(c.action, 'restockFirst');
  assert.equal(c.rule, 'DEMAND_BUT_LOW_COVER');
  // A best seller without a rising trend and ~5 days of stock: restock before any promotion as well.
  const top = classify({ trend: { direction: 'FLAT', recent_units: 10, prior_units: 10, weeks_each_side: 4 }, evolution: 0, topRank: 1, cover: { status: 'CALCULATED', weeks: 0.7, days: 5 } });
  assert.equal(top.status, 'restock');
  // Known stock of 0 with good demand: out of stock, restock first.
  const out = classify({ inventory: { stock_quality: 'UNVERIFIED', stock_units: 0 }, cover: { status: 'NO_STOCK', weeks: null, days: null } });
  assert.equal(out.status, 'restock');
  assert.equal(out.rule, 'DEMAND_BUT_OUT_OF_STOCK');
});

test('potential case 3: high sales with a reliable margin below the threshold -> Marge faible, not À pousser', () => {
  const thin = { status: 'CALCULATED', cost_confidence: 'VERIFIED', margin_pct: 0.08 };
  const best = classify({ topRank: 1, netSales: 9000, units: 300, grossProfit: thin });
  assert.equal(best.status, 'lowMargin');
  assert.equal(best.action, 'doNotPromote');
  assert.notEqual(classify({ grossProfit: thin }).status, 'push', 'rising demand does not override a thin reliable margin');
  // The threshold is the merchant's configuration (cashRisk.lowMarginPct), not a constant of this page.
  assert.equal(classifyProduct(fact({ grossProfit: thin }), mergeConfig({ cashRisk: { lowMarginPct: 0.05 } })).status, 'push');
});

test('potential case 4: strong growth + too many refunds -> À surveiller (review returns); without demand -> Trop de retours', () => {
  const c = classify({ refundRate: 0.3, unitsRefunded: 6 });
  assert.equal(c.status, 'watch');
  assert.equal(c.action, 'reviewReturns');
  assert.ok(c.reasons.includes('HIGH_RETURNS'));
  const r = classify({ trend: { direction: 'FLAT', recent_units: 10, prior_units: 10, weeks_each_side: 4 }, evolution: 0, refundRate: 0.3, unitsRefunded: 6 });
  assert.equal(r.status, 'returns');
  assert.equal(r.action, 'doNotPromote');
  // Refunds above the push limit but below the "high" level: rising demand is still not pushed.
  const e = classify({ refundRate: 0.15, unitsRefunded: 3 });
  assert.equal(e.status, 'watch');
  assert.equal(e.action, 'reviewReturns');
});

test('potential case 5: insufficient data -> no strong recommendation', () => {
  const young = classify({ observableWeeks: 2 });
  assert.equal(young.status, 'insufficient');
  assert.equal(young.action, 'none');
  assert.equal(young.rule, 'NEW_PRODUCT');
  const thin = classify({ units: 2 });
  assert.equal(thin.status, 'insufficient');
  assert.equal(thin.rule, 'THIN_SAMPLE');
  // Even with every other signal favourable, nothing is pushed on thin evidence.
  const p = build([fact({ units: 2 })]);
  assert.equal(p.kpis.push, 0);
  assert.equal(p.rows[0].opportunity, null);
});

// ---------- honest states: unknown is never 0 ----------
test('potential states: no cost -> Coût manquant, margin unknown (null, never 0 %), rising demand says "check the cost"', () => {
  const c = classify({ grossProfit: { status: 'UNCLASSIFIED', cost_confidence: 'NONE', margin_pct: null } });
  assert.equal(c.marginTier, 'MISSING');
  assert.equal(c.marginPct, null);
  assert.equal(c.status, 'watch');
  assert.equal(c.action, 'checkCost');
  assert.ok(c.reasons.includes('COST_MISSING'));
  assert.equal(marginTier(null), 'MISSING');
  const row = build([fact({ grossProfit: null })]).rows[0];
  assert.deepEqual(row.margin, { tier: 'MISSING', pct: null });
});

test('potential states: partial or unverified costs -> Marge partielle / Coût non vérifié, never À pousser', () => {
  const partial = classify({ grossProfit: { status: 'PARTIAL', cost_confidence: 'VERIFIED', margin_pct: 0.5 } });
  assert.equal(partial.marginTier, 'PARTIAL');
  assert.equal(partial.status, 'watch');
  assert.ok(partial.reasons.includes('MARGIN_PARTIAL'));
  const unverified = classify({ grossProfit: { status: 'CALCULATED', cost_confidence: 'UNVERIFIED', margin_pct: 0.5 } });
  assert.equal(unverified.marginTier, 'UNVERIFIED');
  assert.equal(unverified.action, 'checkCost');
  // A thin margin computed from unverified costs is not called "Marge faible" (the cost itself is not trusted).
  assert.notEqual(classify({ grossProfit: { status: 'CALCULATED', cost_confidence: 'UNVERIFIED', margin_pct: 0.05 } }).status, 'lowMargin');
});

test('potential states: no stock data or a stale snapshot -> Stock indisponible (unknown, not 0), no cover, no restock claim', () => {
  for (const q of ['NO_STOCK_DATA', 'STALE', 'UNRELIABLE_NEGATIVE']) {
    const inv = { stock_quality: q, stock_units: q === 'NO_STOCK_DATA' ? null : 3, snapshot_at: q === 'STALE' ? '2026-01-01T00:00:00Z' : null };
    assert.deepEqual(stockState(inv), { usable: false, quality: q, units: null });
    const c = classify({ inventory: inv, cover: { status: 'CALCULATED', weeks: 0.5, days: 3 } });
    assert.notEqual(c.status, 'restock', `${q}: a stock we cannot trust never triggers "restock"`);
    assert.notEqual(c.status, 'push', `${q}: never pushed without a known stock`);
    assert.equal(c.action, 'checkStock');
    const row = build([fact({ inventory: inv, cover: { status: 'CALCULATED', weeks: 0.5, days: 3 } })]).rows[0];
    assert.deepEqual(row.cover, { status: 'STOCK_UNUSABLE', days: null, weeks: null }, 'cover from an unusable stock is not shown');
    assert.equal(row.stock.units, null);
  }
});

test('potential states: low stock, declining, top seller, stable, product without image, new product without history', () => {
  assert.equal(classify({ inventory: { stock_quality: 'UNVERIFIED', stock_units: 3 }, cover: { status: 'CALCULATED', weeks: 1.2, days: 8 } }).status, 'restock');
  const down = classify({ trend: { direction: 'DOWN', recent_units: 3, prior_units: 12, weeks_each_side: 4 }, evolution: -0.75 });
  assert.equal(down.status, 'declining');
  assert.equal(down.action, 'watch');
  const flat = { trend: { direction: 'FLAT', recent_units: 10, prior_units: 10, weeks_each_side: 4 }, evolution: 0 };
  assert.equal(classify({ ...flat, topRank: 2 }).status, 'topSeller');
  assert.equal(classify({ ...flat, topRank: 2 }).action, 'keep');
  assert.equal(classify(flat).status, 'stable');
  const p = build([fact({ key: 'img', imageUrl: null }), fact({ key: 'new', observableWeeks: 1, trend: { direction: 'INSUFFICIENT_DATA' }, evolution: null })]);
  assert.equal(p.rows.find((r) => r.id === 'img').imageUrl, null);
  const young = p.rows.find((r) => r.id === 'new');
  assert.equal(young.status, 'insufficient');
  assert.equal(young.evolution, null);
  assert.ok(young.reasons.includes('TREND_INSUFFICIENT'));
});

// ---------- payload ----------
test('potential payload: KPIs, filter counters, groups and side lists are derived from the rows only', () => {
  const facts = [
    fact({ key: 'push1', netSales: 900 }),
    fact({ key: 'push2', netSales: 800 }),
    fact({ key: 'restock', netSales: 1000, cover: { status: 'CALCULATED', weeks: 1, days: 7 } }),
    fact({ key: 'thin', netSales: 700, grossProfit: { status: 'CALCULATED', cost_confidence: 'VERIFIED', margin_pct: 0.05 }, trend: { direction: 'FLAT' }, evolution: 0 }),
    fact({ key: 'down', netSales: 100, trend: { direction: 'DOWN', recent_units: 2, prior_units: 10, weeks_each_side: 4 }, evolution: -0.8 }),
    fact({ key: 'new', netSales: 50, observableWeeks: 1 }),
    fact({ key: 'nosale', units: 0, netSales: 0 }),
  ];
  const p = build(facts);
  assert.equal(p.rows.length, 6, 'a product with no unit sold in the window is not active');
  assert.deepEqual(p.rows.map((r) => r.id), ['restock', 'push1', 'push2', 'thin', 'down', 'new'], 'ranked by net sales');
  assert.deepEqual(p.kpis, { activeProducts: 6, push: 2, watch: 2, restock: 1 });
  assert.deepEqual(Object.keys(p.filters), FILTERS);
  for (const k of FILTERS) assert.equal(p.filters[k], p.rows.filter((r) => r.filters.includes(k)).length, k);
  assert.equal(p.filters.watch, p.rows.filter((r) => WATCH_GROUP.includes(r.status)).length);
  assert.deepEqual(p.toPush.map((r) => r.id), ['push1', 'push2']);
  assert.deepEqual(p.toProtect.map((r) => r.status), ['restock', 'lowMargin', 'declining']);
  assert.equal(p.byStatus.reduce((a, s) => a + s.count, 0), p.rows.length);
  for (const s of p.byStatus) assert.ok(STATUSES.includes(s.status));
  assert.equal(p.totals.pushShare, Math.round((1700 / 3550) * 10000) / 10000);
  assert.deepEqual(p.rows.find((r) => r.id === 'push1').opportunity, { kind: 'productVisibility', productId: 'push1' });
  assert.deepEqual(p.rows.find((r) => r.id === 'restock').opportunity, { kind: 'productRestock', productId: 'restock' });
  assert.equal(p.rows.find((r) => r.id === 'thin').opportunity, null);
});

test('potential payload: empty dataset -> zero active products, empty lists, no share, no invented row', () => {
  const p = build([]);
  assert.deepEqual(p.kpis, { activeProducts: 0, push: 0, watch: 0, restock: 0 });
  assert.deepEqual(p.rows, []);
  assert.deepEqual(p.toPush, []);
  assert.deepEqual(p.byStatus, []);
  assert.equal(p.totals.pushShare, null);
});

test('potential facts: synthetic 8-week dataset through the existing demand + product-performance engines', () => {
  const f = productPotentialFacts({ data: makeDemandData(), now: NOW, timeZone: TZ, config: CONFIG });
  const p = buildProductPotential(f.facts, { config: CONFIG, currency: f.currency, window: f.window, dataQuality: f.dataQuality });
  const by = Object.fromEntries(p.rows.map((r) => [r.title, r]));
  assert.equal(p.window.weeks, 8);
  assert.equal(p.rows.length, 7, 'the 2 products without sales are not active');
  assert.equal(by.Steady.status, 'topSeller', 'steady best seller, verified cost, enough cover');
  assert.equal(by.Spike.status, 'restock', 'demand up, 2 units left (< 4 weeks of cover)');
  assert.equal(by.Rising.status, 'watch');
  assert.equal(by.Rising.action, 'checkCost', 'rising demand but the cost is unverified: not pushed');
  assert.equal(by.Rising.evolution, 4);
  assert.equal(by.Falling.status, 'declining');
  assert.equal(by.New.status, 'insufficient');
  assert.equal(by.New.category, null, 'no product type -> no category (never invented)');
  assert.deepEqual(by.New.margin, { tier: 'MISSING', pct: null });
  assert.equal(p.dataQuality.salesReconciledWithSource, false);
});

// ---------- tenant isolation ----------
async function seedTwoMerchants() {
  const supabase = createFakeSupabase();
  const [A, B] = [randomUUID(), randomUUID()];
  const now = new Date('2026-09-21T09:00:00Z');
  for (const [m, tag] of [[A, 'Alpha'], [B, 'Beta']]) {
    const productId = randomUUID(); const variantId = randomUUID();
    await supabase.insert('products', [{ id: productId, merchant_id: m, title: `${tag} product`, product_type: tag, source_system: 'shopify', source_id: `${tag}-p`, source_created_at: '2026-01-01T00:00:00Z' }]);
    await supabase.insert('variants', [{ id: variantId, merchant_id: m, product_id: productId, sku: `${tag}-SKU`, title: 'Default', source_system: 'shopify', source_id: `${tag}-v` }]);
    for (let w = 0; w < 8; w += 1) {
      const orderId = randomUUID();
      await supabase.insert('orders', [{ id: orderId, merchant_id: m, source_system: 'shopify', source_id: `${tag}-o${w}`, ordered_at: new Date(Date.UTC(2026, 6, 28) + w * 7 * 86400000).toISOString(), currency: 'EUR', status: 'PAID', taxes_included: true, is_test: false }]);
      await supabase.insert('order_lines', [{ id: randomUUID(), order_id: orderId, merchant_id: m, variant_id: variantId, source_system: 'shopify', source_id: `${tag}-l${w}`, title_snapshot: tag, quantity: 2, unit_price: 10, discount_amount: 0, tax_amount: 0 }]);
    }
  }
  return { supabase, A, B, now };
}

test('potential tenant: each source reads only its own merchant; the merchant is required and fixed at creation', async () => {
  const { supabase, A, B, now } = await seedTwoMerchants();
  const pa = await createProductPotentialSource({ supabase, merchantId: A, now: () => now })();
  const pb = await createProductPotentialSource({ supabase, merchantId: B, now: () => now })();
  assert.deepEqual(pa.rows.map((r) => r.title), ['Alpha product']);
  assert.deepEqual(pb.rows.map((r) => r.title), ['Beta product']);
  assert.ok(!JSON.stringify(pa).includes('Beta'), 'no data of merchant B in merchant A\'s payload');
  assert.throws(() => createProductPotentialSource({ supabase }), TypeError);
  assert.throws(() => createProductPotentialSource({ supabase, merchantId: '' }), TypeError);
});

async function serve(opts) {
  const server = http.createServer(createGrowthApp(opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('potential route: no tenant -> 503 TENANT_NOT_CONFIGURED; the request can never choose the merchant', async () => {
  const none = await serve({});
  try {
    const r = await fetch(`${none.base}/api/growth/products`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: { code: 'TENANT_NOT_CONFIGURED' } });
    assert.equal((await fetch(`${none.base}/potential.js`)).status, 200);
  } finally { await none.close(); }
  const { supabase, A, B, now } = await seedTwoMerchants();
  const calls = [];
  const source = createProductPotentialSource({ supabase, merchantId: A, now: () => now });
  const app = await serve({ productPotential: (...args) => { calls.push(args); return source(); } });
  try {
    for (const q of ['', `?merchantId=${B}`, `?merchant_id=${B}&tenant=${B}`]) {
      const d = await (await fetch(`${app.base}/api/growth/products${q}`, { headers: { 'x-merchant-id': B } })).json();
      assert.deepEqual(d.rows.map((r) => r.title), ['Alpha product'], `query "${q}" is ignored`);
    }
    assert.ok(calls.every((a) => a.length === 0), 'the route passes nothing from the request to the source');
  } finally { await app.close(); }
  const failing = await serve({ productPotential: async () => { throw new Error('db down'); } });
  const origError = console.error; console.error = () => {};
  try {
    const r = await fetch(`${failing.base}/api/growth/products`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: { code: 'DATA_UNAVAILABLE' } });
  } finally { console.error = origError; await failing.close(); }
});

// ---------- UI ----------
test('potential UI: every label exists in FR/NL/EN (incl. every status, action, reason, signal, rule); no hard-coded copy or data', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  const src = await readFile(new URL('potential.js', UI), 'utf8');
  const keys = [
    ...[...src.matchAll(/\bt\('(gr\.[\w.]+)'/g)].map((m) => m[1]),
    ...STATUSES.map((s) => `gr.pp.status.${s}`),
    ...['increaseVisibility', 'restockFirst', 'doNotPromote', 'reviewReturns', 'checkCost', 'checkStock', 'watch', 'keep', 'none'].flatMap((a) => [`gr.pp.action.${a}`, `gr.pp.actionText.${a}`]),
    ...['checkStock', 'checkCost', 'reviewReturns', 'watch'].map((a) => `gr.pp.blocked.${a}`),
    ...['COST_MISSING', 'MARGIN_PARTIAL', 'COST_UNVERIFIED', 'STOCK_STALE', 'STOCK_UNAVAILABLE', 'COVER_UNKNOWN', 'HIGH_RETURNS', 'RETURNS_ELEVATED', 'TREND_INSUFFICIENT'].map((r) => `gr.pp.reason.${r}`),
    ...['MISSING', 'PARTIAL', 'UNVERIFIED', 'RELIABLE'].map((m) => `gr.pp.margin.${m}`),
    ...['STOCK_UNUSABLE', 'INSUFFICIENT_HISTORY', 'INSUFFICIENT_SALES_SAMPLE', 'NO_DEMAND_OBSERVED', 'NO_STOCK', 'UNKNOWN'].map((c) => `gr.pp.cover.${c}`),
    ...['UP', 'DOWN', 'FLAT'].map((x) => `gr.pp.trend.${x}`),
    ...FILTERS.map((f) => `gr.pp.f.${f}`), ...['sales', 'evolution', 'cover', 'margin'].map((s) => `gr.pp.f.sort.${s}`),
    ...['product', 'sales', 'evolution', 'margin', 'stock', 'cover', 'status'].map((c) => `gr.pp.col.${c}`),
    'gr.pp.title', 'gr.pp.subtitle', 'gr.nav.potential', 'gr.period.lastWeeks', 'gr.period.weeksNote',
  ];
  for (const k of keys) for (const l of ['fr', 'nl', 'en']) assert.ok(D[l][k], `missing ${l} key ${k}`);
  const pp = (l) => Object.keys(D[l]).filter((k) => k.startsWith('gr.pp.')).sort();
  assert.deepEqual(pp('nl'), pp('fr')); assert.deepEqual(pp('en'), pp('fr'));
  // No user-facing French sentence and no product / merchant example in the page code or the engine.
  for (const f of [new URL('potential.js', UI), new URL('../src/growth/products/potential.js', import.meta.url), new URL('../src/growth/products/facts.js', import.meta.url)]) {
    const code = await readFile(f, 'utf8');
    for (const v of ['HABB', 'Namur', 'Coque', 'Gourde', 'demo', 'À pousser', 'Réassort']) assert.ok(!code.includes(v), `${f.pathname}: hard-coded "${v}"`);
  }
});

test('potential UI: renders the real payload, the nav entry is active, pills filter the rows, a row opens the detail panel', async () => {
  const { root, errors } = await growthDom('#/potential');
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Produits Potentiels');
  assert.ok(text(root).includes('Identifiez les produits à pousser, à surveiller ou à protéger selon la demande, le stock et la rentabilité.'));
  assert.deepEqual(navState(root).filter((n) => n.active).map((n) => [n.label, n.href]), [['Produits Potentiels', '#/potential']]);
  assert.ok(text(root).includes('8 dernières semaines'), 'the period pill shows the analysis window');
  assert.ok(!text(root).includes('Données de démonstration'), 'real data: no demo badge');
  assert.equal(all(root, (n) => hasClass(n, 'ex-kpi')).length, 4);
  const rows = () => all(root, (n) => hasClass(n, 'gr-pp-row'));
  const pills = () => all(root, (n) => hasClass(n, 'gr-pp-filter'));
  assert.equal(rows().length, 7);
  assert.deepEqual(pills().map((p) => text(p)), ['Tous7', 'À pousser0', 'Forte croissance2', 'Meilleures ventes7', 'À surveiller3', 'Réassort avant promotion1', 'Marge faible0', 'Données insuffisantes2']);
  pills()[5].listeners.click[0]();
  assert.deepEqual(rows().map((r) => text(r.children[0])), ['SpikeBeta · 6 unités vendues']);
  assert.ok(text(rows()[0]).includes('Réassort avant promotion'));
  assert.ok(text(rows()[0]).includes('Stock pour 19 jours seulement'));
  pills()[7].listeners.click[0]();
  assert.equal(rows().length, 2);
  // Unknown values are words, never 0: the new product has no cost and no history.
  const newRow = rows().find((r) => text(r).includes('New'));
  assert.ok(text(newRow).includes('Coût manquant'));
  assert.ok(text(newRow).includes('Historique insuffisant'));
  assert.ok(text(newRow).includes('Sans catégorie'));
  // Detail panel: why, evidence, recommended action.
  newRow.listeners.click[0]();
  const drawer = all(root, (n) => hasClass(n, 'gr-pp-drawer'))[0];
  assert.ok(drawer, 'the detail panel opens');
  for (const s of ['Pourquoi ce statut', 'Preuves (8 dernières semaines)', 'Action recommandée', 'Aucune action']) assert.ok(text(drawer).includes(s), s);
  // Empty push list explains the 4 conditions instead of showing nothing.
  assert.ok(text(all(root, (n) => hasClass(n, 'gr-pp-push'))[0]).includes('Aucun produit ne réunit aujourd’hui les quatre conditions'));
  // The close button closes the panel.
  all(root, (n) => hasClass(n, 'gr-pp-close'))[0].listeners.click[0]();
  assert.equal(all(root, (n) => hasClass(n, 'gr-pp-drawer')).length, 0);
  assert.deepEqual(errors, []);
});

test('potential UI: empty dataset and missing tenant are explicit states, not errors', async () => {
  const empty = potentialPayload({ ...makeDemandData(), orders: [], orderLines: [] });
  const a = await growthDom('#/potential', { products: empty });
  assert.deepEqual(a.errors, []);
  assert.equal(all(a.root, (n) => hasClass(n, 'gr-pp-row')).length, 0);
  assert.equal(all(a.root, (n) => hasClass(n, 'ex-kpi')).length, 4, 'KPIs still shown (all 0 = a real count on an empty window)');
  assert.ok(text(a.root).includes('Aucun produit à protéger pour l’instant.'));
  assert.ok(text(a.root).includes('Aucun produit vendu sur la période'), 'status chart: explicit empty state');
  const b = await growthDom('#/potential', { productsStatus: 503 });
  assert.deepEqual(b.errors, []);
  assert.equal(title(b.root), 'Produits Potentiels');
  assert.equal(all(b.root, (n) => hasClass(n, 'ex-kpi')).length, 0, 'no figure at all without a tenant (never demo data)');
});
