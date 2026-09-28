// Développement des ventes > Opportunités - the priorities aggregator (src/growth/priorities/priorities.js) and its server source.
// Synthetic data only (hand-made engine payloads + the existing synthetic fixtures): never HABB's database.
// Owner rules checked here (2026-09-28): aggregation of the four engines; one card per product (no duplicate); guards win over any
// suggestion; no commercial recommendation under the existing thresholds; problems grouped by problem; purchase costs shown as a
// blocker, never "fixed"; stable ids; aggregates only (no customer data); no database write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPriorities, SECTIONS } from '../src/growth/priorities/priorities.js';
import { createPrioritiesSource } from '../src/growth/server/priorities.js';
import { createProductPotentialSource } from '../src/growth/server/products.js';
import { createAudienceSource } from '../src/growth/server/audience.js';
import { createContentSource } from '../src/growth/server/content.js';
import { createStoreSource } from '../src/growth/server/store.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { makeDemandData, NOW as DEMAND_NOW } from './fixtures/demand-sample.js';
import { potentialPayload, audiencePayload, contentPayload, storePayload, NOW } from './growth-dom.js';

import { smallStore } from './fixtures/growth-priorities-sample.js';

const ids = (p) => SECTIONS.flatMap((s) => p.sections[s].map((i) => i.id));

test('priorities: aggregates the four real engines (synthetic fixtures) into the three sections', () => {
  const p = buildPriorities({ products: potentialPayload(), audience: audiencePayload(), content: contentPayload(), store: storePayload(), now: NOW });
  assert.deepEqual(p.sources, { products: 'ok', audience: 'ok', store: 'ok', content: 'ok' });
  assert.deepEqual(Object.keys(p.sections), SECTIONS);
  assert.ok(p.sections.fix.length > 0, 'content / cost problems are reported');
  assert.ok(p.sections.commercial.length > 0, 'validated engine opportunities are reported');
  const kinds = new Set(p.sections.commercial.map((i) => i.kind));
  assert.ok(kinds.has('product') && kinds.has('segment'), 'product and audience opportunities both arrive');
  assert.deepEqual(p.counts, { fix: p.sections.fix.length, commercial: p.sections.commercial.length, watch: p.sections.watch.length, fixElements: p.sections.fix.reduce((a, g) => a + g.evidence.count, 0) });
  for (const i of [...p.sections.fix, ...p.sections.commercial, ...p.sections.watch]) {
    for (const k of ['id', 'category', 'title', 'explanation', 'evidence', 'reliability', 'entity', 'sourcePage', 'rankReason']) assert.ok(k in i, `${i.id}: contract field ${k}`);
    assert.ok('dataBlocker' in i, `${i.id}: contract field dataBlocker`);
    assert.ok(['potential', 'audience', 'storeGrowth', 'content'].includes(i.sourcePage));
  }
});

test('priorities: a small store with thin data gets corrections and signals to watch, and NO commercial recommendation', () => {
  const p = buildPriorities({ ...smallStore(), now: NOW });
  assert.equal(p.sections.commercial.length, 0, 'nothing passes the existing thresholds: no commercial opportunity is invented');
  assert.deepEqual(p.sections.fix.map((g) => g.id), ['fix:purchase-cost', 'fix:content:missingSku', 'fix:content:noType'], 'cost blocks recommendations: first; then sold products affected, then size');
  // The honest empty state says what Nordla waits for, from the engines' own states.
  assert.deepEqual(p.waiting.map((w) => w.code), ['productSales', 'verifiedCosts', 'identifiedCustomers', 'storeHistory', 'onlineOrders']);
  assert.deepEqual(p.waiting.find((w) => w.code === 'identifiedCustomers').params, { identified: 18, min: 30 });
});

test('priorities: problems are GROUPED by problem - 126 products without SKU make one group, with a few examples, sold ones first', () => {
  const p = buildPriorities({ ...smallStore(), now: NOW });
  const sku = p.sections.fix.find((g) => g.id === 'fix:content:missingSku');
  assert.equal(p.sections.fix.filter((g) => g.problem === 'missingSku').length, 1);
  assert.equal(sku.evidence.count, 126);
  assert.equal(sku.evidence.soldAffected, 2);
  assert.equal(sku.examples.length, 3);
  assert.deepEqual(sku.examples.slice(0, 2).map((e) => e.title), ['Rising product', 'Steady best seller'], 'sold products come first');
  assert.equal(sku.sourcePage, 'content');
  assert.equal(sku.reliability, 'reliable');
});

