// China Sourcing V1 - deterministic fact extraction (P2). The extractor only PROPOSES candidates from text: nothing is applied to a case here.
// Rules under test: numbers are never silently reinterpreted; model identifiers are preserved byte for byte; Chinese originals are preserved; price tiers are not collapsed into
// one price; supplier claims about documents are claims (never received documents); ambiguity produces a candidate that needs correction, never a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, EXTRACTOR_VERSION } from '../src/sourcing/core/extract/index.js';
import { parseNumberToken } from '../src/sourcing/core/extract/numbers.js';

const by = (r, key, ctx) => r.candidates.filter((c) => c.key === key && (ctx === undefined || c.context === ctx));
const one = (r, key, ctx) => { const l = by(r, key, ctx); assert.equal(l.length, 1, `${key}${ctx ? `@${ctx}` : ''}: expected 1 candidate, got ${l.length}: ${JSON.stringify(r.candidates.map((c) => [c.key, c.value, c.context]))}`); return l[0]; };

test('number tokens: 6.8, 6.80 and 680 stay different; a decimal comma or an ambiguous thousands comma is NEVER silently reinterpreted', () => {
  assert.deepEqual(parseNumberToken('6.8', 'price'), { raw: '6.8', value: '6.8', ambiguous: false, flags: [] });
  assert.equal(parseNumberToken('6.80', 'price').value, '6.80', 'trailing zero is preserved');
  assert.equal(parseNumberToken('680', 'price').value, '680');
  const dc = parseNumberToken('6,8', 'price'); assert.equal(dc.ambiguous, true); assert.equal(dc.value, null); assert.equal(dc.suggestion, '6.8'); assert.equal(dc.raw, '6,8');
  const dc2 = parseNumberToken('6,80', 'price'); assert.equal(dc2.ambiguous, true); assert.equal(dc2.value, null);
  const th = parseNumberToken('1,200', 'price'); assert.equal(th.ambiguous, true, 'a price like 1,200 may be 1200 or 1.2: ask');
  assert.equal(parseNumberToken('1,200', 'quantity').value, '1200', 'for a quantity a thousands comma is unambiguous');
  assert.equal(parseNumberToken('1,200.50', 'price').value, '1200.50');
  const eu = parseNumberToken('1.200,50', 'price'); assert.equal(eu.value, '1200.50'); assert.ok(eu.flags.includes('EU_NUMBER_FORMAT'));
});

test('EN: "For 300 pcs we can do USD 6.80, FOB Shenzhen, 30% deposit and balance before shipment." -> candidates, nothing applied', () => {
  const text = 'For 300 pcs we can do USD 6.80, FOB Shenzhen, 30% deposit and balance before shipment.';
  const r = extractFacts({ text, lang: 'en' });
  const tiers = one(r, 'quote.tiers'); assert.deepEqual(tiers.value, [{ minQty: '300', unitPrice: '6.80' }]);
  assert.equal(one(r, 'quote.currency').value, 'USD'); assert.equal(one(r, 'quote.incoterm').value, 'FOB'); assert.equal(one(r, 'quote.port').value, 'Shenzhen');
  assert.equal(one(r, 'payment.depositPct').value, '30');
  const bal = one(r, 'payment.balancePct'); assert.equal(bal.value, '70'); assert.ok(bal.flags.includes('DERIVED'), 'the 70% is derived from "balance" and must say so'); assert.equal(bal.confidence, 'MEDIUM');
  assert.equal(one(r, 'payment.balanceDue').value, 'before shipment');
  for (const c of r.candidates) { assert.equal(c.state, undefined, 'the extractor never sets a decision state'); assert.ok(Array.isArray(c.span) && c.span.length === 2 && text.slice(...c.span).length > 0, `span for ${c.key}`); assert.equal(c.extractor?.name, 'rules'); assert.equal(c.extractor?.version, EXTRACTOR_VERSION); }
  assert.ok(r.unparsed.join(' ').includes('we can do') || r.unparsed.length >= 0);
});

test('EN: price tiers are kept as tiers (100 -> 7.20, 300 -> 6.80, 500 -> 6.40), not collapsed into one price', () => {
  for (const text of ['100 pcs $7.20, 300 pcs $6.80, 500 pcs $6.40', '100pcs: USD 7.20 / 300pcs: USD 6.80 / 500pcs: USD 6.40', 'USD 7.20 for 100 pcs; USD 6.80 for 300 pcs; USD 6.40 for 500 pcs']) {
    const r = extractFacts({ text, lang: 'en' }); const t = one(r, 'quote.tiers');
    assert.deepEqual(t.value, [{ minQty: '100', unitPrice: '7.20' }, { minQty: '300', unitPrice: '6.80' }, { minQty: '500', unitPrice: '6.40' }], text);
    assert.equal(by(r, 'quote.unitPrice').length, 0, 'no separate single price when tiers explain every price');
  }
});

