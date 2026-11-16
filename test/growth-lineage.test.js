// Growth: ONE complete chain, end to end, on the REAL server path, with simulated data in an in-memory database:
//   synced data (orders, stock, costs)  ->  engines (Produits Potentiels: status, cover, margin; variant figures)  ->  priorities (candidate, prepared action, target)  ->  ranking
//   ->  the merchant's decision in the screen (plan, application)  ->  the result (the server's before / after net units, recorded with the action)
// and what an upstream change does: it re-evaluates what is still open, it never rewrites what was applied or reviewed.
// Nothing here reaches a network; the database is the read-only wrapper of an in-memory fake (a write throws).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createProductPotentialSource } from '../src/growth/server/products.js';
import { createReviewSource } from '../src/growth/server/review.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { growthDom, text, all, hasClass } from './growth-dom.js';

const MERCHANT = 'm-lineage'; const TZ = 'UTC'; const NOW = new Date('2026-09-21T09:00:00Z'); // the 8 complete weeks end on Monday 2026-09-21
const D = '2026-09-01'; const R = '2026-09-15'; // application day and planned review day (before: [18 Aug, 1 Sep), after: [2 Sep, 16 Sep), 14 days each)

/** The data of one merchant. Bleu: 2 units before the application, 3 after; Mauve: 1 and 1. Both costs verified, stock sufficient. */
function world({ bleuAfter = ['2026-09-03', '2026-09-08', '2026-09-12'], mauveAfter = ['2026-09-10'], costStatus = 'verified', extraOrders = [], refunds = [] } = {}) {
  const sales = [['bleu', '2026-07-30'], ['bleu', '2026-08-20'], ['bleu', '2026-08-27'], ['mauve', '2026-08-25'], ...bleuAfter.map((d) => ['bleu', d]), ...mauveAfter.map((d) => ['mauve', d]), ...extraOrders];
  const db = createFakeSupabase(); const tag = (rows) => rows.map((r) => ({ ...r, merchant_id: MERCHANT }));
  const orders = []; const lines = [];
  sales.forEach(([v, d, qty], i) => { orders.push({ id: `o${i}`, ordered_at: `${d}T10:00:00Z`, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, order_name: `#${1000 + i}` });
    lines.push({ id: `l${i}`, order_id: `o${i}`, variant_id: `v-${v}`, title_snapshot: v, sku_snapshot: null, quantity: qty ?? 1, unit_price: 20, discount_amount: 0, tax_amount: 3.47 }); });
  const rl = []; const rf = refunds.map((r, i) => { const line = lines.find((l) => l.order_id === orders.find((o) => o.ordered_at.startsWith(r.date))?.id); rl.push({ id: `rl${i}`, refund_id: `rf${i}`, order_line_id: line.id, quantity: 1 }); return { id: `rf${i}`, order_id: line.order_id, refunded_at: r.at, amount: 20 }; });
  const tables = [['products', [{ id: 'pH', source_id: 'gid://P/H', title: 'Casque Remax', product_type: 'Audio', source_created_at: '2026-03-01T00:00:00Z', source_status: 'ACTIVE' }]],
    ['variants', [{ id: 'v-bleu', product_id: 'pH', source_id: 'gid://V/bleu', sku: 'B', title: 'Bleu' }, { id: 'v-mauve', product_id: 'pH', source_id: 'gid://V/mauve', sku: 'M', title: 'Mauve' }]],
    ['locations', [{ id: 'loc1', name: 'Habb', type: 'unknown', source_id: 'gid://L/1' }]],
    ['orders', orders], ['order_lines', lines], ['refunds', rf], ['refund_lines', rl],
    ['product_costs', ['v-bleu', 'v-mauve'].map((variant_id) => ({ variant_id, unit_cost: 5, currency: 'EUR', effective_from: '2026-01-01T00:00:00Z', source: 'manual_entry', validation_status: costStatus }))],
    ['inventory_snapshots', [{ id: 's1', variant_id: 'v-bleu', location_id: 'loc1', quantity: 12, synced_at: '2026-09-21T06:00:00Z' }, { id: 's2', variant_id: 'v-mauve', location_id: 'loc1', quantity: 12, synced_at: '2026-09-21T06:00:00Z' }]]];
  for (const [t, r] of tables) db._tables.set(t, tag(r));
  const writes = []; const readOnly = { select: (...a) => db.select(...a), selectAll: (...a) => db.selectAll(...a), insert: (t) => { writes.push(t); throw new Error('write'); }, upsert: (t) => { writes.push(t); throw new Error('write'); }, update: (t) => { writes.push(t); throw new Error('write'); }, delete: (t) => { writes.push(t); throw new Error('write'); }, rpc: (f) => { writes.push(f); throw new Error('write'); } };
  const args = { supabase: readOnly, merchantId: MERCHANT, timeZone: TZ, now: () => NOW };
  const handler = createGrowthApp({ now: () => NOW, merchantId: MERCHANT, productPotential: createProductPotentialSource({ ...args, cacheMs: 0 }), review: createReviewSource({ ...args, cacheMs: 0 }) });
  const get = async (url) => { let body; await handler({ method: 'GET', url }, { writeHead() {}, end(j) { body = JSON.parse(j); } }); return body; };
  return { db, writes, get };
}

