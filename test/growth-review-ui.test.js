// Growth > Opportunités > "À revoir": the reviews that are due, and the result the server calculated for an applied product / variant action.
// Simulated data, offline (the harness answers the review endpoint with a payload). The history is the merchant's browser history, one scope per merchant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankWeeklyActions } from '../src/growth/priorities/weekly.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const OK = { products: 'ok', audience: 'ok', store: 'ok', content: 'ok' };
const M = { start: '2026-09-19T22:00:00.000Z', end: '2026-11-14T23:00:00.000Z', calculatedAt: '2026-11-15T10:00:00.000Z' };
const base = prioritiesPayload();
const fxProd = base.sections.commercial.find((i) => i.kind === 'product');
const variantItem = () => ({ ...fxProd, title: { code: 'product.push.title', params: { product: 'Casque Remax' } }, explanation: { code: 'product.push.why', params: {} }, id: 'product:pH', entity: { type: 'product', id: 'pH', title: 'Casque Remax' }, measurement: M, prerequisites: [], dataBlocker: null, evidence: { netSales: 99.18 },
  preparedAction: { code: 'variant', target: { id: 'pH', title: 'Casque Remax' }, marginPct: 0.4, variantReason: null, variant: { id: 'gid://V/bleu', title: 'Bleu', unitsNet: 4, stockUnits: 6, stockSnapshotAt: '2026-11-14T23:00:38Z', coverWeeks: 20, minCoverWeeks: 4, since: M.start, until: M.end } },
  target: { type: 'product', page: 'potential', id: 'pH', title: 'Casque Remax', available: true, variantId: 'gid://V/bleu' } });
const productItem = () => ({ ...variantItem(), id: 'product:pP', entity: { type: 'product', id: 'pP', title: 'Coque' }, preparedAction: { code: 'product', target: { id: 'pP', title: 'Coque' }, marginPct: 0.4, variantReason: null, variant: null }, target: { type: 'product', page: 'potential', id: 'pP', title: 'Coque', available: true, variantId: null } });
const weekdayItem = () => ({ id: 'store:weekday:3', category: 'commercial', kind: 'storeWeekday', title: { code: 'store.weekday.title', params: { day: 3 } }, explanation: { code: 'store.weekday.why', params: {} }, evidence: { share: 0.37, storeOrders: 52, weeks: 8 },
  reliability: 'reliable', entity: { type: 'store', id: 'weekday:3' }, sourcePage: 'storeGrowth', measurement: M, prerequisites: [], preparedAction: { code: 'storeWeekday', day: 3 }, target: { type: 'storeWeekday', page: 'storeGrowth', day: 3, location: null, productValidated: false, available: true } });

const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const PAST = '2020-01-01'; const FUTURE = '2999-01-01';
async function open(items, st, { scope = 'merchant-a', review = null, lang = 'fr' } = {}) {
  const opportunities = { ...base, historyScope: scope, sections: { ...base.sections, commercial: items }, weekly: rankWeeklyActions(items, { sources: OK }) };
  const ui = await growthDom('#/overview', { lang, opportunities, review }); ui.ctx.localStorage = st.api; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui;
}
const row = (ui, id) => all(ui.root, (n) => n.getAttribute?.('data-priority-id') === id)[0];
const primary = (ui, id) => all(row(ui, id), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];
const click = (b) => b.listeners.click[0]();
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, name) => all(f, (n) => n.tagName === 'INPUT').find((n) => n.getAttribute('name') === name);
const submit = (f) => f.listeners.submit[0]({ preventDefault() {} });
function plan(ui, id, { reviewDate = PAST, baseline = 2, target = 6 } = {}) {
  click(primary(ui, id)); const f = form(row(ui, id), 'plan'); const n = (k) => named(f, k);
  n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); if (n('product')) n('product').value = 'Coque'; if (n('url')) { n('subject').value = n('subject').getAttribute('value'); n('cta').value = n('cta').getAttribute('value'); n('url').value = 'https://habb.be/x'; }
  n('baseline').valueAsNumber = baseline; n('target').valueAsNumber = target; n('reviewDate').value = reviewDate; submit(f);
}
/** plan + apply through the screen (the merchant's own steps), so the stored history is the real one */
function planAndApply(ui, id, over = {}) { plan(ui, id, over); click(primary(ui, id)); }
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);
const dueEntry = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-reviews'))[0] ?? null;
const reviewLines = (ui) => { const d = dueEntry(ui); return d ? all(d, (n) => hasClass(n, 'gv-action')) : []; };
const comparable = (before, after, over = {}) => ({ state: 'COMPARABLE', rule: 'growth-review.1', calculatedAt: '2026-11-15T12:00:00.000Z', limits: [], timeZone: 'Europe/Brussels',
  windows: { days: 28, weekdaysBalanced: true, appliedDate: '2026-10-10', applicationDayExcluded: true },
  before: { localStart: '2026-09-12', localEnd: '2026-10-10', days: 28, units: before, gross: before }, after: { localStart: '2026-10-11', localEnd: '2026-11-08', days: 28, units: after, gross: after },
  difference: { units: after - before, pct: before > 0 ? Math.round(((after - before) / before) * 10000) / 10000 : null }, ...over });

