// China Sourcing V1 foundation (P1 + P4 domain): provenance, candidate facts, conflicts, price tiers, conversation sessions, free questions, backward compatibility.
// Invariants (hard): a supplier claim is not evidence; a candidate never changes the case before the user confirms it; a rejected candidate changes nothing; the original text is
// never altered; a conflicting material fact is never overwritten silently; old V0 cases load and assess exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { upgradeCase, CASE_SCHEMA } from '../src/sourcing/core/upgrade.js';
import { FACT_STATUS, CANDIDATE_STATE, documentStatusOf } from '../src/sourcing/core/provenance.js';
import { documentModelConflicts, compareModels } from '../src/sourcing/core/conflicts.js';
import { resolveUnitPrice, effectiveQuote } from '../src/sourcing/core/offers.js';
import { summarizeConversation, userQuestionView } from '../src/sourcing/core/conversation.js';
import { NOW, MFR, build, run, ident, traits, importer, commercial, doc, eudoc, docsFor, extraTraits } from './sourcing-fixtures.js';

const at = (n = 0) => new Date(NOW.getTime() + n * 1000);
const start = (s, supplierRef = 'Booth 12', n = 1) => dispatch(s, { type: 'CONVERSATION_START', supplierRef, lang: 'auto' }, at(n));
const say = (s, text, { speaker = 'supplier', n = 2 } = {}) => dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations.at(-1).id, speaker, lang: 'auto', text }, at(n));
const cand = (s, key, ctx) => s.candidates.find((c) => c.key === key && (ctx === undefined || c.context === ctx));
const confirm = (s, c, n = 3) => dispatch(s, { type: 'CANDIDATE_CONFIRM', id: c.id }, at(n));
const view = (a) => JSON.stringify({ q: a.questions.map((x) => [x.id, x.priority]), v: a.decision.verdict, gaps: a.decision.gaps, hb: a.decision.hardBlockers.map((b) => b.code), sum: a.rules.summary, ver: a.evidence.verified, docs: a.documents.length, landed: a.landed.status });

test('schema 2: a new case carries the V1 collections; upgradeCase adds them to a V0 case without touching anything else; it is idempotent', () => {
  const c = newCase({ id: 'x', now: NOW }); assert.equal(c.schema, CASE_SCHEMA); assert.equal(CASE_SCHEMA, 2);
  for (const k of ['conversations', 'candidates', 'ledger', 'conflicts', 'documentLedger', 'userQuestions']) assert.deepEqual(c[k], [], k);
  const legacy = JSON.parse(JSON.stringify(c)); for (const k of ['conversations', 'candidates', 'ledger', 'conflicts', 'documentLedger', 'userQuestions']) delete legacy[k]; legacy.schema = 1;
  const up = upgradeCase(legacy); assert.equal(up.schema, 2); for (const k of ['conversations', 'candidates', 'ledger', 'conflicts', 'documentLedger', 'userQuestions']) assert.deepEqual(up[k], []);
  assert.equal(legacy.schema, 1, 'the input is never mutated'); assert.deepEqual(upgradeCase(up), up, 'idempotent');
  assert.deepEqual({ ...up, schema: 1, conversations: undefined, candidates: undefined, ledger: undefined, conflicts: undefined, documentLedger: undefined, userQuestions: undefined }, { ...legacy, conversations: undefined, candidates: undefined, ledger: undefined, conflicts: undefined, documentLedger: undefined, userQuestions: undefined }, 'nothing else changed');
});

test('backward compatibility: realistic V0 cases (no V1 fields at all) assess IDENTICALLY before and after the upgrade, and still accept every V0 event', () => {
  const scenarios = [
    [...ident({ name: 'Power bank 10000mAh', category: 'power_bank', model: 'PB-X200' }), ...traits({ 'battery.present': true, 'electrical.present': true }), ...importer, ...commercial(), ...docsFor.powerbank('PB-X200')],
    [...ident({ name: 'USB charger', category: 'usb_charger' }), ...importer, ...commercial({ unitPrice: 3.1, qty: 500, moq: 300 })],
    [{ type: 'NAME', name: 'Mystery gadget' }],
  ];
  for (const events of scenarios) {
    const c = build(events); const legacy = JSON.parse(JSON.stringify(c)); for (const k of ['conversations', 'candidates', 'ledger', 'conflicts', 'documentLedger', 'userQuestions']) delete legacy[k]; legacy.schema = 1;
    assert.deepEqual(run(upgradeCase(legacy)), run(c)); assert.deepEqual(run(legacy), run(c), 'assess works on a legacy object directly');
    const next = dispatch(legacy, { type: 'NOTE', text: 'still works' }, at(5)); assert.equal(next.schema, 2); assert.equal(next.notes.at(-1).text, 'still works');
  }
  assert.throws(() => dispatch(newCase({ now: NOW }), { type: 'NOPE' }, NOW), /unknown case event/);
});