test('priorities: purchase costs that are not verified are a data BLOCKER (never fixed or marked verified here)', () => {
  const input = smallStore();
  const before = JSON.stringify(input.products);
  const p = buildPriorities({ ...input, now: NOW });
  const cost = p.sections.fix.find((g) => g.id === 'fix:purchase-cost');
  assert.equal(cost.evidence.count, 16);
  assert.equal(cost.evidence.missing, 1);
  assert.equal(cost.evidence.unverified, 15);
  assert.equal(cost.evidence.blockedRecommendations, 1, 'the rising product is blocked by its cost');
  assert.equal(cost.dataBlocker, 'costVerificationNotAvailable');
  assert.equal(cost.examples[0].title, 'Rising product', 'the blocked recommendation is the first example');
  assert.equal(JSON.stringify(input.products), before, 'the engine payload (costs included) is never modified');
});

test('priorities: ONE card per product - what several engines say about it is merged, never two or three cards', () => {
  const p = buildPriorities({ ...smallStore(), now: NOW });
  const all = ids(p);
  assert.equal(new Set(all).size, all.length, 'no duplicate id');
  for (const pid of ['p1', 'p2']) assert.equal(all.filter((i) => i === `product:${pid}`).length, 1, `${pid}: exactly one card`);
  const p2 = p.sections.watch.find((i) => i.id === 'product:p2');
  assert.deepEqual(p2.findings.map((f) => f.source), ['products', 'store', 'products', 'content'], 'sales status, store suggestion, cost, listing');
  assert.deepEqual(p2.findings.map((f) => f.code), ['potential.topSeller', 'storeSuggestedNotRecommended', 'costUnverified', 'contentIncomplete']);
  assert.deepEqual(p2.relatedPages, ['potential', 'storeGrowth', 'content']);
  assert.equal(new Set(p2.findings.map((f) => f.id)).size, p2.findings.length, 'findings have stable, distinct ids');
});

test('priorities: guards win - the store\'s first product (blocked) and second (4 sales) are both "À surveiller", without contradiction', () => {
  const p = buildPriorities({ ...smallStore(), now: NOW });
  const p1 = p.sections.watch.find((i) => i.id === 'product:p1');
  const p2 = p.sections.watch.find((i) => i.id === 'product:p2');
  assert.ok(p1 && p2, 'both are explained in "À surveiller"');
  assert.equal(p.sections.commercial.some((i) => i.entity && (i.entity.id === 'p1' || i.entity.id === 'p2')), false, 'neither is recommended');
  // First product: demand rises, the missing verified cost blocks it; the store engine kept it out of the highlight.
  assert.equal(p1.explanation.code, 'product.watch.why.risingBlocked');
  assert.ok(p1.findings.some((f) => f.code === 'storeTopBlocked' && f.params.rank === 1));
  assert.deepEqual(p1.missing.map((m) => m.code), ['verifiedCost']);
  // Second product: the store suggests featuring it, but on 4 sales without a "push" status it stays a weak signal.
  assert.equal(p2.explanation.code, 'product.watch.why.storeSuggestionThin');
  assert.equal(p2.reliability, 'limited');
  assert.equal(p2.evidence.units, 4);
  assert.equal(p2.evidence.weeks, 8);
  assert.deepEqual(p2.missing.map((m) => m.code), ['verifiedCost', 'risingDemand']);
});

test('priorities: a store suggestion becomes commercial ONLY when Produits Potentiels says "À pousser" (all its guards passed)', () => {
  const input = smallStore();
  const pushed = input.products.rows.find((r) => r.id === 'p2');
  Object.assign(pushed, { status: 'push', action: 'increaseVisibility', rule: 'RISING_DEMAND_COVERED_RELIABLE_MARGIN', trend: 'UP', margin: { tier: 'RELIABLE', pct: 0.5 }, reasons: [], opportunity: { kind: 'productVisibility', productId: 'p2' } });
  const p = buildPriorities({ ...input, now: NOW });
  const card = p.sections.commercial.find((i) => i.id === 'product:p2');
  assert.ok(card, 'now a commercial opportunity');
  assert.equal(card.reliability, 'reliable');
  assert.equal(card.title.code, 'product.push.title');
  assert.ok(card.findings.some((f) => f.code === 'storeSuggested'));
  assert.equal(p.sections.watch.some((i) => i.id === 'product:p2'), false, 'never in two sections');
});

