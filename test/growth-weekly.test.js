// "À traiter en premier cette semaine": eligibility, ranking and rendering of the weekly commercial actions (src/growth/priorities/weekly.js). Simulated data, offline.
// This tests that the RULE works and is deterministic. It does NOT measure whether a merchant finds the actions useful: that evaluation has not been done.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankWeeklyActions, blockerOf, WEEKLY_MAX } from '../src/growth/priorities/weekly.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { growthDom, potentialPayload, audiencePayload, contentPayload, storePayload, prioritiesPayload, text, all, hasClass, NOW } from './growth-dom.js';

const M = { start: '2026-09-19T22:00:00.000Z', end: '2026-11-14T23:00:00.000Z', calculatedAt: '2026-11-15T10:00:00.000Z' };
const OK = { products: 'ok', audience: 'ok', store: 'ok', content: 'ok' };
let n = 0;
const product = (netSales, over = {}) => ({ id: `product:p${++n}`, category: 'commercial', kind: 'product', sourcePage: 'potential', evidence: { netSales }, measurement: M, dataBlocker: null, findings: [],
  entity: { id: `p${n}`, title: `Produit ${n}` }, preparedAction: { code: 'product', target: { id: `p${n}`, title: `Produit ${n}` }, marginPct: 0.4, variant: null, variantReason: null }, ...over });
const restock = (netSales, over = {}) => product(netSales, { preparedAction: { code: 'restock', target: { id: 'r', title: 'Réassort' }, marginPct: null }, ...over });
const weekday = (share, day = 3) => ({ id: `store:weekday:${day}`, category: 'commercial', kind: 'storeWeekday', sourcePage: 'storeGrowth', evidence: { share }, measurement: M, dataBlocker: null, entity: { id: `weekday:${day}` }, preparedAction: { code: 'storeWeekday', day } });
const segment = (key, customers) => ({ id: `audience:segment:${key}`, category: 'commercial', kind: 'segment', sourcePage: 'audience', evidence: { customers }, measurement: M, dataBlocker: null, entity: { id: key },
  preparedAction: { code: 'segment', segment: key, campaign: { purpose: 'reactivation', customers, days: 90, baselineOrders: 0 } } });
const ids = (r) => r.items.map((i) => i.id);

test('WK-1 zero eligible: an honest empty state (sources readable) or a partial one (a source down), never "nothing to do"; all candidate sources down = unavailable', () => {
  const none = rankWeeklyActions([], { sources: OK }); assert.deepEqual([none.state, none.items.length], ['empty', 0]);
  assert.equal(rankWeeklyActions([], { sources: { ...OK, products: 'unavailable' } }).state, 'emptyPartial');
  assert.deepEqual(rankWeeklyActions([], { sources: { ...OK, products: 'unavailable' } }).unavailableSources, ['products']);
  assert.equal(rankWeeklyActions([weekday(0.4)], { sources: { products: 'unavailable', audience: 'unavailable', store: 'unavailable', content: 'ok' } }).state, 'unavailable');
  assert.equal(rankWeeklyActions([weekday(0.4)], { sources: { ...OK, content: 'unavailable' } }).state, 'ok'); // Contenu never produces a commercial action
  const notPrepared = { ...weekday(0.4), preparedAction: null };
  assert.equal(rankWeeklyActions([notPrepared], { sources: OK }).state, 'empty'); // validated but without a prepared action: stays in the list, is not a weekly candidate
});

test('WK-2 one eligible action: it is alone (HABB today: the store weekday is the only commercial opportunity and the only one shown); Remax or others are never forced in', () => {
  const r = rankWeeklyActions([weekday(0.31, 3)], { sources: OK });
  assert.deepEqual([r.state, ids(r), r.items[0].rank, r.items[0].level], ['ok', ['store:weekday:3'], 1, 1]);
  assert.deepEqual(r.items[0].reasons, { validatedBy: 'storeGrowth', gaps: [], feasibility: { code: 'immediate' }, tie: 'alone' });
});