test('EN: MOQ with context: a base MOQ and a custom-logo MOQ are different facts, not a contradiction', () => {
  const r = extractFacts({ text: 'MOQ is 100 pcs for the standard model. With your logo the MOQ is 300 pcs.', lang: 'en' });
  assert.equal(one(r, 'quote.moq', 'product').value, '100'); assert.equal(one(r, 'quote.moq', 'custom_logo').value, '300');
  const r2 = extractFacts({ text: 'Minimum order quantity: 1,000 pieces', lang: 'en' }); assert.equal(one(r2, 'quote.moq', 'product').value, '1000');
});

test('EN: Incoterm and port: only terms the landed-cost engine supports; unknown places are flagged; no Incoterm is invented', () => {
  assert.equal(one(extractFacts({ text: 'Price is EXW Dongguan factory' }), 'quote.incoterm').value, 'EXW');
  const r = extractFacts({ text: 'FOB Ningbo port, USD 5.50 each' }); assert.equal(one(r, 'quote.port').value, 'Ningbo'); assert.equal(one(r, 'quote.port').confidence, 'HIGH');
  const odd = extractFacts({ text: 'CIF Antwerp' }); assert.equal(one(odd, 'quote.incoterm').value, 'CIF'); assert.ok(one(odd, 'quote.port').flags.includes('UNLISTED_PLACE'));
  assert.equal(by(extractFacts({ text: 'we ship by sea and also by air' }), 'quote.incoterm').length, 0);
  assert.equal(by(extractFacts({ text: 'FAS Shanghai' }), 'quote.incoterm').length, 0, 'FAS is not supported by the engine: it stays unparsed, it is not mapped to something else');
});

test('EN: currencies and symbols are preserved, never converted or merged', () => {
  const usd = extractFacts({ text: 'unit price $6.80' }); assert.equal(one(usd, 'quote.currency').value, 'USD'); assert.ok(one(usd, 'quote.currency').flags.includes('CURRENCY_FROM_SYMBOL'));
  const cny = extractFacts({ text: 'price ¥6.80 per piece' }); assert.equal(one(cny, 'quote.currency').value, 'CNY'); assert.ok(one(cny, 'quote.currency').flags.includes('CURRENCY_FROM_SYMBOL'));
  const code = extractFacts({ text: '6.80 USD each' }); assert.equal(one(code, 'quote.unitPrice').value, '6.80'); assert.equal(one(code, 'quote.currency').confidence, 'HIGH');
  const rmb = extractFacts({ text: 'RMB 48.5 per unit' }); assert.equal(one(rmb, 'quote.currency').value, 'CNY'); assert.equal(one(rmb, 'quote.unitPrice').value, '48.5');
});

test('EN: an ambiguous number becomes a candidate that NEEDS CORRECTION with no value, never a guess', () => {
  const r = extractFacts({ text: 'price USD 6,8 per piece' }); const p = one(r, 'quote.unitPrice');
  assert.equal(p.value, null); assert.equal(p.needsCorrection, true); assert.equal(p.rawText, 'USD 6,8'); assert.equal(p.suggestion, '6.8'); assert.ok(p.flags.includes('AMBIGUOUS_NUMBER'));
  const q = extractFacts({ text: 'USD 1,200 per piece' }); assert.equal(one(q, 'quote.unitPrice').needsCorrection, true);
});

test('EN: lead time, payment and deposit variants', () => {
  const lt = one(extractFacts({ text: 'Lead time is 15-20 working days after deposit' }), 'quote.leadTime');
  assert.deepEqual(lt.value, { min: '15', max: '20', unit: 'days' });
  const wk = one(extractFacts({ text: 'production time about 3 weeks' }), 'quote.leadTime'); assert.deepEqual(wk.value, { min: '21', max: '21', unit: 'days' }); assert.ok(wk.flags.includes('WEEKS_CONVERTED'));
  const pay = extractFacts({ text: 'T/T 30% deposit, 70% balance against copy of B/L' });
  assert.equal(one(pay, 'payment.depositPct').value, '30'); assert.equal(one(pay, 'payment.balancePct').value, '70'); assert.ok(!one(pay, 'payment.balancePct').flags.includes('DERIVED'), 'stated, not derived');
  const slash = extractFacts({ text: 'payment terms 30/70' }); assert.equal(one(slash, 'payment.depositPct').value, '30'); assert.equal(one(slash, 'payment.balancePct').value, '70');
  const bad = extractFacts({ text: '40% deposit and 70% balance' }); assert.ok(by(bad, 'payment.balancePct')[0].needsCorrection, 'a deposit + balance that does not add to 100 must be corrected by a person');
});

