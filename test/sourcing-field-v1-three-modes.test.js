// P0 THREE-MODE STATE DIVERGENCE. Conversation / Terrain, Expert / Quick and Salon are three views and controllers over ONE case. This test seeds one case once, reads it through the REAL screens of the
// three modes (the HTML each of them renders), asserts they show the same facts, then changes one fact through each mode (with the exact event that mode dispatches) and asserts the other two follow at once.
// It also pins: provenance (a shown / prefilled / reloaded value never becomes USER_PROVIDED; "corrected by you" needs an explicit event), the audit and repair of the Remax case, and the photo / document observation seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './sourcing-ui-load.js';
import { loadSalonViews } from './sourcing-salon-load.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { upgradeCase } from '../src/sourcing/core/upgrade.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { offerDraft } from '../src/sourcing/core/field/offer-import.js';
import { caseFacts, factOf, factValues, auditCase, expertQuote, SOURCE_TYPE, REVIEW_STATUS, FACT_TYPES } from '../src/sourcing/core/case-facts.js';
import { quoteFormEvent, quickQuoteEvent } from '../src/sourcing/core/form-events.js';

const { factRows } = await loadUi('screens/fieldfirst.js');
const { quickScreen } = await loadUi('screens/quick.js');
const { moneyScreen } = await loadUi('screens/money.js');
const { caseScreen } = await loadUi('screens/case.js');
const { S } = await loadUi('state.js');
const V = await loadSalonViews();

const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
const REMAX = 'Model FC02. prix 11 $, moq 24pc, FOB Ningbo, lead time 20 days, 3 couleurs blue, white en black. puissance 45W, 20000mAh. 4 sortie. déjà on stock.';
const engine = createFieldEngine({ profile: null, externals: () => ({}), now: () => at(900) });

// ---- the case, seeded ONCE, the way Terrain does it: a conversation item from the supplier, every clean candidate confirmed one by one --------------------------------------------------------
function seed() {
  let c = newCase({ id: 'remax', name: 'batterie externe', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Remax' } }, at(0));
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Remax', lang: 'auto' }, at(1)); const conv = c.conversations.find((x) => x.status === 'OPEN');
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text: REMAX }, at(2));
  for (const k of c.candidates.filter((x) => x.state === 'PROPOSED' && !x.needsCorrection)) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(3));
  return c;
}

// ---- what each mode SHOWS ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const inputVal = (html, name) => { const m = new RegExp(`<input name="${name}" value="([^"]*)"`).exec(html); return m ? m[1] : null; };
const selectVal = (html, name) => { const m = new RegExp(`<select name="${name}">([\\s\\S]*?)</select>`).exec(html); const sel = m && /<option value="([^"]*)" selected>/.exec(m[1]); return sel ? sel[1] : null; };
const textOf = (html, label, cls) => { const m = new RegExp(`<span class="fm-l">${label}</span><span class="fm-v"><b>([^<]*)</b>`).exec(html); return m ? m[1] : null; };
const numberIn = (t) => (t === null ? null : (/(-?\d+(?:\.\d+)?)/.exec(t) ?? [])[1] ?? null);
const nul = (x) => (x === undefined || x === '' || x === 'inconnu' ? null : x);
const norm = (o) => ({ price: nul(o.price ?? null), currency: nul(o.currency ?? null), moq: nul(o.moq ?? null) === null ? null : String(Number(o.moq)), incoterm: nul(o.incoterm ?? null), leadDays: nul(o.leadDays ?? null), model: nul(o.model ?? null) });

