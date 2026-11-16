// From a prioritised opportunity: open the exact target, understand the change, confirm the external prerequisite, record that the action was applied, find the review again.
// Simulated data, offline. The follow-up history lives in the merchant's BROWSER (localStorage, one scope per merchant): these tests check it survives a reload, is isolated, never duplicates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { targetOf } from '../src/growth/priorities/targets.js';
import { rankWeeklyActions, prerequisitesOf } from '../src/growth/priorities/weekly.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { growthDom, potentialPayload, audiencePayload, contentPayload, storePayload, prioritiesPayload, text, all, hasClass, NOW } from './growth-dom.js';

const OK = { products: 'ok', audience: 'ok', store: 'ok', content: 'ok' };
const M = { start: '2026-09-19T22:00:00.000Z', end: '2026-11-14T23:00:00.000Z', calculatedAt: '2026-11-15T10:00:00.000Z' };
const base = prioritiesPayload();
const fixtureProduct = base.sections.commercial.find((i) => i.kind === 'product');
const fixtureSegment = base.sections.commercial.find((i) => i.kind === 'segment' && i.entity.id === 'reactivate');
const productItem = (variant) => ({ ...fixtureProduct, id: 'product:pH', entity: { type: 'product', id: 'pH', title: 'Casque Remax' }, measurement: M, prerequisites: [],
  preparedAction: { code: variant ? 'variant' : 'product', target: { id: 'pH', title: 'Casque Remax' }, marginPct: 0.4, variantReason: null,
    variant: variant ? { id: 'gid://shopify/ProductVariant/57206416703836', title: 'Mauve', unitsNet: 4, stockUnits: 2, stockSnapshotAt: '2026-11-14T23:00:38Z', coverWeeks: 4, minCoverWeeks: 4, since: M.start, until: M.end } : null },
  target: { type: 'product', page: 'potential', id: 'pH', title: 'Casque Remax', available: true, variantId: variant ? 'gid://shopify/ProductVariant/57206416703836' : null } });
const segmentItem = () => ({ ...fixtureSegment, measurement: M, prerequisites: ['recipientsAndLink'],
  preparedAction: { code: 'segment', segment: 'reactivate', campaign: { purpose: 'reactivation', customers: 70, days: 90, baselineOrders: 0 } },
  target: { type: 'segment', page: 'audience', id: 'reactivate', available: true } });
const weekdayItem = (location = { mode: 'single', name: 'Habb' }) => ({ id: 'store:weekday:3', category: 'commercial', kind: 'storeWeekday', title: { code: 'store.weekday.title', params: { day: 3 } },
  explanation: { code: 'store.weekday.why', params: {} }, evidence: { share: 0.37, storeOrders: 52, weeks: 8 }, reliability: 'reliable', entity: { type: 'store', id: 'weekday:3' }, sourcePage: 'storeGrowth',
  measurement: M, prerequisites: [], preparedAction: { code: 'storeWeekday', day: 3 }, target: { type: 'storeWeekday', page: 'storeGrowth', day: 3, location, productValidated: false, available: true } });