test('a conversation item stores the ORIGINAL text exactly (Chinese included) and proposes candidates; the case itself is NOT changed', () => {
  const text = '型号：PB-X200，起订量300个，单价6.8美金，FOB深圳，定金30%，发货前付尾款';
  let s = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' })]); const before = run(s);
  s = start(s); s = say(s, text);
  const conv = s.conversations[0]; assert.equal(conv.items.length, 1); assert.equal(conv.items[0].original, text, 'byte-for-byte'); assert.equal(conv.items[0].speaker, 'supplier'); assert.equal(conv.items[0].lang, 'zh'); assert.deepEqual(conv.items[0].derived, []);
  assert.ok(s.candidates.length >= 6); for (const c of s.candidates) { assert.equal(c.state, CANDIDATE_STATE.PROPOSED); assert.equal(c.convId, conv.id); assert.equal(c.itemId, conv.items[0].id); assert.equal(c.speaker, 'supplier'); assert.ok(c.proposedAt); }
  assert.equal(s.quotes.length, 0, 'no quote before confirmation'); assert.equal(s.identity.identifiers.model, 'PB-X200'); assert.deepEqual(run(s), { ...before, asOf: run(s).asOf }, 'assessment unchanged by unconfirmed candidates');
  assert.equal(s.ledger.length, 0);
});

test('CONFIRM turns a candidate into the EXISTING events (QUOTE, IDENTIFIER...) and a ledger entry; a supplier statement stays SUPPLIER_CLAIM', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s);
  s = say(s, 'For 300 pcs we can do USD 6.80, FOB Shenzhen, 30% deposit and balance before shipment. Model: PB-X200');
  for (const key of ['quote.tiers', 'quote.currency', 'quote.incoterm', 'quote.port', 'payment.depositPct', 'payment.balancePct', 'identifier.model']) s = confirm(s, cand(s, key));
  const q = s.quotes.at(-1); assert.equal(q.incoterm, 'FOB'); assert.equal(q.currency, 'USD'); assert.equal(q.port, 'Shenzhen'); assert.deepEqual(q.tiers, [{ minQty: '300', unitPrice: '6.80' }]); assert.deepEqual(q.payment, { depositPct: '30', balancePct: '70' });
  assert.equal(s.identity.identifiers.model, 'PB-X200');
  const m = s.ledger.find((e) => e.key === 'identifier.model'); assert.equal(m.status, FACT_STATUS.SUPPLIER_CLAIM); assert.equal(m.userConfirmed, true); assert.equal(m.corrected, false); assert.ok(m.source.convId && m.source.itemId && m.source.candidateId); assert.ok(m.confirmedAt);
  assert.equal(s.identity.evidence.model.at(-1).level, 'SUPPLIER_CLAIMED', 'identity evidence level: supplier claimed, not user stated');
  assert.ok(s.events.some((e) => e.type === 'QUOTE'), 'compiled into the existing QUOTE event'); assert.ok(s.events.some((e) => e.type === 'IDENTIFIER'));
  for (const e of s.ledger) assert.ok(![FACT_STATUS.VERIFIED, FACT_STATUS.DOCUMENT_RECEIVED, FACT_STATUS.DOCUMENT_MATCHED].includes(e.status), `${e.key} must not exceed a claim`);
  assert.equal(s.candidates.find((c) => c.key === 'quote.tiers').state, CANDIDATE_STATE.CONFIRMED);
});

