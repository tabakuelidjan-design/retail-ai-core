// "Nordla a compris": grouped confirmation for the field screen. The owner confirms a CLEAN group of facts with one deliberate tap; everything that needs a decision (conflict, ambiguity, low
// confidence, calculated value, document claim) is taken OUT of the group and shown individually. Provenance is unchanged: each fact is still confirmed one by one by the reducer, stays a
// SUPPLIER_CLAIM, and the batch records exactly what the owner saw. Nothing is ever confirmed implicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/sourcing/core/case.js';
import { groupUnderstanding } from '../src/sourcing/core/understanding.js';
import { documentStatusOf, FACT_STATUS } from '../src/sourcing/core/provenance.js';
import { extractFacts } from '../src/sourcing/core/extract/index.js';
import { NOW, build, run, ident, importer } from './sourcing-fixtures.js';

const at = (n = 0) => new Date(NOW.getTime() + n * 1000);
const PHONE = 'PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. We have black, white, blue and pink. You can mix colors, minimum 25 pcs per color. Production time is 15 days. We have CE, RoHS and UN38.3.';
const started = (extra = []) => dispatch(build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer, ...extra]), { type: 'CONVERSATION_START' }, at(1));
const say = (s, text, n = 2, speaker = 'supplier') => dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations.at(-1).id, speaker, lang: 'auto', text }, at(n));
const keys = (list) => list.map((c) => c.key).sort();
const reasonOf = (g, key) => g.attention.find((a) => a.candidate.key === key)?.reason;

test('the phone text: a clean group of 12 facts, the unlabelled model alone in front of the owner, the 3 document statements apart', () => {
  const s = say(started(), PHONE); const g = groupUnderstanding(s);
  assert.deepEqual(keys(g.group), ['moq.mixedColours', 'moq.perColour', 'payment.balanceDue', 'payment.balancePct', 'payment.depositPct', 'quote.currency', 'quote.incoterm', 'quote.leadTime', 'quote.moq', 'quote.port', 'quote.tiers', 'variant.colours']);
  assert.deepEqual(g.attention.map((a) => [a.candidate.key, a.reason]), [['identifier.model', 'LOW_CONFIDENCE']]); assert.deepEqual(keys(g.claims), ['docClaim.CE', 'docClaim.ROHS', 'docClaim.UN383']);
  assert.equal(g.group.length + g.attention.length + g.claims.length, s.candidates.length, 'every proposed fact is in exactly one place');
});