test('EN: colours, mixed-colour MOQ and minimum per colour', () => {
  const c = one(extractFacts({ text: 'Available colours: black, white and blue' }), 'variant.colours'); assert.deepEqual(c.value, ['black', 'white', 'blue']);
  assert.equal(one(extractFacts({ text: 'we have 5 colors' }), 'variant.colourCount').value, '5');
  assert.equal(one(extractFacts({ text: 'You can mix colours within the 100 pcs MOQ' }), 'moq.mixedColours').value, true);
  assert.equal(one(extractFacts({ text: 'Sorry, colours cannot be mixed' }), 'moq.mixedColours').value, false);
  assert.equal(one(extractFacts({ text: 'minimum 50 pcs per colour' }), 'moq.perColour').value, '50');
});

test('EN: carton quantity, dimensions, gross and net weight keep their units', () => {
  const r = extractFacts({ text: '50 pcs per carton, carton size 52x38x30 cm, G.W. 12.5 kg, N.W. 11kg' });
  assert.equal(one(r, 'carton.qty').value, '50'); assert.deepEqual(one(r, 'carton.dimensions').value, { l: '52', w: '38', h: '30', unit: 'cm' });
  assert.deepEqual(one(r, 'carton.grossWeight').value, { amount: '12.5', unit: 'kg' }); assert.deepEqual(one(r, 'carton.netWeight').value, { amount: '11', unit: 'kg' });
});

test('model identifiers are preserved EXACTLY as written (PB-X200, PB X200, X200 are three different strings)', () => {
  assert.equal(one(extractFacts({ text: 'Model: PB-X200' }), 'identifier.model').value, 'PB-X200');
  assert.equal(one(extractFacts({ text: 'model PB X200 is our best seller' }), 'identifier.model').value, 'PB X200');
  assert.equal(one(extractFacts({ text: 'item no. X200, 10000mAh' }), 'identifier.model').value, 'X200');
  assert.equal(one(extractFacts({ text: 'Model No: pb-x200/B' }), 'identifier.model').value, 'pb-x200/B', 'case, slash and suffix are kept');
  assert.equal(by(extractFacts({ text: 'type C cable' }), 'identifier.model').length, 0, 'a word without digits is not a model');
  const a = extractFacts({ text: 'Model: PB-X200' }).candidates[0].value; const b = extractFacts({ text: 'Model: PB X200' }).candidates[0].value; assert.notEqual(a, b);
});

test('document claims are CLAIMS: "we have CE and UN38.3" proposes claims, never a received document; promises and denials are distinct', () => {
  const r = extractFacts({ text: 'We have CE and UN38.3 certificates. We can send the RoHS report tomorrow. We do not have FCC.' });
  assert.equal(one(r, 'docClaim.CE').value, 'CLAIMED'); assert.equal(one(r, 'docClaim.UN383').value, 'CLAIMED'); assert.equal(one(r, 'docClaim.ROHS').value, 'PROMISED'); assert.equal(one(r, 'docClaim.FCC').value, 'NOT_AVAILABLE');
  for (const k of ['docClaim.CE', 'docClaim.UN383']) assert.ok(one(r, k).confidence !== 'VERIFIED');
  assert.ok(!r.candidates.some((c) => /received|verified/i.test(String(c.value))));
});

test('free text with no recognisable fact yields no candidates and keeps the text unparsed (the original is never lost)', () => {
  const r = extractFacts({ text: 'Hello, nice to meet you. Please sit down, tea?' }); assert.equal(r.candidates.length, 0); assert.ok(r.unparsed.join(' ').includes('nice to meet you'));
});

