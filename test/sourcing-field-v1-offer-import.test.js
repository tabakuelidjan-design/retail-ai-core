// Field V1 - P6-lite OfferImport: every source, review of every fact, revisions that are not contradictions, nothing invented, nothing promoted to VERIFIED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { offerDraft, extractOfferExtras, manualOffer, parseChat, looksLikeChat, offerIdOf, attributeNameEvents, listOffers, contentHash } from '../src/sourcing/core/field/offer-import.js';

const T0 = new Date('2026-10-20T08:00:00Z'); const T1 = new Date('2026-10-20T09:00:00Z'); const T2 = new Date('2026-10-20T10:00:00Z');
const QUOTE_TEXT = 'Dear friend, model GB-220: 100-299pcs USD7.20/pc, 300-499pcs USD6.80/pc, 500+pcs USD6.40/pc. MOQ 100pcs. EXW Ningbo. Lead time 15-20 days. Payment T/T 30% deposit, 70% before shipment. Material: zinc alloy. Packing: opp bag, 100pcs/ctn. Sample USD25, refundable. We can do custom logo UV printing. CE RoHS reports available. Production time 20 days. We are a factory.';
const fresh = (name = 'Gift opener') => newCase({ id: 'case-a', name, now: T0 });
const imp = (c, ev, at = T0) => dispatch(c, { type: 'OFFER_IMPORT', ...ev }, at);
const only = (c) => offerDraft(c, c.offers.at(-1).id);
const keys = (d) => d.fields.map((f) => f.key);

test('a pasted quotation becomes a draft: every fact is a SUPPLIER_CLAIM awaiting review, the original text is kept exactly', () => {
  const c = imp(fresh(), { source: 'PASTED_QUOTE', text: QUOTE_TEXT, supplier: 'Ningbo Gifts Co' }); const d = only(c);
  assert.equal(c.offers.length, 1); assert.equal(d.source, 'PASTED_QUOTE'); assert.equal(d.kind, 'INITIAL');
  for (const k of ['identifier.model', 'quote.tiers', 'quote.moq', 'quote.incoterm', 'quote.port', 'quote.leadTime', 'payment.depositPct', 'spec.material', 'offer.packaging', 'offer.productionDays', 'offer.customization', 'offer.paymentMethods', 'offer.sampleRefund', 'quote.samplePrice', 'docClaim.CE', 'docClaim.ROHS', 'supplier.type']) assert.ok(keys(d).includes(k), `missing ${k}: ${keys(d)}`);
  assert.ok(d.fields.every((f) => f.status === 'SUPPLIER_CLAIM' && f.review.state === 'PENDING'), 'nothing is confirmed by importing');
  assert.ok(d.fields.every((f) => f.status !== 'VERIFIED'));
  assert.equal(d.noVerified, true);
  const item = c.conversations.find((x) => x.id === c.offers[0].convId).items[0]; assert.equal(item.original, QUOTE_TEXT.trim());
  for (const f of d.fields) assert.equal(item.original.slice(f.span[0], f.span[1]), f.rawText, `${f.key} points at the exact characters`);
  assert.equal(c.supplier.name, 'Ningbo Gifts Co');
  assert.deepEqual(d.fields.find((f) => f.key === 'quote.tiers').value.map((r) => r.minQty), ['100', '300', '500']);
});

test('what the offer does not say is an explicit UNKNOWN row, never a default', () => {
  const c = imp(fresh(), { source: 'PASTED_QUOTE', text: 'Price USD 5 for 200 pcs' }); const d = only(c);
  const unk = d.unknown.map((u) => u.key);
  for (const k of ['identifier.model', 'quote.moq', 'quote.incoterm', 'quote.leadTime', 'payment.depositPct', 'spec.material', 'offer.packaging']) assert.ok(unk.includes(k), k);
  assert.ok(d.unknown.every((u) => u.status === 'UNKNOWN' && u.value === null));
  assert.equal(c.quotes.length, 0, 'importing never writes the case quote by itself');
});

