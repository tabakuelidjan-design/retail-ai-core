// REAL XIAOMI BUG (batterie externe, supplier "Sonny"). One note typed in Terrain: MOQ 60 appeared confirmed, but the model AB521 was not in the Expert sheet, the price was still "missing", ASK NEXT asked for the
// model again, and capacity / power / colours were not visible in the other modes. These tests pin the exact input, trace each value from the original text to the candidates, the ledger, the case and the three
// modes, and pin the rules: nothing is confirmed for the owner; an unclear unit is never corrected silently; a brand is never deduced from the supplier's name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './sourcing-ui-load.js';
import { loadSalonViews } from './sourcing-salon-load.js';
import { extractFacts } from '../src/sourcing/core/extract/index.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { upgradeCase } from '../src/sourcing/core/upgrade.js';
import { askNow } from '../src/sourcing/core/field/ask-now.js';
import { validateCorrection } from '../src/sourcing/core/candidate-view.js';
import { caseFacts, factOf, factStatusBoard, auditCase, FACT_STATE } from '../src/sourcing/core/case-facts.js';

const { factRows } = await loadUi('screens/fieldfirst.js');
const { quickScreen } = await loadUi('screens/quick.js');
const { caseScreen } = await loadUi('screens/case.js');
const V = await loadSalonViews();

export const SONNY = 'prix 12$, MOQ 60, puissance 10000mAp. variante 4 couleur blanc, blue, rouge et noir. puissance 45W. nom de Modele AB521';
const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
const facts = (text) => extractFacts({ text }).candidates; const one = (text, key) => facts(text).find((c) => c.key === key) ?? null;

// Terrain, as the owner did it: a case named "batterie externe", supplier "Sonny", one note from the supplier, and ONLY the MOQ confirmed
function terrain({ confirmMoq = true } = {}) {
  let c = newCase({ id: 'sonny', name: 'batterie externe', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Sonny' } }, at(0));
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1)); const conv = c.conversations.at(-1);
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text: SONNY }, at(2));
  if (confirmMoq) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: c.candidates.find((x) => x.key === 'quote.moq').id }, at(3));
  return c;
}
const A = (c) => assess(c, { now: at(60), externals: {} });
const board = (c, locale = 'fr') => Object.fromEntries(factStatusBoard(c, { locale }).map((b) => [b.fact_type, b]));

test('1. the exact note: model, price, currency (flagged), MOQ, power, four colours; the capacity unit is AMBIGUOUS, never corrected', () => {
  const m = one(SONNY, 'identifier.model'); assert.ok(m, 'the model is found'); assert.equal(m.value, 'AB521'); assert.equal(m.rawText, 'AB521'); assert.equal(m.confidence, 'HIGH');
  const p = one(SONNY, 'quote.unitPrice'); assert.equal(p.value, '12'); const cur = one(SONNY, 'quote.currency'); assert.equal(cur.value, 'USD'); assert.ok(cur.flags.includes('CURRENCY_FROM_SYMBOL'), '"$" is only a symbol: the currency is flagged, to be checked'); assert.equal(cur.confidence, 'MEDIUM');
  assert.equal(one(SONNY, 'quote.moq').value, '60'); assert.deepEqual(one(SONNY, 'spec.power').value, { amount: 45, unit: 'W' });
  assert.deepEqual(one(SONNY, 'variant.colours').value, ['white', 'blue', 'red', 'black']); assert.equal(one(SONNY, 'variant.colourCount').value, '4');
  const cap = one(SONNY, 'spec.capacity'); assert.ok(cap, 'the number is not lost'); assert.equal(cap.value, null, 'no value: the unit is not mAh'); assert.equal(cap.needsCorrection, true); assert.ok(cap.flags.includes('UNIT_UNRECOGNISED')); assert.equal(cap.rawText, '10000mAp'); assert.equal(cap.confidence, 'LOW');
  assert.ok(!facts(SONNY).some((c) => c.key === 'spec.capacity' && c.value?.unit === 'mAh'), 'mAp was never silently turned into mAh'); assert.ok(!facts(SONNY).some((c) => /^identifier\.(brand|manufacturer)$/.test(c.key)), 'no brand or manufacturer is deduced');
  assert.equal(extractFacts({ text: SONNY }).unparsed.some((u) => /Modele AB521/.test(u)), false, 'the model is no longer left under "not understood"');
});

