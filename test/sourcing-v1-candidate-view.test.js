// How a candidate fact and a conflict are SHOWN to a non-developer holding a phone, and how a typed correction is validated. Pure helpers behind the Capture/Review screen.
// Rules: plain words (no event names, no JSON), every guess-like step is said out loud, a supplier statement is never presented as proof, a correction is never silently reinterpreted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts } from '../src/sourcing/core/extract/index.js';
import { describeCandidate, validateCorrection, describeConflict, FLAG_TEXT } from '../src/sourcing/core/candidate-view.js';

const cands = (text) => extractFacts({ text }).candidates;
const d = (text, key, ctx) => describeCandidate(cands(text).find((c) => c.key === key && (ctx === undefined || c.context === ctx)));

test('labels and values are plain words', () => {
  assert.deepEqual([d('MOQ 100 pcs', 'quote.moq').label, d('MOQ 100 pcs', 'quote.moq').valueText], ['Minimum order', '100 pieces']);
  assert.equal(d('With your logo MOQ is 300 pcs.', 'quote.moq').label, 'Minimum order (with your logo)'); assert.equal(d('sample MOQ is 5 pcs.', 'quote.moq').label, 'Minimum order (samples)');
  assert.equal(d('100 pcs $7.20, 300 pcs $6.80', 'quote.tiers').valueText, '100 pcs: 7.20 / 300 pcs: 6.80');
  assert.equal(d('FOB Shenzhen', 'quote.incoterm').label, 'Incoterm'); assert.equal(d('FOB Shenzhen', 'quote.port').valueText, 'Shenzhen');
  assert.equal(d('Lead time 15-20 days', 'quote.leadTime').valueText, '15 to 20 days'); assert.equal(d('Lead time 15 days', 'quote.leadTime').valueText, '15 days');
  assert.equal(d('30% deposit', 'payment.depositPct').valueText, '30%'); assert.equal(d('Model: PB-X200', 'identifier.model').valueText, 'PB-X200');
  assert.equal(d('carton size 52x38x30 cm', 'carton.dimensions').valueText, '52 x 38 x 30 cm'); assert.equal(d('G.W. 12.5 kg', 'carton.grossWeight').valueText, '12.5 kg');
  assert.equal(d('Available colours: black, white', 'variant.colours').valueText, 'black, white'); assert.equal(d('colours cannot be mixed', 'moq.mixedColours').valueText, 'No');
});

test('document statements read as statements, never as received documents', () => {
  assert.equal(d('We have UN38.3', 'docClaim.UN383').valueText, 'the supplier says they have it'); assert.equal(d('We have UN38.3', 'docClaim.UN383').label, 'Document: UN 38.3');
  assert.equal(d('We can send the RoHS report', 'docClaim.ROHS').valueText, 'the supplier says they will send it'); assert.equal(d('We do not have FCC', 'docClaim.FCC').valueText, 'the supplier says they do not have it');
  for (const t of ['We have CE', 'We can send the RoHS report']) { const v = describeCandidate(cands(t).find((c) => c.key.startsWith('docClaim.'))); assert.match(v.note, /not proof|not received/i); assert.equal(v.kind, 'CLAIM'); }
});

test('flags are explained in plain words; a derived or ambiguous value says so; ambiguous ones cannot be confirmed as they are', () => {
  const bal = d('30% deposit and balance before shipment', 'payment.balancePct'); assert.match(bal.warnings.join(' '), /calculated/i); assert.equal(bal.canConfirm, true);
  const amb = d('price USD 6,8 per piece', 'quote.unitPrice'); assert.equal(amb.canConfirm, false); assert.equal(amb.canCorrect, true); assert.match(amb.warnings.join(' '), /unclear/i); assert.equal(amb.valueText, 'unclear: "USD 6,8"'); assert.equal(amb.suggestion, '6.8');
  assert.match(d('unit price $6.80', 'quote.currency').warnings.join(' '), /symbol/i); assert.match(d('about 3 weeks lead time', 'quote.leadTime').warnings.join(' '), /weeks/i);
  const sum = d('40% deposit and 70% balance', 'payment.balancePct'); assert.equal(sum.canConfirm, false); assert.match(sum.warnings.join(' '), /100/);
  for (const f of Object.keys(FLAG_TEXT)) assert.ok(!/[A-Z_]{6,}/.test(FLAG_TEXT[f]), `${f} text has no code words`);
});