test('REJECT changes nothing in the case; the candidate is kept (audit) and marked rejected', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); s = say(s, 'MOQ 100 pcs, USD 7.20'); const snapshot = JSON.stringify({ q: s.quotes, id: s.identity, led: s.ledger });
  s = dispatch(s, { type: 'CANDIDATE_REJECT', id: cand(s, 'quote.moq').id }, at(4)); s = dispatch(s, { type: 'CANDIDATE_REJECT', id: cand(s, 'quote.unitPrice').id }, at(5));
  assert.equal(JSON.stringify({ q: s.quotes, id: s.identity, led: s.ledger }), snapshot); assert.equal(cand(s, 'quote.moq').state, CANDIDATE_STATE.REJECTED); assert.ok(cand(s, 'quote.moq').decidedAt);
});

test('CORRECT applies the corrected value, records USER_PROVIDED, and keeps the original candidate value and the supplier text untouched', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); const text = 'Model: PB-X20O, USD 6.80'; s = say(s, text);
  const c0 = cand(s, 'identifier.model'); assert.equal(c0.value, 'PB-X20O'); s = dispatch(s, { type: 'CANDIDATE_CORRECT', id: c0.id, value: 'PB-X200' }, at(3));
  const c1 = cand(s, 'identifier.model'); assert.equal(c1.state, CANDIDATE_STATE.CORRECTED); assert.equal(c1.original.value, 'PB-X20O', 'the original proposal is preserved'); assert.equal(c1.correctedValue, 'PB-X200');
  assert.equal(s.identity.identifiers.model, 'PB-X200'); const led = s.ledger.find((e) => e.key === 'identifier.model'); assert.equal(led.status, FACT_STATUS.USER_PROVIDED); assert.equal(led.corrected, true); assert.equal(led.original.value, 'PB-X20O');
  assert.equal(s.identity.evidence.model.at(-1).level, 'USER_STATED'); assert.equal(s.conversations[0].items[0].original, text);
});

test('a candidate that NEEDS CORRECTION (ambiguous number) cannot be confirmed as is; a correction makes it usable', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); s = say(s, 'price USD 6,8 per piece'); const c = cand(s, 'quote.unitPrice'); assert.equal(c.needsCorrection, true); assert.equal(c.value, null);
  assert.throws(() => dispatch(s, { type: 'CANDIDATE_CONFIRM', id: c.id }, at(3)), /needs a correction/i);
  s = dispatch(s, { type: 'CANDIDATE_CORRECT', id: c.id, value: '6.80' }, at(4)); assert.equal(s.quotes.at(-1).unitPrice, '6.80');
  assert.throws(() => dispatch(s, { type: 'CANDIDATE_CORRECT', id: cand(s, 'quote.currency')?.id ?? c.id, value: '' }, at(5)), /value/i, 'an empty correction is refused');
});

test('MOQ context: base MOQ 100 and custom-logo MOQ 300 coexist (no conflict, no overwrite); a second base MOQ that differs is a CONFLICT', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); s = say(s, 'MOQ is 100 pcs for the standard model. With your logo the MOQ is 300 pcs.');
  s = confirm(s, cand(s, 'quote.moq', 'product')); s = confirm(s, cand(s, 'quote.moq', 'custom_logo'));
  assert.equal(s.quotes.at(-1).moq, 100, 'the engines keep reading the PRODUCT MOQ'); assert.equal(s.conflicts.length, 0);
  assert.deepEqual(s.ledger.filter((e) => e.key === 'quote.moq').map((e) => [e.context, e.value]).sort(), [['custom_logo', '300'], ['product', '100']]);
  s = say(s, 'Actually the MOQ is 300 pcs.', { n: 6 }); const c2 = cand(s, 'quote.moq', 'product'); const newest = s.candidates.filter((c) => c.key === 'quote.moq' && c.context === 'product').at(-1); assert.ok(c2);
  s = confirm(s, newest, 7); assert.equal(s.quotes.at(-1).moq, 100, 'NOT overwritten'); assert.equal(newest.id, s.candidates.find((c) => c.id === newest.id).id);
  const conflict = s.conflicts.find((x) => x.state === 'OPEN'); assert.ok(conflict); assert.equal(conflict.key, 'quote.moq'); assert.deepEqual(conflict.entries.map((e) => e.value).sort(), ['100', '300']); assert.ok(conflict.question?.en, 'a clarification question is proposed');
  assert.equal(s.candidates.find((c) => c.id === newest.id).state, CANDIDATE_STATE.CONFLICT);
  const keep = dispatch(s, { type: 'CONFLICT_RESOLVE', id: conflict.id, choice: 'OLD' }, at(8)); assert.equal(keep.quotes.at(-1).moq, 100); assert.equal(keep.conflicts[0].state, 'RESOLVED');
  const take = dispatch(s, { type: 'CONFLICT_RESOLVE', id: conflict.id, choice: 'NEW' }, at(8)); assert.equal(take.quotes.at(-1).moq, 300); assert.equal(take.conflicts[0].resolution, 'NEW');
  assert.ok(take.ledger.some((e) => e.key === 'quote.moq' && e.value === '300' && e.context === 'product'), 'both statements stay in the ledger');
});