const readTerrain = (c) => { const h = factRows(c).join(''); const price = textOf(h, 'Prix indicatif'); return norm({ price: numberIn(price), currency: price ? (/\b(USD|CNY|EUR)\b/.exec(price) ?? [])[1] ?? null : null, moq: numberIn(textOf(h, 'MOQ')), incoterm: textOf(h, 'Incoterm'), leadDays: numberIn(textOf(h, 'Délai de production')), model: textOf(h, 'Référence') }); };
const readExpert = (c) => { const A = assess(c, { now: at(900), externals: {} }); const q = quickScreen(A, c); const m = moneyScreen(A, c); const k = caseScreen(A, c); return norm({ price: inputVal(q, 'unitPrice'), currency: selectVal(q, 'currency'), moq: inputVal(q, 'moq'), incoterm: inputVal(q, 'incoterm'), leadDays: inputVal(m, 'leadTimeDays'), model: inputVal(k, 'model') }); };
const factsPane = (c) => V.factsHtml({ facts: caseFacts(c), audit: auditCase(c), observations: c.factObservations ?? [], editing: null, caseId: c.id });
const salonCell = (html, label) => { const m = new RegExp(`<li[^>]*><div class="sl-fh"><b>${label}</b>(?:(?!</li>)[\\s\\S])*?<div class="sl-fv">([^<]*)</div>`).exec(html); return m ? m[1] : null; }; // inside the SAME list item: an unknown fact has no value cell
const readSalon = (c) => { const h = factsPane(c); const v = engine.caseView(c, null); const price = salonCell(h, 'Prix unitaire'); const lead = salonCell(h, 'Délai de production');
  // the Salon ALSO reads the numbers engines (deal) and the fiche: they must agree with the facts pane
  const d = v.deal.quoted; assert.equal(String(d.unitPrice ?? ''), String(numberIn(price) ?? ''), 'Salon deal and Salon facts agree on the price'); assert.equal(String(d.moq ?? ''), String(numberIn(salonCell(h, 'Minimum de commande \\(MOQ\\)')) ?? ''), 'Salon deal and Salon facts agree on the MOQ');
  return norm({ price: numberIn(price), currency: salonCell(h, 'Devise'), moq: numberIn(salonCell(h, 'Minimum de commande \\(MOQ\\)')), incoterm: salonCell(h, 'Incoterm'), leadDays: numberIn(lead), model: salonCell(h, 'Modèle') }); };
const authoritative = (c) => { const v = factValues(c); const days = v.LEAD_TIME && typeof v.LEAD_TIME === 'object' ? v.LEAD_TIME.max : v.LEAD_TIME; return norm({ price: v.PRICE, currency: v.CURRENCY, moq: v.MOQ, incoterm: v.INCOTERM, leadDays: days, model: v.MODEL }); };
function sameEverywhere(c, label) {
  const a = authoritative(c); const t = readTerrain(c); const e = readExpert(c); const s = readSalon(c);
  assert.deepEqual(t, a, `${label}: TERRAIN differs from the authoritative facts`); assert.deepEqual(e, a, `${label}: EXPERT differs from the authoritative facts`); assert.deepEqual(s, a, `${label}: SALON differs from the authoritative facts`);
  return a;
}

// ---- what each mode WRITES (the exact event the mode dispatches) --------------------------------------------------------------------------------------------------------------------------------------
const byTerrain = (c, factType, value, m) => dispatch(c, { type: 'FACT_CORRECT', factType, value, mode: 'terrain' }, at(m));
const bySalon = (c, factType, value, m) => dispatch(c, { type: 'FACT_CORRECT', factType, value, mode: 'salon' }, at(m));
// Expert: the owner opens Quick, the form is prefilled from the case, the owner changes ONE field and saves
function byExpertQuick(c, change, m) { const q = expertQuote(c); const d = { name: c.identity.workingName, category: '', unitPrice: q.unitPrice ?? '', currency: q.currency ?? 'USD', moq: q.moq ?? '', qty: q.qty ?? '', incoterm: q.incoterm ?? '', ...change }; return dispatch(c, quickQuoteEvent(d), at(m)); }
function byExpertMoney(c, change, m) { const q = expertQuote(c); const d = { unitPrice: q.unitPrice ?? '', currency: q.currency ?? 'USD', moq: q.moq ?? '', qty: q.qty ?? '', incoterm: q.incoterm ?? '', leadTimeDays: q.leadTimeDays ?? '', carton: '', ...change }; return dispatch(c, quoteFormEvent(d), at(m)); }

test('1. ONE seed, THREE modes: Terrain, Expert and Salon show identical authoritative facts', () => {
  const c = seed(); const a = sameEverywhere(c, 'seed');
  assert.deepEqual(a, { price: '11', currency: 'USD', moq: '24', incoterm: 'FOB', leadDays: '20', model: 'FC02' });
  const f = Object.fromEntries(caseFacts(c).map((x) => [x.fact_type, x])); assert.deepEqual(f.POWER.value, { amount: 45, unit: 'W' }); assert.equal(f.OUTPUT_COUNT.value, '4'); assert.deepEqual(f.COLOURS.value, ['blue', 'white', 'black']); assert.equal(f.STOCK_STATUS.value, 'IN_STOCK');
  for (const x of Object.values(f)) { assert.equal(x.source_type, SOURCE_TYPE.SUPPLIER_CLAIM, `${x.fact_type} is a supplier claim`); assert.equal(x.review_status, REVIEW_STATUS.CONFIRMED); assert.ok(x.created_at && x.revision === 1 && x.supersedes === null && x.superseded_by === null && x.source_reference.itemId); }
  assert.equal(f.MOQ.unit, 'pcs'); assert.equal(f.PRICE.currency, 'USD'); assert.equal(f.MOQ.source_reference.rawText, 'moq 24pc');
});

