// The Opportunités screen, dense version: the prioritised actions are compact lines (title, short proof, ONE button), the form and the detail open under the line,
// "Autres actions", "À corriger maintenant" and "À surveiller" are folded with their signal in the closed label. Simulated data, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankWeeklyActions } from '../src/growth/priorities/weekly.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const OK = { products: 'ok', audience: 'ok', store: 'ok', content: 'ok' };
const M = { start: '2026-09-19T22:00:00.000Z', end: '2026-11-14T23:00:00.000Z', calculatedAt: '2026-11-15T10:00:00.000Z' };
const base = prioritiesPayload();
const fxSeg = base.sections.commercial.find((i) => i.kind === 'segment' && i.entity.id === 'reactivate');
const fxProd = base.sections.commercial.find((i) => i.kind === 'product');
const weekday = () => ({ id: 'store:weekday:3', category: 'commercial', kind: 'storeWeekday', title: { code: 'store.weekday.title', params: { day: 3 } }, explanation: { code: 'store.weekday.why', params: {} },
  evidence: { share: 0.367, storeOrders: 52, weeks: 8 }, reliability: 'reliable', entity: { type: 'store', id: 'weekday:3' }, sourcePage: 'storeGrowth', measurement: M, prerequisites: [],
  preparedAction: { code: 'storeWeekday', day: 3 }, target: { type: 'storeWeekday', page: 'storeGrowth', day: 3, location: { mode: 'single', name: 'Habb' }, productValidated: false, available: true } });
const segment = () => ({ ...fxSeg, measurement: M, prerequisites: ['recipientsAndLink'], preparedAction: { code: 'segment', segment: 'reactivate', campaign: { purpose: 'reactivation', customers: 70, days: 90, baselineOrders: 0 } },
  target: { type: 'segment', page: 'audience', id: 'reactivate', available: true } });
const product = () => ({ ...fxProd, id: 'product:pH', entity: { type: 'product', id: 'pH', title: 'Casque Remax' }, measurement: M, prerequisites: [], dataBlocker: null, evidence: { netSales: 99.18 },
  preparedAction: { code: 'variant', target: { id: 'pH', title: 'Casque Remax' }, marginPct: 0.4, variantReason: null, variant: { id: 'v1', title: 'Mauve', unitsNet: 4, stockUnits: 2, stockSnapshotAt: '2026-11-14T23:00:38Z', coverWeeks: 4, minCoverWeeks: 4, since: M.start, until: M.end } },
  target: { type: 'product', page: 'potential', id: 'pH', title: 'Casque Remax', available: true, variantId: 'v1' } });