test('model mismatch: a supplier model that differs from the case model is a CONFLICT and never replaces it silently', () => {
  let s = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' })]); s = start(s); s = say(s, 'Model: PB-X180');
  const c = cand(s, 'identifier.model'); s = confirm(s, c);
  assert.equal(s.identity.identifiers.model, 'PB-X200'); const cf = s.conflicts.find((x) => x.type === 'MODEL_MISMATCH'); assert.ok(cf, 'a visible mismatch'); assert.deepEqual(cf.entries.map((e) => e.value).sort(), ['PB-X180', 'PB-X200']);
  const same = dispatch(s, { type: 'CONFLICT_RESOLVE', id: cf.id, choice: 'OLD' }, at(9)); assert.equal(same.identity.identifiers.model, 'PB-X200');
  const swap = dispatch(s, { type: 'CONFLICT_RESOLVE', id: cf.id, choice: 'NEW' }, at(9)); assert.equal(swap.identity.identifiers.model, 'PB-X180', 'the owner chose the supplier model: recorded as the owner decision'); assert.equal(swap.conflicts[0].state, 'RESOLVED');
});

test('model comparison is exact: PB-X200 / PB X200 / X200 are not silently equal; a format variant is reported as a variant that needs a decision', () => {
  assert.equal(compareModels('PB-X200', 'PB-X200').result, 'MATCH'); assert.equal(compareModels('PB-X200', 'PB-X180').result, 'MISMATCH');
  assert.equal(compareModels('PB-X200', 'PB X200').result, 'FORMAT_VARIANT'); assert.equal(compareModels('PB-X200', 'pb-x200').result, 'FORMAT_VARIANT'); assert.equal(compareModels('PB-X200', 'X200').result, 'MISMATCH');
  assert.equal(compareModels(null, 'PB-X200').result, 'NO_CASE_MODEL'); assert.equal(compareModels('PB-X200', '').result, 'NO_DOC_MODEL');
});

test('a document naming another model than the case is a visible MODEL_MISMATCH (computed, not stored); a format variant is flagged separately; the case model is untouched', () => {
  const base = [...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer];
  const wrong = build([...base, doc(eudoc({ model: 'PB-X180', product: 'Power bank' }), { id: 'd1' })]);
  const m = documentModelConflicts(wrong); assert.equal(m.length, 1); assert.equal(m[0].result, 'MISMATCH'); assert.equal(m[0].docId, 'd1'); assert.equal(m[0].caseModel, 'PB-X200'); assert.deepEqual(m[0].docModels, ['PB-X180']);
  assert.equal(wrong.identity.identifiers.model, 'PB-X200');
  const variant = build([...base, doc(eudoc({ model: 'PB X200', product: 'Power bank' }), { id: 'd2' })]); assert.equal(documentModelConflicts(variant)[0].result, 'FORMAT_VARIANT');
  const ok = build([...base, doc(eudoc({ model: 'PB-X200', product: 'Power bank' }), { id: 'd3' })]); assert.equal(documentModelConflicts(ok).length, 0);
});

