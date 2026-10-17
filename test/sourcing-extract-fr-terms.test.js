// REGRESSION - staging case case-mvcbnpmd. A French supplier note gave only EUR and the unit price 5; the minimum order, the lead time and the offered quantity were not proposed because the extractor
// only knew English and Chinese wording. These tests pin the French readings, the difference between the THREE quantities (offered / minimum / ordered), the "nothing is confirmed for you" rule,
// the additive owner-initiated re-reading of a stored case, and that price / currency / English / Chinese extraction did not move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts } from '../src/sourcing/core/extract/index.js';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { describeCandidate } from '../src/sourcing/core/candidate-view.js';

const NOTE = 'Nous proposons 100 gourdes en acier inoxydable à 5 € pièce. Quantité minimale : 100 unités. Livraison en Belgique non précisée. Délai de fabrication : 15 jours.';
const facts = (text) => extractFacts({ text }).candidates;
const of = (text, key, context) => facts(text).filter((c) => c.key === key && (context === undefined || c.context === context));
const val = (text, key) => of(text, key)[0]?.value;
const keys = (text) => facts(text).map((c) => c.key).sort();

test('1. the exact staging note: price and currency as before, plus MOQ 100, lead time 15 days and offered quantity 100', () => {
  assert.equal(val(NOTE, 'quote.unitPrice'), '5');
  assert.equal(val(NOTE, 'quote.currency'), 'EUR');
  assert.equal(val(NOTE, 'quote.moq'), '100');
  assert.deepEqual(val(NOTE, 'quote.leadTime'), { min: '15', max: '15', unit: 'days' });
  assert.equal(val(NOTE, 'quote.offeredQty'), '100');
  assert.equal(of(NOTE, 'quote.tiers').length, 0, 'an offered quantity beside one price is not a price table');
  for (const c of facts(NOTE)) assert.equal(NOTE.slice(c.span[0], c.span[1]), c.rawText, `${c.key} points at the exact characters`);
  assert.equal(of(NOTE, 'quote.moq')[0].rawText, 'Quantité minimale : 100 unités');
  assert.equal(of(NOTE, 'quote.offeredQty')[0].rawText, '100 gourdes');
  assert.equal(of(NOTE, 'quote.leadTime')[0].rawText, 'Délai de fabrication : 15 jours');
});

test('2. "Livraison en Belgique non précisée" is not a lead time and nothing is invented for it', () => {
  assert.equal(of('Livraison en Belgique non précisée.', 'quote.leadTime').length, 0);
  assert.equal(of(NOTE, 'quote.leadTime').length, 1, 'only the manufacturing delay');
  assert.equal(of(NOTE, 'quote.incoterm').length, 0); assert.equal(of(NOTE, 'quote.port').length, 0);
});

test('3. offered quantity, MOQ and the quantity ordered are three different things', () => {
  const t = 'Nous proposons 500 gourdes à 4,80 € pièce. Quantité minimale : 100 unités.';
  assert.equal(val(t, 'quote.offeredQty'), '500'); assert.equal(val(t, 'quote.moq'), '100');
  assert.notEqual(val(t, 'quote.offeredQty'), val(t, 'quote.moq'));
  const only = 'Nous proposons 100 gourdes à 5 € pièce.';
  assert.equal(of(only, 'quote.moq').length, 0, 'an offered quantity is NOT a minimum order');
  assert.equal(of('Quantité minimale : 100 unités.', 'quote.offeredQty').length, 0, 'a minimum order is NOT an offered quantity');
  const c = of(NOTE, 'quote.offeredQty')[0]; assert.equal(describeCandidate(c, 'fr').label, 'Quantité proposée'); assert.equal(describeCandidate(c, 'fr').valueText, '100 pièces');
  assert.equal(describeCandidate(of(NOTE, 'quote.moq')[0], 'fr').label, 'Minimum de commande');
});