const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function screen(w, st, { hash = '#/opportunities' } = {}) {
  const opportunities = await w.get('/api/growth/opportunities'); const ui = await growthDom('#/overview', { opportunities, review: (u) => w.get(u) });
  ui.ctx.localStorage = st.api; await ui.navigate(hash); assert.deepEqual(ui.errors, []); return { ui, opportunities };
}
const ID = 'product:369'; // replaced at runtime by the real product id of the payload
const rowOf = (ui, id) => all(ui.root, (n) => n.getAttribute?.('data-priority-id') === id)[0];
const primary = (ui, id) => all(rowOf(ui, id), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];
const click = (b) => b.listeners.click[0]();
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, k) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === k);
const submit = (f) => f.listeners.submit[0]({ preventDefault() {} });
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);
const norm = (t) => t.replace(/[  ]/g, ' ');
const dueEntry = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-reviews'))[0] ?? null;

function planAndApply(ui, id, { baseline = 2, target = 4 } = {}) {
  click(primary(ui, id)); const f = form(rowOf(ui, id), 'plan'); const n = (k) => named(f, k);
  n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = baseline; n('target').valueAsNumber = target; n('reviewDate').value = R; submit(f);
  const a = form(rowOf(ui, id), 'applied'); named(a, 'appliedOn').value = D; submit(a); // the merchant applied the action on D (the date is the merchant's, typed in the follow-up)
}

