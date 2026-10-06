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
  DUPLICATE_THRESHOLD: 'Two different prices were given for the same quantity: reject this and enter the right tiers in the Money tab.',
  UNLABELLED_IDENTIFIER: 'No "model" label was written next to this code: please check that it is the model.',
  MULTIPLE_CURRENCIES: 'More than one currency was mentioned: check which one applies.',
});
const HIDDEN_FLAGS = new Set(['SUPPLIER_STATEMENT']);
const DOC_NAME = { CE: 'CE', UN383: 'UN 38.3', ROHS: 'RoHS', REACH: 'REACH', FCC: 'FCC', SDS: 'Safety data sheet', IEC62133: 'IEC 62133', TEST_REPORT: 'Test report' };
const CTX = { custom_logo: ' (with your logo)', custom_packaging: ' (with your packaging)', sample: ' (samples)', per_colour: ' (per colour)' };
const LABELS = { 'quote.moq': 'Minimum order', 'quote.unitPrice': 'Unit price', 'quote.samplePrice': 'Sample price', 'quote.currency': 'Currency', 'quote.tiers': 'Price tiers', 'quote.incoterm': 'Incoterm', 'quote.port': 'Port or place', 'quote.leadTime': 'Lead time', 'payment.depositPct': 'Deposit', 'payment.balancePct': 'Balance', 'payment.balanceDue': 'Balance is due', 'variant.colours': 'Colours', 'variant.colourCount': 'Number of colours', 'moq.mixedColours': 'Mixed colours in the minimum order', 'moq.perColour': 'Minimum per colour', 'carton.qty': 'Units per carton', 'carton.dimensions': 'Carton size', 'product.dimensions': 'Product size', 'carton.grossWeight': 'Carton gross weight', 'carton.netWeight': 'Carton net weight', 'identifier.model': 'Model', 'identifier.brand': 'Brand', 'identifier.manufacturer': 'Manufacturer' };
const CLAIM_TEXT = { CLAIMED: 'the supplier says they have it', PROMISED: 'the supplier says they will send it', NOT_AVAILABLE: 'the supplier says they do not have it' };
const CORRECTABLE = new Set(['quote.unitPrice', 'quote.samplePrice', 'quote.currency', 'quote.moq', 'quote.incoterm', 'quote.port', 'payment.depositPct', 'payment.balancePct', 'payment.balanceDue', 'identifier.model', 'identifier.brand', 'identifier.manufacturer', 'variant.colourCount', 'moq.perColour', 'carton.qty']);