test('4. similar French wordings of the minimum order', () => {
  for (const [t, ctx] of [
    ['Quantité minimale : 100 unités.', 'product'], ['Quantité minimale de commande 100 pièces', 'product'], ['La quantité minimum est de 100 pièces.', 'product'], ['Commande minimale : 100 pcs', 'product'],
    ['Minimum de commande : 100 unités', 'product'], ['Minimum d’achat 100 pièces', 'product'], ['Minimum de 100 pièces', 'product'], ['minimum 100 unités', 'product'], ['100 pièces minimum', 'product'],
    ['100 unités au minimum par commande', 'product'], ['MOQ de 100 pièces', 'product'], ['MOQ : 100 unités', 'product'], ['Qté min : 100 pcs', 'product'], ['Quantité minimale environ 100 unités', 'product'],
  ]) { const c = of(t, 'quote.moq'); assert.equal(c.length, 1, t); assert.equal(c[0].value, '100', t); assert.equal(c[0].context, ctx, t); assert.equal(c[0].confidence, 'HIGH', t); }
  assert.equal(val('Quantité minimale : 1 000 unités', 'quote.moq'), '1000'); assert.equal(val('Quantité minimale : 1 000 unités', 'quote.moq'), '1000');
});

test('5. a minimum order for a logo, a packaging or a sample keeps its context (it is not the product MOQ)', () => {
  assert.equal(of('Quantité minimale avec votre logo : 300 unités.', 'quote.moq')[0].context, 'custom_logo');
  assert.equal(of('Quantité minimale pour un emballage personnalisé : 500 pièces.', 'quote.moq')[0].context, 'custom_packaging');
  assert.equal(of('Quantité minimale pour les échantillons : 2 pièces.', 'quote.moq')[0].context, 'sample');
  assert.equal(val('Quantité minimale par couleur : 50 pièces.', 'moq.perColour'), '50'); assert.equal(of('Quantité minimale par couleur : 50 pièces.', 'quote.moq').length, 0, 'a per-colour minimum is its own fact, as in English');
});

test('6. French thousands: "1.000" is refused as ambiguous instead of guessed (1.0 or 1000?)', () => {
  const c = of('Quantité minimale : 1.000 unités', 'quote.moq')[0]; assert.equal(c.value, null); assert.equal(c.needsCorrection, true); assert.equal(c.suggestion, '1000'); assert.equal(c.confidence, 'LOW');
});

test('7. similar French wordings of the lead time', () => {
  for (const [t, min, max] of [
    ['Délai de fabrication : 15 jours', '15', '15'], ['Délai de production 15 jours', '15', '15'], ['Délai : 15 jours', '15', '15'], ['Le délai est de 15 jours.', '15', '15'], ['Durée de fabrication : environ 15 jours', '15', '15'],
    ['Fabrication en 15 jours', '15', '15'], ['Production sous 15 jours ouvrés', '15', '15'], ['Délai de fabrication : 10 à 15 jours', '10', '15'], ['Délai de fabrication : 10-15 jours', '10', '15'],
    ['Délai de fabrication : 2 semaines', '14', '14'], ['Délai de fabrication : 2 à 3 semaines', '14', '21'], ['Prêt en 15 jours', '15', '15'], ['Délai de préparation de 15 jours', '15', '15'],
  ]) { const c = of(t, 'quote.leadTime'); assert.equal(c.length, 1, t); assert.deepEqual(c[0].value, { min, max, unit: 'days' }, t); }
  assert.deepEqual(of('Délai de fabrication : 2 semaines', 'quote.leadTime')[0].flags, ['WEEKS_CONVERTED']);
  assert.equal(of('Délai de fabrication : 15 jours', 'quote.leadTime')[0].confidence, 'HIGH');
  assert.equal(of('Délai de livraison : 15 jours', 'quote.leadTime')[0].confidence, 'MEDIUM', 'a delivery delay may include transport: less sure');
});