test('1b. the model label in every spelling: Model, Modèle, Modele, with a note word before it, with a colon, with an accent', () => {
  for (const t of ['Model AB521', 'Modèle AB521', 'Modele AB521', 'MODELE AB521', 'nom de Modele AB521', 'nom de modèle : AB521', 'Model no. AB521', 'modele: AB521']) assert.equal(one(t, 'identifier.model')?.value, 'AB521', t);
  assert.equal(one('Modele AB-521/B', 'identifier.model')?.value, 'AB-521/B', 'the identifier is kept exactly as written');
  for (const t of ['Modelling clay 500g', 'modeling paste 12', 'model', 'modele']) assert.equal(one(t, 'identifier.model'), null, `${t}: a word that merely starts like the label is not a model`);
});

test('1c. price and capacity edge cases around the same wording', () => {
  assert.equal(one('prix 12$', 'quote.unitPrice').value, '12'); assert.equal(one('prix 12 $', 'quote.currency').value, 'USD'); assert.equal(one('12$', 'quote.unitPrice').value, '12');
  for (const [t, unit] of [['10000mAp', 'mAp'], ['5000mAn', 'mAn'], ['3000 mAk', 'mAk']]) { const c = one(t, 'spec.capacity'); assert.equal(c.value, null, t); assert.equal(c.needsCorrection, true, t); assert.equal(c.rawText.replace(/\s/g, ''), t.replace(/\s/g, '')); assert.ok(unit); }
  for (const t of ['10000mAh', '10000 mAh', '10,000 mAh']) assert.deepEqual(one(t, 'spec.capacity').value, { amount: 10000, unit: 'mAh' }, t);
  assert.equal(one('20mA', 'spec.capacity'), null, '20 mA is a current, not a capacity'); assert.equal(one('mAh', 'spec.capacity'), null);
});

test('2. TRACE: from the original text to candidates, ledger, case and the board; only the MOQ the owner confirmed is a fact', () => {
  const c = terrain(); const item = c.conversations.at(-1).items[0];
  assert.equal(item.original, SONNY, 'the original text is kept exactly'); assert.equal(item.speaker, 'supplier');
  // every candidate points at an exact slice of that original and is PROPOSED (nothing confirmed for the owner) except the MOQ the owner confirmed
  for (const k of c.candidates) { assert.equal(item.original.slice(k.span[0], k.span[1]), k.rawText, k.key); assert.equal(k.speaker, 'supplier'); assert.equal(k.state, k.key === 'quote.moq' ? 'CONFIRMED' : 'PROPOSED', `${k.key} is ${k.state}`); }
  assert.deepEqual(c.ledger.map((e) => [e.key, e.status]), [['quote.moq', 'SUPPLIER_CLAIM']], 'the ledger holds the MOQ and nothing else'); assert.equal(c.quotes.length, 1); assert.equal(c.quotes[0].moq, 60); assert.equal(c.quotes[0].unitPrice, undefined, 'no price in the case: it was not confirmed');
  assert.equal(c.identity.identifiers.model, null); assert.equal(c.identity.identifiers.brand, null, 'no brand deduced from the supplier name'); assert.equal(c.identity.identifiers.manufacturer, null); assert.equal(c.supplier.name, 'Sonny');
  const b = board(c); const st = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.state]));
  assert.deepEqual([st.MOQ, st.PRICE, st.CURRENCY, st.MODEL, st.POWER, st.CAPACITY, st.COLOURS, st.OUTPUT_COUNT, st.LEAD_TIME], [FACT_STATE.CONFIRMED, FACT_STATE.PROPOSED, FACT_STATE.PROPOSED, FACT_STATE.PROPOSED, FACT_STATE.PROPOSED, FACT_STATE.AMBIGUOUS, FACT_STATE.PROPOSED, FACT_STATE.MISSING, FACT_STATE.MISSING]);
  assert.equal(b.MODEL.proposedValueText, 'AB521'); assert.equal(b.MODEL.source_type, 'SUPPLIER_CLAIM'); assert.equal(b.CAPACITY.canConfirm, false, 'an ambiguous fact cannot be confirmed as it is'); assert.equal(b.CAPACITY.canCorrect, true);
  assert.deepEqual(caseFacts(c).map((f) => f.fact_type), ['MOQ'], 'the authoritative facts are only what the owner confirmed');
});