test('SUPPLIER CLAIM IS NOT EVIDENCE: "we have CE and UN38.3" changes NOTHING in Docs, Rules, questions or the verdict', () => {
  const base = [...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...traits({ 'battery.present': true, 'electrical.present': true }), ...importer, ...commercial()];
  let s = build(base); const before = run(s);
  s = start(s); s = say(s, 'We have CE and UN38.3 certificates. We can send the RoHS report tomorrow.');
  for (const key of ['docClaim.CE', 'docClaim.UN383', 'docClaim.ROHS']) s = confirm(s, cand(s, key));
  assert.deepEqual(s.documentLedger.map((d) => [d.claim, d.status]).sort(), [['CE', 'CLAIMED'], ['ROHS', 'PROMISED'], ['UN383', 'CLAIMED']]);
  assert.equal(s.documents.length, 0, 'no document was received'); const after = run(s);
  assert.equal(view(after), view(before), 'questions, gaps, blockers, rules and verdict are unchanged'); assert.equal(after.documents.length, 0);
  assert.ok(after.questions.some((q) => q.id === 'doc:UN383' || /UN383/.test(q.id)), 'Nordla still asks for the UN 38.3 document');
  for (const e of s.ledger.filter((x) => x.key.startsWith('docClaim.'))) assert.equal(e.status, FACT_STATUS.SUPPLIER_CLAIM);
  assert.equal(documentStatusOf(s, 'UN383').status, 'CLAIMED'); assert.equal(documentStatusOf(s, 'ROHS').status, 'PROMISED'); assert.equal(documentStatusOf(s, 'FCC').status, 'NONE');
});

test('DOCUMENT PROMISED != RECEIVED != MATCHED: the document ledger status moves only when a real document is added', () => {
  const base = [...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer];
  let s = build(base); s = start(s); s = say(s, 'We have UN38.3.'); s = confirm(s, cand(s, 'docClaim.UN383'));
  assert.equal(documentStatusOf(s, 'UN383').status, 'CLAIMED');
  const un = (model) => `UN 38.3 test summary\nManual of Tests and Criteria, Section 38.3 - lithium battery test summary\nModel: ${model}\nManufacturer: ${MFR}\nAll tests passed. Date of issue: 2026-02-20\nTesting laboratory: Pearl Delta Testing Services Ltd`;
  const wrong = dispatch(s, { type: 'DOCUMENT', id: 'un1', text: un('PB-X180'), fileName: 'un383.txt', docType: 'UN383' }, at(8)); assert.equal(documentStatusOf(wrong, 'UN383').status, 'MISMATCH'); assert.equal(documentStatusOf(wrong, 'UN383').matched, false);
  const right = dispatch(s, { type: 'DOCUMENT', id: 'un2', text: un('PB-X200'), fileName: 'un383.txt', docType: 'UN383' }, at(8)); const st = documentStatusOf(right, 'UN383'); assert.equal(st.status, 'DOCUMENT_MATCHED'); assert.equal(st.received, 1);
  const nomodel = dispatch(s, { type: 'DOCUMENT', id: 'un3', text: 'UN 38.3 test summary - all tests passed', fileName: 'x.txt', docType: 'UN383' }, at(8)); assert.equal(documentStatusOf(nomodel, 'UN383').status, 'DOCUMENT_RECEIVED');
  assert.equal(documentStatusOf(build(base), 'UN383').status, 'NONE');
});

test('price tiers: 100 -> 7.20, 300 -> 6.80, 500 -> 6.40 are stored as tiers and resolved by quantity; boundaries and gaps are explicit', () => {
  const q = { currency: 'USD', tiers: [{ minQty: '500', unitPrice: '6.40' }, { minQty: '100', unitPrice: '7.20' }, { minQty: '300', unitPrice: '6.80' }] };
  const at_ = (qty) => resolveUnitPrice(q, qty);
  assert.equal(at_(100).unitPrice, '7.20'); assert.equal(at_(299).unitPrice, '7.20'); assert.equal(at_(300).unitPrice, '6.80'); assert.equal(at_(499).unitPrice, '6.80'); assert.equal(at_(500).unitPrice, '6.40'); assert.equal(at_(5000).unitPrice, '6.40');
  const below = at_(99); assert.equal(below.unitPrice, null); assert.equal(below.reason, 'BELOW_FIRST_TIER'); assert.equal(resolveUnitPrice({ ...q, unitPrice: '8.00' }, 99).unitPrice, '8.00', 'an explicit single price still answers below the first tier'); assert.equal(resolveUnitPrice({ ...q, unitPrice: '8.00' }, 99).source, 'QUOTE');
  assert.equal(resolveUnitPrice({ currency: 'USD', unitPrice: '5.00' }, 1000).source, 'QUOTE', 'a V0 quote without tiers behaves exactly as before');
  assert.equal(resolveUnitPrice({ tiers: [{ minQty: '100', unitPrice: '7.20' }, { minQty: '100', unitPrice: '7.00' }] }, 100).reason, 'AMBIGUOUS_TIER'); assert.equal(resolveUnitPrice(q, null).reason, 'QUANTITY_UNKNOWN');
  assert.equal(effectiveQuote({ ...q, qty: '300' }).unitPrice, '6.80'); assert.deepEqual(effectiveQuote({ unitPrice: '5', currency: 'USD' }), { unitPrice: '5', currency: 'USD' });
});

