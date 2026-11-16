// Two Growth corrections (2026-11-15). 1) Vue d'ensemble: a TRUE zero is not "nothing could be read". 2) Fiche produit: the detail BY VARIANT with the exact window,
// the net units and the sellable stock with its snapshot date and location; an unknown or stale stock is never 0.
// Offline: simulated payloads (growth-dom fixtures) and the real HABB figures of 2026-11-15 copied as fixtures (Remax RB-300HB Bleu: 4 net units over 120 days, 6 in stock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOverview } from '../src/growth/server/overview.js';
import { buildPriorities } from '../src/growth/priorities/priorities.js';
import { variantDetailsByProduct, stockStateOf } from '../src/growth/products/variants.js';
import { variantRowsFromDataset, rankAdOpportunities } from '../src/creative-autonomy/opportunity.js';
import { growthDom, potentialPayload, prioritiesPayload, text, all, hasClass, NOW } from './growth-dom.js';

const down = (keys) => { const p = prioritiesPayload(); return { ...p, sources: { ...p.sources, ...Object.fromEntries(keys.map((k) => [k, 'unavailable'])) } }; };
const kpiValues = (root) => all(root, (n) => hasClass(n, 'ex-kpi-value')).map(text);

test('OV-1 all four engines unavailable: nothing was computed, so the overview has NO figures (never 0)', () => {
  const p = buildPriorities({ now: NOW }); // every source null
  assert.deepEqual(Object.values(p.sources), ['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  const d = buildOverview({ now: NOW, store: null, priorities: p });
  assert.equal(d.sources.priorities, 'unavailable');
  assert.equal(d.kpis.fix, null); assert.equal(d.kpis.commercial, null); assert.equal(d.kpis.watch, null); assert.equal(d.attention, null); assert.equal(d.opportunities, null);
});

test('OV-2 partly unavailable: the figures stand, marked partial, the missing sources are named; all readable: payload unchanged', () => {
  const d = buildOverview({ now: NOW, store: null, priorities: down(['audience']) });
  assert.equal(d.sources.priorities, 'partial'); assert.deepEqual(d.unavailableSources, ['audience']); assert.notEqual(d.kpis.fix, null);
  const ok = buildOverview({ now: NOW, store: null, priorities: prioritiesPayload() });
  assert.equal(ok.sources.priorities, 'real'); assert.equal('unavailableSources' in ok, false);
});

test('OV-3 screen: all unavailable shows dashes and "Donnée non disponible", no 0; a REAL zero still shows 0; partial names the source', async () => {
  const none = await growthDom('#/', { overview: buildOverview({ now: NOW, store: null, priorities: buildPriorities({ now: NOW }) }) });
  assert.deepEqual(kpiValues(none.root), ['—', '—', '—']); assert.ok(text(none.root).includes('Donnée non disponible'));
  const real0 = buildOverview({ now: NOW, store: null, priorities: { ...prioritiesPayload(), counts: { fix: 0, commercial: 0, watch: 0, fixCorrections: 0 }, sections: { fix: [], commercial: [], watch: [] } } });
  const z = await growthDom('#/', { overview: real0 }); assert.deepEqual(kpiValues(z.root), ['0', '0', '0']); assert.equal(real0.sources.priorities, 'real');
  const part = await growthDom('#/', { overview: buildOverview({ now: NOW, store: null, priorities: down(['audience']) }) });
  assert.ok(text(part.root).includes('Source indisponible pour le moment : Audience'), text(part.root).slice(0, 300));
});

// ---- variants ----
const NOW2 = new Date('2026-11-15T12:00:00Z');
const dataset = (snapshots) => ({
  products: [{ id: 'p-remax', source_id: 'gid://P/1', title: 'Casque Bluetooth Remax RB-300HB pliable' }],
  variants: [{ id: 'v-bleu', product_id: 'p-remax', source_id: 'gid://V/57206453109084', title: 'Bleu' }, { id: 'v-mauve', product_id: 'p-remax', source_id: 'gid://V/57206416703836', title: 'Mauve' }],
  locations: [{ id: 'L1', name: 'Habb' }],
  orders: [['#1063', '2026-09-12T12:00:43Z'], ['#1067', '2026-09-16T12:01:57Z'], ['#1070', '2026-09-19T11:47:15Z'], ['#1114', '2026-10-26T11:20:45Z']].map(([id, t]) => ({ id, ordered_at: t, is_test: false, status: 'PAID' })),
  orderLines: ['#1063', '#1067', '#1070', '#1114'].map((o, i) => ({ id: `l${i}`, order_id: o, variant_id: 'v-bleu', quantity: 1 })), refunds: [], refundLines: [], snapshots });
const fresh = [{ variant_id: 'v-bleu', location_id: 'L1', quantity: 6, synced_at: '2026-11-14T23:00:38.506Z' }];
const W8 = { start: new Date('2026-09-14T00:00:00Z'), end: new Date('2026-11-09T00:00:00Z') };

test('VD-1 blue Remax over 120 days: 4 net units, 6 in stock (snapshot 2026-11-14 23:00 UTC, Habb) = the fixture; over Growth\'s 8 weeks the window is exact and the net units differ (3)', () => {
  const r120 = variantRowsFromDataset(dataset(fresh), { now: NOW2, windowDays: 120 }).find((r) => r.variant_title === 'Bleu');
  assert.deepEqual([r120.units, r120.stock, r120.evidence.stock_snapshot_at, r120.evidence.stock_locations[0].name], [4, 6, '2026-11-14T23:00:38.506Z', 'Habb']);
  const fx = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/opportunity-habb-20261115.json', import.meta.url), 'utf8'));
  const first = rankAdOpportunities(fx.rows, { now: new Date(fx.now) }).ranked[0];
  assert.deepEqual([first.variant_title, first.units, first.stock], ['Bleu', r120.units, r120.stock]); // the fixture says the same: 4 and 6
  const v = variantDetailsByProduct(dataset(fresh), { window: W8, now: NOW2, maxSnapshotAgeHours: 36 });
  assert.deepEqual(v.window, { since: '2026-09-14T00:00:00.000Z', until: '2026-11-09T00:00:00.000Z', days: 56 });
  const bleu = v.byProduct.get('p-remax').find((x) => x.title === 'Bleu'); assert.equal(bleu.unitsNet, 3); assert.equal(bleu.stock.units, 6); assert.equal(bleu.stock.state, 'OK');
});

test('VD-2 unknown or stale stock is never 0: no snapshot = UNKNOWN, a 3-day-old snapshot = STALE, negative = UNRELIABLE (units null); a fresh snapshot at 0 is a real 0', () => {
  const get = (snaps, title = 'Bleu') => variantDetailsByProduct(dataset(snaps), { window: W8, now: NOW2, maxSnapshotAgeHours: 36 }).byProduct.get('p-remax').find((x) => x.title === title).stock;
  const unknown = get(fresh, 'Mauve'); assert.deepEqual([unknown.state, unknown.usable, unknown.units], ['UNKNOWN', false, null]);
  const stale = get([{ variant_id: 'v-bleu', location_id: 'L1', quantity: 6, synced_at: '2026-11-12T00:00:00Z' }]); assert.deepEqual([stale.state, stale.usable, stale.units], ['STALE', false, null]);
  const neg = get([{ variant_id: 'v-bleu', location_id: 'L1', quantity: -2, synced_at: '2026-11-15T08:00:00Z' }]); assert.deepEqual([neg.state, neg.units], ['UNRELIABLE', null]);
  const zero = get([{ variant_id: 'v-bleu', location_id: 'L1', quantity: 0, synced_at: '2026-11-15T08:00:00Z' }]); assert.deepEqual([zero.state, zero.usable, zero.units], ['OK', true, 0]);
  assert.equal(stockStateOf({ stock_snapshot_at: null, stock_locations: [] }, null, { now: NOW2, maxSnapshotAgeHours: 36 }).units, null);
});

test('VD-3 screen: the product sheet shows the variant detail (exact window, net units and deductions, stock with snapshot date and location); an unknown stock is a dash with its reason, not a quantity', async () => {
  const p = potentialPayload(); const row = p.rows[0];
  p.variantWindow = { since: '2026-09-14T00:00:00.000Z', until: '2026-11-09T00:00:00.000Z', days: 56 };
  const st = (o) => ({ usable: false, units: null, snapshotAt: null, locations: [], ...o });
  row.variants = [
    { id: 'a', title: 'Bleu', unitsGross: 4, unitsRefunded: 1, unitsCancelled: 0, unitsNet: 3, lastSale: '2026-10-26', stock: st({ state: 'OK', usable: true, units: 6, snapshotAt: '2026-11-14T23:00:38.506Z', locations: [{ name: 'Habb', quantity: 6 }] }) },
    { id: 'b', title: 'Mauve', unitsGross: 8, unitsRefunded: 0, unitsCancelled: 0, unitsNet: 8, lastSale: '2026-11-04', stock: st({ state: 'UNKNOWN' }) },
    { id: 'c', title: 'Kaki', unitsGross: 1, unitsRefunded: 0, unitsCancelled: 0, unitsNet: 1, lastSale: '2026-10-01', stock: st({ state: 'STALE', snapshotAt: '2026-11-12T00:00:00.000Z', locations: [{ name: 'Habb', quantity: 6 }] }) }];
  const { root } = await growthDom('#/potential', { products: p });
  const first = all(root, (n) => hasClass(n, 'gr-pp-row') && n.listeners?.click)[0]; assert.ok(first, 'a product row exists'); first.listeners.click[0]();
  const drawer = all(root, (n) => hasClass(n, 'gr-pp-drawer'))[0]; assert.ok(drawer, 'the sheet opens');
  const t = text(drawer);
  for (const s of ['Détail par variante', '(8 semaines)', '3 vendues nettes', '4 commandées · 1 remboursées · 0 annulées', 'En stock : 6', '23:00 UTC · lieu : Habb', 'Stock inconnu (aucun relevé)', 'Stock non utilisable : relevé trop ancien']) assert.ok(t.includes(s), `${s}\n${t.slice(-700)}`);
  const unknownRow = all(drawer, (n) => n.getAttribute?.('data-variant-id') === 'b')[0]; assert.ok(unknownRow && !text(unknownRow).includes('En stock'), 'unknown stock is not shown as a quantity');
});

test('OP-A Opportunités: all four engines unavailable = the unavailable message, no figure and no "nothing to do" message; a real zero is an honest empty state; partial keeps its content and names the source', async () => {
  const none = await growthDom('#/opportunities', { opportunities: buildPriorities({ now: NOW }) }); const t = text(none.root);
  assert.ok(t.includes('Priorités indisponibles pour le moment.'), t.slice(0, 300));
  assert.equal(all(none.root, (n) => hasClass(n, 'ex-kpi')).length, 0, 'no count tile on the Opportunités page (they repeated the section headers)');
  assert.ok(!/Rien à corriger|Aucune opportunité commerciale fiable/.test(t), 'no reassuring empty-state message');
  const real0 = { ...prioritiesPayload(), counts: { fix: 0, commercial: 0, watch: 0, fixCorrections: 0 }, sections: { fix: [], commercial: [], watch: [] }, weekly: undefined };
  assert.ok(text((await growthDom('#/opportunities', { opportunities: real0 })).root).includes('Aucune opportunité commerciale fiable pour l’instant'));
  const part = await growthDom('#/opportunities', { opportunities: down(['audience']) }); assert.ok(text(part.root).includes('Source indisponible pour le moment : Audience'));
});
