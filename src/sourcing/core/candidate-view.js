// Presentation rules for candidate facts and conflicts (pure; used by the Capture/Review screen). Plain words for a person holding a phone in front of a supplier:
// no event names, no JSON, every guess-like step said out loud, a supplier statement never shown as proof, a typed correction validated and never silently reinterpreted.
import { conflictText } from './conversation.js';
import { INCOTERMS } from './extract/shared.js';

export const FLAG_TEXT = Object.freeze({
  DERIVED: 'Calculated by Nordla from what was said (for example 100 minus the deposit): please check it.',
  AMBIGUOUS_NUMBER: 'The number format is unclear (comma or dot): please type the right value.',
  CURRENCY_FROM_SYMBOL: 'The currency was guessed from the symbol: please check it.',
  WEEKS_CONVERTED: 'Weeks were converted to days (1 week = 7 days).',
  WAN_CONVERTED: 'The Chinese unit 万 was converted (1万 = 10,000). The original is kept.',
  UNLISTED_PLACE: 'This place is not in the list of known ports: please check the spelling.',
  SUM_NOT_100: 'Deposit and balance do not add up to 100%: please correct one of them.',
  EU_NUMBER_FORMAT: 'A European number format (1.200,50) was read as 1200.50.',
  THOUSANDS_COMMA_REMOVED: 'A thousands comma was removed from the number.',
  MULTIPLE_CURRENCIES: 'More than one currency was mentioned: check which one applies.',
});
const HIDDEN_FLAGS = new Set(['SUPPLIER_STATEMENT']);
const DOC_NAME = { CE: 'CE', UN383: 'UN 38.3', ROHS: 'RoHS', REACH: 'REACH', FCC: 'FCC', SDS: 'Safety data sheet', IEC62133: 'IEC 62133', TEST_REPORT: 'Test report' };
const CTX = { custom_logo: ' (with your logo)', custom_packaging: ' (with your packaging)', sample: ' (samples)', per_colour: ' (per colour)' };
const LABELS = { 'quote.moq': 'Minimum order', 'quote.unitPrice': 'Unit price', 'quote.samplePrice': 'Sample price', 'quote.currency': 'Currency', 'quote.tiers': 'Price tiers', 'quote.incoterm': 'Incoterm', 'quote.port': 'Port or place', 'quote.leadTime': 'Lead time', 'payment.depositPct': 'Deposit', 'payment.balancePct': 'Balance', 'payment.balanceDue': 'Balance is due', 'variant.colours': 'Colours', 'variant.colourCount': 'Number of colours', 'moq.mixedColours': 'Mixed colours in the minimum order', 'moq.perColour': 'Minimum per colour', 'carton.qty': 'Units per carton', 'carton.dimensions': 'Carton size', 'product.dimensions': 'Product size', 'carton.grossWeight': 'Carton gross weight', 'carton.netWeight': 'Carton net weight', 'identifier.model': 'Model', 'identifier.brand': 'Brand', 'identifier.manufacturer': 'Manufacturer' };
const CLAIM_TEXT = { CLAIMED: 'the supplier says they have it', PROMISED: 'the supplier says they will send it', NOT_AVAILABLE: 'the supplier says they do not have it' };
const CORRECTABLE = new Set(['quote.unitPrice', 'quote.samplePrice', 'quote.currency', 'quote.moq', 'quote.incoterm', 'quote.port', 'payment.depositPct', 'payment.balancePct', 'payment.balanceDue', 'identifier.model', 'identifier.brand', 'identifier.manufacturer', 'variant.colourCount', 'moq.perColour', 'carton.qty']);

const unit = (n) => `${n} ${String(n) === '1' ? 'piece' : 'pieces'}`;
function valueText(c) {
  const v = c.value;
  if (c.needsCorrection && (v === null || v === undefined)) return `unclear: "${c.rawText}"`;
  switch (c.key) {
    case 'quote.moq': case 'moq.perColour': case 'carton.qty': return unit(v);
    case 'quote.tiers': return v.map((t) => `${t.minQty ?? '?'} pcs: ${t.unitPrice ?? 'unclear'}`).join(' / ');
    case 'quote.leadTime': return v.min === v.max ? `${v.min} days` : `${v.min} to ${v.max} days`;
    case 'payment.depositPct': case 'payment.balancePct': return `${v}%`;
    case 'carton.dimensions': case 'product.dimensions': return `${v.l} x ${v.w} x ${v.h} ${v.unit}`;
    case 'carton.grossWeight': case 'carton.netWeight': return `${v.amount} ${v.unit}`;
    case 'variant.colours': return v.join(', ');
    case 'moq.mixedColours': return v ? 'Yes' : 'No';
    default: return c.key.startsWith('docClaim.') ? (CLAIM_TEXT[v] ?? String(v)) : String(v);
  }
}