const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
async function open(items, scope, st, { lang = 'fr', hash = '#/opportunities' } = {}) {
  const opportunities = { ...base, historyScope: scope, sections: { ...base.sections, commercial: items }, weekly: rankWeeklyActions(items, { sources: OK }) };
  const ui = await growthDom('#/overview', { lang, opportunities });
  ui.ctx.localStorage = st.api; await ui.navigate(hash); assert.deepEqual(ui.errors, []); return ui;
}
const row = (ui, id) => all(ui.root, (n) => n.getAttribute?.('data-priority-id') === id)[0];
const form = (scope, name, code) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name && (!code || n.getAttribute('data-prereq') === code))[0];
const inputs = (f) => all(f, (n) => n.tagName === 'INPUT');
const submit = (f) => f.listeners.submit[0]({ preventDefault() {} });
const links = (scope) => all(scope, (n) => n.tagName === 'A' && n.getAttribute('data-target')).map((a) => [a.getAttribute('data-target'), a.getAttribute('href')]);
const stateOf = (ui, id) => text(all(row(ui, id), (n) => hasClass(n, 'gr-follow-state'))[0]);
const events = (st) => [...st.m.values()].flatMap((v) => JSON.parse(v).events);
const named = (f, name) => inputs(f).find((n) => n.getAttribute('name') === name);
/** Every action is its own line with its own form: nothing to select (kept as a check that the action is there). */
function pick(ui, id) { assert.ok(hasClass(row(ui, id), 'gv-action'), `${id} is an action line`); }
function savePlan(ui, id, over = {}) {
  const f = form(row(ui, id), 'plan'); const field = (n) => named(f, n);
  field('action').value = over.action ?? field('action').getAttribute('value'); field('metric').value = over.metric ?? field('metric').getAttribute('value');
  if (field('product')) field('product').value = over.product ?? '';
  if (field('url')) { field('subject').value = field('subject').getAttribute('value'); field('cta').value = field('cta').getAttribute('value'); field('url').value = over.url ?? 'https://habb.be/collections/coques'; }
  field('baseline').valueAsNumber = over.baseline ?? 1; field('target').valueAsNumber = over.target ?? 3; field('reviewDate').value = over.reviewDate ?? '2026-12-15';
  submit(f);
}

test('AT-1 product WITH a variant: the row opens the exact product sheet with the proposed variant; the sheet shows target, change, 4 steps; nothing left to fill that Growth already knows', async () => {
  const st = store(); const ui = await open([productItem(true)], 'merchant-a', st);
  assert.deepEqual(links(row(ui, 'product:pH')).slice(0, 1), [['product', '#/potential?open=pH&variant=gid%3A%2F%2Fshopify%2FProductVariant%2F57206416703836']]);
  const t = text(row(ui, 'product:pH'));
  for (const s of ['Ouvrir la fiche du produit (variante proposée visible)', 'Cible', 'variante proposée visible dans la fiche', 'Étapes', 'Ouvrez la fiche du produit et repérez la variante proposée', 'Proposition prête', 'Mettre en avant « Casque Remax » en montrant la variante « Mauve »']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('Reste à compléter'), 'the link exists: no manual gap');
});

test('AT-2 product WITHOUT a variant: the link has no variant parameter', async () => {
  const ui = await open([productItem(false)], 'merchant-a', store());
  assert.deepEqual(links(row(ui, 'product:pH')).slice(0, 1), [['product', '#/potential?open=pH']]);
  assert.ok(text(row(ui, 'product:pH')).includes('Ouvrir la fiche du produit'));
});

test('AT-3 campaign with a prerequisite: opens the segment in Audience, the draft stays in the sheet, the check needs a saved plan, is confirmed for THAT plan revision', async () => {
  const st = store(); const ui = await open([segmentItem()], 'merchant-a', st); const id = 'audience:segment:reactivate';
  assert.deepEqual(links(row(ui, id)), [['segment', '#/audience?open=reactivate']]);
  const t = text(row(ui, id));
  assert.ok(t.includes('Brouillon d’e-mail') && t.includes('Enregistrez d’abord le plan pour confirmer'));
  assert.match(named(form(row(ui, id), 'plan'), 'subject').getAttribute('value'), /Cela fait un moment/, 'the draft subject is a field of the plan form');
  assert.equal(form(row(ui, id), 'prereq', 'recipientsAndLink').listeners?.submit?.length ?? 0, 1);
  assert.equal(all(row(ui, id), (n) => n.tagName === 'BUTTON' && text(n).startsWith('Destinataires et lien vérifiés')).length, 0, 'no confirm button before the plan exists');
  savePlan(ui, id);
  assert.ok(all(row(ui, id), (n) => n.tagName === 'BUTTON' && text(n).startsWith('Destinataires et lien vérifiés')).length >= 1, 'the primary button is now the check');
  submit(form(row(ui, id), 'prereq', 'recipientsAndLink'));
  const plan = events(st).find((e) => e.type === 'plan'); const conf = events(st).find((e) => e.type === 'prereq');
  assert.deepEqual([conf.code, conf.planAt], ['recipientsAndLink', plan.at]);
  assert.ok(text(row(ui, id)).includes('Destinataires et lien vérifiés pour ce plan.') && text(row(ui, id)).includes('ne voit pas cette confirmation'));
  submit(form(row(ui, id), 'prereq', 'recipientsAndLink')); assert.equal(events(st).filter((e) => e.type === 'prereq').length, 1, 'confirming twice records once');
});