test('2. a change made in TERRAIN reaches Expert and Salon; in EXPERT reaches Terrain and Salon; in SALON reaches Terrain and Expert (value, source, review status)', () => {
  let c = seed();
  c = byTerrain(c, 'MOQ', '30', 10); let a = sameEverywhere(c, 'after Terrain'); assert.equal(a.moq, '30'); let f = factOf(c, 'MOQ'); assert.equal(f.source_type, SOURCE_TYPE.USER_PROVIDED); assert.equal(f.review_status, REVIEW_STATUS.CORRECTED); assert.equal(f.source_reference.mode, 'terrain'); assert.equal(f.revision, 2);
  c = byExpertQuick(c, { moq: '40' }, 20); a = sameEverywhere(c, 'after Expert'); assert.equal(a.moq, '40'); f = factOf(c, 'MOQ'); assert.equal(f.source_type, SOURCE_TYPE.USER_PROVIDED); assert.equal(f.source_reference.mode, 'expert'); assert.equal(f.revision, 3);
  c = bySalon(c, 'MOQ', '50', 30); a = sameEverywhere(c, 'after Salon'); assert.equal(a.moq, '50'); f = factOf(c, 'MOQ'); assert.equal(f.source_reference.mode, 'salon'); assert.equal(f.revision, 4);
  // nothing was overwritten: the four values are all in the history, in order, each with who and when
  assert.deepEqual(f.history.map((h) => String(h.value)), ['24', '30', '40', '50']); assert.deepEqual(f.history.map((h) => h.source_type), ['SUPPLIER_CLAIM', 'USER_PROVIDED', 'USER_PROVIDED', 'USER_PROVIDED']); assert.equal(f.history[3].supersedes, f.history[2].ledger_id);
  // every other fact kept its own source
  assert.equal(factOf(c, 'PRICE').source_type, SOURCE_TYPE.SUPPLIER_CLAIM);
  // each mode can change each editable fact and the others follow
  for (const [type, value, key] of [['PRICE', '9.5', 'price'], ['CURRENCY', 'EUR', 'currency'], ['INCOTERM', 'EXW', 'incoterm'], ['MODEL', 'FC02-B', 'model'], ['LEAD_TIME', '35', 'leadDays']]) { for (const [name, fn] of [['terrain', byTerrain], ['salon', bySalon]]) { c = fn(c, type, value, 40); const x = sameEverywhere(c, `${name} ${type}`); assert.equal(x[key], value, `${name} ${type}`); value === 'EUR' && (c = fn(c, 'CURRENCY', 'USD', 41)); } }
  c = byExpertMoney(c, { leadTimeDays: '28', incoterm: 'DAP' }, 50); a = sameEverywhere(c, 'expert money form'); assert.equal(a.leadDays, '28'); assert.equal(a.incoterm, 'DAP'); assert.equal(factOf(c, 'LEAD_TIME').source_type, SOURCE_TYPE.USER_PROVIDED);
  c = dispatch(c, { type: 'IDENTIFIER', origin: 'expert', name: 'model', value: 'FC02-C' }, at(60)); a = sameEverywhere(c, 'expert product form'); assert.equal(a.model, 'FC02-C'); assert.equal(factOf(c, 'MODEL').source_reference.mode, 'expert');
  // the engines the three modes share use the same numbers
  const v = engine.caseView(c, null); assert.equal(String(v.deal.quoted.moq), '50'); assert.equal(String(assess(c, { now: at(900), externals: {} }).landed.inputs?.supplier?.moq ?? '50'), '50');
});