test('8. things that look like a delay or a minimum but are not', () => {
  for (const t of ['Délai de paiement : 30 jours', 'Validité de l’offre 30 jours', 'Garantie 12 mois', 'Livraison en Belgique non précisée', 'Délai non précisé', 'Fabrication en Chine']) assert.equal(of(t, 'quote.leadTime').length, 0, t);
  for (const t of ['minimum 5 jours', 'Prix minimum 5 €', 'Quantité par carton : 100 unités', 'Nous livrons en 15 jours']) assert.equal(of(t, 'quote.moq').length, 0, t);
});

test('9. similar French wordings of the offered quantity', () => {
  for (const t of ['Nous proposons 100 gourdes à 5 € pièce.', 'Nous vous proposons 100 gourdes.', 'On propose 100 gourdes', 'Nous pouvons vous fournir 100 gourdes', 'Nous offrons 100 gourdes', 'Nous proposons une quantité de 100 gourdes']) {
    const c = of(t, 'quote.offeredQty'); assert.equal(c.length, 1, t); assert.equal(c[0].value, '100', t);
  }
  assert.equal(val('Nous proposons 1 000 gourdes', 'quote.offeredQty'), '1000');
  for (const t of ['Nous proposons 5 € pièce', 'Nous proposons 15 jours', 'Nous proposons 10 % de remise', 'Nous proposons 100 euros', 'Nous proposons un prix de 100']) assert.equal(of(t, 'quote.offeredQty').length, 0, t);
});

test('10. price, currency and the other supplier terms are not altered by the French rules', () => {
  // the same note without the three French terms reads exactly as before
  const t = 'Nous proposons gourdes à 5 € pièce.'; assert.deepEqual(keys(t), ['quote.currency', 'quote.unitPrice']);
  assert.equal(val(t, 'quote.unitPrice'), '5'); assert.equal(val(t, 'quote.currency'), 'EUR');
  // English notes: same candidates as ever, and no French key leaks in
  const en = 'Model GB-220: 100-299pcs USD7.20/pc, 300-499pcs USD6.80/pc, 500+pcs USD6.40/pc. MOQ 100pcs. Lead time 15 days. EXW Ningbo.';
  assert.deepEqual(val(en, 'quote.tiers'), [{ minQty: '100', unitPrice: '7.20' }, { minQty: '300', unitPrice: '6.80' }, { minQty: '500', unitPrice: '6.40' }]);
  assert.equal(val(en, 'quote.moq'), '100'); assert.deepEqual(val(en, 'quote.leadTime'), { min: '15', max: '15', unit: 'days' }); assert.equal(val(en, 'quote.incoterm'), 'EXW'); assert.equal(of(en, 'quote.offeredQty').length, 0);
  assert.equal(of(en, 'quote.moq').length, 1, 'one MOQ, never doubled by the French rule');
  assert.equal(of(en, 'quote.leadTime').length, 1, 'one lead time, never doubled by the French rule');
  const mixed = 'prix 12$, MOQ 60, délai 20 days'; assert.equal(val(mixed, 'quote.moq'), '60'); assert.equal(of(mixed, 'quote.moq').length, 1);
  assert.equal(val('起订量 500 个,交期 15 天', 'quote.moq'), '500'); assert.equal(of('起订量 500 个,交期 15 天', 'quote.offeredQty').length, 0);
  assert.equal(val('11$ moq 24pcs', 'quote.moq'), '24');
  // English wording of a per-colour minimum stays a per-colour fact; the French rules add no product MOQ next to it
  for (const t of ['You can mix colors, minimum 25 pcs per color.', 'minimum 50 pcs per colour', 'MOQ 25 pcs per colour']) assert.equal(of(t, 'quote.moq', 'product').length, 0, t);
  assert.equal(val('minimum 50 pcs per colour', 'moq.perColour'), '50');
  assert.equal(of('minimum 50 pcs', 'quote.moq').length, 0, 'English "minimum 50 pcs" is read exactly as before (not at all)');
  assert.equal(of('Prix 12 USD, MOQ 60 pièces', 'quote.moq').length, 1);
});