test('WK-3 more than three eligible: exactly three are kept, the others stay out of the list; segments are never compared with product sales', () => {
  const items = [segment('big', 1000), product(5), product(300), weekday(0.5), segment('small', 3)];
  const r = rankWeeklyActions(items, { sources: OK });
  assert.equal(r.items.length, WEEKLY_MAX); assert.equal(r.eligibleCount, 5);
  // level 1 (no gap, immediate): the two products (net sales 300 then 5, same unit and period) then the weekday; the segments (email prerequisites) are level 2 whatever their size
  assert.deepEqual(ids(r), [items[2].id, items[1].id, 'store:weekday:3']);
  assert.deepEqual(r.items.map((i) => i.level), [1, 1, 1]);
  assert.deepEqual(r.items[0].reasons.tie, { code: 'magnitude', metric: 'netSales', position: 'ahead' });
  assert.deepEqual(r.items[1].reasons.tie, { code: 'magnitude', metric: 'netSales', position: 'behind' });
  assert.equal(r.items[2].reasons.tie, 'displayOrder'); // different kind: not compared, fixed display order, no commercial reason invented
});

test('WK-4 a blocked candidate is reported with its reason and never ranked; a datum blocks only when needed (cost blocks a push, not a restock)', () => {
  const blockedPush = product(500, { dataBlocker: 'costNotVerified' });
  const restockOk = restock(80, { dataBlocker: 'costNotVerified', findings: [{ code: 'costUnverified' }] });
  const noPeriod = weekday(0.4, 5); noPeriod.measurement = { start: null, end: null, calculatedAt: null };
  const noVolume = segment('x', 10); noVolume.preparedAction.campaign.customers = null;
  const noTarget = product(10, { preparedAction: { code: 'product', target: { id: null, title: null } } });
  const r = rankWeeklyActions([blockedPush, restockOk, noPeriod, noVolume, noTarget], { sources: OK });
  assert.deepEqual(ids(r), [restockOk.id]);
  assert.deepEqual(r.blocked.map((b) => b.reason).sort(), ['AUDIENCE_VOLUME_MISSING', 'COST_NOT_VERIFIED', 'MEASUREMENT_MISSING', 'TARGET_MISSING']);
  assert.equal(blockerOf(restockOk), null);
  assert.deepEqual(r.items[0].reasons.gaps, ['COST_UNVERIFIED']); // eligible, but with an incomplete proof (shown, and ranked after complete ones)
});

test('WK-5 different kinds: a complete, immediately feasible action outranks one with a proof gap or an external prerequisite, whatever the figures', () => {
  const gapRestock = restock(900, { dataBlocker: 'costNotVerified' });
  const variantGap = product(50, { preparedAction: { code: 'product', target: { id: 'v', title: 'V' }, variant: null, variantReason: { code: 'STOCK_UNVERIFIED' } } });
  const campaign = segment('huge', 5000);
  const plain = weekday(0.2);
  const r = rankWeeklyActions([gapRestock, campaign, variantGap, plain], { sources: OK });
  assert.deepEqual(ids(r), ['store:weekday:3', campaign.id, variantGap.id]);
  assert.deepEqual(r.items.map((i) => i.level), [1, 2, 3]); // (no gap, immediate) < (no gap, prerequisite) < (gap, immediate)
  assert.deepEqual(r.items[2].reasons.gaps, ['VARIANT_STOCK_UNVERIFIED']);
  // a tie on a decision (cover too low, tie between variants) is NOT a proof gap
  const decided = product(60, { preparedAction: { code: 'product', target: { id: 'd', title: 'D' }, variant: null, variantReason: { code: 'COVER_LOW', title: 'x', weeks: 2, minWeeks: 4 } } });
  assert.deepEqual(rankWeeklyActions([decided], { sources: OK }).items[0].reasons.gaps, []);
});

test('WK-6 equal evidence: same kind and same figure is a tie (stable order by id, said as such); an unknown figure is never a reason', () => {
  const a = weekday(0.4, 2); const b = weekday(0.4, 6);
  const r = rankWeeklyActions([b, a], { sources: OK });
  assert.deepEqual(ids(r), ['store:weekday:2', 'store:weekday:6']); assert.deepEqual(r.items.map((i) => i.level), [1, 1]); assert.equal(r.items[0].reasons.tie, 'equalFigures');
  const unknown = product(null); const known = product(10);
  assert.equal(rankWeeklyActions([unknown, known], { sources: OK }).items[1].reasons.tie, 'equalFigures');
});