const FR_LABELS = { 'quote.moq': 'Minimum de commande', 'quote.unitPrice': 'Prix unitaire', 'quote.samplePrice': "Prix de l'échantillon", 'quote.currency': 'Devise', 'quote.tiers': 'Prix par palier', 'quote.incoterm': 'Incoterm', 'quote.port': 'Port ou lieu', 'quote.leadTime': 'Délai', 'payment.depositPct': 'Acompte', 'payment.balancePct': 'Solde', 'payment.balanceDue': 'Le solde est dû', 'variant.colours': 'Couleurs', 'variant.colourCount': 'Nombre de couleurs', 'moq.mixedColours': 'Couleurs mélangées dans le minimum', 'moq.perColour': 'Minimum par couleur', 'carton.qty': 'Pièces par carton', 'carton.dimensions': 'Taille du carton', 'product.dimensions': 'Taille du produit', 'carton.grossWeight': 'Poids brut du carton', 'carton.netWeight': 'Poids net du carton', 'identifier.model': 'Modèle', 'identifier.brand': 'Marque', 'identifier.manufacturer': 'Fabricant' };
const FR_CTX = { custom_logo: ' (avec votre logo)', custom_packaging: ' (avec votre emballage)', sample: ' (échantillons)', per_colour: ' (par couleur)' };
const FR_DOC_NAME = { CE: 'CE', UN383: 'UN 38.3', ROHS: 'RoHS', REACH: 'REACH', FCC: 'FCC', SDS: 'Fiche de données de sécurité', IEC62133: 'IEC 62133', TEST_REPORT: "Rapport d'essai" };
const FR_CLAIM_TEXT = { CLAIMED: "le fournisseur dit l'avoir", PROMISED: "le fournisseur dit qu'il l'enverra", NOT_AVAILABLE: 'le fournisseur dit ne pas l\'avoir' };
export const FLAG_TEXT_FR = Object.freeze({
  DERIVED: 'Calculé par Nordla à partir de ce qui a été dit (par exemple 100 moins l\'acompte) : à vérifier.',
  AMBIGUOUS_NUMBER: 'Le format du nombre est ambigu (virgule ou point) : tapez la bonne valeur.',
  CURRENCY_FROM_SYMBOL: 'La devise a été devinée à partir du symbole : à vérifier.',
  WEEKS_CONVERTED: 'Les semaines ont été converties en jours (1 semaine = 7 jours).',
  WAN_CONVERTED: "L'unité chinoise 万 a été convertie (1万 = 10 000). L'original est conservé.",
  UNLISTED_PLACE: "Ce lieu n'est pas dans la liste des ports connus : vérifiez l'orthographe.",
  SUM_NOT_100: "L'acompte et le solde ne font pas 100 % : corrigez l'un des deux.",
  EU_NUMBER_FORMAT: 'Un format numérique européen (1.200,50) a été lu comme 1200.50.',
  THOUSANDS_COMMA_REMOVED: 'Une virgule de milliers a été retirée du nombre.',
  DUPLICATE_THRESHOLD: 'Deux prix différents pour la même quantité : rejetez et saisissez les bons paliers dans Money.',
  UNLABELLED_IDENTIFIER: 'Aucun libellé « modèle » n\'était écrit à côté de ce code : vérifiez que c\'est bien le modèle.',
  MULTIPLE_CURRENCIES: 'Plusieurs devises ont été citées : vérifiez laquelle s\'applique.',
});
const unit = (n) => `${n} ${String(n) === '1' ? 'piece' : 'pieces'}`;
function valueText(c, fr = false) {
  const v = c.value;
  if (c.needsCorrection && (v === null || v === undefined)) return `${fr ? 'ambigu' : 'unclear'}: "${c.rawText}"`;
  if (fr) {
    switch (c.key) {
      case 'quote.moq': case 'moq.perColour': case 'carton.qty': return `${v} ${String(v) === '1' ? 'pièce' : 'pièces'}`;
      case 'quote.tiers': return v.map((t) => `${t.minQty ?? '?'} pièces : ${t.unitPrice ?? 'ambigu'}`).join(' / ');
      case 'quote.leadTime': return v.min === v.max ? `${v.min} jours` : `${v.min} à ${v.max} jours`;
      case 'payment.depositPct': case 'payment.balancePct': return `${v} %`;
      case 'moq.mixedColours': return v ? 'Oui' : 'Non';
      case 'payment.balanceDue': return { 'before shipment': 'avant expédition', 'before delivery': 'avant livraison', 'before loading': 'avant chargement', 'against B/L': 'contre le connaissement (B/L)', 'after inspection': "après inspection", 'on delivery': 'à la livraison', 'at shipment': "à l'expédition" }[String(v)] ?? String(v);
      default: if (c.key.startsWith('docClaim.')) return FR_CLAIM_TEXT[v] ?? String(v);
    }
  }
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

/** Label of a fact key in the owner's language. */
export function labelOf(key, context, locale = 'en') {
  const fr = locale === 'fr';
  if (key.startsWith('docClaim.')) return `${fr ? 'Document' : 'Document'} : ${(fr ? FR_DOC_NAME : DOC_NAME)[key.slice(9)] ?? key.slice(9)}`.replace(' : ', fr ? ' : ' : ': ');
  return `${(fr ? FR_LABELS : LABELS)[key] ?? key}${key === 'quote.moq' ? ((fr ? FR_CTX : CTX)[context] ?? '') : ''}`;
}
/** A confirmed or proposed fact described in plain words (works for candidates and ledger entries alike). */
export function describeFact(f, locale = 'en') { return { key: f.key, label: labelOf(f.key, f.context, locale), valueText: valueText(f, locale === 'fr') }; }

/** @returns {{ id, key, label, valueText, from, lang, kind, note, warnings: string[], canConfirm, canCorrect, suggestion? }} */
export function describeCandidate(c, locale = 'en') {
  const isClaim = c.key.startsWith('docClaim.'); const fr = locale === 'fr'; const flags = fr ? FLAG_TEXT_FR : FLAG_TEXT;
  return { id: c.id, key: c.key, label: labelOf(c.key, c.context, locale), valueText: valueText(c, fr), from: c.rawText, lang: c.lang, kind: isClaim ? 'CLAIM' : 'FACT',
    note: isClaim ? (fr ? 'Une déclaration du fournisseur, pas une preuve. Aucun document n\'a été reçu.' : 'A statement by the supplier, not proof. No document was received.') : null,
    warnings: (c.flags ?? []).filter((f) => !HIDDEN_FLAGS.has(f) && flags[f]).map((f) => flags[f]),
    canConfirm: !c.needsCorrection, canCorrect: CORRECTABLE.has(c.key), ...(c.suggestion ? { suggestion: c.suggestion } : {}) };
}

const INTEGER_KEYS = new Set(['quote.moq', 'carton.qty', 'variant.colourCount', 'moq.perColour']);
const DECIMAL_KEYS = new Set(['quote.unitPrice', 'quote.samplePrice']);
const TEXT_KEYS = new Set(['quote.port', 'payment.balanceDue', 'identifier.model', 'identifier.brand', 'identifier.manufacturer']);
/** A typed correction: validated, trimmed, never reinterpreted (a decimal comma is refused, a model keeps its case, slash and suffix). */
export function validateCorrection(key, text, locale = 'en') {
  const r = validateCorrectionEn(key, text); if (locale !== 'fr' || r.ok) return r;
  return { ok: false, error: FR_ERRORS[r.error] ?? r.error };
}
const FR_ERRORS = { 'Type a value first.': 'Tapez une valeur.', 'Use a dot for decimals (6.80), not a comma.': 'Utilisez un point pour les décimales (6.80), pas une virgule.', 'Type a number above zero, for example 6.80.': 'Tapez un nombre supérieur à zéro, par exemple 6.80.', 'Type whole digits only, for example 1000 (no comma, no dot).': 'Tapez uniquement des chiffres entiers, par exemple 1000 (sans virgule ni point).', 'Currency must be USD, CNY or EUR.': 'La devise doit être USD, CNY ou EUR.', 'Type a percentage between 0 and 100.': 'Tapez un pourcentage entre 0 et 100.' };
function validateCorrectionEn(key, text) {
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