test('LN-1 the whole chain, on the real server path: data -> decision -> action -> result, each step keeping the target, the period, the source and the version', async () => {
  const w = world(); const st = store(); const { ui, opportunities } = await screen(w, st);
  // 1. DATA -> DECISION (engine + aggregator): Produits Potentiels says "push", the aggregator prepares ONE action on the variant that leads in net units, with its window and its dated stock
  const item = opportunities.sections.commercial.find((i) => i.kind === 'product'); assert.ok(item, `a validated product opportunity exists: ${JSON.stringify(opportunities.sections.commercial.map((i) => i.id))}`);
  assert.equal(item.title.code, 'product.push.title'); const pid = item.entity.id; assert.equal(item.id, `product:${pid}`);
  const a = item.preparedAction; assert.deepEqual([a.code, a.variant.id, a.variant.title, a.variant.unitsNet, a.variant.stockUnits], ['variant', 'gid://V/bleu', 'Bleu', 6, 12]);
  assert.deepEqual([item.measurement.start, item.measurement.end], ['2026-07-27T00:00:00.000Z', '2026-09-21T00:00:00.000Z'], 'the period of the figures = the engine window');
  assert.deepEqual([a.variant.since, a.variant.until], [item.measurement.start, item.measurement.end], 'the variant figures cover exactly that period');
  assert.equal(item.target.variantId, 'gid://V/bleu'); assert.equal(opportunities.weekly.items[0].id, item.id); assert.equal(opportunities.weekly.items[0].rank, 1);
  // 2. DECISION -> ACTION (the merchant): plan + application, recorded with the version of the plan that was applied
  planAndApply(ui, item.id);
  const plan = events(st).find((e) => e.type === 'plan'); const applied = events(st).find((e) => e.type === 'applied');
  assert.deepEqual([plan.baseline, plan.reviewDate, applied.date, applied.planAt], [2, R, D, plan.at], 'the application points at the plan version it applied; 2 is the merchant\'s own starting value');
  // 3. ACTION -> RESULT: the review is due; the server compares the SAME variant over equal windows around the application date, from the same data source
  const due = await screen(w, st); assert.ok(dueEntry(due.ui), 'the applied action is due for review');
  const line = all(dueEntry(due.ui), (n) => hasClass(n, 'gv-action'))[0]; click(all(line, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick();
  const t = norm(text(line)); for (const s of ['2 avant · 3 après · +1 unités nettes · +50 %', 'Avant : 18 août 2026 – 31 août 2026', 'Après : 2 sept. 2026 – 15 sept. 2026', '14 jours chacune, jour d’application exclu', 'Valeur de départ saisie dans le plan : 2']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 900)}`);
  const f = form(line, 'review'); assert.equal(named(f, 'observed').getAttribute('value'), '3'); named(f, 'applied').value = D; named(f, 'observed').valueAsNumber = 3; named(f, 'notes').value = 'Calculé par Growth'; all(f, (x) => x.tagName === 'SELECT')[0].value = 'comparable'; submit(f); await tick();
  // 4. RESULT RECORDED: attached to the applied action - its plan version, its target (the variant), the period, the source (the server's net-units calculation)
  const review = events(st).find((e) => e.type === 'review'); assert.deepEqual([review.computed.before.units, review.computed.after.units, review.computed.difference.units, review.computed.rule, review.baseline], [2, 3, 1, 'growth-review.1', 2]);
  assert.deepEqual([review.computed.before.localStart, review.computed.before.localEnd, review.computed.after.localStart, review.computed.after.localEnd], ['2026-08-18', '2026-09-01', '2026-09-02', '2026-09-16']);
  assert.equal(w.writes.length, 0, 'the whole chain only read'); assert.equal(dueEntry((await screen(w, st)).ui), null, 'reviewed: no longer to review');
});

test('LN-2 an upstream change re-evaluates what is open and never rewrites what was applied or reviewed', async () => {
  const st = store(); const A = world(); const { ui, opportunities } = await screen(A, st); const item = opportunities.sections.commercial.find((i) => i.kind === 'product'); planAndApply(ui, item.id);
  const frozen = JSON.stringify([...st.m.entries()]);
  // (a) upstream: the purchase cost is no longer verified -> the open recommendation is re-evaluated (no longer a validated "push"), the saved plan/application are untouched
  const B = world({ costStatus: 'unverified' }); const after = await B.get('/api/growth/opportunities');
  assert.ok(!after.sections.commercial.some((i) => i.id === item.id), 'the product leaves the validated commercial list when its cost is not verified');
  assert.equal(JSON.stringify([...st.m.entries()]), frozen, 'nothing recorded changed');
  // (b) upstream: a refund of one "after" sale synced later -> the review the server computes now differs (2 instead of 3) ...
  const C = world({ refunds: [{ date: '2026-09-08', at: '2026-09-18T10:00:00Z' }] }); const r = await C.get(`/api/growth/review?type=variant&id=gid://V/bleu&applied=${D}&review=${R}`);
  assert.deepEqual([r.before.units, r.after.units], [2, 2], 'the refund is deducted once, in the window of the sale');
  // ... and a review recorded BEFORE the refund keeps its figures when reopened later on the changed data
  const due = await screen(A, st); const line = all(dueEntry(due.ui), (n) => hasClass(n, 'gv-action'))[0]; click(all(line, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick();
  const f = form(line, 'review'); named(f, 'applied').value = D; named(f, 'observed').valueAsNumber = 3; named(f, 'notes').value = 'ok'; all(f, (x) => x.tagName === 'SELECT')[0].value = 'comparable'; submit(f); await tick();
  const rev = events(st).find((e) => e.type === 'review'); const plan = events(st).find((e) => e.type === 'plan'); const applied = events(st).find((e) => e.type === 'applied');
  assert.deepEqual([rev.computed.after.units, applied.planAt, plan.baseline], [3, plan.at, 2]);
  const reopened = await growthDom('#/overview', { opportunities: await C.get('/api/growth/opportunities'), review: (u) => C.get(u) }); reopened.ctx.localStorage = st.api; await reopened.navigate('#/opportunities');
  const kept = events(st).find((e) => e.type === 'review'); assert.deepEqual([kept.computed.after.units, kept.computed.difference.units, kept.at], [3, 1, rev.at], 'the stored result still says 3, untouched by the reopening');
  assert.equal(A.writes.length + B.writes.length + C.writes.length, 0);
});