test('price tiers reach the landed-cost engine through the existing quote path: same result as a plain single-price quote; below the first tier it fails closed', () => {
  const common = [...ident({ name: 'Power bank', category: 'power_bank' }), ...importer, { type: 'COSTS', costs: { fx: { rate: 0.92, date: '2026-10-02', source: 'USER_ENTERED' }, costs: { freight: { total: 600, status: 'ESTIMATED' } }, importVat: { ratePct: 21, recoverable: true } } }, { type: 'CUSTOMS', customs: { chosenCode: '8507.60', duty: { ratePct: 2.7, kind: 'USER_ENTERED', source: 'owner' } } }, { type: 'SALE', sale: { sellingPriceGross: 21, vatRatePct: 21, targetContributionPct: 30 } }];
  const tiered = build([...common, { type: 'QUOTE', quote: { currency: 'USD', qty: 300, moq: 100, incoterm: 'FOB', tiers: [{ minQty: '100', unitPrice: '7.20' }, { minQty: '300', unitPrice: '6.80' }, { minQty: '500', unitPrice: '6.40' }] } }]);
  const plain = build([...common, { type: 'QUOTE', quote: { unitPrice: '6.80', currency: 'USD', qty: 300, moq: 100, incoterm: 'FOB' } }]);
  assert.deepEqual(run(tiered).landed.totals, run(plain).landed.totals); assert.equal(run(tiered).landed.goods.totalEurMinor, run(plain).landed.goods.totalEurMinor);
  assert.equal(run(tiered).landed.goods.unitPriceMinor, 680);
  const low = build([...common, { type: 'QUOTE', quote: { currency: 'USD', qty: 50, moq: 50, incoterm: 'FOB', tiers: [{ minQty: '100', unitPrice: '7.20' }] } }]); assert.equal(run(low).landed.status, 'INFORMATION_INSUFFICIENT'); assert.ok(run(low).landed.criticalUnknown.includes('supplier.unitPrice'));
  const wi = run(tiered, undefined, { quoteOverride: { qty: 500 } }); assert.equal(wi.landed.goods.unitPriceMinor, 640, 'what-if on quantity picks the 500 tier');
});

test('a V0 form QUOTE keeps tiers/port/payment unless the owner types a DIFFERENT unit price (then the tiers are dropped: an explicit single price wins)', () => {
  let s = build([{ type: 'QUOTE', quote: { currency: 'USD', qty: 300, moq: 100, tiers: [{ minQty: '100', unitPrice: '7.20' }, { minQty: '300', unitPrice: '6.80' }], port: 'Shenzhen', payment: { depositPct: '30', balancePct: '70' } } }]);
  const same = dispatch(s, { type: 'QUOTE', quote: { unitPrice: '6.80', currency: 'USD', qty: 300, moq: 100, incoterm: 'FOB' } }, at(1)); const qs = same.quotes.at(-1);
  assert.equal(qs.tiers.length, 2); assert.equal(qs.port, 'Shenzhen'); assert.deepEqual(qs.payment, { depositPct: '30', balancePct: '70' });
  const diff = dispatch(s, { type: 'QUOTE', quote: { unitPrice: '6.00', currency: 'USD', qty: 300, moq: 100 } }, at(1)).quotes.at(-1); assert.equal(diff.tiers, undefined); assert.equal(diff.port, 'Shenzhen'); assert.equal(diff.unitPrice, '6.00');
});