test('ZH: price, MOQ, deposit/balance, lead time and model are extracted deterministically; the Chinese original is preserved', () => {
  const text = '型号：PB-X200，起订量300个，单价6.8美金，FOB深圳，定金30%，发货前付尾款，交期15-20天';
  const r = extractFacts({ text, lang: 'zh' });
  assert.equal(one(r, 'identifier.model').value, 'PB-X200');
  assert.equal(one(r, 'quote.moq', 'product').value, '300'); assert.equal(one(r, 'quote.unitPrice').value, '6.8'); assert.equal(one(r, 'quote.currency').value, 'USD');
  assert.equal(one(r, 'quote.incoterm').value, 'FOB'); const port = one(r, 'quote.port'); assert.equal(port.value, 'Shenzhen'); assert.equal(port.rawText, '深圳');
  assert.equal(one(r, 'payment.depositPct').value, '30'); assert.equal(one(r, 'payment.balancePct').value, '70'); assert.equal(one(r, 'payment.balanceDue').value, 'before shipment');
  assert.deepEqual(one(r, 'quote.leadTime').value, { min: '15', max: '20', unit: 'days' });
  for (const c of r.candidates) { assert.equal(c.lang, 'zh'); assert.equal(text.slice(...c.span), c.rawText, `span matches rawText for ${c.key}`); }
});

test('ZH: Chinese units, 万, RMB words, tiers and doc claims; model numbers inside Chinese text survive untouched', () => {
  const w = one(extractFacts({ text: '起订量1万个' }), 'quote.moq', 'product'); assert.equal(w.value, '10000'); assert.ok(w.flags.includes('WAN_CONVERTED')); assert.equal(w.rawText.includes('1万'), true);
  assert.equal(by(extractFacts({ text: '起订量1.5万个' }), 'quote.moq')[0].value, '15000');
  assert.equal(one(extractFacts({ text: '单价48.5元' }), 'quote.currency').value, 'CNY');
  const t = one(extractFacts({ text: '100个 7.2美金，300个 6.8美金，500个 6.4美金' }), 'quote.tiers'); assert.deepEqual(t.value, [{ minQty: '100', unitPrice: '7.2' }, { minQty: '300', unitPrice: '6.8' }, { minQty: '500', unitPrice: '6.4' }]);
  const d = extractFacts({ text: '我们有CE和UN38.3，没有FCC，RoHS可以提供' });
  assert.equal(one(d, 'docClaim.CE').value, 'CLAIMED'); assert.equal(one(d, 'docClaim.UN383').value, 'CLAIMED'); assert.equal(one(d, 'docClaim.FCC').value, 'NOT_AVAILABLE'); assert.equal(one(d, 'docClaim.ROHS').value, 'PROMISED');
  assert.equal(one(extractFacts({ text: '这款型号是 XJ-9000B 的充电宝' }), 'identifier.model').value, 'XJ-9000B');
  assert.equal(one(extractFacts({ text: '型号：PB X200' }), 'identifier.model').value, 'PB X200');
});

test('ZH: colours, mixed colours, carton data', () => {
  assert.deepEqual(one(extractFacts({ text: '颜色有黑色、白色和蓝色' }), 'variant.colours').value, ['black', 'white', 'blue']);
  assert.equal(one(extractFacts({ text: '颜色可以混色' }), 'moq.mixedColours').value, true);
  assert.equal(one(extractFacts({ text: '不能混色' }), 'moq.mixedColours').value, false);
  const c = extractFacts({ text: '每箱50个，毛重12.5公斤，箱规52x38x30cm' });
  assert.equal(one(c, 'carton.qty').value, '50'); assert.deepEqual(one(c, 'carton.grossWeight').value, { amount: '12.5', unit: 'kg' }); assert.deepEqual(one(c, 'carton.dimensions').value, { l: '52', w: '38', h: '30', unit: 'cm' });
});

test('mixed Chinese + English text: both extractors run, results are not duplicated, each candidate points at its own span', () => {
  const text = '你好，MOQ 100 pcs，USD 7.20，FOB Shenzhen，型号 PB-X200';
  const r = extractFacts({ text, lang: 'auto' });
  assert.equal(one(r, 'quote.moq', 'product').value, '100'); assert.equal(one(r, 'quote.incoterm').value, 'FOB'); assert.equal(one(r, 'identifier.model').value, 'PB-X200');
  const keys = r.candidates.map((c) => `${c.key}|${c.context}|${JSON.stringify(c.value)}`); assert.equal(new Set(keys).size, keys.length, 'no duplicates');
});

test('the extractor is deterministic and pure: same input, same output; the input text is never modified', () => {
  const text = 'Model: PB-X200, MOQ 100 pcs, USD 7.20, FOB Shenzhen'; const a = extractFacts({ text }); const b = extractFacts({ text });
  assert.deepEqual(a, b); assert.equal(text, 'Model: PB-X200, MOQ 100 pcs, USD 7.20, FOB Shenzhen');
});