test('structured values (tiers, colours, sizes) cannot be corrected by typing a text; scalar values can', () => {
  assert.equal(d('100 pcs $7.20, 300 pcs $6.80', 'quote.tiers').canCorrect, false); assert.equal(d('Available colours: black, white', 'variant.colours').canCorrect, false); assert.equal(d('Model: PB-X200', 'identifier.model').canCorrect, true);
  const ambTiers = d('1,200 pcs USD 7,2', 'quote.tiers'); if (ambTiers) assert.equal(ambTiers.canConfirm, false);
});

test('the source sentence is shown with the candidate (the supplier original, unchanged)', () => {
  const text = '型号：PB-X200，起订量300个'; const v = describeCandidate(cands(text).find((c) => c.key === 'quote.moq')); assert.equal(v.from, '起订量300个'); assert.equal(v.lang, 'zh');
});

test('typed corrections are validated, never reinterpreted: a decimal comma is refused, units are checked, models are kept as typed', () => {
  assert.deepEqual(validateCorrection('quote.unitPrice', ' 6.80 '), { ok: true, value: '6.80' }); assert.equal(validateCorrection('quote.unitPrice', '6,8').ok, false); assert.match(validateCorrection('quote.unitPrice', '6,8').error, /dot/i);
  assert.equal(validateCorrection('quote.unitPrice', '-1').ok, false); assert.equal(validateCorrection('quote.unitPrice', 'abc').ok, false); assert.equal(validateCorrection('quote.unitPrice', '0').ok, false);
  assert.deepEqual(validateCorrection('quote.moq', '1000'), { ok: true, value: '1000' }); assert.equal(validateCorrection('quote.moq', '10.5').ok, false); assert.equal(validateCorrection('quote.moq', '1,000').ok, false);
  assert.deepEqual(validateCorrection('quote.currency', 'usd'), { ok: true, value: 'USD' }); assert.equal(validateCorrection('quote.currency', 'GBP').ok, false);
  assert.deepEqual(validateCorrection('quote.incoterm', 'fob'), { ok: true, value: 'FOB' }); assert.equal(validateCorrection('quote.incoterm', 'FAS').ok, false);
  assert.deepEqual(validateCorrection('payment.depositPct', '30'), { ok: true, value: '30' }); assert.equal(validateCorrection('payment.depositPct', '130').ok, false);
  assert.deepEqual(validateCorrection('identifier.model', ' pb-x200/B '), { ok: true, value: 'pb-x200/B' }, 'trimmed only: case, slash and suffix kept'); assert.equal(validateCorrection('identifier.model', '   ').ok, false);
  assert.equal(validateCorrection('quote.tiers', 'x').ok, false); assert.match(validateCorrection('quote.tiers', 'x').error, /cannot be corrected/i);
});

test('a conflict is described with both values, in plain words, with the two honest choices', () => {
  const conflict = { id: 'conf-1', type: 'VALUE', key: 'quote.moq', context: 'product', entries: [{ value: '100', from: 'CASE' }, { value: '300', from: 'SUPPLIER' }], state: 'OPEN', question: { en: 'Which one is right?', zh: null, zhNote: 'No Chinese version available for this question yet.' } };
  const v = describeConflict(conflict); assert.equal(v.title, 'Minimum order: 100 earlier, 300 now'); assert.deepEqual(v.choices.map((c) => c.choice), ['OLD', 'NEW']); assert.match(v.choices[0].label, /100/); assert.match(v.choices[1].label, /300/); assert.equal(v.question, 'Which one is right?'); assert.match(v.zhNote, /no chinese/i);
  const model = describeConflict({ ...conflict, type: 'MODEL_MISMATCH', key: 'identifier.model', entries: [{ value: 'PB-X200', from: 'CASE' }, { value: 'PB-X180', from: 'SUPPLIER' }] }); assert.match(model.title, /PB-X200/); assert.match(model.title, /PB-X180/); assert.match(model.help, /exact model/i);
});