// the clock is FIXED at the day of the measurements above (M.calculatedAt, 2026-11-15): the screen's "today" no longer depends on the day the suite runs (it failed from 2026-11-16 on)
const NOW = new Date('2026-11-15T12:00:00Z');
const ClockDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); } static now() { return NOW.getTime(); } };
const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
async function open(items, st, lang = 'fr') {
  const opportunities = { ...base, historyScope: 'merchant-a', sections: { ...base.sections, commercial: items }, weekly: rankWeeklyActions(items, { sources: OK }) };
  const ui = await growthDom('#/overview', { lang, opportunities }); ui.ctx.localStorage = st.api; ui.ctx.Date = ClockDate; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui;
}
const row = (ui, id) => all(ui.root, (n) => n.getAttribute?.('data-priority-id') === id)[0];
const primary = (ui, id) => all(row(ui, id), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];
const click = (b) => b.listeners.click[0]();
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, name) => all(f, (n) => n.tagName === 'INPUT').find((n) => n.getAttribute('name') === name);
const panelHidden = (ui, id, name) => all(row(ui, id), (n) => n.getAttribute?.('data-panel') === name)[0].getAttribute('hidden') !== null;
const local = () => { const d = new ClockDate(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** Fills and submits the plan form like a merchant would (the harness has no attribute defaults: the prefilled action and metric are read from the attributes). */
function submitPlan(ui, id, v = {}) {
  const f = form(row(ui, id), 'plan'); const n = (k) => named(f, k);
  n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value');
  if (n('product')) n('product').value = v.product ?? 'Coque Samsung';
  if (n('url')) { n('subject').value = n('subject').getAttribute('value'); n('cta').value = n('cta').getAttribute('value'); n('url').value = v.url ?? 'https://habb.be/collections/coques'; }
  n('baseline').valueAsNumber = v.baseline ?? 1; n('target').valueAsNumber = v.target ?? 3; n('reviewDate').value = '2026-12-15';
  f.listeners.submit[0]({ preventDefault() {} });
}
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);

const isHidden = (n) => n.getAttribute('hidden') !== null;
const lineOf = (ui, id) => all(row(ui, id), (n) => hasClass(n, 'gv-line'))[0];
const bodyOf = (ui, id) => all(row(ui, id), (n) => hasClass(n, 'gv-body'))[0];

test('FI-1 one action (HABB today): ONE compact line, closed - title, short proof, button; nothing else open; the detail is behind the line', async () => {
  const ui = await open([weekday()], store()); const id = 'store:weekday:3'; const t = text(ui.root);
  assert.equal(all(ui.root, (n) => hasClass(n, 'gv-action')).length, 1); assert.equal(all(ui.root, (n) => hasClass(n, 'ex-kpi')).length, 0);
  assert.ok(!t.includes('Autres actions'), 'no "other actions" entry when there is none');
  const line = lineOf(ui, id); const lt = text(line);
  assert.ok(lt.includes('Mettre un produit en avant le jeudi'), lt);
  assert.ok(lt.includes('37 % des ventes magasin le jeudi · 52 commandes analysées'), lt);
  const buttons = all(line, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary')); assert.equal(buttons.length, 1); assert.equal(text(buttons[0]), 'Préparer');
  assert.ok(all(line, (n) => hasClass(n, 'gv-line-action')).length === 1, 'the button sits in its own right-hand cell');
  assert.equal(isHidden(bodyOf(ui, id)), true, 'summary, target, exact dates, detailed proof and steps are not shown until the line is opened');
  assert.ok(!/Fiable|Voir dans Croissance magasin/.test(t));
  const bt = text(bodyOf(ui, id)); for (const s of ['Cible · jeudi · Habb', 'Part des ventes le jeudi', 'Commandes magasin analysées', 'Période observée', ' – ', 'Choisissez le produit à mettre en avant ce jour-là']) assert.ok(bt.includes(s), s);
});

test('FI-2 "Préparer" opens the form under the line; the button then follows the step: mark applied (today), enter the result, edit the result', async () => {
  const st = store(); const ui = await open([weekday()], st); const id = 'store:weekday:3';
  assert.equal(panelHidden(ui, id, 'plan'), true);
  click(primary(ui, id)); assert.equal(isHidden(bodyOf(ui, id)), false, 'the body opens'); assert.equal(panelHidden(ui, id, 'plan'), false, 'with the plan form');
  submitPlan(ui, id, { baseline: 40, target: 55 }); assert.equal(events(st).filter((e) => e.type === 'plan').length, 1);
  assert.ok(text(primary(ui, id)).startsWith('Marquer comme appliquée'), 'plan saved: the next step is to apply it');
  click(primary(ui, id)); const applied = events(st).filter((e) => e.type === 'applied'); assert.equal(applied.length, 1); assert.equal(applied[0].date, local());
  assert.ok(text(primary(ui, id)).startsWith('Revoir')); click(primary(ui, id)); assert.equal(panelHidden(ui, id, 'result'), false);
  const r = form(row(ui, id), 'review'); named(r, 'applied').value = local(); named(r, 'observed').valueAsNumber = 58; named(r, 'notes').value = 'Jeudi comparable';
  all(r, (n) => n.tagName === 'SELECT')[0].value = 'comparable'; r.listeners.submit[0]({ preventDefault() {} });
  assert.ok(text(primary(ui, id)).startsWith('Modifier le résultat'));
  assert.equal(text(all(row(ui, id), (n) => hasClass(n, 'gr-follow-state'))[0]), 'Résultat mesuré');
});

test('FI-3 a campaign with a prerequisite: "Préparer" first, then the check, then "mark as sent"; the draft is under the line, in the form panel', async () => {
  const st = store(); const ui = await open([segment()], st); const id = 'audience:segment:reactivate';
  assert.equal(text(primary(ui, id)), 'Préparer'); assert.ok(text(lineOf(ui, id)).includes('70 clients')); assert.match(named(form(row(ui, id), 'plan'), 'subject').getAttribute('value'), /Cela fait un moment/);
  click(primary(ui, id)); submitPlan(ui, id, { baseline: 0, target: 5 });
  assert.ok(text(primary(ui, id)).startsWith('Destinataires et lien vérifiés')); click(primary(ui, id));
  assert.equal(events(st).filter((e) => e.type === 'prereq').length, 1); assert.ok(text(primary(ui, id)).startsWith('Marquer comme envoyée'));
});

test('FI-4 the store journey is in the right order everywhere: product, starting value, target and review date, save the plan, THEN carry out the action, mark it applied, enter the result', async () => {
  const ui = await open([weekday()], store()); const id = 'store:weekday:3'; const steps = all(all(row(ui, id), (n) => n.tagName === 'OL')[0], (n) => n.tagName === 'LI').map(text);
  assert.equal(steps.length, 4);
  assert.match(steps[0], /Choisissez le produit/); assert.match(steps[1], /valeur de départ.*cible.*date de revue.*enregistrez le plan/); assert.match(steps[2], /réalisez la mise en avant/); assert.match(steps[3], /Marquez l’action comme appliquée.*saisissez le résultat/);
  assert.ok(!/Réalisez la mise en avant le jour recommandé, puis enregistrez le plan/.test(text(ui.root)), 'the old order (act, then save the plan) is gone');
  const names = all(form(row(ui, id), 'plan'), (n) => n.tagName === 'INPUT').map((n) => n.getAttribute('name')); assert.deepEqual(names.slice(0, 4), ['product', 'baseline', 'target', 'reviewDate']);
});

test('FI-5 three prioritised actions: three lines one under the other, ranks 1-3 in the same place; the others folded under "Autres actions"; the ranking is kept', async () => {
  const st = store(); const restock = { ...product(), id: 'product:pR', entity: { type: 'product', id: 'pR', title: 'Spike' }, preparedAction: { code: 'restock', target: { id: 'pR', title: 'Spike' }, marginPct: null }, target: { type: 'product', page: 'potential', id: 'pR', title: 'Spike', available: true, variantId: null } };
  const items = [segment(), weekday(), product(), restock]; const ui = await open(items, st);
  const ranking = rankWeeklyActions(items, { sources: OK }).items.map((i) => i.id);
  const list = all(ui.root, (n) => hasClass(n, 'gv-priorities'))[0]; const lines = all(list, (n) => hasClass(n, 'gv-action'));
  assert.deepEqual(lines.map((l) => l.getAttribute('data-priority-id')), ranking, 'ranking order, in one list');
  assert.deepEqual(lines.map((l) => l.getAttribute('data-weekly-rank')), ['1', '2', '3']);
  assert.ok(ranking.every((id, k) => text(lineOf(ui, id)).includes(`Priorité ${k + 1}`)), 'ranks 2 and 3 are as visible as rank 1');
  assert.ok(all(list, (n) => n.tagName === 'A' && n.getAttribute('data-target')).length >= 1, 'target links are kept');
  const others = all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-others'))[0]; assert.ok(others, 'folded section'); assert.equal(others.getAttribute('open'), null);
  assert.ok(text(all(others, (n) => n.tagName === 'SUMMARY')[0]).includes('Autres actions (1)')); assert.equal(all(others, (n) => hasClass(n, 'gv-action')).length, 1);
  assert.ok(text(ui.root).includes('Pourquoi cette priorité'), 'the reasons of the priority stay reachable');
});

test('FI-6 an action already applied: its state shows on its own line, the button is "Revoir"; the other lines are untouched', async () => {
  const st = store(); let ui = await open([weekday(), segment()], st); const id = 'store:weekday:3';
  click(primary(ui, id)); submitPlan(ui, id, { product: 'X', target: 2 });
  click(primary(ui, id)); // marked applied
  ui = await open([weekday(), segment()], st); // reload
  assert.ok(text(primary(ui, id)).startsWith('Revoir')); assert.match(text(all(lineOf(ui, id), (n) => hasClass(n, 'gr-follow-state'))[0]), /^Appliquée le /);
  assert.equal(text(primary(ui, 'audience:segment:reactivate')), 'Préparer'); assert.equal(text(all(lineOf(ui, 'audience:segment:reactivate'), (n) => hasClass(n, 'gr-follow-state'))[0]), 'Proposition prête');
});

test('FI-7 folded sections: "À corriger maintenant" and "À surveiller" are closed by default with their signal in the label; opening them gives all the details back', async () => {
  const d = prioritiesPayload(); const ui = await growthDom('#/opportunities', { opportunities: d });
  const fix = all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gr-pr-fix'))[0]; const watch = all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gr-pr-watch'))[0];
  assert.ok(fix && watch); assert.equal(fix.getAttribute('open'), null); assert.equal(watch.getAttribute('open'), null);
  const corrections = d.sections.fix.reduce((a, g) => a + g.evidence.count, 0); const label = text(all(fix, (n) => n.tagName === 'SUMMARY')[0]);
  assert.ok(label.includes('À corriger maintenant') && label.includes(`${d.sections.fix.length} catégories`) && label.includes(`${corrections} corrections détectées`), label);
  assert.equal(all(fix, (n) => n.getAttribute?.('data-priority-id')).length, d.sections.fix.length, 'every category is still in the section');
  assert.equal(all(watch, (n) => n.getAttribute?.('data-priority-id')).length, d.sections.watch.length);
  assert.ok(text(all(watch, (n) => n.tagName === 'SUMMARY')[0]).includes(String(d.sections.watch.length)));
});