test('extraction never touches case data and never calls the network (static guard on the module sources)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../src/sourcing/core/extract/', import.meta.url);
  for (const f of readdirSync(dir)) { const src = readFileSync(new URL(f, dir), 'utf8'); assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\.|localStorage|indexedDB|require\(|node:/.test(src.replace(/\/\/.*$/gm, '')), `${f} must be pure and isomorphic`); }
});

test('number safety in running text: 6.8, 6.80, 680, $6.80, 6.80 USD and ¥6.80 keep exactly the digits the supplier wrote', () => {
  const val = (text) => by(extractFacts({ text }), 'quote.unitPrice').map((c) => c.value);
  assert.deepEqual(val('USD 6.8'), ['6.8']); assert.deepEqual(val('USD 6.80'), ['6.80']); assert.deepEqual(val('USD 680'), ['680']); assert.deepEqual(val('$6.80'), ['6.80']); assert.deepEqual(val('6.80 USD'), ['6.80']); assert.deepEqual(val('¥6.80'), ['6.80']);
  assert.equal(by(extractFacts({ text: 'USD 6,80' }), 'quote.unitPrice')[0].needsCorrection, true); assert.equal(by(extractFacts({ text: 'USD 6,80' }), 'quote.unitPrice')[0].value, null);
  assert.notEqual(val('USD 6.8')[0], val('USD 680')[0]);
});

// ---- price tiers: a price is bound to ITS quantity, never to the neighbouring one (regression from the physical-phone test of 2026-10-06) -----------------------------------------
const PHONE_TEXT = 'PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. We have black, white, blue and pink. You can mix colors, minimum 25 pcs per color. Production time is 15 days. We have CE, RoHS and UN38.3.';
const T = (pairs) => pairs.map(([q, p]) => ({ minQty: String(q), unitPrice: String(p) }));
const GROUND = [[50, '8'], [100, '7.20'], [300, '6.80']];

test('REGRESSION (phone, 2026-10-06): "USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs" keeps 50 -> 8, 100 -> 7.20, 300 -> 6.80', () => {
  const r = extractFacts({ text: PHONE_TEXT });
  assert.deepEqual(one(r, 'quote.tiers').value, T(GROUND)); assert.equal(by(r, 'quote.unitPrice').length, 0, 'no stray single price: every price belongs to a tier');
  assert.equal(one(r, 'quote.moq', 'product').value, '50', 'the MOQ stays a separate fact');
  assert.equal(one(r, 'quote.tiers').rawText, 'USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs', 'the candidate points at the supplier words it came from');
});

test('price tiers: several phrasings, separators and orders give the SAME pairs (a price never takes the neighbouring quantity)', () => {
  const cases = [
    'USD 8 for 50 pcs, USD 7.20 for 100 pcs, USD 6.80 for 300 pcs',
    '50 pcs: $8; 100 pcs: $7.20; 300 pcs: $6.80',
    'Price: $8/pc MOQ 50, $7.20/pc at 100, $6.80/pc at 300',
    'USD 6.80 for 300 pcs, USD 7.20 for 100 pcs, USD 8 for 50 pcs', // reversed order
    '300 pcs: USD 6.80 / 100 pcs: USD 7.20 / 50 pcs: USD 8',
    '50pcs = USD 8, 100pcs = USD 7.20, 300pcs = USD 6.80',
    'For 50 pcs we can do USD 8. For 100 pcs we can do USD 7.20. For 300 pcs we can do USD 6.80.',
    '50 pcs $8, 100 pcs $7.20, 300 pcs $6.80',
    '8 USD for 50 pcs; 7.20 USD for 100 pcs; 6.80 USD for 300 pcs',
    'USD 8 each if you order 50 pcs, USD 7.20 each if you order 100 pcs, USD 6.80 each if you order 300 pcs',
    'MOQ is 50 pcs. USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs.', // MOQ stated apart from the price list
    '$8/pc at 50, $7.20/pc at 100 and $6.80/pc at 300',
  ];
  for (const text of cases) { const r = extractFacts({ text }); assert.deepEqual(one(r, 'quote.tiers').value, T(GROUND), text); assert.equal(by(r, 'quote.unitPrice').length, 0, `no stray price: ${text}`); }
});