test('WK-7 deterministic: any input order gives the same ranking, the same levels and the same reasons, on every run', () => {
  const base = [product(300), product(5), restock(80), weekday(0.5), weekday(0.5, 6), segment('a', 70), segment('b', 32), segment('c', 70)];
  const reference = JSON.stringify(rankWeeklyActions(base, { sources: OK }));
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 40; k += 1) {
    const shuffled = base.slice().sort(() => rnd() - 0.5);
    assert.equal(JSON.stringify(rankWeeklyActions(shuffled, { sources: OK })), reference);
  }
  assert.equal(JSON.stringify(rankWeeklyActions(base, { sources: OK })), reference);
  assert.ok(!/score|revenue|estimate/i.test(reference), 'no score and no revenue estimate in the result');
});

// ---- through the HTTP handler, on the simulated fixtures: the exact example reported ----
const st = (units) => ({ state: 'OK', usable: true, units, snapshotAt: '2026-09-21T09:00:00Z', locations: [{ name: 'Habb', quantity: units }] });
async function payload({ cleanCost = true, sources = {} } = {}) {
  const p = potentialPayload(); const row = p.rows[1];
  row.status = 'push'; row.action = 'increaseVisibility'; row.opportunity = { kind: 'productVisibility', productId: row.id };
  row.variants = [{ id: 'a', title: 'Mauve', unitsGross: 4, unitsRefunded: 0, unitsCancelled: 0, unitsNet: 4, stock: st(2), cover: { minWeeks: 4, status: 'CALCULATED', weeks: 4, days: 28 } },
    { id: 'b', title: 'Bleu', unitsGross: 1, unitsRefunded: 0, unitsCancelled: 0, unitsNet: 1, stock: st(6), cover: { minWeeks: 4, status: 'CALCULATED', weeks: 48, days: 336 } }];
  p.variantWindow = { since: p.window.start, until: p.window.end, days: 56 };
  if (cleanCost) row.margin = { tier: 'RELIABLE', pct: 0.4 };
  const h = createGrowthApp({ now: () => NOW, merchantId: 'm', productPotential: sources.products === false ? null : async () => p, audience: sources.audience === false ? null : async () => audiencePayload(), content: async () => contentPayload(), store: sources.store === false ? null : async () => storePayload() });
  let body; await h({ method: 'GET', url: '/api/growth/opportunities' }, { writeHead() {}, end(j) { body = JSON.parse(j); } }); return body;
}

test('WK-8 simulated fixture with several solid actions: which are kept and why (printed for the report), stable across runs', async () => {
  const a = await payload(); const b = await payload();
  assert.deepEqual(a.weekly, b.weekly);
  const kept = a.weekly.items.map((w) => `${w.rank}. ${w.id} [level ${w.level}] gaps=${JSON.stringify(w.reasons.gaps)} ${w.reasons.feasibility.code}${w.reasons.feasibility.prerequisite ? ':' + w.reasons.feasibility.prerequisite : ''} tie=${JSON.stringify(w.reasons.tie)}`);
  console.log('SIMULATED RANKING:\n' + kept.join('\n') + '\nblocked: ' + JSON.stringify(a.weekly.blocked) + ' eligible: ' + a.weekly.eligibleCount);
  assert.equal(a.weekly.items.length, 3);
  assert.ok(a.weekly.items[0].id.startsWith('product:') && a.weekly.items[0].reasons.feasibility.code === 'immediate'); // the complete, immediate product action first
  assert.deepEqual(a.weekly.items[0].reasons.gaps, []);
  // only the three kept are marked; every commercial item stays reachable in the payload
  assert.equal(a.sections.commercial.length, a.weekly.eligibleCount + a.weekly.blocked.length);
});

