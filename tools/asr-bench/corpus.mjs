// The benchmark SCRIPT: one continuous canonical session made of controlled items (facts, identifiers, mixed sentences) and natural conversation topics. Deterministic (fixed seed): the same script every time.
// The owner speaks NATURALLY (no pronunciation tuning for a recogniser); the display text only says WHAT to cover, `expect` says what a perfect pipeline would understand (used by the scorer, never sent to a provider).
// The 30 synthetic identifiers are generated here and are NEVER part of a provider's context unless a pass explicitly allows it (context.mjs).
export const SEED = 20261007;
export const KEY_REFERENCES = Object.freeze(['RB-980HB', 'ZF-024', 'ZF-041', '8755C', '8709C']);
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O: indistinguishable from 1 / 0 once written, which would make the reference itself ambiguous
export const canonId = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function syntheticIdentifiers(seed = SEED) {
  const rnd = mulberry32(seed);
  const L = (n) => Array.from({ length: n }, () => LETTERS[Math.floor(rnd() * LETTERS.length)]).join('');
  const D = (n) => Array.from({ length: n }, (_, i) => String(i === 0 ? 1 + Math.floor(rnd() * 9) : Math.floor(rnd() * 10))).join('');
  const patterns = [['letters-digits', () => `${L(2)}-${D(4)}`], ['digits-letters', () => `${D(4)}${L(1)}`], ['letters-digits-letters', () => `${L(2)}${D(3)}${L(2)}`], ['hyphenated', () => `${L(2)}-${D(2)}-${D(2)}`], ['short', () => `${L(1)}${D(3)}`], ['long', () => `${L(2)}-${D(5)}-${L(2)}`]];
  const seen = new Set(KEY_REFERENCES.map(canonId)); const out = [];
  for (const [name, gen] of patterns) { let n = 0; while (n < 5) { const id = gen(); const c = canonId(id); if (seen.has(c)) continue; seen.add(c); out.push({ id, pattern: name }); n++; } }
  return out; // 6 patterns x 5 = 30
}

const F = (type, value, extra = {}) => ({ type, value, ...extra });
const FACT_ITEMS = [
  ['A1', 'MOQ : 100 pièces', 'The MOQ is one hundred pieces.', [F('moq', '100')]],
  ['A2', 'MOQ : 500 pièces', 'Our MOQ is five hundred pieces.', [F('moq', '500')]],
  ['A3', 'Prix : 6 dollars', 'The unit price is six dollars.', [F('unitPrice', '6'), F('currency', 'USD')]],
  ['A4', 'FOB Shenzhen', 'Six dollars, FOB Shenzhen.', [F('unitPrice', '6'), F('incoterm', 'FOB'), F('port', 'Shenzhen')]],
  ['A5', 'EXW Yiwu', 'We can also do EXW Yiwu.', [F('incoterm', 'EXW'), F('port', 'Yiwu')]],
  ['A6', 'Délai : 20 jours', 'The lead time is twenty days.', [F('leadTime', '20')]],
  ['A7', 'Acompte 30 % / 70 % avant expédition', 'Payment is thirty percent deposit and seventy percent before shipment.', [F('deposit', '30'), F('balance', '70')]],
  ['A8', '4 couleurs', 'It comes in four colours.', [F('colourCount', '4')]],
  ['A9', 'Carton : 24 pièces', 'Carton quantity is twenty four pieces.', [F('cartonQty', '24')]],
  ['A10', 'USB-C', 'It has a USB-C port.', [F('token', 'USB-C')]],
  ['A11', 'PD 65 watts', 'It supports PD, sixty five watts.', [F('power', '65'), F('token', 'PD')]],
  ['A12', 'CE, RoHS, REACH', 'We have CE, RoHS and REACH.', [F('claim', 'CE'), F('claim', 'ROHS'), F('claim', 'REACH')]],
  ['A13', 'UN38.3', 'The battery has UN38.3.', [F('claim', 'UN383')]],
  ['A14', 'Capacité : 20 000 mAh', 'The capacity is twenty thousand milliamp hours.', [F('capacity', '20000')]],
];
const KEY_FORMS = [
  ['RB-980HB', ['R B nine eight zero H B', 'the model is RB nine eighty H B', 'RB nine eight zero H B']],
  ['ZF-024', ['Z F zero twenty four', 'Z F zero two four', 'the reference is ZF zero twenty four']],
  ['ZF-041', ['Z F zero four one', 'Z F zero forty one']],
  ['8755C', ['eight seven five five C', 'eighty seven fifty five C']],
  ['8709C', ['eight seven zero nine C', 'eighty seven oh nine C']],
];
const MIXED = [
  ['C1', 'The model is RB-980HB and the minimum order quantity is one hundred pieces.', [F('identifier', 'RB-980HB'), F('moq', '100')]],
  ['C2', 'The reference is ZF-024 and it comes in four colours.', [F('identifier', 'ZF-024'), F('colourCount', '4')]],
  ['C3', 'The price for five hundred pieces is six dollars FOB Shenzhen.', [F('tier', '500', { unitPrice: '6' }), F('incoterm', 'FOB'), F('port', 'Shenzhen'), F('currency', 'USD')]],
  ['C4', 'Model 8755C, MOQ five hundred pieces, six dollars, EXW Yiwu, lead time twenty days.', [F('identifier', '8755C'), F('moq', '500'), F('unitPrice', '6'), F('incoterm', 'EXW'), F('port', 'Yiwu'), F('leadTime', '20')]],
  ['C5', 'ZF-041 has a sixty five watt PD USB-C charger, thirty percent deposit.', [F('identifier', 'ZF-041'), F('power', '65'), F('token', 'PD'), F('token', 'USB-C'), F('deposit', '30')]],
  ['C6', 'Reference 8709C is CE and RoHS certified, carton quantity twenty four pieces.', [F('identifier', '8709C'), F('claim', 'CE'), F('claim', 'ROHS'), F('cartonQty', '24')]],
];
const NATURAL = [
  ['D1', 'Le produit : parlez de ce que c’est, à quoi il sert, comment il est fait'], ['D2', 'Le modèle / la référence et les variantes'], ['D3', 'Le MOQ et ce qui est négociable'], ['D4', 'Les prix par quantité, la devise, l’Incoterm'],
  ['D5', 'Les couleurs et la personnalisation (logo)'], ['D6', 'L’emballage et le carton'], ['D7', 'Le délai de production et le paiement'], ['D8', 'Le transport, les certificats (CE, RoHS, REACH), la batterie et les matériaux'],
];