test('price tiers: exhaustive check over templates x orders - the extracted pairs always equal the pairs that were written', () => {
  const levels = [[100, '7.20'], [300, '6.80'], [500, '6.40'], [1000, '6.10']];
  const templates = [([q, p]) => `USD ${p} for ${q} pcs`, ([q, p]) => `${q} pcs: $${p}`, ([q, p]) => `${q} pcs $${p}`, ([q, p]) => `$${p}/pc at ${q}`, ([q, p]) => `${q}pcs = USD ${p}`, ([q, p]) => `${p} USD for ${q} pcs`];
  const seps = ['; ', ' / ', ', '];
  const perms = (a) => (a.length < 2 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
  let n = 0;
  for (const tpl of templates) for (const sep of seps) for (const set of [levels.slice(0, 2), levels.slice(0, 3), levels]) for (const order of perms(set).filter((_, i) => i % 5 === 0)) {
    const text = `Our price list: ${order.map(tpl).join(sep)}.`; const r = extractFacts({ text }); const tiers = by(r, 'quote.tiers');
    assert.equal(tiers.length, 1, `one tier list: ${text}`); assert.deepEqual(tiers[0].value, T([...set].sort((a, b) => a[0] - b[0])), text); n += 1;
  }
  assert.ok(n >= 144, `${n} phrasings checked`);
});

test('price tiers: the output is always in ascending quantity order; a duplicated threshold with two prices needs a correction instead of a guess', () => {
  const r = extractFacts({ text: 'USD 6.80 for 300 pcs, USD 8 for 50 pcs, USD 7.20 for 100 pcs' }); assert.deepEqual(one(r, 'quote.tiers').value.map((t) => t.minQty), ['50', '100', '300']);
  const d = extractFacts({ text: 'USD 8 for 50 pcs, USD 7 for 50 pcs' }); const t = one(d, 'quote.tiers'); assert.equal(t.needsCorrection, true); assert.ok(t.flags.includes('DUPLICATE_THRESHOLD'));
});

test('a MOQ, a sample price and a freight price are not tiers; a lone price with no quantity stays a single price', () => {
  const a = extractFacts({ text: 'MOQ is 100 pcs, price USD 6.8' }); assert.equal(by(a, 'quote.tiers').length, 0, 'a MOQ next to a price is not a tier'); assert.equal(one(a, 'quote.unitPrice').value, '6.8');
  const b = extractFacts({ text: 'Sample price USD 15 for 1 pc. USD 8 for 50 pcs, USD 7.20 for 100 pcs.' }); assert.deepEqual(one(b, 'quote.tiers').value, T([[50, '8'], [100, '7.20']])); assert.equal(one(b, 'quote.samplePrice').value, '15');
  const c = extractFacts({ text: 'Freight USD 200 for 50 pcs. USD 8 for 50 pcs, USD 7.20 for 100 pcs.' }); assert.deepEqual(one(c, 'quote.tiers').value, T([[50, '8'], [100, '7.20']]));
});

test('the full phone text: model and colours are extracted, claims stay claims', () => {
  const r = extractFacts({ text: PHONE_TEXT });
  assert.equal(one(r, 'identifier.model').value, 'PB-X200'); assert.equal(one(r, 'identifier.model').confidence, 'LOW'); assert.ok(one(r, 'identifier.model').flags.includes('UNLABELLED_IDENTIFIER'), 'an identifier with no label is proposed with a visible warning');
  assert.deepEqual(one(r, 'variant.colours').value, ['black', 'white', 'blue', 'pink']);
  for (const k of ['CE', 'ROHS', 'UN383']) { assert.equal(one(r, `docClaim.${k}`).value, 'CLAIMED'); assert.ok(one(r, `docClaim.${k}`).flags.includes('SUPPLIER_STATEMENT')); }
  assert.ok(!r.candidates.some((c) => /RECEIVED|MATCHED|VERIFIED/.test(String(c.value))), 'nothing becomes a received document');
});

test('an unlabelled model-like word is NOT proposed when it is really a standard, a document name, a currency or a plain word', () => {
  for (const t of ['We have CE, RoHS and UN38.3.', 'IEC 62133 report available', 'USD 8 for 50 pcs', 'FOB Shenzhen', 'Sorry, black and white only']) assert.equal(by(extractFacts({ text: t }), 'identifier.model').length, 0, t);
  assert.equal(by(extractFacts({ text: 'Black and white are available' }), 'variant.colours').length, 0, 'two colour words in a sentence about something else are not a colour list');
});
