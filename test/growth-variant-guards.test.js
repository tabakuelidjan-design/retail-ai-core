// Reliability of the variant chosen for promotion (Growth). Simulated data, offline.
//  - the sales windows of the opportunity (product engine) and of the variant figures must be the same, end EXCLUDED, on the same time base; otherwise Growth stays at product level and says why;
//  - the variant's COVER uses the product engine's own computeCover and threshold (config.demand.cover.lowWeeks); an unknown / stale stock is never read as 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthApp } from '../src/growth/server/app.js';
import { prepareOpportunityAction, sameSalesWindow } from '../src/growth/priorities/actions.js';
import { variantDetailsByProduct } from '../src/growth/products/variants.js';
import { variantRowsFromDataset } from '../src/creative-autonomy/opportunity.js';
import { mergeConfig } from '../src/metrics/config.js';
import { growthDom, potentialPayload, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const CFG = mergeConfig().demand; // cover.lowWeeks = 4, cover.minUnits = 3: the product engine's thresholds
const W = { start: new Date('2026-09-19T22:00:00Z'), end: new Date('2026-11-14T23:00:00Z') }; // 8 weeks, end excluded
const PW = { start: W.start.toISOString(), end: W.end.toISOString() };
const NOW = new Date('2026-11-15T12:00:00Z');
const EXPOSURE = new Map([['p', { exposureWeeks: 8, observableWeeks: 8 }]]);
const item = { category: 'commercial', kind: 'product', entity: { id: 'p', title: 'Casque' }, title: { code: 'product.push.title' } };

// leader = "Mauve" (4 net units), runner-up = "Bleu" (1). Stocks vary per case.
function scenario({ mauveStock, mauveAt = '2026-11-14T23:00:38Z', mauveUnits = 4, bleuStock = 6, bleuAt = '2026-11-14T23:00:38Z' }) {
  const lines = [...Array(mauveUnits).keys()].map((i) => ({ id: `m${i}`, order_id: `om${i}`, variant_id: 'v-mauve', quantity: 1 })).concat([{ id: 'b0', order_id: 'ob0', variant_id: 'v-bleu', quantity: 1 }]);
  const data = { products: [{ id: 'p', source_id: 'gid://P/1', title: 'Casque' }],
    variants: [{ id: 'v-mauve', product_id: 'p', source_id: 'gid://V/1', title: 'Mauve' }, { id: 'v-bleu', product_id: 'p', source_id: 'gid://V/2', title: 'Bleu' }],
    locations: [{ id: 'L', name: 'Habb' }], orders: lines.map((l) => ({ id: l.order_id, ordered_at: '2026-10-10T10:00:00Z', is_test: false, status: 'PAID' })), orderLines: lines, refunds: [], refundLines: [],
    snapshots: [mauveStock == null ? null : { variant_id: 'v-mauve', location_id: 'L', quantity: mauveStock, synced_at: mauveAt }, bleuStock == null ? null : { variant_id: 'v-bleu', location_id: 'L', quantity: bleuStock, synced_at: bleuAt }].filter(Boolean) };
  return variantDetailsByProduct(data, { window: W, now: NOW, maxSnapshotAgeHours: 36, demandConfig: CFG, exposureByProduct: EXPOSURE });
}
const action = (v, productWindow = PW) => prepareOpportunityAction(item, { variants: v.byProduct.get('p') }, v.window, productWindow);

test('VG-1 sufficient cover: 2 units in stock for 4 net units over 8 weeks = 4 weeks of cover, exactly the product engine minimum: the variant is recommended, with its cover and its dated stock', () => {
  const a = action(scenario({ mauveStock: 2 }));
  assert.equal(a.code, 'variant'); assert.equal(a.variantReason, null);
  assert.deepEqual([a.variant.title, a.variant.unitsNet, a.variant.stockUnits, a.variant.coverWeeks, a.variant.minCoverWeeks], ['Mauve', 4, 2, 4, 4]);
  assert.equal(new Date(a.variant.stockSnapshotAt).toISOString(), '2026-11-14T23:00:38.000Z'); // the snapshot date is its own field, not a sales bound
  assert.equal(a.variant.since, W.start.toISOString()); assert.equal(a.variant.until, W.end.toISOString());
});

test('VG-2 insufficient cover: 1 unit for 4 net units = 2 weeks < 4: no variant, product level kept, reason names the variant, its weeks and the minimum', () => {
  const a = action(scenario({ mauveStock: 1 }));
  assert.equal(a.code, 'product'); assert.equal(a.variant, null);
  assert.deepEqual(a.variantReason, { code: 'COVER_LOW', title: 'Mauve', weeks: 2, minWeeks: 4 });
});

test('VG-3 stock unavailable is never 0: no snapshot or a stale one = product level (STOCK_UNVERIFIED); a sample too small to compute a cover = COVER_UNKNOWN', () => {
  assert.equal(action(scenario({ mauveStock: null })).variantReason.code, 'STOCK_UNVERIFIED');
  assert.equal(action(scenario({ mauveStock: 9, mauveAt: '2026-11-10T00:00:00Z' })).variantReason.code, 'STOCK_UNVERIFIED');
  const v = scenario({ mauveStock: 5, mauveUnits: 2 }); // 2 net units < cover.minUnits (3)
  assert.equal(v.byProduct.get('p').find((x) => x.title === 'Mauve').cover.status, 'INSUFFICIENT_SALES_SAMPLE');
  assert.deepEqual(action(v).variantReason, { code: 'COVER_UNKNOWN', title: 'Mauve', status: 'INSUFFICIENT_SALES_SAMPLE' });
  const stale = scenario({ mauveStock: 9, mauveAt: '2026-11-10T00:00:00Z' }).byProduct.get('p').find((x) => x.title === 'Mauve');
  assert.deepEqual([stale.stock.units, stale.cover.status], [null, 'STOCK_UNUSABLE']);
});

test('VG-4 inconsistent windows: a missing or different bound (even by one hour, or an inclusive instead of an excluded end) keeps the product action and says why; the stock snapshot date is not a window bound', () => {
  const v = scenario({ mauveStock: 2 });
  assert.equal(sameSalesWindow(PW, v.window), null);
  assert.equal(sameSalesWindow({ start: PW.start }, v.window), 'WINDOW_MISSING');
  assert.equal(sameSalesWindow(null, v.window), 'WINDOW_MISSING');
  assert.equal(sameSalesWindow(PW, { since: v.window.since }), 'WINDOW_MISSING');
  assert.equal(sameSalesWindow({ ...PW, end: '2026-11-15T00:00:00.000Z' }, v.window), 'WINDOW_MISMATCH');
  assert.equal(sameSalesWindow({ start: '2026-07-27T02:00:00Z', end: '2026-09-21T02:00:00Z' }, v.window), 'WINDOW_MISMATCH');
  const a = action(v, { start: PW.start, end: '2026-11-15T00:00:00.000Z' });
  assert.equal(a.code, 'product'); assert.equal(a.variant, null); assert.equal(a.variantReason.code, 'WINDOW_MISMATCH'); assert.equal(a.target.id, 'p');
  assert.equal(action(v, null).variantReason.code, 'WINDOW_MISSING');
  assert.equal(sameSalesWindow({ start: new Date(W.start), end: W.end.toISOString() }, v.window), null); // Date and ISO string: same time base
});

test('VG-5 the end of the sales window is excluded: an order at exactly `until` is not counted, one at exactly `since` is', () => {
  const mk = (at) => ({ products: [{ id: 'p', source_id: 'P', title: 'x' }], variants: [{ id: 'v', product_id: 'p', source_id: 'V', title: 'v' }], orders: [{ id: 'o', ordered_at: at, is_test: false, status: 'PAID' }], orderLines: [{ id: 'l', order_id: 'o', variant_id: 'v', quantity: 1 }] });
  const units = (at) => variantRowsFromDataset(mk(at), { now: NOW, since: W.start, until: W.end })[0].units;
  assert.deepEqual([units(W.end.toISOString()), units(W.start.toISOString()), units('2026-11-14T22:59:59Z')], [0, 1, 1]);
});

// ---- end to end through the HTTP handler: coherent periods produce the recommendation, a divergence keeps the product level ----
async function opportunities(products) {
  const handler = createGrowthApp({ productPotential: async () => products, merchantId: 'm' });
  let body; await handler({ method: 'GET', url: '/api/growth/opportunities' }, { writeHead() {}, end(j) { body = JSON.parse(j); } });
  return body.sections.commercial.find((i) => i.kind === 'product' && i.title.code === 'product.push.title');
}
const pushPayload = (variantWindow) => {
  const p = potentialPayload(); const row = p.rows[1];
  row.status = 'push'; row.action = 'increaseVisibility'; row.opportunity = { kind: 'productVisibility', productId: row.id };
  const st = (units) => ({ state: 'OK', usable: true, units, snapshotAt: '2026-09-21T09:00:00Z', locations: [{ name: 'Habb', quantity: units }] });
  row.variants = [{ id: 'a', title: 'Mauve', unitsGross: 4, unitsRefunded: 0, unitsCancelled: 0, unitsNet: 4, stock: st(2), cover: { minWeeks: 4, status: 'CALCULATED', weeks: 4, days: 28 } },
    { id: 'b', title: 'Bleu', unitsGross: 1, unitsRefunded: 0, unitsCancelled: 0, unitsNet: 1, stock: st(6), cover: { minWeeks: 4, status: 'CALCULATED', weeks: 48, days: 336 } }];
  p.variantWindow = variantWindow(p.window); return p;
};

test('VG-6 HTTP: the fixture windows were the cause of the July-September / 20-09 gap; with the same bounds the push opportunity prepares the variant, with a diverging bound it stays on the product', async () => {
  const coherent = await opportunities(pushPayload((w) => ({ since: w.start, until: w.end })));
  assert.equal(coherent.preparedAction.code, 'variant'); assert.equal(coherent.preparedAction.variant.since, coherent.measurement.start); assert.equal(coherent.preparedAction.variant.until, coherent.measurement.end);
  const shifted = await opportunities(pushPayload((w) => ({ since: '2026-09-20T00:00:00.000Z', until: '2026-11-15T00:00:00.000Z' })));
  assert.equal(shifted.preparedAction.code, 'product'); assert.equal(shifted.preparedAction.variantReason.code, 'WINDOW_MISMATCH');
  const missing = await opportunities(pushPayload(() => undefined)); assert.equal(missing.preparedAction.code, 'product'); assert.equal(missing.preparedAction.variantReason.code, 'WINDOW_MISSING');
});

test('VG-7 screen FR / NL / EN: the reason and the cover are worded, no raw translation key, the snapshot date stays apart from the sales period', async () => {
  const data = prioritiesPayload(); const base = data.sections.commercial.find((i) => i.kind === 'product');
  const reasons = [{ code: 'COVER_LOW', title: 'Mauve', weeks: 2, minWeeks: 4 }, { code: 'WINDOW_MISMATCH' }, { code: 'COVER_UNKNOWN', title: 'Mauve' }, { code: 'STOCK_UNVERIFIED' }, { code: 'TIE' }, { code: 'WINDOW_MISSING' }, { code: 'NO_VARIANT_IN_STOCK_WITH_SALES' }];
  const items = reasons.map((variantReason, k) => ({ ...base, id: `product:r${k}`, preparedAction: { code: 'product', target: { id: `r${k}`, title: 'Casque' }, marginPct: null, variant: null, variantReason } }));
  items.push({ ...base, id: 'product:ok', preparedAction: { code: 'variant', target: { id: 'ok', title: 'Casque' }, marginPct: null, variantReason: null,
    variant: { id: 'a', title: 'Mauve', unitsNet: 4, stockUnits: 2, stockSnapshotAt: '2026-11-14T23:00:38Z', coverWeeks: 4, minCoverWeeks: 4, since: '2026-09-19T22:00:00Z', until: '2026-11-14T23:00:00Z' } } });
  for (const [lang, probes] of [['fr', ['Growth reste au niveau du produit', '2 semaines de couverture', 'Couverture de la variante : 4 semaines']], ['nl', ['Growth blijft op productniveau', 'slechts 2 weken dekking', 'Dekking van de variant: 4 weken']], ['en', ['Growth stays at product level', 'only 2 weeks of cover', 'Variant cover: 4 weeks']]]) {
    const ui = await growthDom('#/overview', { lang, opportunities: { ...data, historyScope: 'scope', sections: { ...data.sections, commercial: items } } });
    const entries = new Map(); // the harness's localStorage answers the language for any key: give the follow-up its own storage, as the follow-up tests do
    ui.ctx.localStorage = { get length() { return entries.size; }, key: (i) => [...entries.keys()][i], getItem: (k) => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v) };
    await ui.navigate('#/opportunities');
    assert.deepEqual(ui.errors, []); const root = ui.root;
    let t = text(ui.root); // only the main action shows its detail: open each other action in turn and read them all
    for (const it of items.slice(1)) { const btn = all(all(ui.root, (n) => n.getAttribute?.('data-priority-id') === it.id)[0], (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-open'))[0]; if (btn) { btn.listeners.click[0](); t += text(ui.root); } }
    for (const p of probes) assert.ok(t.includes(p), `${lang}: ${p}`);
    assert.ok(!/gr\.follow\.|gr\.pp\.var\./.test(t), `${lang}: raw key`);
  }
});