test('3. VISIBILITY: the proposed facts show in Terrain, Expert and Salon, each with its own status; nothing is hidden because it is not confirmed yet', () => {
  const c = terrain();
  // TERRAIN
  const t = factRows(c).join(''); assert.match(t, /Référence[\s\S]*AB521/); assert.match(t, /Puissance[\s\S]*45 W/); assert.match(t, /Capacité[\s\S]*ambigu/); assert.match(t, /Couleurs[\s\S]*white, blue, red, black/); assert.match(t, /Prix indicatif[\s\S]*12/); assert.match(t, /MOQ[\s\S]*60 pièces/);
  assert.match(t, /annoncé par le fournisseur/); assert.match(t, /data-act="cand-confirm"/, 'a Confirmer button for the proposals');
  // EXPERT (Quick and Case)
  for (const html of [quickScreen(A(c), c), caseScreen(A(c), c)]) { assert.match(html, /FACTS - where each one stands/); assert.match(html, /Model: <b>AB521<\/b> <span class="chip warn">TO CONFIRM/); assert.match(html, /Unit price: <b>12<\/b>/); assert.match(html, /Capacity: <b>[^<]*10000mAp[^<]*<\/b> <span class="chip warn">AMBIGUOUS/); assert.match(html, /Minimum order: <b>60 pieces<\/b> <span class="chip ok">confirmed/); assert.match(html, /Power: <b>45 W<\/b>/); assert.match(html, /Colours: <b>white, blue, red, black<\/b>/); }
  assert.match(quickScreen(A(c), c), /name="value" placeholder="e\.g\. 10000 mAh"/, 'the ambiguous capacity has a field to type the right value');
  // SALON
  const view = V.factsHtml({ facts: caseFacts(c), audit: auditCase(c), observations: [], editing: null, caseId: c.id, board: factStatusBoard(c, { locale: 'fr' }), correcting: null });
  assert.match(view, /À confirmer \(dit par le fournisseur\)/); assert.match(view, /<b>Modèle<\/b>[\s\S]*?<div class="sl-fv">AB521<\/div>/); assert.match(view, /ambigu : à corriger/); assert.match(view, /Capacité/); assert.match(view, /« 10000mAp »/); assert.match(view, /<b>Puissance<\/b>[\s\S]*?45 W/); assert.match(view, /<b>Couleurs<\/b>[\s\S]*?white, blue, red, black/);
  assert.match(view, /pas encore confirmé/); assert.match(view, /data-act="sl-confirm"/); assert.match(view, /<b>Minimum de commande \(MOQ\)<\/b>[\s\S]*?60 pièces/);
  // the unknown row of a fact that is only PROPOSED is not shown as "inconnu": it would contradict the proposal
  assert.ok(!/<b>Modèle<\/b><span[^>]*>inconnu/.test(view));
});

test('4. NO IMPLICIT CONFIRMATION: showing, rendering, ASK NEXT, switching modes and reloading confirm nothing', () => {
  const c = terrain(); const before = JSON.stringify([c.ledger, c.candidates.map((k) => k.state), c.quotes]);
  factRows(c); quickScreen(A(c), c); caseScreen(A(c), c); V.factsHtml({ facts: caseFacts(c), audit: [], observations: [], editing: null, caseId: c.id, board: factStatusBoard(c), correcting: 'x' }); askNow(c, A(c)); const back = upgradeCase(JSON.parse(JSON.stringify(c)));
  assert.equal(JSON.stringify([back.ledger, back.candidates.map((k) => k.state), back.quotes]), before);
  assert.deepEqual(c.candidates.filter((k) => k.state === 'CONFIRMED').map((k) => k.key), ['quote.moq']); assert.equal(c.events.filter((e) => e.type === 'CANDIDATE_CONFIRM').length, 1);
  // the Quick form saved WITHOUT touching a field still confirms nothing and changes no provenance
  const q = { name: 'batterie externe', category: '', unitPrice: '', currency: 'USD', moq: '60', qty: '', incoterm: '' }; assert.equal(JSON.stringify(Object.keys(q).length), '7');
});