test('importing the same content twice changes nothing; the id is derived from the content', () => {
  const a = imp(fresh(), { source: 'PASTED_QUOTE', text: QUOTE_TEXT }); const b = imp(a, { source: 'PASTED_QUOTE', text: QUOTE_TEXT });
  assert.equal(b.offers.length, 1); assert.equal(b.candidates.length, a.candidates.length);
  assert.equal(offerIdOf({ source: 'PASTED_QUOTE', text: QUOTE_TEXT }), offerIdOf({ source: 'PASTED_QUOTE', text: `${QUOTE_TEXT}\r\n` })); // line endings / trailing space do not make a different offer
  assert.notEqual(offerIdOf({ source: 'PASTED_QUOTE', text: QUOTE_TEXT }), offerIdOf({ source: 'CHAT', text: QUOTE_TEXT }));
  assert.equal(contentHash('a'), contentHash('a')); assert.notEqual(contentHash('a'), contentHash('b'));
});

test('review: CONFIRM applies a supplier claim to the case, CORRECT keeps the original and becomes the owner\'s value, REJECT keeps the evidence but applies nothing', () => {
  let c = imp(fresh(), { source: 'PASTED_QUOTE', text: 'Model GB-220. USD 6.80 for 300 pcs. MOQ 300. FOB Ningbo. Lead time 15 days.' });
  const d0 = only(c); const f = (k) => d0.fields.find((x) => x.key === k);
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: f('quote.moq').id }, T1);
  c = dispatch(c, { type: 'CANDIDATE_CORRECT', id: f('quote.leadTime').id, value: '18' }, T1);
  c = dispatch(c, { type: 'CANDIDATE_REJECT', id: f('quote.incoterm').id }, T1);
  const d = only(c); const g = (k) => d.fields.find((x) => x.key === k);
  assert.equal(g('quote.moq').review.state, 'CONFIRMED'); assert.equal(g('quote.moq').status, 'SUPPLIER_CLAIM'); assert.equal(g('quote.moq').review.at, T1.toISOString());
  assert.equal(g('quote.leadTime').review.state, 'CORRECTED'); assert.equal(g('quote.leadTime').status, 'USER_PROVIDED'); assert.deepEqual(g('quote.leadTime').review.original.value, { min: '15', max: '15', unit: 'days' }); assert.equal(g('quote.leadTime').review.reviewedValue, '18');
  assert.equal(g('quote.incoterm').review.state, 'REJECTED'); assert.equal(g('quote.incoterm').rawText, 'FOB'); // the supplier's words are still on record
  assert.equal(c.quotes.at(-1).moq, 300); assert.equal(c.quotes.at(-1).leadTimeDays, '18'); assert.equal(c.quotes.at(-1).incoterm, undefined, 'a rejected fact applies nothing');
  assert.ok(c.ledger.every((e) => e.status !== 'VERIFIED' && e.userConfirmed === true));
  assert.equal(d.counts.pending > 0, true); assert.equal(d.complete, false);
});

test('a pasted chat: supplier lines are extracted, the owner\'s own lines are kept as original but never become supplier facts', () => {
  const chat = '[10:32] Supplier: Hello boss. Price is 34 RMB each for 500pcs.\n[10:33] Me: I need 5 RMB please, MOQ 50000 pcs for me\n[10:35] Supplier: 1000pcs 31 RMB. MOQ 500. Delivery 25 days after deposit.';
  const c = imp(fresh(), { source: 'CHAT', text: chat }); const d = only(c);
  const conv = c.conversations.find((x) => x.id === c.offers[0].convId);
  assert.equal(conv.items.length, 3); assert.deepEqual(conv.items.map((i) => i.speaker), ['supplier', 'me', 'supplier']);
  assert.ok(d.fields.every((f) => f.speaker === 'supplier'), 'no fact comes from the owner line');
  assert.ok(!d.fields.some((f) => f.rawText.includes('50000')), 'the owner counter-offer is not a supplier fact');
  assert.equal(conv.items[1].original.includes('50000'), true);
  const moq = d.fields.filter((f) => f.key === 'quote.moq'); assert.equal(moq.length, 1); assert.equal(moq[0].value, '500');
});