test('priorities: no commercial item under the thresholds - insufficient engine statuses never produce one', () => {
  const input = smallStore();
  for (const r of input.products.rows) Object.assign(r, { status: 'insufficient', rule: 'THIN_SAMPLE', opportunity: null });
  input.store.actions = [];
  const p = buildPriorities({ ...input, now: NOW });
  assert.equal(p.sections.commercial.length, 0);
  assert.equal(p.sections.watch.filter((i) => i.kind === 'product' && i.entity.id !== 'p1').length, 0, 'only the guard-blocked store best seller stays explained');
});

test('priorities: ids are stable - same input, same ids and same order', () => {
  const a = buildPriorities({ ...smallStore(), now: NOW });
  const b = buildPriorities({ ...smallStore(), now: new Date('2026-10-01T10:00:00Z') });
  assert.deepEqual(ids(a), ids(b));
  assert.ok(ids(a).every((i) => /^(fix:[\w:-]+|product:[\w-]+|store:weekday:\d|audience:segment:\w+)$/.test(i)), 'readable, entity-based ids');
});

test('priorities: aggregates only - no customer identifier, no per-customer row, no personal field', () => {
  const p = buildPriorities({ products: potentialPayload(), audience: audiencePayload(), content: contentPayload(), store: storePayload(), now: NOW });
  const json = JSON.stringify(p);
  for (const k of ['customer_key', 'customerKey', 'email', 'phone', 'address', 'firstName', 'lastName', 'customerId']) assert.ok(!json.includes(`"${k}"`), `no ${k}`);
  for (const i of p.sections.commercial.filter((x) => x.kind === 'segment')) assert.deepEqual(Object.keys(i.evidence).sort(), ['customers', 'days', 'orders', 'revenueShare']);
});

test('priorities: a missing source is reported, never guessed; nothing configured = no source at all', async () => {
  const p = buildPriorities({ products: potentialPayload(), now: NOW });
  assert.deepEqual(p.sources, { products: 'ok', audience: 'unavailable', store: 'unavailable', content: 'unavailable' });
  assert.equal(createPrioritiesSource({}), null);
});

test('priorities source: reads the engines through the database client and NEVER writes', async () => {
  const d = makeDemandData(); const merchantId = 'm-synthetic';
  const tag = (rows) => rows.map((r) => ({ ...r, merchant_id: merchantId }));
  const db = createFakeSupabase();
  for (const [t, rows] of [['products', d.products], ['variants', d.variants], ['orders', d.orders], ['order_lines', d.orderLines], ['product_costs', d.costs], ['inventory_snapshots', d.snapshots]]) db._tables.set(t, tag(rows));
  const writes = [];
  const readOnly = {
    select: (...a) => db.select(...a), selectAll: (...a) => db.selectAll(...a),
    insert: (t) => { writes.push(`insert ${t}`); throw new Error('write'); }, upsert: (t) => { writes.push(`upsert ${t}`); throw new Error('write'); },
    update: (t) => { writes.push(`update ${t}`); throw new Error('write'); }, delete: (t) => { writes.push(`delete ${t}`); throw new Error('write'); },
    rpc: (f) => { writes.push(`rpc ${f}`); throw new Error('write'); },
  };
  const args = { supabase: readOnly, merchantId, timeZone: 'UTC', now: () => DEMAND_NOW };
  const source = createPrioritiesSource({ productPotential: createProductPotentialSource(args), audience: createAudienceSource(args), content: createContentSource(args), store: createStoreSource(args), now: () => DEMAND_NOW });
  const p = await source();
  assert.deepEqual(writes, [], 'no insert / upsert / update / delete / rpc');
  assert.equal(p.sources.products, 'ok');
  assert.ok(p.sections.fix.length + p.sections.commercial.length + p.sections.watch.length > 0);
});