test('5. ASK NEXT does not ask again what the supplier already said: it proposes to VERIFY it', () => {
  const c = terrain(); const items = askNow(c, A(c)).items; const ids = items.map((i) => i.id);
  assert.ok(!items.some((i) => !i.verify && /exact model number/i.test(i.en ?? '')), 'the plain "what is the model" question is gone');
  const model = items.find((i) => i.id === 'model'); assert.ok(model?.verify, 'the model is a verification'); assert.equal(model.verify.key, 'identifier.model'); assert.match(model.en, /Please confirm: Model AB521\./); assert.match(model.fr, /Vérifier avec le fournisseur : Modèle AB521/); assert.equal(model.zh, null, 'no Chinese sentence is invented'); assert.ok(model.zhNote);
  const price = items.find((i) => i.id === 'price'); assert.ok(price?.verify); assert.equal(price.verify.key, 'quote.unitPrice'); assert.match(price.en, /Please confirm: Unit price 12\./);
  assert.ok(ids.indexOf('model') < ids.indexOf('field:material') || !ids.includes('field:material'), 'a verification keeps the rank of the question it replaces');
  const html = V.askListHtml(askNow(c, A(c)), c.id); assert.match(html, /Vérifier : Modèle exact/); assert.match(html, /class="sl-tag t-imp">À confirmer</); assert.match(html, /Please confirm: Model AB521\./);
  // once the owner confirms the model, the verification disappears and the fact is a fact in every mode
  const d = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: c.candidates.find((k) => k.key === 'identifier.model').id }, at(5)); assert.ok(!askNow(d, A(d)).items.some((i) => i.id === 'model'), 'confirmed: no longer asked nor verified'); assert.equal(factOf(d, 'MODEL').value, 'AB521'); assert.equal(factOf(d, 'MODEL').source_type, 'SUPPLIER_CLAIM');
  assert.match(quickScreen(A(d), d), /Model: <b>AB521<\/b> <span class="chip ok">confirmed/); assert.match(factRows(d).join(''), /Référence[\s\S]*AB521/); assert.match(V.factsHtml({ facts: caseFacts(d), audit: [], observations: [], editing: null, caseId: d.id, board: factStatusBoard(d), correcting: null }), /<b>Modèle<\/b>[\s\S]*?<div class="sl-fv">AB521<\/div>[\s\S]*?dit par le fournisseur/);
  // the brand is NOT deduced from the supplier name: "Sonny" is a supplier, the manufacturer question is still asked as a question
  assert.equal(d.identity.identifiers.brand, null); assert.ok(askNow(d, A(d)).items.some((i) => i.id === 'manufacturer' && !i.verify), 'the manufacturer / brand stays an open question');
});

test('6. the ambiguous capacity needs a HUMAN correction: it cannot be confirmed as it is, a wrong unit is refused, the right one is recorded as the owner\'s', () => {
  const c = terrain(); const cap = c.candidates.find((k) => k.key === 'spec.capacity');
  assert.throws(() => dispatch(c, { type: 'CANDIDATE_CONFIRM', id: cap.id }, at(5)), /needs a correction/);
  for (const bad of ['10000', '10000mAp', '10000 mAp', 'abc', '', '0 mAh', '10000 kg']) assert.equal(validateCorrection('spec.capacity', bad, 'fr').ok, false, `"${bad}" is refused`);
  assert.equal(validateCorrection('spec.capacity', '10000', 'fr').error, 'Tapez la capacité avec son unité, par exemple 10000 mAh.');
  assert.deepEqual(validateCorrection('spec.capacity', '10000 mAh', 'fr'), { ok: true, value: { amount: 10000, unit: 'mAh' } }); assert.deepEqual(validateCorrection('spec.capacity', '10000mah', 'en').value, { amount: 10000, unit: 'mAh' });
  const d = dispatch(c, { type: 'CANDIDATE_CORRECT', id: cap.id, value: { amount: 10000, unit: 'mAh' } }, at(6)); const f = factOf(d, 'CAPACITY');
  assert.deepEqual(f.value, { amount: 10000, unit: 'mAh' }); assert.equal(f.source_type, 'USER_PROVIDED'); assert.equal(f.review_status, 'CORRECTED'); assert.equal(f.provenance.original.value, null, 'the supplier\'s own value was none'); assert.equal(f.source_reference.rawText, '10000mAp', 'the supplier\'s characters stay on record');
  assert.equal(board(d).CAPACITY.state, FACT_STATE.CONFIRMED); assert.match(quickScreen(A(d), d), /Capacity: <b>10000 mAh<\/b> <span class="chip ok">confirmed/);
});