test('3. PROVENANCE: showing, prefilling, saving unchanged, parsing, reloading and merging NEVER make a fact USER_PROVIDED; only an explicit event or a typed change does', () => {
  const c0 = seed(); const before = JSON.stringify(caseFacts(c0).map((f) => [f.fact_type, f.source_type, f.review_status, f.revision]));
  // rendering every mode reads without writing
  readTerrain(c0); readExpert(c0); readSalon(c0); V.caseHtml({ info: { caseId: c0.id, title: 'x', supplier: 'Remax', sample: { status: 'NONE' }, numbers: {} }, tab: 'facts', v: engine.caseView(c0, null), history: null, factsView: { facts: caseFacts(c0), audit: auditCase(c0), observations: [], editing: 'MOQ', caseId: c0.id } });
  assert.equal(JSON.stringify(caseFacts(c0).map((f) => [f.fact_type, f.source_type, f.review_status, f.revision])), before, 'reading changes nothing');
  // the Quick form, prefilled from the case, saved again WITHOUT touching a field: no edit, no ledger entry, same sources
  const ledgerLen = c0.ledger.length; let c = byExpertQuick(c0, {}, 20); assert.equal(c.ledger.length, ledgerLen, 'no ledger entry for a prefilled value saved again'); for (const f of caseFacts(c)) assert.notEqual(f.source_type, SOURCE_TYPE.USER_PROVIDED, `${f.fact_type} stayed the supplier's`);
  c = byExpertMoney(c0, {}, 21); assert.equal(c.ledger.length, ledgerLen); for (const f of caseFacts(c)) assert.notEqual(f.source_type, SOURCE_TYPE.USER_PROVIDED);
  // typed changes: only the changed field becomes the owner's
  c = byExpertQuick(c0, { moq: '30' }, 22); assert.deepEqual(caseFacts(c).filter((f) => f.source_type === SOURCE_TYPE.USER_PROVIDED).map((f) => f.fact_type), ['MOQ']);
  // store / reload / merge: JSON round trip and the upgrade used when a phone reopens a stored case
  for (const x of [c0, c]) { const back = upgradeCase(JSON.parse(JSON.stringify(x))); assert.deepEqual(caseFacts(back).map((f) => [f.fact_type, f.value, f.source_type, f.review_status, f.revision]), caseFacts(x).map((f) => [f.fact_type, f.value, f.source_type, f.review_status, f.revision])); }
  // a supplier statement confirmed in Terrain is NOT "corrected by you" in the Salon
  const draft = engine.caseView(c0, null); assert.ok(draft); assert.ok(!/corrigé par vous/.test(factsPane(c0)));
  // the candidate view says "corrected" only for a candidate the owner explicitly corrected
  let d = seed(); const cand = d.candidates.find((x) => x.key === 'quote.moq'); assert.equal(cand.state, 'CONFIRMED'); assert.equal(cand.correctedValue, undefined);
});

test('4. REVIEW correction and a conflicting SUPPLIER update: every mode follows, nothing forks', () => {
  // a pasted offer in the Salon, one fact corrected in the review (explicit CANDIDATE_CORRECT)
  let c = newCase({ id: 'r2', name: 'batterie externe', now: T0 }); c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: REMAX, supplier: 'Remax' }, at(1));
  for (const k of c.candidates.filter((x) => !x.needsCorrection && x.key !== 'quote.moq')) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(2));
  const moq = c.candidates.find((x) => x.key === 'quote.moq'); c = dispatch(c, { type: 'CANDIDATE_CORRECT', id: moq.id, value: '25' }, at(3));
  const a = sameEverywhere(c, 'after review correction'); assert.equal(a.moq, '25'); const f = factOf(c, 'MOQ'); assert.equal(f.review_status, REVIEW_STATUS.CORRECTED); assert.equal(f.source_type, SOURCE_TYPE.USER_PROVIDED); assert.equal(f.provenance.original.value, '24'); assert.equal(f.source_reference.candidateId, moq.id);
  // the supplier sends an UPDATED offer (negotiable terms move: a revision, not a contradiction)
  c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'Model FC02. prix 10 $, moq 20pc, FOB Ningbo, lead time 18 days', supplier: 'Remax', revision: true }, at(10));
  for (const k of c.candidates.filter((x) => x.state === 'PROPOSED' && !x.needsCorrection)) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(11));
  const b = sameEverywhere(c, 'after the supplier update'); assert.deepEqual([b.price, b.moq, b.leadDays], ['10', '20', '18']); assert.equal(factOf(c, 'MOQ').source_type, SOURCE_TYPE.SUPPLIER_CLAIM, 'the later supplier value is the supplier\'s, not the owner\'s'); assert.equal(factOf(c, 'MOQ').revision, 2); assert.deepEqual(factOf(c, 'MOQ').history.map((h) => [String(h.value), h.source_type]), [['25', 'USER_PROVIDED'], ['20', 'SUPPLIER_CLAIM']]);
  // a conflicting PRODUCT fact (the model) is a contradiction a person resolves: the facts stay as they were, in every mode
  c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'Model ZZ99. prix 10 $', supplier: 'Remax', revision: true }, at(20));
  for (const k of c.candidates.filter((x) => x.state === 'PROPOSED' && !x.needsCorrection)) { try { c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(21)); } catch { /* a conflict is raised, not thrown */ } }
  assert.ok(c.conflicts.some((x) => x.state === 'OPEN' && x.key === 'identifier.model'), 'the model contradiction is open'); const k2 = sameEverywhere(c, 'with an open model conflict'); assert.equal(k2.model, 'FC02', 'the case keeps FC02 until a person decides');
});