test('AT-4 store action: the day, the location when identified, the steps; no product validated so the merchant chooses it (required in the plan)', async () => {
  for (const [location, probe] of [[{ mode: 'single', name: 'Habb' }, 'jeudi · Habb'], [{ mode: 'several', count: 2 }, 'Tous les magasins (2)'], [null, 'Non identifié par les données']]) {
    const st = store(); const ui = await open([weekdayItem(location)], 'merchant-a', st); const id = 'store:weekday:3';
    const t = text(row(ui, id));
    for (const s of ['Cible · jeudi', probe, 'Produit à mettre en avant : à choisir', 'Choisissez le produit à mettre en avant ce jour-là', 'Reste à compléter']) assert.ok(t.includes(s), s);
    assert.deepEqual(links(row(ui, id)), [], 'no link: the target is a day in a store');
    savePlan(ui, id, { product: '' }); assert.equal(events(st).length, 0, 'the product to feature is required for a store action');
    savePlan(ui, id, { product: 'Coque Samsung' }); assert.equal(events(st).find((e) => e.type === 'plan').product, 'Coque Samsung');
  }
});

test('AT-5 target unavailable: no link, a clear message, the manual steps and what is left to complete', async () => {
  const item = productItem(true); item.target = { ...item.target, available: false, variantId: null };
  const ui = await open([item], 'merchant-a', store()); const t = text(row(ui, 'product:pH'));
  assert.deepEqual(links(row(ui, 'product:pH')), []);
  for (const s of ['La cible ne peut pas être ouverte dans Growth', 'Suivez les étapes à la main', 'Étapes', 'Reste à compléter', 'La page ou l’emplacement où mettre le produit en avant']) assert.ok(t.includes(s), s);
});

test('AT-6 the server describes the target with Growth ids; a product missing from the engine list, or a missing variant, is unavailable', async () => {
  const row0 = { id: 'p', variants: [{ id: 'v1' }] };
  const item = { kind: 'product', preparedAction: { code: 'variant', target: { id: 'p', title: 'P' }, variant: { id: 'v1' } } };
  assert.deepEqual(targetOf(item, { productRow: row0 }), { type: 'product', page: 'potential', id: 'p', title: 'P', available: true, variantId: 'v1' });
  assert.deepEqual(targetOf(item, { productRow: { id: 'p', variants: [] } }).variantId, null);
  assert.equal(targetOf(item, { productRow: null }).available, false);
  const seg = { kind: 'segment', preparedAction: { code: 'segment', segment: 'reactivate' } };
  assert.equal(targetOf(seg, { audience: { segments: [{ key: 'reactivate' }] } }).available, true); assert.equal(targetOf(seg, { audience: { segments: [] } }).available, false);
  const day = { kind: 'storeWeekday', preparedAction: { code: 'storeWeekday', day: 3 } };
  assert.deepEqual(targetOf(day, { store: { locations: [{ known: true, name: 'Habb' }, { known: false, name: null }] } }).location, { mode: 'single', name: 'Habb' });
  assert.deepEqual(targetOf(day, { store: { locations: [{ known: true, name: 'A' }, { known: true, name: 'B' }] } }).location, { mode: 'several', count: 2 });
  assert.equal(targetOf(day, { store: { locations: [{ known: true, name: null }] } }).location, null);
  assert.deepEqual([prerequisitesOf({ code: 'segment' }), prerequisitesOf({ code: 'restock' }), prerequisitesOf({ code: 'variant' }), prerequisitesOf(null)], [['recipientsAndLink'], ['supplierLeadTime'], [], []]);
  // through the HTTP handler
  const handler = createGrowthApp({ now: () => NOW, merchantId: 'm', productPotential: async () => potentialPayload(), audience: async () => audiencePayload(), content: async () => contentPayload(), store: async () => storePayload() });
  let body; await handler({ method: 'GET', url: '/api/growth/opportunities' }, { writeHead() {}, end(j) { body = JSON.parse(j); } });
  for (const i of body.sections.commercial.filter((x) => x.preparedAction)) { assert.ok(i.target, i.id); assert.deepEqual(i.prerequisites, prerequisitesOf(i.preparedAction)); }
  assert.equal(body.sections.commercial.find((i) => i.kind === 'segment').target.available, true);
});