test('WK-9 a source down: the ranking is built from the readable sources and the unavailable one is named, not hidden', async () => {
  const p = await payload({ sources: { audience: false } });
  assert.equal(p.sources.audience, 'unavailable'); assert.deepEqual(p.weekly.unavailableSources, ['audience']);
  assert.ok(p.weekly.items.every((w) => w.kind !== 'segment'));
});

// ---- rendering ----
const open = async (opportunities, lang = 'fr') => {
  const ui = await growthDom('#/overview', { lang, opportunities });
  const entries = new Map(); // the harness's localStorage answers the language for any key: the follow-up gets its own storage, as in the follow-up tests
  ui.ctx.localStorage = { get length() { return entries.size; }, key: (i) => [...entries.keys()][i], getItem: (k) => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v) };
  await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui.root;
};

test('WK-10 screen FR / NL / EN: the prioritised actions as compact lines (rank, title, one button); why / proof reachable; each action appears ONCE; no raw key', async () => {
  const p = await payload();
  for (const [lang, probes] of [['fr', ['Priorité 1', 'Préparer', 'Pourquoi cette priorité', 'Autres actions (', 'Période observée']], ['nl', ['Prioriteit 1', 'Voorbereiden', 'Waarom deze prioriteit', 'Andere acties (', 'Waargenomen periode']], ['en', ['Priority 1', 'Prepare', 'Why this priority', 'Other actions (', 'Observed period']]]) {
    const root = await open(p, lang); const t = text(root);
    for (const s of probes) assert.ok(t.includes(s), `${lang}: ${s}`);
    assert.ok(!/gr\.(wk|follow|pp|op|fiche)\.[\w.]+/.test(t), `${lang}: raw key`);
    const rows = all(root, (n) => n.getAttribute?.('data-priority-id') && String(n.getAttribute('data-priority-id')).match(/^(product|audience|store)/)).map((n) => n.getAttribute('data-priority-id'));
    assert.equal(new Set(rows).size, rows.length, `${lang}: an action is shown twice`);
    assert.equal(all(root, (n) => n.getAttribute?.('data-weekly-rank')).length, 3, 'the three prioritised actions carry their rank');
    assert.equal(all(all(root, (n) => hasClass(n, 'gv-priorities'))[0], (n) => hasClass(n, 'gv-action')).length, 3, 'the three prioritised actions are lines of ONE list');
  }
});

test('WK-11 screen: empty (honest), partial (named sources) and one-action states', async () => {
  const base = prioritiesPayload();
  const mk = (sections, weekly) => ({ ...base, historyScope: 's', sections: { ...base.sections, commercial: sections }, weekly });
  const one = await payload(); const only = one.sections.commercial.find((i) => i.kind === 'segment');
  const r1 = await open(mk([only], rankWeeklyActions([only], { sources: OK }))); assert.equal(all(r1, (n) => n.getAttribute?.('data-weekly-rank')).length, 1); assert.ok(!text(r1).includes('Autres actions'), 'one action: no list repeating it'); assert.equal(all(r1, (n) => hasClass(n, 'gv-action')).length, 1);
  const noPrepared = { ...only, preparedAction: null };
  const r2 = await open(mk([noPrepared], rankWeeklyActions([noPrepared], { sources: OK }))); assert.ok(text(r2).includes('Aucune action éligible cette semaine') && text(r2).includes('Ce n’est pas un défaut de données'));
  const r3 = await open(mk([noPrepared], rankWeeklyActions([noPrepared], { sources: { ...OK, store: 'unavailable' } }))); assert.ok(text(r3).includes('Aucune action éligible parmi les sources lisibles') && text(r3).includes('Cela ne veut pas dire qu’il n’y a rien à faire'));
  const blocked = { ...only, measurement: { start: null, end: null } };
  const r4 = await open(mk([blocked], rankWeeklyActions([blocked], { sources: OK }))); assert.ok(text(r4).includes('Non proposée') && text(r4).includes('la période des chiffres est inconnue'));
  const r5 = await open(mk([], rankWeeklyActions([], { sources: OK }))); assert.ok(!text(r5).includes('Aucune action éligible cette semaine'), 'the section own empty state already says it');
});