test('RV-1 what counts as "to review": an applied action whose review date is reached; not a future review, not a plan that was never applied, not a review already recorded', async () => {
  const st = store(); const items = [variantItem(), productItem(), weekdayItem()]; const ui = await open(items, st);
  planAndApply(ui, 'product:pH', { reviewDate: PAST }); // applied, due
  planAndApply(ui, 'product:pP', { reviewDate: FUTURE }); // applied, review in the future
  plan(ui, 'store:weekday:3', { reviewDate: PAST }); // planned, never applied
  const ui2 = await open(items, st); const entry = dueEntry(ui2);
  assert.ok(entry, 'the entry is there'); assert.ok(text(all(entry, (n) => n.tagName === 'SUMMARY')[0]).startsWith('À revoir (1)'), text(all(entry, (n) => n.tagName === 'SUMMARY')[0]));
  assert.equal(entry.getAttribute('open'), null, 'compact: closed by default'); assert.deepEqual(reviewLines(ui2).map((l) => text(all(l, (n) => hasClass(n, 'ex-mover-name'))[0])), ['Mettre en avant « Casque Remax »']);
  // nothing due: no entry at all
  const none = store(); const u3 = await open(items, none); assert.equal(dueEntry(u3), null); plan(u3, 'product:pH', { reviewDate: PAST }); assert.equal(dueEntry(await open(items, none)), null, 'a plan that is not applied is not a review to do');
});

test('RV-2 the line of a review to do: the action, its target, the review date and a direct "Revoir"; the action stays reachable when it left the active list; listed once', async () => {
  const st = store(); const ui = await open([variantItem()], st); planAndApply(ui, 'product:pH', { reviewDate: PAST });
  const gone = await open([], st); const entry = dueEntry(gone); assert.ok(entry, 'the opportunity is gone from the list, its history is not');
  const line = reviewLines(gone)[0]; const t = text(line);
  assert.ok(t.includes('Mettre en avant « Casque Remax »') && t.includes(`Revue prévue le ${PAST}`), t);
  assert.equal(all(all(line, (n) => hasClass(n, 'gv-proofline'))[0], (n) => n.tagName === 'A' && n.getAttribute('data-target') === 'product').length, 1, 'the exact target, on the closed line'); assert.equal(text(all(line, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]), 'Revoir');
  assert.equal(all(gone.root, (n) => hasClass(n, 'gv-action')).length, 1, 'not duplicated in the history of previous opportunities'); assert.ok(!text(gone.root).includes('Opportunités suivies précédemment') || all(gone.root, (n) => hasClass(n, 'gv-action')).length === 1);
  // still active and due: it is both an action of the list (state: applied, button "Revoir") and an entry of the reviews
  const live = await open([variantItem()], st); assert.equal(text(primary(live, 'product:pH')), 'Revoir'); assert.equal(reviewLines(live).length, 1);
});