/** @returns {{ id, key, label, valueText, from, lang, kind, note, warnings: string[], canConfirm, canCorrect, suggestion? }} */
export function describeCandidate(c) {
  const isClaim = c.key.startsWith('docClaim.');
  const label = isClaim ? `Document: ${DOC_NAME[c.key.slice(9)] ?? c.key.slice(9)}` : `${LABELS[c.key] ?? c.key}${c.key === 'quote.moq' ? (CTX[c.context] ?? '') : ''}`;
  return { id: c.id, key: c.key, label, valueText: valueText(c), from: c.rawText, lang: c.lang, kind: isClaim ? 'CLAIM' : 'FACT',
    note: isClaim ? 'A statement by the supplier, not proof. No document was received.' : null,
    warnings: (c.flags ?? []).filter((f) => !HIDDEN_FLAGS.has(f) && FLAG_TEXT[f]).map((f) => FLAG_TEXT[f]),
    canConfirm: !c.needsCorrection, canCorrect: CORRECTABLE.has(c.key), ...(c.suggestion ? { suggestion: c.suggestion } : {}) };
}

const INTEGER_KEYS = new Set(['quote.moq', 'carton.qty', 'variant.colourCount', 'moq.perColour']);
const DECIMAL_KEYS = new Set(['quote.unitPrice', 'quote.samplePrice']);
const TEXT_KEYS = new Set(['quote.port', 'payment.balanceDue', 'identifier.model', 'identifier.brand', 'identifier.manufacturer']);
/** A typed correction: validated, trimmed, never reinterpreted (a decimal comma is refused, a model keeps its case, slash and suffix). */
export function validateCorrection(key, text) {
  const t = String(text ?? '').trim();
  if (!CORRECTABLE.has(key)) return { ok: false, error: 'This value cannot be corrected by typing here: reject it and enter it in the Money tab.' };
  if (!t) return { ok: false, error: 'Type a value first.' };
  if (DECIMAL_KEYS.has(key)) { if (/,/.test(t)) return { ok: false, error: 'Use a dot for decimals (6.80), not a comma.' }; return /^\d+(\.\d+)?$/.test(t) && Number(t) > 0 ? { ok: true, value: t } : { ok: false, error: 'Type a number above zero, for example 6.80.' }; }
  if (INTEGER_KEYS.has(key)) return /^\d+$/.test(t) && Number(t) > 0 ? { ok: true, value: t } : { ok: false, error: 'Type whole digits only, for example 1000 (no comma, no dot).' };
  if (key === 'quote.currency') { const u = t.toUpperCase(); return ['USD', 'CNY', 'EUR'].includes(u) ? { ok: true, value: u } : { ok: false, error: 'Currency must be USD, CNY or EUR.' }; }
  if (key === 'quote.incoterm') { const u = t.toUpperCase(); return INCOTERMS.includes(u) ? { ok: true, value: u } : { ok: false, error: `Incoterm must be one of ${INCOTERMS.join(', ')}.` }; }
  if (key.startsWith('payment.') && key !== 'payment.balanceDue') return /^\d{1,3}$/.test(t) && Number(t) <= 100 ? { ok: true, value: t } : { ok: false, error: 'Type a percentage between 0 and 100.' };
  if (TEXT_KEYS.has(key)) return { ok: true, value: t };
  return { ok: false, error: 'This value cannot be corrected by typing here.' };
}

export function describeConflict(x) {
  const [old, now] = x.entries.map((e) => (typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value)));
  const title = conflictText(x); return { id: x.id, key: x.key, title: title.charAt(0).toUpperCase() + title.slice(1), question: x.question?.en ?? null, zhNote: x.question?.zhNote ?? null,
    help: x.type === 'MODEL_MISMATCH' ? 'Check the exact model on the product or on the paper. Models are compared character by character.' : 'One of the two may be for a different case (for example with your logo). Ask the supplier if unsure.',
    choices: [{ choice: 'OLD', label: `Keep the earlier value (${old})` }, { choice: 'NEW', label: `Use the new value (${now})` }] };
}