test('AT-7 mark as applied: records the date and the plan revision, once; survives a reload; the date can be corrected without a duplicate; the review date and the result path are shown', async () => {
  const st = store(); let ui = await open([weekdayItem()], 'merchant-a', st); const id = 'store:weekday:3';
  assert.ok(text(row(ui, id)).includes('Enregistrez d’abord le plan'), 'applying needs a plan revision');
  savePlan(ui, id, { product: 'Coque Samsung' }); const plan = events(st).find((e) => e.type === 'plan');
  const f = form(row(ui, id), 'applied'); assert.ok(text(f).includes('Marquer comme appliquée'));
  inputs(f)[0].value = '2026-11-10'; submit(f);
  let applied = events(st).filter((e) => e.type === 'applied'); assert.equal(applied.length, 1); assert.deepEqual([applied[0].date, applied[0].planAt, applied[0].prerequisites], ['2026-11-10', plan.at, 'none']);
  let t = text(row(ui, id)); for (const s of ['Appliquée le 2026-11-10 (déclarée par vous)', 'Revue prévue le 2026-12-15', 'Corriger la date', 'Ce qui s’est passé']) assert.ok(t.includes(s), s);
  const again = form(row(ui, id), 'applied'); inputs(again)[0].value = '2026-11-10'; submit(again); submit(again); // double click
  assert.equal(events(st).filter((e) => e.type === 'applied').length, 1); assert.ok(text(row(ui, id)).includes('Déjà enregistré'));
  ui = await open([weekdayItem()], 'merchant-a', st); // reload
  assert.equal(events(st).filter((e) => e.type === 'applied').length, 1); assert.ok(text(row(ui, id)).includes('Appliquée le 2026-11-10'));
  const fix = form(row(ui, id), 'applied'); inputs(fix)[0].value = '2026-11-11'; submit(fix);
  applied = events(st).filter((e) => e.type === 'applied'); assert.deepEqual(applied.map((a) => a.date), ['2026-11-10', '2026-11-11']);
  assert.ok(text(row(ui, id)).includes('Appliquée le 2026-11-11') && text(row(ui, id)).includes('Date corrigée'));
  const future = form(row(ui, id), 'applied'); inputs(future)[0].value = '2999-01-01'; submit(future); assert.equal(events(st).filter((e) => e.type === 'applied').length, 2, 'a future date is refused');
});

test('AT-8 three different things: proposal ready, applied (declared), measured; a plan change keeps the application bound to its OWN revision', async () => {
  const st = store(); const ui = await open([productItem(true)], 'merchant-a', st); const id = 'product:pH';
  assert.equal(stateOf(ui, id), 'Proposition prête');
  savePlan(ui, id); assert.equal(stateOf(ui, id), 'Plan enregistré, non appliqué');
  const f = form(row(ui, id), 'applied'); inputs(f)[0].value = '2026-11-10'; submit(f);
  assert.equal(stateOf(ui, id), 'Appliquée le 2026-11-10 (déclarée par vous)');
  savePlan(ui, id, { target: 5 }); // the plan is revised after the application
  const t = text(row(ui, id)); assert.ok(t.includes('Le plan a été modifié depuis la version du') && t.includes('Marquer comme appliquée'), 'applying the new revision is a new act');
  const review = form(row(ui, id), 'review'); const [d, observed, notes] = inputs(review); d.value = '2026-11-10'; observed.valueAsNumber = 3; notes.value = 'Mêmes durées';
  all(review, (n) => n.tagName === 'SELECT')[0].value = 'comparable'; submit(review);
  assert.equal(stateOf(ui, id), 'Résultat mesuré');
});