test('what must NEVER be grouped: conflicts, ambiguous values, calculated values, low confidence, duplicates, claims', () => {
  const g1 = groupUnderstanding(say(started(), '30% deposit and balance before shipment')); assert.equal(reasonOf(g1, 'payment.balancePct'), 'CALCULATED'); assert.ok(keys(g1.group).includes('payment.depositPct'));
  assert.equal(reasonOf(groupUnderstanding(say(started(), 'price USD 6,8 per piece')), 'quote.unitPrice'), 'AMBIGUOUS');
  const withMoq = started([{ type: 'QUOTE', quote: { unitPrice: '8', currency: 'USD', qty: 50, moq: 100 } }, ...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' })]);
  const g2 = groupUnderstanding(say(withMoq, 'MOQ is 300 pcs. Model: PB-X180')); assert.equal(reasonOf(g2, 'quote.moq'), 'CONFLICT'); assert.equal(reasonOf(g2, 'identifier.model'), 'CONFLICT'); assert.equal(g2.group.length, 0);
  const g3 = groupUnderstanding(say(started(), 'MOQ is 100 pcs. Actually MOQ is 300 pcs.')); assert.deepEqual(g3.attention.map((a) => a.reason), ['DUPLICATE', 'DUPLICATE']); assert.equal(g3.group.length, 0);
  assert.equal(reasonOf(groupUnderstanding(say(started(), '起订量1万个')), 'quote.moq'), 'CALCULATED');
  assert.equal(reasonOf(groupUnderstanding(say(started(), 'CIF Antwerp')), 'quote.port'), 'LOW_CONFIDENCE');
  assert.equal(reasonOf(groupUnderstanding(say(started(), 'unit price $6.80')), 'quote.currency'), 'LOW_CONFIDENCE', 'a currency guessed from a symbol is reviewed');
  const g4 = groupUnderstanding(say(started(), 'We have CE.')); assert.equal(g4.group.length, 0); assert.equal(g4.claims.length, 1);
});

test('the group is shown in plain French lines (what the owner reads before the tap)', () => {
  const g = groupUnderstanding(say(started(), PHONE), { locale: 'fr' }); const all = g.lines.join('\n');
  assert.match(all, /MOQ 50/); assert.match(all, /50 = 8 · 100 = 7\.20 · 300 = 6\.80/); assert.match(all, /FOB Shenzhen/); assert.match(all, /30 % d'acompte/); assert.match(all, /70 % avant expédition/); assert.match(all, /4 couleurs : black, white, blue, pink/); assert.match(all, /15 jours/); assert.match(all, /mélange possible/); assert.match(all, /min\. 25 par couleur/);
  assert.equal(g.claimsLine, 'CE · RoHS · UN 38.3 : le fournisseur dit les avoir ou les envoyer, aucun document reçu'); assert.ok(g.rows.every((r) => r.label && r.valueText && r.from));
});

test('one explicit tap confirms the group: the same confirmations as one by one, provenance intact, and the batch keeps exactly what the owner saw', () => {
  let s = say(started(), PHONE); const g = groupUnderstanding(s); const ids = g.group.map((c) => c.id);
  s = dispatch(s, { type: 'CANDIDATES_CONFIRM_BATCH', ids, via: 'GROUP', shown: g.rows.map((r) => ({ id: r.id, label: r.label, valueText: r.valueText })) }, at(5));
  const q = s.quotes.at(-1); assert.deepEqual(q.tiers, [{ minQty: '50', unitPrice: '8' }, { minQty: '100', unitPrice: '7.20' }, { minQty: '300', unitPrice: '6.80' }]); assert.equal(q.moq, 50); assert.equal(q.incoterm, 'FOB'); assert.equal(q.port, 'Shenzhen'); assert.deepEqual(q.payment, { depositPct: '30', balancePct: '70', balanceDue: 'before shipment' });
  const mine = s.ledger.filter((e) => ids.includes(e.source.candidateId)); assert.equal(mine.length, ids.length);
  for (const e of mine) { assert.equal(e.status, FACT_STATUS.SUPPLIER_CLAIM); assert.equal(e.userConfirmed, true); assert.equal(e.via, 'GROUP'); assert.equal(e.batchId, 'batch-1'); }
  const b = s.confirmBatches[0]; assert.deepEqual(b.ids, ids); assert.equal(b.via, 'GROUP'); assert.ok(b.at); assert.equal(b.shown.length, ids.length); assert.ok(b.shown.find((x) => /50/.test(x.valueText)));
  assert.equal(s.candidates.find((c) => c.key === 'identifier.model').state, 'PROPOSED', 'the item that needed attention is untouched'); assert.equal(s.identity.identifiers.model, null);
  assert.equal(s.documentLedger.length, 0, 'no claim was recorded by the group tap'); assert.equal(s.documents.length, 0);
  assert.equal(groupUnderstanding(s).group.length, 0, 'nothing left to group');
});

test('the group tap refuses anything that is not clean: a calculated value, a conflict, an ambiguous value, a document claim or an unknown id', () => {
  const s = say(started(), '30% deposit and balance before shipment. We have CE. Price USD 6,8'); const g = groupUnderstanding(s);
  const id = (key) => s.candidates.find((c) => c.key === key).id;
  for (const key of ['payment.balancePct', 'docClaim.CE', 'quote.unitPrice']) assert.throws(() => dispatch(s, { type: 'CANDIDATES_CONFIRM_BATCH', ids: [id(key)], via: 'GROUP' }, at(5)), /not eligible/i, key);
  assert.throws(() => dispatch(s, { type: 'CANDIDATES_CONFIRM_BATCH', ids: ['cand-999'], via: 'GROUP' }, at(5)), /unknown candidate|not eligible/i);
  assert.throws(() => dispatch(s, { type: 'CANDIDATES_CONFIRM_BATCH', ids: g.group.map((c) => c.id), via: 'GROUP', shown: [] }, at(5)), /does not match what was shown/i, 'what was confirmed must be what was shown');
  assert.ok(g.group.length >= 1);
});

test('document statements have their OWN deliberate tap ("noted as statements"): they become claims in the document ledger, never documents, never proof', () => {
  let s = say(started(), 'We have CE, RoHS and UN38.3.'); const g = groupUnderstanding(s);
  s = dispatch(s, { type: 'CANDIDATES_CONFIRM_BATCH', ids: g.claims.map((c) => c.id), via: 'CLAIMS' }, at(5));
  assert.deepEqual(s.documentLedger.map((d) => [d.claim, d.status]).sort(), [['CE', 'CLAIMED'], ['ROHS', 'CLAIMED'], ['UN383', 'CLAIMED']]); assert.equal(s.documents.length, 0);
  assert.equal(documentStatusOf(s, 'UN383').status, 'CLAIMED'); assert.equal(run(s).documents.length, 0); assert.ok(s.ledger.every((e) => e.status === FACT_STATUS.SUPPLIER_CLAIM && e.via === 'CLAIMS'));
  const s2 = say(started(), 'MOQ is 50 pcs'); assert.throws(() => dispatch(s2, { type: 'CANDIDATES_CONFIRM_BATCH', ids: [s2.candidates[0].id], via: 'CLAIMS' }, at(5)), /not eligible/i, 'a fact cannot go through the claims tap');
});

test('a double tap is harmless: already confirmed facts are skipped, no duplicate ledger rows, no empty batch', () => {
  let s = say(started(), 'MOQ is 50 pcs. FOB Shenzhen.'); const g = groupUnderstanding(s); const ev = { type: 'CANDIDATES_CONFIRM_BATCH', ids: g.group.map((c) => c.id), via: 'GROUP' };
  s = dispatch(s, ev, at(5)); const n = s.ledger.length; const b = s.confirmBatches.length; s = dispatch(s, ev, at(6)); assert.equal(s.ledger.length, n); assert.equal(s.confirmBatches.length, b);
});

test('individual attention items are still confirmed, corrected or rejected one by one (same events as the Expert review)', () => {
  let s = say(started(), 'PB-X200. price USD 6,8'); const g = groupUnderstanding(s);
  const model = g.attention.find((a) => a.candidate.key === 'identifier.model').candidate; s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: model.id }, at(5)); assert.equal(s.identity.identifiers.model, 'PB-X200'); assert.equal(s.identity.evidence.model.at(-1).level, 'SUPPLIER_CLAIMED');
  const price = g.attention.find((a) => a.candidate.key === 'quote.unitPrice').candidate; s = dispatch(s, { type: 'CANDIDATE_CORRECT', id: price.id, value: '6.80' }, at(6)); assert.equal(s.quotes.at(-1).unitPrice, '6.80');
  assert.equal(groupUnderstanding(s).attention.length, 0);
});

test('grouping is pure and deterministic and never mutates the case', () => {
  const s = say(started(), PHONE); const before = JSON.stringify(s); assert.deepEqual(groupUnderstanding(s), groupUnderstanding(s)); assert.equal(JSON.stringify(s), before);
  assert.ok(extractFacts({ text: 'We have black, white and pink' }).candidates.find((c) => c.key === 'variant.colours').confidence === 'HIGH', 'three colours after "we have" are a reliable list');
  assert.equal(extractFacts({ text: 'We have black and white' }).candidates.find((c) => c.key === 'variant.colours').confidence, 'MEDIUM', 'two colours stay a proposal to review');
});