test('5. STALE view, RELOAD, CLOSE / REOPEN: the same case read from a stored copy shows the same facts; an old review can no longer be mistaken for the current fact', () => {
  let c = seed(); c = bySalon(c, 'MOQ', '60', 10);
  // close / reopen = serialise the case (localStorage / server file) and read it back through the upgrade
  const stored = JSON.stringify(c); const reopened = upgradeCase(JSON.parse(stored)); assert.deepEqual(sameEverywhere(reopened, 'reopened'), authoritative(c));
  // a stale local copy (before the edit) shows the OLD value; after the reload from the stored newest copy every mode shows the new one: never a mix
  const stale = seed(); assert.equal(readSalon(stale).moq, '24'); assert.equal(readTerrain(stale).moq, '24'); assert.equal(readExpert(stale).moq, '24'); assert.deepEqual([readTerrain(reopened).moq, readExpert(reopened).moq, readSalon(reopened).moq], ['60', '60', '60']);
  // offline cached reopen: the screens are pure functions of the stored case (no network): rebuilding them from the same stored JSON, any number of times, gives the same text
  const once = [factsPane(reopened), factRows(reopened).join(''), quickScreen(assess(reopened, { now: at(900), externals: {} }), reopened)]; const twice = [factsPane(upgradeCase(JSON.parse(stored))), factRows(upgradeCase(JSON.parse(stored))).join(''), quickScreen(assess(upgradeCase(JSON.parse(stored)), { now: at(900), externals: {} }), upgradeCase(JSON.parse(stored)))]; assert.deepEqual(once, twice);
  // the review of an OLDER offer shows that it is an archive and shows the current fact beside it
  let d = newCase({ id: 'r3', name: 'x', now: T0 }); d = dispatch(d, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'moq 24pc', supplier: 'Remax' }, at(1)); for (const k of d.candidates) d = dispatch(d, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(2));
  d = dispatch(d, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'prix 11 $, moq 30pc', supplier: 'Remax', revision: true }, at(3)); for (const k of d.candidates.filter((x) => x.state === 'PROPOSED')) d = dispatch(d, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(4));
  const first = offerDraft(d, d.offers[0].id); assert.equal(first.isLatest, false); const fm = first.fields.find((x) => x.key === 'quote.moq'); assert.equal(fm.historical, true); assert.equal(String(fm.current.value), '30');
  const html = V.reviewHtml({ draft: first, caseInfo: { caseId: d.id, title: 'x', supplier: 'Remax' }, groupableIds: [], conflicts: [], unknownNames: [], correcting: null }); assert.match(html, /Ancienne offre \(n°1\) : lecture d'archive/); assert.match(html, /Archive de cette offre\.<\/b> Valeur actuelle du dossier : <b>30 pièces<\/b>/); assert.match(html, /data-act="sl-open-fact"/, 'a way back to the underlying fact');
  const latest = offerDraft(d, d.offers[1].id); assert.equal(latest.isLatest, true); assert.ok(!/lecture d'archive/.test(V.reviewHtml({ draft: latest, caseInfo: { caseId: d.id, title: 'x', supplier: 'Remax' }, groupableIds: [], conflicts: [], unknownNames: [], correcting: null })));
});

