// NORDLA: "the model number" and "the technical identification" are two different questions. A model number the owner accepted is never reported as missing; what still blocks is named exactly (category, safety traits, documents, costs) and every real gate stays.
// Real cases: Remax "Batterie externe" (Fc-02) and Sonny (AB521), seen on the Xiaomi with "Modèle exact" still blocking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSalonViews } from './sourcing-salon-load.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { newWorkspace } from '../src/sourcing/core/field/workspace.js';
import { identificationStatus, modelState } from '../src/sourcing/core/field/identity-gaps.js';
import { KEY_TRAITS } from '../src/sourcing/core/taxonomy.js';
import { factStatusBoard } from '../src/sourcing/core/case-facts.js';

const V = await loadSalonViews(); const N = await import(new URL('../src/sourcing/ui/screens/nx.js', import.meta.url).href);
const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000); const eng = createFieldEngine({ now: () => at(60) });
/** a supplier who said `text`; `confirm`: the candidate keys the owner accepts; `category`: confirmed by the owner (a decision, never automatic) */
function supplier(name, product, text, { confirm = null, category = null, categoryLevel } = {}) {
  let c = newCase({ id: name.toLowerCase(), name: product, now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name } }, at(0)); if (category) c = dispatch(c, { type: 'CATEGORY', category, ...(categoryLevel ? { level: categoryLevel } : {}) }, at(0));
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: name, lang: 'auto' }, at(1)); c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'auto', text }, at(2));
  for (const k of c.candidates.filter((x) => (confirm ?? ['quote.unitPrice', 'quote.currency', 'quote.moq', 'identifier.model']).includes(x.key))) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(3));
  return c;
}
const view = (c) => { const v = eng.caseView(c, newWorkspace(at(0)), ['evidenceStatus', 'recommendation']); return { ev: v.evidenceStatus, a: v.assessment, sum: V.blockerSummary(v.evidenceStatus, v.assessment) }; };
const remax = (o) => supplier('Remax', 'Batterie externe', 'price 11.68 USD, MOQ 60, model Fc-02', o); const sonny = (o) => supplier('Sonny', 'batterie externe', 'prix 12$, MOQ 60, modele AB521', o);
const IDENT = ['MODEL_NOT_ESTABLISHED', 'MODEL_NOT_CONFIRMED', 'MODEL_CONTRADICTORY', 'PRODUCT_IDENTITY_UNRESOLVED', 'PRODUCT_NOT_IDENTIFIED'];