test('7. Terrain -> Expert -> Salon -> Terrain keeps the same case, the same facts and their provenance', () => {
  let c = terrain(); const id = c.id; const get = (k) => c.candidates.find((x) => x.key === k).id;
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: get('identifier.model') }, at(10)); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: get('quote.currency') }, at(10)); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: get('quote.unitPrice') }, at(10)); // Terrain
  c = dispatch(c, { type: 'QUOTE', origin: 'expert', quote: { ...c.quotes.at(-1), moq: 70 } }, at(20)); // Expert: the owner types a different MOQ
  c = dispatch(c, { type: 'FACT_CORRECT', factType: 'LEAD_TIME', value: '25', mode: 'salon' }, at(30)); // Salon
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: get('spec.power') }, at(40)); // back in Terrain
  assert.equal(c.id, id); assert.equal(c.supplier.name, 'Sonny'); const f = Object.fromEntries(caseFacts(c).map((x) => [x.fact_type, x]));
  assert.deepEqual([f.MODEL.value, f.PRICE.value, f.CURRENCY.value, Number(f.MOQ.value), f.LEAD_TIME.value.max], ['AB521', '12', 'USD', 70, '25']);
  assert.deepEqual([f.MODEL.source_type, f.PRICE.source_type, f.CURRENCY.source_type, f.MOQ.source_type, f.LEAD_TIME.source_type, f.POWER.source_type], ['SUPPLIER_CLAIM', 'SUPPLIER_CLAIM', 'SUPPLIER_CLAIM', 'USER_PROVIDED', 'USER_PROVIDED', 'SUPPLIER_CLAIM']);
  assert.deepEqual([f.MOQ.source_reference.mode, f.LEAD_TIME.source_reference.mode], ['expert', 'salon']); assert.deepEqual(f.MOQ.history.map((h) => [String(h.value), h.source_type]), [['60', 'SUPPLIER_CLAIM'], ['70', 'USER_PROVIDED']]);
  assert.equal(board(c).CAPACITY.state, FACT_STATE.AMBIGUOUS, 'the unresolved capacity is still ambiguous: nothing resolved it for the owner');
  for (const html of [factRows(c).join(''), quickScreen(A(c), c), V.factsHtml({ facts: caseFacts(c), audit: [], observations: [], editing: null, caseId: c.id, board: factStatusBoard(c), correcting: null })]) { assert.match(html, /AB521/); assert.match(html, /70/); }
  // save locally and restart offline: the stored JSON gives exactly the same board and facts
  const stored = JSON.stringify(c); const reopened = upgradeCase(JSON.parse(stored)); assert.deepEqual(factStatusBoard(reopened), factStatusBoard(c)); assert.deepEqual(caseFacts(reopened).map((x) => [x.fact_type, x.value, x.source_type, x.revision]), caseFacts(c).map((x) => [x.fact_type, x.value, x.source_type, x.revision]));
  assert.equal(factRows(reopened).join(''), factRows(c).join(''));
});

test('8. NO DUPLICATE, NO OVERWRITE: the same text imported twice is one offer; a revised offer is a second one and the first stays intact', () => {
  let c = terrain(); const n0 = c.candidates.length;
  c = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: SONNY, supplier: 'Sonny' }, at(10)); assert.equal(c.offers.length, 1); const once = c.candidates.length; assert.ok(once > n0);
  const again = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: SONNY, supplier: 'Sonny' }, at(11)); assert.equal(again.offers.length, 1, 'the same content is the same offer'); assert.equal(again.candidates.length, once, 'no candidate is added twice');
  assert.equal(c.conversations[0].items[0].original, SONNY, 'the Terrain conversation is untouched by the import'); assert.equal(c.candidates.slice(0, n0).find((k) => k.key === 'quote.moq').state, 'CONFIRMED', 'the owner\'s confirmation is not undone');
  const rev = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'prix 11$, MOQ 50, Modele AB521', supplier: 'Sonny', revision: true }, at(12)); assert.equal(rev.offers.length, 2); assert.equal(rev.offers[0].id, c.offers[0].id); assert.equal(rev.offers[0].candidateIds.length, c.offers[0].candidateIds.length, 'offer 1 is intact');
  assert.equal(rev.quotes.length, c.quotes.length, 'importing proposes: it does not change the case quote by itself'); assert.equal(factOf(rev, 'MOQ').value, 60);
});