export function buildScript(seed = SEED) {
  const items = []; const add = (it) => items.push({ order: items.length + 1, ...it });
  add({ id: 'S1', section: 'SILENCE', kind: 'silence', display: 'Silence total : ne dites rien pendant 10 secondes', seconds: 10, expect: { silent: true } });
  for (const [id, display, say, facts] of FACT_ITEMS) add({ id, section: 'A_FACTS', kind: 'fact', display, say, seconds: 8, expect: { facts } });
  for (const [ref, forms] of KEY_FORMS) forms.forEach((form, i) => add({ id: `B-${canonId(ref)}-${i + 1}`, section: 'B_KEY_IDENTIFIERS', kind: 'identifier', display: `Référence ${ref}`, say: form, seconds: 6, expect: { identifier: ref } }));
  syntheticIdentifiers(seed).forEach((s, i) => add({ id: `B-SYN-${String(i + 1).padStart(2, '0')}`, section: 'B_SYNTHETIC_IDENTIFIERS', kind: 'identifier', display: `Référence ${s.id}`, say: null, seconds: 5, pattern: s.pattern, expect: { identifier: s.id } }));
  for (const [id, say, facts] of MIXED) add({ id, section: 'C_MIXED', kind: 'mixed', display: say, say, seconds: 10, expect: { facts, identifier: facts.find((f) => f.type === 'identifier')?.value ?? null } });
  add({ id: 'S2', section: 'NOISE', kind: 'noise', display: 'Bruit : tapotez sur la table ou froissez un papier pendant 8 secondes, sans parler', seconds: 8, expect: { silent: true } });
  for (const [id, display] of NATURAL) add({ id, section: 'D_NATURAL', kind: 'natural', display, say: null, seconds: 35, expect: { reference: 'OWNER_PROVIDED' } });
  add({ id: 'S3', section: 'SILENCE', kind: 'silence', display: 'Silence total : ne dites rien pendant 10 secondes (fin)', seconds: 10, expect: { silent: true } });
  return { version: 1, seed, createdFor: 'ASR physical benchmark (LAB)', keyReferences: [...KEY_REFERENCES], items, estimatedMinutes: Math.round((items.reduce((a, i) => a + i.seconds, 0) / 60) * 10) / 10 };
}