test('6. SALON FACT EDITING: every actionable fact shows value, source, provenance, review status and [Corriger]; a correction appends a revision and keeps the previous value', () => {
  let c = seed(); const html = factsPane(c);
  for (const label of ['Prix unitaire', 'Devise', 'Minimum de commande \\(MOQ\\)', 'Modèle', 'Délai de production', 'Incoterm', 'Matière', 'Emballage']) assert.match(html, new RegExp(`<b>${label}</b>`), label);
  assert.match(html, /dit par le fournisseur/); assert.match(html, /confirmé/); assert.match(html, /version 1/); assert.match(html, /« moq 24pc »/);
  for (const t of ['PRICE', 'CURRENCY', 'MOQ', 'MODEL', 'LEAD_TIME', 'INCOTERM']) assert.match(html, new RegExp(`data-act="sl-fact-edit" data-key="${t}"`), `[Corriger] for ${t}`);
  for (const t of ['MATERIAL', 'PACKAGING']) assert.match(html, new RegExp(`data-act="sl-fact-edit" data-key="${t}"`), `[Saisir] for the unknown ${t}`);
  // an unknown fact can be entered; the value is validated; a refused value changes nothing
  c = bySalon(c, 'MATERIAL', 'acier inox 304', 10); assert.equal(factOf(c, 'MATERIAL').value, 'acier inox 304'); assert.equal(factOf(c, 'MATERIAL').source_type, SOURCE_TYPE.USER_PROVIDED); assert.equal(factOf(c, 'MATERIAL').review_status, REVIEW_STATUS.CONFIRMED, 'first value typed: confirmed, not "corrected"');
  const before = JSON.stringify(c); for (const [type, bad] of [['MOQ', '11,5'], ['MOQ', 'abc'], ['PRICE', '6,8'], ['CURRENCY', 'GBP'], ['INCOTERM', 'XYZ'], ['LEAD_TIME', '-3']]) assert.throws(() => bySalon(c, type, bad, 11), /./, `${type} ${bad} refused`); assert.equal(JSON.stringify(c), before);
  // the editing form and the history
  c = bySalon(c, 'MOQ', '30', 12); const f = factOf(c, 'MOQ'); const pane = V.factsHtml({ facts: caseFacts(c), audit: auditCase(c), observations: [], editing: 'MOQ', caseId: c.id });
  assert.match(pane, /<form data-form="sl-fact" data-id="MOQ"/); assert.match(pane, /avant : 24 pièces/); assert.match(pane, /Historique \(2\)/); assert.match(pane, /data-act="sl-fact-revert"/, 'the owner can cancel their own correction');
  assert.equal(String(f.provenance.previousValue), '24'); assert.equal(f.supersedes, f.history[0].ledger_id); assert.equal(c.events.filter((e) => e.type === 'FACT_CORRECT').length, 2, 'one event per explicit correction (material, MOQ)'); assert.ok(c.events.some((e) => e.ref?.ledgerId === f.ledger_id), 'the compiled quote event points at the ledger entry that explains it');
  // cancel the correction: the supplier's value comes back as a NEW entry, the correction stays (voided) with its reason
  c = dispatch(c, { type: 'FACT_REVERT', ledgerId: f.ledger_id, mode: 'salon', reason: 'test' }, at(13)); const g = factOf(c, 'MOQ'); assert.equal(String(g.value), '24'); assert.equal(g.source_type, SOURCE_TYPE.SUPPLIER_CLAIM); assert.equal(g.review_status, REVIEW_STATUS.REVERTED); assert.equal(g.provenance.revertOf, f.ledger_id); assert.equal(g.history.length, 3); assert.equal(g.history[1].voided, true);
  sameEverywhere(c, 'after revert'); assert.deepEqual(c.factAudit.map((a) => [a.kind, a.ledgerId, a.mode]), [['REVERT', f.ledger_id, 'salon']]);
  assert.throws(() => dispatch(c, { type: 'FACT_REVERT', ledgerId: g.history[0].ledger_id, mode: 'salon' }, at(14)), /only an owner correction/, 'a supplier statement cannot be "reverted"');
});