test('a chat whose names cannot be classified: facts cannot be confirmed until the owner says who is who - one decision per name', () => {
  const chat = '[10:32] Jack Lee: price USD 6.80 for 500 pcs\n[10:33] Elidjan: ok and MOQ?\n[10:34] Jack Lee: MOQ 300, FOB Shenzhen\n[10:35] Elidjan: thanks';
  let c = imp(fresh(), { source: 'CHAT', text: chat }); let d = only(c);
  assert.deepEqual(d.unknownSpeakers.sort(), ['Elidjan', 'Jack Lee']);
  const moq = d.fields.find((f) => f.key === 'quote.moq' && f.value === '300'); assert.equal(moq.speaker, 'unknown');
  assert.throws(() => dispatch(c, { type: 'CANDIDATE_CONFIRM', id: moq.id }, T1), /who spoke/);
  const mine = d.fields.filter((f) => f.rawText.includes('MOQ?') || f.speaker === 'unknown').filter((f) => f.id !== moq.id);
  for (const e of attributeNameEvents(c, c.offers[0].id, 'Jack Lee', 'supplier')) c = dispatch(c, e, T1);
  for (const e of attributeNameEvents(c, c.offers[0].id, 'Elidjan', 'me')) c = dispatch(c, e, T1);
  d = only(c); assert.deepEqual(d.unknownSpeakers, []);
  assert.ok(d.fields.filter((f) => mine.some((m) => m.id === f.id && m.itemId !== moq.itemId && f.speaker === 'me')).every((f) => f.review.state === 'REJECTED'), 'the owner\'s own lines are not proposals about the supplier');
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: moq.id }, T1); assert.equal(c.quotes.at(-1).moq, 300);
  const sup = looksLikeChat('Price: USD 6.80\nMOQ: 300\nMaterial: ABS'); assert.equal(sup, false, 'a quotation with labelled lines is not a chat');
  assert.equal(parseChat('Supplier: hi\nsecond line of hi\nMe: ok').length, 2);
});

test('PDF text layer is an import source like any other (the same facts, the PDF_TEXT source recorded)', () => {
  const c = imp(fresh(), { source: 'PDF_TEXT', text: QUOTE_TEXT }); assert.equal(only(c).source, 'PDF_TEXT'); assert.ok(keys(only(c)).includes('quote.tiers'));
});

test('a manual quote: typed values become reviewable facts pointing at the typed characters; an invalid value is kept as typed and needs a correction; empty fields are simply absent', () => {
  const c = imp(fresh(), { source: 'MANUAL', manual: { model: 'GB-220', currency: 'usd', unitPrice: '6,8', moq: '300', incoterm: 'fob', leadTimeDays: '15', material: 'Zinc alloy', tiers: [{ minQty: '300', unitPrice: '6.80' }, { minQty: '500', unitPrice: '6.40' }], certificates: ['CE'], notes: 'met on stand B12' } });
  const d = only(c); const g = (k) => d.fields.find((f) => f.key === k);
  assert.equal(g('quote.currency').value, 'USD'); assert.equal(g('quote.incoterm').value, 'FOB'); assert.equal(g('quote.moq').value, '300'); assert.equal(g('spec.material').value, 'zinc alloy');
  assert.equal(g('quote.unitPrice').value, null); assert.equal(g('quote.unitPrice').needsCorrection, true); assert.equal(g('quote.unitPrice').rawText, '6,8');
  assert.deepEqual(g('quote.tiers').value, [{ minQty: '300', unitPrice: '6.80' }, { minQty: '500', unitPrice: '6.40' }]); assert.equal(g('docClaim.CE').value, 'CLAIMED');
  const item = c.conversations[0].items[0]; for (const f of d.fields) assert.equal(item.original.slice(f.span[0], f.span[1]), f.rawText);
  assert.ok(!keys(d).includes('quote.port')); assert.ok(d.unknown.some((u) => u.key === 'offer.packaging'));
  assert.throws(() => dispatch(c, { type: 'CANDIDATE_CONFIRM', id: g('quote.unitPrice').id }, T1), /correction/);
  const c2 = dispatch(c, { type: 'CANDIDATE_CORRECT', id: g('quote.unitPrice').id, value: '6.80' }, T1); assert.equal(c2.quotes.at(-1).unitPrice, '6.80');
  assert.throws(() => imp(fresh(), { source: 'MANUAL', manual: {} }), /at least one/);
  const m = manualOffer({ unitPrice: '5' }); assert.equal(m.candidates.length, 1);
});