test('FINISH conversation summary: what we learned / still missing / contradictions; only confirmed facts reached the case', () => {
  let s = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer]); s = start(s);
  s = say(s, 'Model: PB-X180, MOQ 100 pcs, USD 7.20, FOB Shenzhen. We have CE.');
  s = confirm(s, cand(s, 'quote.moq')); s = confirm(s, cand(s, 'quote.incoterm')); s = confirm(s, cand(s, 'identifier.model')); s = dispatch(s, { type: 'CANDIDATE_REJECT', id: cand(s, 'quote.port').id }, at(5));
  s = dispatch(s, { type: 'CONVERSATION_FINISH', convId: s.conversations[0].id }, at(6)); assert.equal(s.conversations[0].status, 'FINISHED'); assert.ok(s.conversations[0].finishedAt);
  const a = run(s); const sum = summarizeConversation(s, s.conversations[0].id, a);
  assert.equal(sum.factsFound, s.candidates.length); assert.equal(sum.confirmed, 3 - 1 /* the model went to a conflict */); assert.equal(sum.rejected, 1); assert.equal(sum.conflicts, 1); assert.ok(sum.stillToReview >= 2, 'unreviewed candidates are counted'); assert.ok(sum.missingImportant >= 1, 'P1 questions still open');
  assert.equal(sum.documentClaimsNotReceived.length, 0, 'the CE claim was not confirmed yet'); assert.ok(sum.learned.length === sum.confirmed); assert.ok(sum.contradictions.some((c) => /PB-X180|PB-X200/.test(c.text)));
  assert.equal(s.quotes.at(-1).moq, 100); assert.equal(s.quotes.at(-1).unitPrice, undefined, 'the unconfirmed price never reached the case');
  const empty = summarizeConversation(build([]), 'none', run(build([]))); assert.equal(empty.factsFound, 0);
});

test('free user question: stored in the user\'s language; no Chinese is invented; a covered phrasebook question is still translated by the fixed phrasebook', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]);
  s = dispatch(s, { type: 'QUESTION_ADD', text: 'How many colours are available for this model and can I mix colours in the 100-piece MOQ?', lang: 'en' }, at(2));
  const q = s.userQuestions[0]; assert.equal(q.origin, 'USER'); assert.equal(q.state, 'OPEN'); assert.equal(q.translation, null); assert.equal(q.text, 'How many colours are available for this model and can I mix colours in the 100-piece MOQ?');
  const v = userQuestionView(q); assert.equal(v.en, q.text); assert.equal(v.zh, null); assert.match(v.zhNote, /no chinese/i); assert.equal(v.zhOrigin, 'NONE');
  const fr = userQuestionView({ ...q, lang: 'fr', text: 'Combien de couleurs ?' }); assert.equal(fr.zh, null); assert.equal(fr.en, null, 'a French question is not pretended to be English'); assert.match(fr.original, /couleurs/);
  s = dispatch(s, { type: 'QUESTION_STATE', id: q.id, state: 'ASKED' }, at(3)); assert.equal(s.userQuestions[0].state, 'ASKED'); assert.throws(() => dispatch(s, { type: 'QUESTION_ADD', text: '   ', lang: 'en' }, at(4)), /text/i);
  assert.ok(run(s).questions.every((x) => typeof x.zh === 'string'), 'the fixed phrasebook is untouched');
});

test('everything is plain JSON: the whole conversation state survives a storage round trip and keeps working (offline durability)', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); s = say(s, 'MOQ 100 pcs, USD 7.20, FOB Shenzhen'); s = confirm(s, cand(s, 'quote.moq'));
  const stored = JSON.parse(JSON.stringify(s)); assert.deepEqual(stored, s);
  const next = confirm(stored, cand(stored, 'quote.incoterm'), 9); assert.equal(next.quotes.at(-1).incoterm, 'FOB'); assert.equal(next.quotes.at(-1).moq, 100);
});

test('confirming an already decided candidate is idempotent for the case (no duplicate events, no duplicate ledger rows)', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); s = say(s, 'FOB Shenzhen'); const c = cand(s, 'quote.incoterm'); s = confirm(s, c); const n = s.events.length; const l = s.ledger.length; s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: c.id }, at(7));
  assert.equal(s.ledger.length, l); assert.equal(s.quotes.length, 1); assert.ok(s.events.length <= n + 1);
  assert.throws(() => dispatch(s, { type: 'CANDIDATE_CONFIRM', id: 'cand-none' }, at(8)), /unknown candidate/);
  assert.throws(() => dispatch(s, { type: 'CANDIDATE_REJECT', id: c.id }, at(8)), /already/i, 'a confirmed candidate cannot be silently rejected');
});