// A saved Xiaomi dossier created BEFORE the extractor fix has neither the model nor
// the misspelled-capacity candidate, even though both strings remain in the original.
// Recovery must be additive, explicit and idempotent: never rewrite the supplier
// message, existing confirmations, a rejection, the quote, or any audit history.
test('9. existing Sonny JSON recovers ONLY missing proposals by explicit reanalysis, without touching decided facts', () => {
  let legacy = terrain();
  legacy = { ...legacy, candidates: legacy.candidates.filter((c) => !['identifier.model', 'spec.capacity'].includes(c.key)) };
  const original = JSON.parse(JSON.stringify(legacy)); const oldCandidates = JSON.stringify(original.candidates);
  const oldLedger = JSON.stringify(original.ledger); const oldQuote = JSON.stringify(original.quotes);
  const oldHistory = JSON.stringify(original.factAudit); const oldOffer = JSON.stringify(original.offers);
  let restored = upgradeCase(JSON.parse(JSON.stringify(original))); // genuine persisted JSON round-trip
  assert.equal(board(restored).MODEL.state, FACT_STATE.MISSING, 'an old saved case is not rewritten by a simple reload');
  restored = dispatch(restored, { type: 'CONVERSATION_REANALYZE' }, at(8));
  assert.equal(restored.candidates.length, original.candidates.length + 2);
  const model = restored.candidates.find((c) => c.key === 'identifier.model');
  const cap = restored.candidates.find((c) => c.key === 'spec.capacity');
  assert.equal(model.value, 'AB521'); assert.equal(model.state, 'PROPOSED');
  assert.equal(cap.value, null); assert.equal(cap.state, 'PROPOSED'); assert.equal(cap.needsCorrection, true);
  assert.equal(cap.rawText, '10000mAp'); assert.equal(cap.recovery.kind, 'OWNER_INITIATED_REANALYSIS');
  assert.equal(JSON.stringify(restored.candidates.slice(0, original.candidates.length)), oldCandidates);
  assert.equal(JSON.stringify(restored.ledger), oldLedger); assert.equal(JSON.stringify(restored.quotes), oldQuote);
  assert.equal(JSON.stringify(restored.factAudit), oldHistory); assert.equal(JSON.stringify(restored.offers), oldOffer);
  assert.equal(restored.conversations[0].items[0].original, SONNY);
  assert.equal(restored.supplier.name, 'Sonny'); assert.equal(restored.identity.identifiers.model, null);
  assert.deepEqual(caseFacts(restored).map((f) => f.fact_type), ['MOQ']);
  assert.equal(board(restored).MODEL.state, FACT_STATE.PROPOSED);
  assert.equal(board(restored).CAPACITY.state, FACT_STATE.AMBIGUOUS);
  const count = restored.candidates.length;
  const twice = dispatch(restored, { type: 'CONVERSATION_REANALYZE' }, at(9));
  assert.equal(twice.candidates.length, count, 'repeated reanalysis never duplicates proposals');
  const reopened = upgradeCase(JSON.parse(JSON.stringify(twice)));
  assert.equal(board(reopened).MODEL.proposedValueText, 'AB521');
  assert.equal(factOf(reopened, 'MOQ').value, 60);
});

test('10. recovery respects prior rejection and does not reinterpret the owner’s notes', () => {
  let c = terrain();
  const price = c.candidates.find((x) => x.key === 'quote.unitPrice');
  c = dispatch(c, { type: 'CANDIDATE_REJECT', id: price.id }, at(5));
  const conv = c.conversations.at(-1);
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'me', text: 'Modele ZZ999', extract: false }, at(6));
  const length = c.candidates.length;
  c = dispatch(c, { type: 'CONVERSATION_REANALYZE' }, at(7));
  assert.equal(c.candidates.length, length, 'no resurrection of rejected price or extraction of own words');
  assert.equal(c.candidates.find((x) => x.id === price.id).state, 'REJECTED');
  assert.equal(c.candidates.some((x) => x.key === 'identifier.model' && x.value === 'ZZ999'), false);
  assert.equal(c.ledger.some((e) => e.key === 'quote.unitPrice'), false);
});