test('an UPDATED offer: a negotiable term that changes is a new revision, not a contradiction; the earlier value stays in the ledger', () => {
  let c = imp(fresh(), { source: 'PASTED_QUOTE', text: 'Model GB-220. USD 7.20 for 300 pcs. MOQ 300. Lead time 15 days.' }, T0);
  for (const f of only(c).fields) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: f.id }, T0);
  assert.equal(c.quotes.at(-1).moq, 300);
  c = imp(c, { source: 'PASTED_QUOTE', text: 'Model GB-220. USD 6.60 for 500 pcs. MOQ 500. Lead time 22 days.' }, T1);
  const d2 = only(c); assert.equal(d2.kind, 'REVISION'); assert.equal(d2.previousOfferId, c.offers[0].id);
  for (const f of d2.fields) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: f.id }, T2);
  assert.equal(c.conflicts.filter((x) => x.state === 'OPEN').length, 0, 'price, MOQ and lead time changes are revisions');
  const q = c.quotes.at(-1); assert.equal(q.moq, 500); assert.equal(q.leadTimeDays, '22'); assert.equal(q.qty ?? q.tiers?.[0]?.minQty, q.qty ?? '500');
  const moqEntries = c.ledger.filter((e) => e.key === 'quote.moq'); assert.deepEqual(moqEntries.map((e) => e.value), ['300', '500']); assert.equal(moqEntries[1].supersedes, true); assert.equal(moqEntries[1].previousValue, 300);
  assert.equal(listOffers(c).length, 2);
});

test('an UPDATED offer that changes a product FACT (material, model) is still a conflict a person must resolve', () => {
  let c = imp(fresh(), { source: 'PASTED_QUOTE', text: 'Model GB-220. Material: zinc alloy. MOQ 300.' }, T0);
  for (const f of only(c).fields) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: f.id }, T0);
  c = imp(c, { source: 'PASTED_QUOTE', text: 'Model GB-220. Material: aluminium alloy. MOQ 400.' }, T1);
  const mat = only(c).fields.find((f) => f.key === 'spec.material'); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: mat.id }, T2);
  const open = c.conflicts.filter((x) => x.state === 'OPEN'); assert.equal(open.length, 1); assert.equal(open[0].key, 'spec.material');
  assert.equal(only(c).fields.find((f) => f.key === 'spec.material').review.state, 'CONFLICT');
});

test('two different prices stated INSIDE one offer stay a contradiction even for an updated offer', () => {
  let c = imp(fresh(), { source: 'PASTED_QUOTE', text: 'Model GB-220. MOQ 300.' }, T0);
  for (const f of only(c).fields) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: f.id }, T0);
  c = imp(c, { source: 'CHAT', text: '[10:00] Supplier: MOQ 500\n[10:05] Supplier: sorry, MOQ 800' }, T1);
  const moqs = only(c).fields.filter((f) => f.key === 'quote.moq'); assert.equal(moqs.length, 2);
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: moqs[0].id }, T1); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: moqs[1].id }, T1);
  assert.equal(c.conflicts.filter((x) => x.state === 'OPEN' && x.key === 'quote.moq').length, 1, 'the supplier contradicted itself within one offer');
});