test('AT-9 a confirmed prerequisite follows the plan revision: kept when only figures change, asked again when the action it was about changes', async () => {
  const st = store(); const ui = await open([segmentItem()], 'merchant-a', st); const id = 'audience:segment:reactivate'; const conf = () => text(form(row(ui, id), 'prereq', 'recipientsAndLink')).includes('Destinataires et lien vérifiés pour ce plan.'); // the history also lists past confirmations: read the check itself
  savePlan(ui, id); submit(form(row(ui, id), 'prereq', 'recipientsAndLink')); assert.ok(conf());
  savePlan(ui, id, { target: 9, baseline: 2, reviewDate: '2027-01-10' }); assert.ok(conf(), 'figures and review date do not concern the prerequisite');
  savePlan(ui, id, { action: 'Envoyer à tous les clients inactifs, lien vers la page promo' });
  assert.ok(!conf() && text(form(row(ui, id), 'prereq', 'recipientsAndLink')).includes('Le plan a changé depuis la dernière confirmation : à reconfirmer'));
  submit(form(row(ui, id), 'prereq', 'recipientsAndLink')); assert.ok(conf());
  assert.equal(events(st).filter((e) => e.type === 'prereq').length, 2);
  // applying with an unconfirmed prerequisite is possible but recorded as such
  savePlan(ui, id, { metric: 'Commandes du segment sur 30 jours' });
  const f = form(row(ui, id), 'applied'); inputs(f)[0].value = '2026-11-10'; submit(f);
  assert.equal(events(st).filter((e) => e.type === 'applied').at(-1).prerequisites, 'unconfirmed'); assert.ok(text(row(ui, id)).includes('vérifications extérieures n’étaient pas toutes confirmées'));
});

test('AT-10 the ranking can use a confirmation (pure option): confirmed = immediate; the HTTP endpoint passes none (server ranking does not see the browser history)', () => {
  const day = { ...weekdayItem(), preparedAction: { code: 'storeWeekday', day: 3 } }; const seg = segmentItem(); seg.id = 'audience:segment:reactivate'; seg.evidence = { customers: 70 };
  const plain = rankWeeklyActions([day, seg], { sources: OK }); assert.deepEqual(plain.items.map((i) => i.level), [1, 2]);
  const confirmed = rankWeeklyActions([day, seg], { sources: OK, confirmed: new Set([seg.id]) }); assert.deepEqual(confirmed.items.map((i) => i.level), [1, 1]);
  assert.deepEqual(confirmed.items[1].reasons.feasibility, { code: 'immediate', confirmed: true });
  assert.equal(confirmed.items[1].reasons.tie, 'displayOrder');
});

test('AT-11 isolation by merchant and persistence: another merchant does not see the application; the applied action stays reachable when the opportunity leaves the active list', async () => {
  const st = store(); let ui = await open([weekdayItem()], 'merchant-a', st); const id = 'store:weekday:3';
  savePlan(ui, id, { product: 'Coque Samsung' }); const f = form(row(ui, id), 'applied'); inputs(f)[0].value = '2026-11-10'; submit(f);
  const other = await open([weekdayItem()], 'merchant-b', st); assert.ok(text(row(other, id)).includes('Proposition prête') && !text(other.root).includes('Appliquée le 2026-11-10'));
  assert.ok([...st.m.keys()].every((k) => k.startsWith('nordla.growth.follow-up.v1:merchant-a:')));
  const gone = await open([], 'merchant-a', st); const t = text(gone.root);
  assert.ok(t.includes('Opportunités suivies précédemment') && t.includes('Appliquée le 2026-11-10 (déclarée par vous)') && t.includes('Revue prévue le'), t.slice(0, 200));
  assert.ok(!text((await open([], 'merchant-b', st)).root).includes('Opportunités suivies précédemment'));
});