test('RV-3 isolation: another merchant sees none of these reviews', async () => {
  const st = store(); const ui = await open([variantItem()], st); planAndApply(ui, 'product:pH', { reviewDate: PAST });
  assert.equal(dueEntry(await open([variantItem()], st, { scope: 'merchant-b' })), null); assert.ok(dueEntry(await open([variantItem()], st, { scope: 'merchant-a' })));
  assert.ok([...st.m.keys()].every((k) => k.startsWith('nordla.growth.follow-up.v1:merchant-a:')));
});

test('RV-4 a calculated review: the server comparison is shown (3 before · 5 after · +2 net units), dates, scope, the manual starting value kept apart; the form is prefilled and the result is recorded with the calculation; the entry disappears and the history stays', async () => {
  const st = store(); const calls = []; const ui0 = await open([variantItem()], st); planAndApply(ui0, 'product:pH', { reviewDate: PAST, baseline: 2 });
  const ui = await open([variantItem()], st, { review: (url) => { calls.push(url); return comparable(3, 5); } });
  click(all(reviewLines(ui)[0], (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick();
  assert.equal(calls.length, 1); assert.match(calls[0], /^\/api\/growth\/review\?type=variant&id=gid%3A%2F%2FV%2Fbleu&applied=\d{4}-\d{2}-\d{2}&review=2020-01-01$/); assert.ok(!/merchant/i.test(calls[0]), 'no merchant in the request');
  const line = reviewLines(ui)[0]; const t = text(line);
  for (const s of ['Évolution observée', '3 avant · 5 après · +2 unités nettes', '+66,7 %', 'Avant : ', 'Après : ', '28 jours chacune, jour d’application exclu', 'sans lien de cause démontré', 'Valeur de départ saisie dans le plan : 2 (saisie à la main, distincte du « avant » calculé)', 'Calculé le']) assert.ok(t.includes(s), `${s}\n${t.slice(0, 900)}`);
  const f = form(line, 'review'); assert.equal(named(f, 'observed').getAttribute('value'), '5', 'prefilled with the "after" value'); assert.match(named(f, 'notes').getAttribute('value'), /3 avant · 5 après, sur 28 jours/);
  assert.equal(all(f, (n) => n.tagName === 'SELECT')[0].children.find((o) => o.getAttribute('selected') !== null)?.getAttribute('value'), 'comparable');
  named(f, 'observed').valueAsNumber = 5; named(f, 'notes').value = 'Calculé'; named(f, 'applied').value = '2020-01-02'; all(f, (n) => n.tagName === 'SELECT')[0].value = 'comparable'; submit(f);
  const saved = events(st).find((e) => e.type === 'review'); assert.ok(saved); assert.deepEqual([saved.computed.before.units, saved.computed.after.units, saved.computed.difference.units, saved.baseline, saved.observed], [3, 5, 2, 2, 5]);
  await tick(); assert.equal(dueEntry(ui), null, 'removed from the list once reviewed'); assert.equal(events(st).filter((e) => e.type === 'plan').length, 1, 'the history is kept');
  assert.match(text(ui.root), /Comparable · 3 avant · 5 après · \+2 unités nettes · \+66,7 % \(calculé\)/, 'the recorded result keeps the calculation, labelled as calculated');
});

test('RV-5 a true zero before: the evolution is in units, no percentage', async () => {
  const st = store(); const ui0 = await open([variantItem()], st); planAndApply(ui0, 'product:pH', { reviewDate: PAST });
  const ui = await open([variantItem()], st, { review: () => comparable(0, 5) }); click(all(reviewLines(ui)[0], (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick();
  const t = text(reviewLines(ui)[0]); assert.ok(t.includes('0 avant · 5 après · +5 unités nettes')); assert.ok(!/\d\s?%/.test(t.slice(t.indexOf('0 avant'), t.indexOf('Avant :'))), 'no percentage when the before value is zero');
});

test('RV-6 limits: the reason is said, the numbers (if any) are informative, nothing is prefilled, the manual review stays open - history too short, period not complete, target not found, low volume, service unavailable', async () => {
  const st = store(); const ui0 = await open([variantItem()], st); planAndApply(ui0, 'product:pH', { reviewDate: PAST });
  const cases = [
    [{ ...comparable(1, 1), state: 'LIMITED', limits: ['LOW_VOLUME'] }, 'Volume trop faible pour comparer'],
    [{ ...comparable(3, 5), state: 'LIMITED', limits: ['HISTORY_TOO_SHORT'] }, 'L’historique synchronisé est trop court'],
    [{ state: 'LIMITED', limits: ['PERIOD_NOT_COMPLETE'], before: null, after: null, difference: null, calculatedAt: '2026-11-15T12:00:00.000Z' }, 'Pas encore de période complète'],
    [{ state: 'LIMITED', limits: ['TARGET_NOT_FOUND'], before: null, after: null, difference: null, calculatedAt: '2026-11-15T12:00:00.000Z' }, 'n’est pas retrouvé dans les données synchronisées'],
  ];
  for (const [payload, reason] of cases) {
    const ui = await open([variantItem()], st, { review: () => payload }); click(all(reviewLines(ui)[0], (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick();
    const line = reviewLines(ui)[0]; const t = text(line);
    assert.ok(t.includes('Comparaison non calculable.') && t.includes('La revue reste manuelle') && t.includes(reason), `${reason}\n${t.slice(0, 700)}`);
    assert.equal(named(form(line, 'review'), 'observed').getAttribute('value'), '', 'not prefilled'); assert.ok(!t.includes('Valeur de départ saisie dans le plan'));
  }
  const down = await open([variantItem()], st); click(all(reviewLines(down)[0], (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick();
  assert.ok(text(reviewLines(down)[0]).includes('Le calcul est indisponible pour le moment. La revue reste manuelle.')); assert.ok(form(reviewLines(down)[0], 'review'), 'manual review available');
});

test('RV-7 e-mail, restock and store actions stay manual in this first scope: no request, said plainly; the manual review works', async () => {
  const st = store(); const calls = []; const ui0 = await open([weekdayItem()], st); planAndApply(ui0, 'store:weekday:3', { reviewDate: PAST });
  const ui = await open([weekdayItem()], st, { review: (u) => { calls.push(u); return comparable(1, 2); } }); click(all(reviewLines(ui)[0], (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick();
  assert.equal(calls.length, 0); const line = reviewLines(ui)[0]; assert.ok(text(line).includes('Cette action se revoit à la main dans ce premier périmètre'));
  const f = form(line, 'review'); named(f, 'observed').valueAsNumber = 60; named(f, 'notes').value = 'Jeudi du 12'; named(f, 'applied').value = '2020-01-02'; all(f, (n) => n.tagName === 'SELECT')[0].value = 'comparable'; submit(f);
  const saved = events(st).find((e) => e.type === 'review'); assert.ok(saved && !saved.computed); await tick(); assert.equal(dueEntry(ui), null);
});

test('RV-8 FR / NL / EN: the entry, the line, the calculated result and the limits are worded; no raw key', async () => {
  for (const [lang, probes] of [['nl', ['Te evalueren (1)', 'Evalueren', 'Waargenomen verandering', '3 ervoor · 5 erna · +2 netto-eenheden', 'Evaluatie gepland op']], ['en', ['To review (1)', 'Review', 'Observed change', '3 before · 5 after · +2 net units', 'Review planned for']], ['fr', ['À revoir (1)', 'Revoir', 'Évolution observée', '3 avant · 5 après · +2 unités nettes', 'Revue prévue le']]]) {
    const st = store(); const ui0 = await open([variantItem()], st, { lang }); planAndApply(ui0, 'product:pH', { reviewDate: PAST });
    const ui = await open([variantItem()], st, { lang, review: () => comparable(3, 5) }); click(all(reviewLines(ui)[0], (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick();
    const t = text(ui.root); for (const p of probes) assert.ok(t.includes(p), `${lang}: ${p}`); assert.ok(!/gr\.(review|follow|wk|fiche)\.[\w.]+/.test(t), `${lang}: raw key`);
  }
});

// ---- regression: the calculated change stays what it was calculated, after saving, reloading and reopening; the manual value is shown apart; a manual review keeps comparing the manual values ----
function reviewAs(ui, over = {}) {
  const f = form(reviewLines(ui)[0], 'review'); named(f, 'applied').value = '2020-01-02'; named(f, 'observed').valueAsNumber = over.observed ?? 5; named(f, 'notes').value = over.notes ?? 'Revue';
  all(f, (n) => n.tagName === 'SELECT')[0].value = 'comparable'; submit(f);
}
const NOTHING = { nodeType: 3, data: '' };
/** Edits a recorded review like a merchant: the fields start with their saved values (the harness has no attribute defaults, so they are copied), then one field changes. */
function editReview(ui, id, changes) {
  const f = form(row(ui, id), 'review'); const sel = all(f, (n) => n.tagName === 'SELECT')[0];
  named(f, 'applied').value = named(f, 'applied').getAttribute('value'); named(f, 'observed').valueAsNumber = Number(named(f, 'observed').getAttribute('value')); named(f, 'notes').value = named(f, 'notes').getAttribute('value');
  sel.value = sel.children.find((o) => o.getAttribute('selected') !== null)?.getAttribute('value') ?? '';
  if (changes.notes != null) named(f, 'notes').value = changes.notes; if (changes.observed != null) named(f, 'observed').valueAsNumber = changes.observed; submit(f);
}
const shown = (ui, id) => { const r = row(ui, id); return { line: text(all(r, (n) => hasClass(n, 'gv-review-line'))[0] ?? NOTHING), compare: all(r, (n) => hasClass(n, 'gv-compare')).map(text).join(' | '), all: text(r) }; };
const reopen = async (ui, id) => { click(all(row(ui, id), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick(); return shown(ui, id); };
const openFirstReview = async (ui) => { click(all(reviewLines(ui)[0], (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0]); await tick(); };

test('RV-9 manual 2, calculated 3 before / 5 after: the calculated change is +2 (+66,7 %) after saving, after a reload and after reopening - the same periods, the manual 2 apart, never +3; a changed server answer or an edit does not alter it', async () => {
  const st = store(); const id = 'product:pH'; const ui0 = await open([variantItem()], st); planAndApply(ui0, id, { reviewDate: PAST, baseline: 2, target: 6 });
  const calls = []; const ui = await open([variantItem()], st, { review: (u) => { calls.push(u); return comparable(3, 5); } });
  await openFirstReview(ui); assert.equal(calls.length, 1);
  assert.ok(text(reviewLines(ui)[0]).includes('3 avant · 5 après · +2 unités nettes · +66,7 %') && text(reviewLines(ui)[0]).includes('Valeur de départ saisie dans le plan : 2'), 'while the review is open');
  reviewAs(ui); await tick();
  const WIN = ['Avant : 12 sept. 2026 – 9 oct. 2026', 'Après : 11 oct. 2026 – 7 nov. 2026', '28 jours chacune, jour d’application exclu'];
  const check = (s, where) => {
    assert.ok(s.line.includes('Comparable · 3 avant · 5 après · +2 unités nettes · +66,7 % (calculé)'), `${where} review line: ${s.line}`);
    for (const w of WIN) assert.ok(s.compare.includes(w), `${where}: ${w}\n${s.compare}`);
    assert.ok(s.compare.includes('3 avant · 5 après · +2 unités nettes'), `${where} compare: ${s.compare}`);
    assert.ok(s.compare.includes('Valeur de départ saisie dans le plan : 2 (saisie à la main, distincte du « avant » calculé)'), `${where}: the manual value is apart`);
    assert.ok(s.compare.includes('Enregistré avec la revue'), `${where}: said to be stored`);
    assert.ok(!/\+3\b/.test(s.all), `${where}: the calculated change never becomes +3 (5 after - 2 manual)`);
    assert.ok(!s.all.includes('Variation observée'), `${where}: no manual comparison next to a calculated one`);
  };
  const first = await reopen(ui, id); check(first, 'after saving'); const stored = events(st).find((e) => e.type === 'review');
  assert.deepEqual([stored.computed.before.units, stored.computed.after.units, stored.computed.difference.units, stored.computed.difference.pct, stored.baseline, stored.observed], [3, 5, 2, 0.6667, 2, 5]);
  assert.deepEqual([stored.computed.before.localStart, stored.computed.before.localEnd, stored.computed.after.localStart, stored.computed.after.localEnd, stored.computed.days], ['2026-09-12', '2026-10-10', '2026-10-11', '2026-11-08', 28]);
  // reload, the server now answers different figures (the data moved on): the recorded review does not change and no new calculation is requested
  const calls2 = []; const reloaded = await open([variantItem()], st, { review: (u) => { calls2.push(u); return comparable(4, 9); } });
  check(shown(reloaded, id), 'after reload'); check(await reopen(reloaded, id), 'after reopening'); assert.equal(calls2.length, 0, 'a recorded review is never recalculated');
  assert.ok(text(all(row(reloaded, id), (n) => hasClass(n, 'gr-follow-body'))[0]).includes('3 avant · 5 après · +2 unités nettes · +66,7 % (calculé) · valeur de départ saisie : 2'), 'the history line carries both, apart');
  // editing the notes of the recorded review keeps the calculation untouched
  editReview(reloaded, id, { notes: 'Notes corrigées' }); await tick();
  const edited = events(st).filter((e) => e.type === 'review').at(-1); assert.equal(edited.notes, 'Notes corrigées'); assert.deepEqual(edited.computed, stored.computed, 'the calculation is carried over unchanged'); check(await reopen(reloaded, id), 'after an edit');
});

test('RV-10 a review entered entirely by hand keeps comparing the values the merchant entered (observed - starting value), after saving, reloading and reopening; no calculation is attached to it later', async () => {
  const st = store(); const id = 'store:weekday:3'; const ui0 = await open([weekdayItem()], st); planAndApply(ui0, id, { reviewDate: PAST, baseline: 40, target: 55 });
  const ui = await open([weekdayItem()], st); await openFirstReview(ui); reviewAs(ui, { observed: 55 }); await tick();
  const checkManual = (s, where, delta = '15') => { assert.ok(s.line.includes(`Comparable · Variation observée ${delta}`), `${where}: ${s.line}`); assert.ok(!/avant · \d+ après|\(calculé\)/.test(s.all), `${where}: nothing calculated`); assert.equal(s.compare, '', `${where}: no calculation block`); };
  checkManual(await reopen(ui, id), 'after saving'); const reloaded = await open([weekdayItem()], st, { review: () => comparable(3, 5) }); checkManual(shown(reloaded, id), 'after reload'); checkManual(await reopen(reloaded, id), 'after reopening');
  editReview(reloaded, id, { observed: 60, notes: 'Corrigé' }); await tick();
  const last = events(st).filter((e) => e.type === 'review').at(-1); assert.deepEqual([last.observed, last.baseline, 'computed' in last], [60, 40, false]);
  checkManual(await reopen(reloaded, id), 'after an edit', '20'); // 60 - 40: still the manual comparison
});

test('RV-11 a product review that could not be calculated (low volume) and was entered by hand stays manual: reopening later does not attach a calculation, the manual comparison stays (observed 5 - starting value 2 = 3)', async () => {
  const st = store(); const id = 'product:pH'; const ui0 = await open([variantItem()], st); planAndApply(ui0, id, { reviewDate: PAST, baseline: 2, target: 6 });
  const ui = await open([variantItem()], st, { review: () => ({ ...comparable(1, 1), state: 'LIMITED', limits: ['LOW_VOLUME'] }) }); await openFirstReview(ui); reviewAs(ui, { observed: 5 }); await tick();
  assert.equal('computed' in events(st).find((e) => e.type === 'review'), false);
  const calls = []; const later = await open([variantItem()], st, { review: (u) => { calls.push(u); return comparable(3, 5); } }); const s = await reopen(later, id);
  assert.ok(s.line.includes('Comparable · Variation observée 3'), s.line); assert.equal(s.compare, ''); assert.equal(calls.length, 0);
});