test('claim candidates of a speaker "me" (the owner\'s own note) are USER_PROVIDED, never SUPPLIER_CLAIM', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); s = say(s, 'MOQ 200 pcs', { speaker: 'me' }); s = confirm(s, cand(s, 'quote.moq'));
  assert.equal(s.ledger.find((e) => e.key === 'quote.moq').status, FACT_STATUS.USER_PROVIDED); assert.equal(s.quotes.at(-1).moq, 200);
});

test('extra: trait-related and unrelated candidates (colours, carton) go to the ledger only; no engine event is invented', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); s = say(s, 'Available colours: black, white. 50 pcs per carton, carton size 52x38x30 cm, G.W. 12.5 kg');
  const eventsBefore = s.events.length; for (const k of ['variant.colours', 'carton.qty', 'carton.dimensions', 'carton.grossWeight']) s = confirm(s, cand(s, k));
  assert.equal(s.quotes.length, 0, 'ledger-only facts do not create quotes'); assert.ok(s.ledger.length === 4);
  const carton = s.ledger.find((e) => e.key === 'carton.dimensions'); assert.deepEqual(carton.value, { l: '52', w: '38', h: '30', unit: 'cm' });
  assert.ok(extraTraits && s.events.length >= eventsBefore);
});

test('a quote form that still shows an earlier tier price (stale after a quantity change) does not silently drop the tiers; a genuinely different price does', () => {
  const tiers = [{ minQty: '100', unitPrice: '7.20' }, { minQty: '300', unitPrice: '6.80' }, { minQty: '500', unitPrice: '6.40' }];
  let s = build([{ type: 'QUOTE', quote: { currency: 'USD', qty: 300, moq: 100, tiers } }]);
  s = dispatch(s, { type: 'QUOTE', quote: { unitPrice: '6.80', currency: 'USD', qty: 500, moq: 100 } }, at(1)); assert.equal(s.quotes.at(-1).tiers.length, 3, 'qty changed to 500: the form still shows 6.80');
  assert.equal(effectiveQuote(s.quotes.at(-1)).unitPrice, '6.40', 'the 500 tier applies'); assert.equal(run(s).landed.goods.unitPriceMinor, 640);
  s = dispatch(s, { type: 'QUOTE', quote: { unitPrice: '6.80', currency: 'USD', qty: 500, moq: 100, incoterm: 'FOB' } }, at(2)); assert.equal(s.quotes.at(-1).tiers.length, 3, 'a second form save with the same stale price keeps the tiers');
  const manual = dispatch(s, { type: 'QUOTE', quote: { unitPrice: '5.90', currency: 'USD', qty: 500, moq: 100 } }, at(3)); assert.equal(manual.quotes.at(-1).tiers, undefined, 'a price that matches no quoted tier is an explicit override');
});

test('supplier statements about a document: promised -> claimed is recorded as progress; "we have it" vs "we do not have it" is a conflict, never a silent overwrite', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }]); s = start(s); s = say(s, 'We can send the UN38.3 report.'); s = confirm(s, cand(s, 'docClaim.UN383'));
  assert.equal(documentStatusOf(s, 'UN383').status, 'PROMISED');
  s = say(s, 'We have UN38.3.', { n: 5 }); s = confirm(s, s.candidates.filter((c) => c.key === 'docClaim.UN383').at(-1), 6); assert.equal(s.documentLedger.length, 2, 'both statements are recorded'); assert.equal(documentStatusOf(s, 'UN383').status, 'CLAIMED'); assert.equal(s.conflicts.length, 0);
  s = say(s, 'Sorry, we do not have UN38.3.', { n: 8 }); const flip = s.candidates.filter((c) => c.key === 'docClaim.UN383').at(-1); assert.equal(flip.value, 'NOT_AVAILABLE'); s = confirm(s, flip, 9);
  assert.equal(documentStatusOf(s, 'UN383').status, 'CLAIMED', 'not overwritten'); const cf = s.conflicts.find((x) => x.state === 'OPEN'); assert.ok(cf); assert.match(describeText(cf), /UN 38\.3/);
  const taken = dispatch(s, { type: 'CONFLICT_RESOLVE', id: cf.id, choice: 'NEW' }, at(10)); assert.equal(documentStatusOf(taken, 'UN383').status, 'NOT_AVAILABLE'); assert.equal(taken.documents.length, 0);
});
function describeText(cf) { return JSON.stringify(cf.question) + cf.key; }