test('7. REMAX: how the false "MOQ 11 corrected by you" arises, how it is detected, and the audited repair', () => {
  // the first phone test: the build understood only "moq 24pc"; the owner was left with ONE fact on the screen and corrected it to 11 (the price). Later the full note was imported again (offer 2).
  let c = newCase({ id: 'remax-real', name: 'batterie externe', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Remax' } }, at(0));
  c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'moq 24pc', supplier: 'Remax' }, at(1)); const m = c.candidates.find((x) => x.key === 'quote.moq'); c = dispatch(c, { type: 'CANDIDATE_CORRECT', id: m.id, value: '11' }, at(2));
  const NOTE = 'prix 11 $, moq 24pc, 3 couleurs blue, white en black. puissance 45W, capacités 20000mAp. 4 sortie. déjà on stock.';
  c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: NOTE, supplier: 'Remax' }, at(3)); for (const k of c.candidates.filter((x) => x.state === 'PROPOSED' && !x.needsCorrection)) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(4));
  // BEFORE: the old Salon review says "11, corrigé par vous" while the case holds 24 and Terrain / Expert show 24 (the three-mode symptom)
  const old = offerDraft(c, c.offers[0].id).fields.find((x) => x.key === 'quote.moq'); assert.deepEqual([old.value, old.status, old.review.state, String(old.current.value), old.historical], ['11', 'USER_PROVIDED', 'CORRECTED', '24', true]);
  assert.equal(readTerrain(c).moq, '24'); assert.equal(readExpert(c).moq, '24'); assert.equal(readSalon(c).moq, '24');
  // detected, with the evidence, as a hint (never as a verdict)
  const found = auditCase(c); assert.deepEqual(found.map((x) => x.kind).sort(), ['CORRECTION_EQUALS_PRICE', 'STALE_CORRECTION']); const hit = found.find((x) => x.kind === 'STALE_CORRECTION'); assert.deepEqual([hit.originalValue, hit.correctedValue, String(hit.currentValue)], ['24', '11', '24']);
  const pane = factsPane(c); assert.match(pane, /Ancienne correction/); assert.match(pane, /le fournisseur disait 24, une correction à 11 a été enregistrée sur une ancienne offre, mais le dossier indique aujourd'hui 24/); assert.match(pane, /Correction à vérifier/); assert.match(pane, /égale au prix unitaire/);
  // THE REPAIR: the owner cancels that correction (one tap). The authoritative state is exactly what the text says, and the audit trail explains it.
  c = dispatch(c, { type: 'FACT_REVERT', ledgerId: hit.ledgerId, mode: 'salon', reason: 'MOQ 11 était le prix saisi au mauvais endroit : le fournisseur dit 24' }, at(5));
  const f = Object.fromEntries(caseFacts(c).map((x) => [x.fact_type, x]));
  assert.equal(f.PRICE.value, '11'); assert.equal(f.PRICE.currency, 'USD'); assert.equal(Number(f.MOQ.value), 24); assert.equal(f.MOQ.unit, 'pcs'); assert.deepEqual(f.POWER.value, { amount: 45, unit: 'W' }); assert.equal(f.OUTPUT_COUNT.value, '4'); assert.deepEqual(f.COLOURS.value, ['blue', 'white', 'black']); assert.equal(f.STOCK_STATUS.value, 'IN_STOCK');
  assert.equal(f.CAPACITY, undefined, '"20000mAp" is NOT turned into mAh: it is no confirmed fact'); const amb = offerDraft(c, c.offers[1].id).fields.find((x) => x.key === 'spec.capacity'); assert.ok(amb && amb.needsCorrection && amb.value === null && /20000mAp/.test(amb.rawText), 'it is proposed as AMBIGUOUS, with the supplier\'s own characters');
  assert.equal(f.MOQ.source_type, SOURCE_TYPE.SUPPLIER_CLAIM); assert.ok(!caseFacts(c).some((x) => x.source_type === SOURCE_TYPE.USER_PROVIDED), 'no fact is the owner\'s: MOQ 11 is not a valid owner correction');
  assert.deepEqual(auditCase(c), [], 'nothing left to flag'); const after = offerDraft(c, c.offers[0].id).fields.find((x) => x.key === 'quote.moq'); assert.ok(after.reverted && /prix saisi au mauvais endroit/.test(after.reverted.reason)); assert.match(V.reviewHtml({ draft: offerDraft(c, c.offers[0].id), caseInfo: { caseId: c.id, title: 'x', supplier: 'Remax' }, groupableIds: [], conflicts: [], unknownNames: [], correcting: null }), /correction annulée/);
  // audit history preserved: the original correction, the revert, the reason, and the event log
  assert.ok(c.ledger.some((e) => e.id === hit.ledgerId && e.value === '11' && e.corrected)); assert.equal(c.factAudit.length, 1); assert.match(c.factAudit[0].reason, /fournisseur dit 24/); assert.deepEqual(f.MOQ.history.map((h) => [String(h.value), h.source_type, h.voided]), [['11', 'USER_PROVIDED', true], ['24', 'SUPPLIER_CLAIM', false]]);
  sameEverywhere(c, 'Remax repaired');
  // the SAME text typed again does not re-create the problem
  const again = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: NOTE, supplier: 'Remax' }, at(6)); assert.equal(again.offers.length, c.offers.length, 'idempotent import'); assert.equal(readSalon(again).moq, '24');
});