test('AT-12 FR / NL / EN: every new message is worded (no raw key), including the steps and the states', async () => {
  for (const [lang, probes] of [['nl', ['Doel', 'Stappen', 'Voorstel klaar', 'Datum corrigeren']], ['en', ['Target', 'Steps', 'Proposal ready', 'Correct the date']], ['fr', ['Cible', 'Étapes', 'Proposition prête', 'Corriger la date']]]) {
    const st = store(); const ui = await open([productItem(true), segmentItem(), weekdayItem()], 'merchant-a', st, { lang });
    pick(ui, 'audience:segment:reactivate'); savePlan(ui, 'audience:segment:reactivate'); pick(ui, 'store:weekday:3'); savePlan(ui, 'store:weekday:3', { product: 'X' });
    const f = form(row(ui, 'store:weekday:3'), 'applied'); inputs(f)[0].value = '2026-11-10'; submit(f);
    const t = text(ui.root); for (const p of probes) assert.ok(t.includes(p), `${lang}: ${p}`);
    assert.ok(!/gr\.(follow|pp|au|op|wk)\.[\w.]+/.test(t), `${lang}: raw key`);
  }
});

test('AT-13 deep links: the product sheet opens on #/potential?open=<id> with the proposed variant marked; the segment opens on #/audience?open=<key>; an unknown id is said, not ignored', async () => {
  const p = potentialPayload(); const r0 = p.rows[0];
  r0.variants = [{ id: 'gid://shopify/ProductVariant/1', title: 'Mauve', unitsGross: 4, unitsRefunded: 0, unitsCancelled: 0, unitsNet: 4, stock: { usable: true, state: 'OK', units: 2, snapshotAt: '2026-11-14T23:00:00Z', locations: [{ name: 'Habb', quantity: 2 }] }, cover: { status: 'CALCULATED', weeks: 4, minWeeks: 4 } },
    { id: 'gid://shopify/ProductVariant/2', title: 'Bleu', unitsGross: 1, unitsRefunded: 0, unitsCancelled: 0, unitsNet: 1, stock: { usable: true, state: 'OK', units: 6, snapshotAt: '2026-11-14T23:00:00Z', locations: [{ name: 'Habb', quantity: 6 }] }, cover: { status: 'NO_DEMAND_OBSERVED' } }];
  p.variantWindow = { since: p.window.start, until: p.window.end, days: 56 };
  const open1 = await growthDom(`#/potential?open=${encodeURIComponent(r0.id)}&variant=${encodeURIComponent('gid://shopify/ProductVariant/1')}`, { products: p });
  const drawer = all(open1.root, (n) => hasClass(n, 'gr-pp-drawer'))[0]; assert.ok(drawer, 'the sheet is open'); assert.ok(text(drawer).includes(r0.title));
  const proposed = all(drawer, (n) => hasClass(n, 'gr-pp-var-proposed')); assert.equal(proposed.length, 1); assert.ok(text(proposed[0]).includes('Mauve') && text(proposed[0]).includes('Variante proposée'));
  const missing = await growthDom('#/potential?open=nope', { products: p }); assert.ok(text(missing.root).includes('n’est pas dans la liste actuelle de Produits Potentiels')); assert.equal(all(missing.root, (n) => hasClass(n, 'gr-pp-drawer')).length, 0);
  const a = audiencePayload(); const key = a.segments.find((s) => s.customers > 0).key;
  const seg = await growthDom(`#/audience?open=${key}`, { audience: a }); assert.ok(all(seg.root, (n) => hasClass(n, 'gr-pp-drawer'))[0], 'the segment sheet is open');
  const segMissing = await growthDom('#/audience?open=nope', { audience: a }); assert.ok(text(segMissing.root).includes('n’est pas dans la liste actuelle d’Audience'));
});