// ---- the case flow: nothing confirmed for the owner, the original note and what is already stored are kept -------------------------------------------------------------------------
const T0 = new Date('2026-10-17T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
function withNote(text = NOTE) {
  let c = newCase({ id: 'case-fr', name: 'gourdes', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Fournisseur FR' } }, at(0));
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Fournisseur FR', lang: 'auto' }, at(1)); const conv = c.conversations.at(-1);
  return dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text }, at(2));
}
const copy = (x) => JSON.parse(JSON.stringify(x));

test('11. nothing is confirmed automatically: every extracted fact is only PROPOSED, no quote and no ledger entry exists, the original note is kept word for word', () => {
  const c = withNote();
  assert.ok(c.candidates.length >= 5);
  for (const x of c.candidates) assert.equal(x.state, 'PROPOSED', x.key);
  assert.equal(c.quotes.length, 0); assert.equal(c.ledger.length, 0);
  assert.equal(c.conversations.at(-1).items.at(-1).original, NOTE);
});

test('12. confirming the offered quantity changes neither the MOQ nor the quantity ordered; confirming the MOQ is a separate owner act', () => {
  let c = withNote(); const id = (k) => c.candidates.find((x) => x.key === k).id;
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: id('quote.offeredQty') }, at(3));
  assert.equal(c.ledger.length, 1); assert.equal(c.ledger[0].key, 'quote.offeredQty');
  assert.equal(c.quotes.at(-1)?.moq, undefined, 'the offered quantity did not become the MOQ'); assert.equal(c.quotes.at(-1)?.qty, undefined, 'nor the quantity ordered'); assert.equal(c.context?.plannedQty, undefined);
  assert.equal(c.candidates.find((x) => x.key === 'quote.moq').state, 'PROPOSED');
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: id('quote.moq') }, at(4)); assert.equal(c.quotes.at(-1).moq, 100);
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: id('quote.leadTime') }, at(5)); assert.equal(c.quotes.at(-1).leadTimeDays, '15');
});

test('13. a stored case that only holds the old readings gets the missing ones ONLY by the owner\'s explicit re-reading, additively', () => {
  let c = withNote();
  // what the staging case held: only the currency and the unit price were ever proposed
  c = copy(c); c.candidates = c.candidates.filter((x) => x.key === 'quote.unitPrice' || x.key === 'quote.currency'); c.candidates.forEach((x, i) => { x.id = `cand-${i + 1}`; });
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: c.candidates.find((x) => x.key === 'quote.unitPrice').id }, at(3));
  const before = copy(c); const note = before.conversations.at(-1).items.at(-1).original;
  const loaded = copy(before); assert.equal(loaded.candidates.length, 2, 'loading a case never rewrites it');
  const after = dispatch(c, { type: 'CONVERSATION_REANALYZE' }, at(4));
  const added = after.candidates.filter((x) => !before.candidates.some((b) => b.id === x.id));
  assert.deepEqual(added.map((x) => x.key).sort(), ['quote.leadTime', 'quote.moq', 'quote.offeredQty']);
  for (const x of added) { assert.equal(x.state, 'PROPOSED'); assert.equal(x.recovery.kind, 'OWNER_INITIATED_REANALYSIS'); }
  assert.deepEqual(after.candidates.slice(0, 2), before.candidates, 'the earlier candidates, including the confirmed price, are untouched');
  assert.deepEqual(after.ledger, before.ledger); assert.deepEqual(after.quotes, before.quotes);
  assert.equal(after.conversations.at(-1).items.at(-1).original, note);
  assert.equal(dispatch(after, { type: 'CONVERSATION_REANALYZE' }, at(5)).candidates.length, after.candidates.length, 'a second re-reading adds nothing');
});