test('1. REMAX (Fc-02) and SONNY (AB521): the model is KNOWN and accepted -> never "Modèle exact" / "model not established"; the blocker says what is really missing (technical identification: the category), with the model named as known', () => {
  for (const [c, model] of [[remax(), 'Fc-02'], [sonny(), 'AB521']]) {
    const { ev, sum } = view(c); const idn = identificationStatus(c, ev && assess(c, { now: at(60), externals: {} })); assert.equal(idn.model.state, 'CONFIRMED'); assert.equal(idn.model.value, model); assert.equal(idn.code, 'PRODUCT_IDENTITY_UNRESOLVED');
    assert.deepEqual(ev.blockingCodes.filter((x) => IDENT.includes(x)), ['PRODUCT_IDENTITY_UNRESOLVED'], 'ONE identification gap, under ONE code'); assert.ok(!ev.blocking.some((b) => /model number is not known|exact product \(model\)/.test(b)));
    assert.ok(sum.labels.includes('Identification technique incomplète') && !sum.labels.some((l) => /Modèle exact|Numéro de modèle|Modèle à confirmer/.test(l)), sum.labels.join());
    const txt = sum.details.join('\n'); assert.match(txt, new RegExp(`Numéro de modèle ${model} : connu`)); assert.match(txt, /Identification technique incomplète : la catégorie du produit n'est pas confirmée/); assert.match(txt, /10 caractéristiques de sécurité/); assert.match(txt, /Cela ne prouve ni l'identification technique ni la conformité/); assert.doesNotMatch(txt, /modèle exact manquant|numéro de modèle exact n'est pas/i);
    assert.equal(sum.details.filter((d) => /Identification technique incomplète/.test(d)).length, 1, 'told once, not under two codes'); assert.equal(sum.needsCategory, true); assert.ok(sum.labels.length === new Set(sum.labels).size);
  }
});
test('1b. the REAL app flow: the product name "Batterie externe" already makes the engine ASSUME the ten safety traits (name cues), yet the category is not confirmed: still "Identification technique incomplète", worded for that cause', () => {
  const named = (c) => dispatch(c, { type: 'NAME', name: 'Batterie externe' }, at(1)); const c = named(remax()); const conf = view(c).a.identity.confidence;
  assert.equal(conf.level, 'LOW'); assert.equal(conf.categoryConfirmed, false); assert.equal(conf.unresolvedTraits.length, 0, 'the traits are assumed from the name, not unresolved'); assert.ok(conf.assumedFromProfileOnly.length >= 2);
  const { ev, sum } = view(c); assert.deepEqual(ev.blockingCodes.filter((x) => IDENT.includes(x)), ['PRODUCT_IDENTITY_UNRESOLVED']); const txt = sum.details.join('\n'); assert.match(txt, /Numéro de modèle Fc-02 : connu/); assert.match(txt, /catégorie du produit n'est pas confirmée, et les \d+ caractéristiques de sécurité \(.+\) ne sont que supposées d'après le nom du produit/); assert.equal(sum.needsCategory, true);
  const done = named(remax({ category: 'power_bank' })); assert.equal(view(done).a.identity.confidence.level, 'MEDIUM'); assert.ok(!view(done).ev.blockingCodes.some((x) => IDENT.includes(x)));
});
test('2. model ABSENT: "Numéro de modèle" (nothing known, nothing proposed) with a direct way to ask for it', () => {
  const c = supplier('NoModel', 'batterie externe', 'price 11.68 USD, MOQ 60'); const idn = identificationStatus(c, assess(c, { now: at(60), externals: {} })); assert.equal(idn.model.state, 'ABSENT'); const { ev, sum } = view(c);
  assert.ok(ev.blockingCodes.includes('MODEL_NOT_ESTABLISHED')); assert.match(ev.blocking[ev.blockingCodes.indexOf('MODEL_NOT_ESTABLISHED')], /exact model number is not known yet/); assert.ok(sum.labels.includes('Modèle et identification technique'), 'both gaps at once share one first-level word'); assert.match(sum.details.join('\n'), /Numéro de modèle : aucun n'est connu/);
  assert.ok(sum.actions.some((x) => x.act === 'sl-case-tab' && x.key === 'ask'), 'direct access: ask for the model');
  const withCat = view(supplier('NoModel2', 'batterie externe', 'price 11.68 USD, MOQ 60', { category: 'power_bank' })); assert.ok(withCat.sum.labels.includes('Numéro de modèle') && !withCat.sum.labels.some((l) => /technique/.test(l)), withCat.sum.labels.join());
});
test('3. model PROPOSED, not confirmed: told as "Modèle à confirmer", counted ONCE (not also as a fact to review), with a link to the facts', () => {
  const c = supplier('Prop', 'batterie externe', 'price 11.68 USD, MOQ 60, model Fc-02', { confirm: ['quote.unitPrice', 'quote.moq'], category: 'power_bank' }); const idn = identificationStatus(c, assess(c, { now: at(60), externals: {} })); assert.equal(idn.model.state, 'PROPOSED'); assert.deepEqual(idn.model.proposed, ['Fc-02']);
  const { ev, sum } = view(c); assert.ok(ev.blockingCodes.includes('MODEL_NOT_CONFIRMED')); assert.ok(sum.labels.includes('Modèle à confirmer')); assert.match(sum.details.join('\n'), /Fc-02 est proposé mais pas encore confirmé/); assert.ok(sum.actions.some((x) => x.key === 'facts'));
  assert.ok(!ev.importantCodes.includes('FACTS_TO_REVIEW') || ev.important.every((t) => !/identifier\.model|model/i.test(t)), 'the proposed model is not counted a second time as a fact to review');
});
test('4. model CONFIRMED but category or traits incomplete: the model never completes the identification (and is never asked again); a category CONFIRMED by the owner completes it, a GUESSED one does not', () => {
  const c = remax(); const m = c.candidates.filter((k) => k.key === 'identifier.model'); assert.equal(m.length, 1); assert.equal(m[0].state, 'CONFIRMED'); assert.equal(c.candidates.filter((k) => k.key === 'identifier.model' && k.state === 'PROPOSED').length, 0, 'no second confirmation of the model');
  assert.equal(c.ledger.find((e) => e.key === 'identifier.model').status, 'SUPPLIER_CLAIM', 'still the supplier\'s word: neither verified nor independent proof'); assert.equal(factStatusBoard(c, { locale: 'fr' }).find((b) => b.fact_type === 'MODEL').state, 'CONFIRMED');
  assert.equal(view(c).a.identity.confidence.level, 'LOW');
  const guessed = remax({ category: 'power_bank', categoryLevel: 'AI_SUGGESTED' }); assert.equal(view(guessed).a.identity.confidence.level, 'LOW', 'a guessed category alone stays LOW: nothing is relaxed'); assert.ok(view(guessed).ev.blockingCodes.includes('PRODUCT_IDENTITY_UNRESOLVED'));
  const done = remax({ category: 'power_bank' }); const { ev, a, sum } = view(done); assert.equal(a.identity.confidence.level, 'MEDIUM'); assert.ok(!ev.blockingCodes.some((x) => IDENT.includes(x)) && !sum.labels.some((l) => /modèle|identification/i.test(l)), sum.labels.join());
});
test('5. model CONTRADICTORY: two different model numbers -> "Modèles contradictoires", counted once (not again as a generic contradiction)', () => {
  let c = remax({ category: 'power_bank' }); c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'auto', text: 'sorry the model is Fc-03' }, at(10)); const k = c.candidates.find((x) => x.key === 'identifier.model' && x.state === 'PROPOSED'); assert.equal(k.value, 'Fc-03');
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(11)); assert.equal(c.conflicts.filter((x) => x.state === 'OPEN').length, 1, 'a conflict is raised, nothing is overwritten'); const idn = identificationStatus(c, assess(c, { now: at(60), externals: {} })); assert.equal(idn.model.state, 'CONTRADICTORY'); assert.ok(idn.model.values.includes('Fc-02') && idn.model.values.includes('Fc-03'));
  const { ev, sum } = view(c); assert.ok(ev.blockingCodes.includes('MODEL_CONTRADICTORY')); assert.ok(!ev.blockingCodes.includes('OPEN_CONTRADICTION'), 'one contradiction, one code'); assert.ok(sum.labels.includes('Modèles contradictoires')); assert.match(sum.details.join('\n'), /ne s'accordent pas \(Fc-02 \/ Fc-03\)/);
  assert.equal(modelState(c).conflictIds.length, 1);
});
test('6. identification COMPLETE (model + confirmed category) but NO regulatory documents: the identification gap is gone, the real blockers stay (documents, costs), the verdict is not "compliant"', () => {
  const c = remax({ category: 'power_bank' }); const { ev, a, sum } = view(c);
  assert.ok(ev.blockingCodes.includes('REQUIRED_DOCUMENT_MISSING') && ev.blockingCodes.includes('LANDED_UNKNOWN')); assert.ok(a.decision.hardBlockers.some((b) => b.code === 'REQUIRED_DOCUMENT_MISSING') && a.decision.hardBlockers.some((b) => b.code === 'CRITICAL_COST_UNKNOWN'));
  assert.ok(sum.labels.includes('Documents de conformité') && sum.docs.length >= 3, 'the documents to obtain are listed'); assert.equal(a.decision.canCommitMoney, false); assert.notEqual(a.decision.verdict, 'GO'); assert.ok(a.decision.conditions.some((x) => /obtain the required documents/.test(x)), 'a known model does not make the product compliant');
  assert.ok(a.decision.conditions.some((x) => /traits that are only assumed from the category/.test(x)), 'the traits supposed by the category still await the owner\'s confirmation');
});
test('7. KEY_TRAITS are not loosened: still the same ten; for a battery pack a CONFIRMED category supposes all ten (no useless request), no category leaves all ten unresolved', () => {
  assert.equal(KEY_TRAITS.length, 10); const none = view(remax()).a.identity.confidence; assert.equal(none.unresolvedTraits.length, 10); assert.equal(none.categoryConfirmed, false);
  const some = view(remax({ category: 'power_bank' })).a.identity.confidence; assert.equal(some.unresolvedTraits.length, 0); assert.equal(some.assumedFromProfileOnly.length, 10, 'supposed, not established'); assert.equal(some.categoryConfirmed, true);
  const bad = view(supplier('H', 'gobelet', 'price 2 USD, MOQ 60, model H-1', { category: 'household_general' })).a.identity.confidence; assert.ok(['LOW', 'MEDIUM'].includes(bad.level));
});
test('8. the views: the Remax sheet names "Identification technique incomplète" with the category decision in the blocker detail; "Modèle exact" is gone; nothing is selected for the owner', () => {
  const c = remax(); const v = eng.caseView(c, newWorkspace(at(0)), ['evidenceStatus', 'recommendation']); const cats = { options: [{ id: 'power_bank', label: 'Batterie externe (power bank)' }, { id: 'usb_charger', label: 'Chargeur USB' }], suggested: 'power_bank' };
  const html = N.ficheHtml({ info: { caseId: c.id, title: 'Batterie externe', supplier: 'Remax' }, v, tab: 'sum', sub: null, flash: '', sync: { kind: 'synced', label: 'Serveur à jour' }, conflicts: 0, photos: [], questionsHtml: '', factsView: {}, board: [], lastNotes: [], counts: { toConfirm: 0, waiting: 0 }, negotiation: null, strip: [], now: Date.now(), cats });
  assert.match(html, /Identification technique incomplète/); assert.doesNotMatch(html, /Modèle exact/); assert.match(html, /<form data-form="sl-category"/); assert.match(html, /<option value="power_bank" selected>Batterie externe \(power bank\) \(suggérée\)/); assert.match(html, /Confirmer la catégorie/); assert.match(html, /rien n'est confirmé sans vous/);
  const done = remax({ category: 'power_bank' }); const v2 = eng.caseView(done, newWorkspace(at(0)), ['evidenceStatus', 'recommendation']); const html2 = N.ficheHtml({ info: { caseId: done.id, title: 'Batterie externe', supplier: 'Remax' }, v: v2, tab: 'sum', sub: null, flash: '', sync: { kind: 'synced', label: 'x' }, conflicts: 0, photos: [], questionsHtml: '', factsView: {}, board: [], lastNotes: [], counts: { toConfirm: 0, waiting: 0 }, negotiation: null, strip: [], now: Date.now(), cats });
  assert.doesNotMatch(html2, /sl-category/); assert.doesNotMatch(html2, /Identification technique incomplète/); assert.match(html2, /Documents de conformité/);
});