test('extras: packaging, production time, customisation, payment methods, sample terms, warranty, supplier type - exact spans, string values, claims only', () => {
  const t = 'Packing: opp bag, 100pcs/ctn. Production time 3 weeks. We do OEM and custom logo. Payment T/T or L/C or Trade Assurance. Sample time 5-7 days, sample fee refundable. 12 months warranty. Ships by sea or DHL. We are a trading company. Comes with a charging cable.';
  const x = extractOfferExtras(t); const g = (k) => x.find((c) => c.key === k);
  assert.equal(g('offer.packaging').value, 'opp bag, 100pcs/ctn'); assert.equal(g('offer.productionDays').value, '21'); assert.deepEqual(g('offer.productionDays').flags, ['WEEKS_CONVERTED']);
  assert.match(g('offer.customization').value, /OEM/); assert.match(g('offer.customization').value, /custom logo/);
  assert.match(g('offer.paymentMethods').value, /T\/T/); assert.match(g('offer.paymentMethods').value, /L\/C/); assert.match(g('offer.paymentMethods').value, /Trade Assurance/);
  assert.equal(g('offer.sampleDays').value, '5-7'); assert.equal(g('offer.sampleRefund').value, 'REFUNDABLE'); assert.equal(g('offer.warranty').value, '12 months');
  assert.equal(g('offer.shippingMethod').value, 'sea, express'); assert.equal(g('supplier.type').value, 'TRADING'); assert.equal(g('offer.accessories').value, 'charging cable');
  for (const c of x) assert.equal(t.slice(c.span[0], c.span[1]).length > 0, true);
  assert.deepEqual(extractOfferExtras('Hello, thanks for your inquiry.'), [], 'nothing is invented from small talk');
  assert.equal(extractOfferExtras('non-refundable sample').find((c) => c.key === 'offer.sampleRefund').value, 'NOT_REFUNDABLE');
});

test('Chinese offers: supplier type and packaging are read; the price is read by the existing extractor', () => {
  const c = imp(fresh(), { source: 'PASTED_QUOTE', text: '我们是源头工厂。报价: 型号 GB-220 单价 6.8美元 起订量300件 FOB深圳 生产周期20天 包装: 彩盒' }); const d = only(c);
  const g = (k) => d.fields.find((f) => f.key === k);
  assert.equal(g('supplier.type').value, 'FACTORY'); assert.equal(g('quote.unitPrice').value, '6.8'); assert.equal(g('quote.moq').value, '300'); assert.equal(g('offer.productionDays').value, '20'); assert.equal(g('offer.packaging').value, '彩盒');
});

test('a very long transcript is imported without losing the structure (and stays fast)', () => {
  const lines = []; for (let i = 0; i < 600; i += 1) lines.push(`[10:${String(i % 60).padStart(2, '0')}] ${i % 2 ? 'Me' : 'Supplier'}: ${i % 2 ? 'ok thanks' : `message ${i}: ${i % 50 === 0 ? 'MOQ 300 pcs' : 'we will check'}`}`);
  const t0 = performance.now(); const c = imp(fresh(), { source: 'CHAT', text: lines.join('\n') }); const ms = performance.now() - t0;
  assert.equal(c.conversations.at(-1).items.length, 600); assert.ok(c.candidates.length >= 12); assert.ok(ms < 4000, `import took ${ms.toFixed(0)} ms`);
});

test('import never touches other cases (no shared state between cases)', () => {
  const a = imp(fresh(), { source: 'PASTED_QUOTE', text: QUOTE_TEXT }); const b = newCase({ id: 'case-b', now: T0 });
  assert.equal(b.offers.length, 0); assert.equal(b.candidates.length, 0); assert.ok(a.candidates.every((c) => c.offerId === a.offers[0].id));
});