test('8. IMAGE_OBSERVED / DOCUMENT_OBSERVED: a value read from a photo enters the same state model without pretending the supplier said it', () => {
  // a model read from the product photo, a power and a capacity read from its label (no OCR provider here: the event is the seam)
  let d = newCase({ id: 'photo', name: 'batterie externe', now: T0 });
  d = dispatch(d, { type: 'FACT_OBSERVE', factType: 'MODEL', value: 'FC02', sourceType: 'IMAGE_OBSERVED', ref: { photoRef: 'photo-0', region: [0.1, 0.2, 0.3, 0.1] }, confidence: 0.82, observer: 'future-ocr' }, at(1));
  d = dispatch(d, { type: 'FACT_OBSERVE', factType: 'POWER', value: '45', sourceType: 'IMAGE_OBSERVED', ref: { photoRef: 'photo-0' } }, at(1));
  d = dispatch(d, { type: 'FACT_OBSERVE', factType: 'CAPACITY', value: '20000 mAh', sourceType: 'IMAGE_OBSERVED', ref: { photoRef: 'photo-0' } }, at(1));
  assert.equal(caseFacts(d).length, 0, 'an observation is NOT a fact of the case yet'); assert.equal(d.factObservations.length, 3); assert.ok(d.factObservations.every((o) => o.state === 'PROPOSED' && o.sourceType === 'IMAGE_OBSERVED'));
  assert.equal(d.ledger.length, 0, 'nothing reached the ledger'); assert.equal(d.identity.identifiers.model ?? null, null); assert.match(factsPane(d), /Lu mais pas encore accepté/); assert.match(factsPane(d), /lu sur une photo/);
  for (const o of d.factObservations) d = dispatch(d, { type: 'FACT_ACCEPT', observationId: o.id, mode: 'salon' }, at(2));
  const f = Object.fromEntries(caseFacts(d).map((x) => [x.fact_type, x])); assert.equal(f.MODEL.value, 'FC02'); assert.deepEqual(f.POWER.value, { amount: 45, unit: 'W' }); assert.deepEqual(f.CAPACITY.value, { amount: 20000, unit: 'mAh' });
  for (const x of Object.values(f)) { assert.equal(x.source_type, SOURCE_TYPE.IMAGE_OBSERVED); assert.notEqual(x.source_type, SOURCE_TYPE.SUPPLIER_CLAIM); assert.notEqual(x.source_type, SOURCE_TYPE.VERIFIED); assert.equal(x.review_status, REVIEW_STATUS.CONFIRMED); assert.equal(x.source_reference.ref.photoRef, 'photo-0'); }
  assert.equal(readTerrain(d).model, 'FC02'); assert.equal(readExpert(d).model, 'FC02'); assert.equal(readSalon(d).model, 'FC02'); assert.match(factRows(d).join(''), /lu sur la photo, accepté par vous/);
  assert.throws(() => dispatch(d, { type: 'FACT_OBSERVE', factType: 'MODEL', value: 'X', sourceType: 'SUPPLIER_CLAIM' }, at(3)), /IMAGE_OBSERVED/, 'a photo cannot be recorded as a supplier claim');
  // the supplier then says a DIFFERENT model: it is a contradiction a person resolves, not a silent overwrite of what the photo showed
  let e = dispatch(d, { type: 'CONVERSATION_START', supplierRef: 'Remax', lang: 'auto' }, at(4)); const conv = e.conversations.at(-1); e = dispatch(e, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text: 'Model FC03' }, at(5)); const cand = e.candidates.find((x) => x.key === 'identifier.model'); e = dispatch(e, { type: 'CANDIDATE_CONFIRM', id: cand.id }, at(6));
  assert.ok(e.conflicts.some((x) => x.state === 'OPEN' && x.key === 'identifier.model')); assert.equal(factOf(e, 'MODEL').value, 'FC02');
  assert.ok(Object.keys(FACT_TYPES).includes('POWER') && Object.keys(FACT_TYPES).includes('CAPACITY'));
});
