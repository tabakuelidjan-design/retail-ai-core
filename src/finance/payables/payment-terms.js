// Payment terms of a SUPPLIER document: a closed, deterministic grammar (FR / NL / EN). Pure: no model, no clock, no network.
//
// The reader locates the words a supplier printed ("Paiement à 30 jours", "Betaalbaar binnen 14 dagen", "Net 30", "Payment upfront"...);
// this module says whether they are a term it understands, and which one. Anything else is reported as such and NEVER interpreted:
// discounts ("2/10 net 30"), deposits, "selon contrat", a starting point that is not the invoice date... An unknown wording is never
// turned into an approximate number of days, and no default number of days exists here.
//
//   parsePaymentTerms(text, { labelled }) -> { status, parsed, grammarVersion }
//     status  PARSED          a term of the grammar was recognised
//             OUT_OF_GRAMMAR  the text is (or is labelled as) a payment term, but not one this grammar computes from
//             AMBIGUOUS       two different terms in the same text
//             NOT_A_TERM      the text is not a payment term at all (only ever returned for an unlabelled text)
//     parsed  { kind, days, referencePoint, referenceExplicit, endOfMonth } | null
//             kind IMMEDIATE | NET_DAYS | NET_DAYS_END_OF_MONTH | PREPAID
//
// `labelled` = the text was found after a "payment terms" label (or in a structured field). An unlabelled text must be a short, whole
// phrase with an explicit payment cue: "30 jours" alone (a warranty, a return period) is not a payment term.

export const GRAMMAR_VERSION = 'pt-1';
export const MAX_TERM_DAYS = 365;
export const UNLABELLED_MAX_LENGTH = 80;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`´]/g, "'").replace(/\s+/g, ' ').trim();

const DAY_UNIT = '(?:jours?|jrs?|dagen|days?|j|d)';
const DAY_NUMBER = new RegExp(`(?<![a-z\\d.,/])(\\d{1,4})\\s*${DAY_UNIT}(?![a-z])`, 'g');   // a number glued to letters ("3j27...") is part of an identifier, not a duration
const NET_N = /\bnet\s*(\d{1,3})\b(?!\s*(?:%|eur|€|usd|[.,]\d))/;
const EOM = /(?:fin\s+de\s+mois|fin\s+mois|\bfdm\b|\bf\.d\.m\b|\bfm\b|einde\s+(?:van\s+de\s+)?maand|\beom\b|end\s+of\s+(?:the\s+)?month)/;
const IMMEDIATE = new RegExp([
  "(?:payable\\s+)?(?:immediatement|immediat|des\\s+reception|a\\s+reception(?:\\s+de\\s+(?:la\\s+)?facture)?|comptant)\\b",
  "paiement\\s+(?:immediat|comptant|a\\s+reception)\\b",
  "onmiddellijk\\b", "direct\\s+(?:te\\s+)?betalen\\b", "bij\\s+ontvangst(?:\\s+van\\s+(?:de\\s+)?factuur)?\\b",
  "(?:due|payable|payment(?:\\s+due)?)\\s+(?:on|upon)\\s+receipt(?:\\s+of\\s+(?:the\\s+)?invoice)?\\b",
  "payable\\s+immediately\\b", "immediate(?:ly)?(?:\\s+payment)?\\b", "net\\s+immediate\\b",
].map((p) => `(?:\\b${p})`).join('|'));
// "on delivery" / "à la livraison" / "à réception des marchandises": due at an event that is not on the document, so not computable.
const NOT_INVOICE_EVENT = /(?:reception\s+(?:des\s+)?(?:marchandises?|commande|colis)|receipt\s+of\s+(?:the\s+)?goods|ontvangst\s+(?:van\s+de\s+)?goederen|a\s+la\s+livraison|on\s+delivery|bij\s+levering|a\s+l'enlevement|on\s+collection)/;
const PREPAID_ANYWHERE = /\b(?:upfront|up-front|prepaid|pre-paid|prepayment|vooruitbetaling|vooruit\s+betaald|paiement\s+anticipe|paiement\s+a\s+l'avance|deja\s+(?:paye|regle)|reeds\s+betaald|already\s+paid)\b/;
const PREPAID_WHOLE = /^(?:payment\s+upfront|upfront\s+payment|paiement\s+anticipe|paiement\s+a\s+l'avance|paye|deja\s+paye|betaald|paid|prepaid|already\s+paid|vooruitbetaling|reeds\s+betaald)[\s.!]*$/;
// wording that makes a text something else than a term we compute from: discounts, deposits, instalments, contracts, percentages.
const EXCLUDED = /(?:\d+\s*\/\s*\d+\s*net|escompte|korting|discount|skonto|acompte|deposit|voorschot|\bsolde\b|balance\s+due|instal|termijnen|tranche|\d+\s*%|selon\s+(?:le\s+)?contrat|volgens\s+(?:het\s+)?contract|as\s+agreed|according\s+to\s+(?:the\s+)?contract|sur\s+accord|na\s+overeenkomst)/;
// an unlabelled text must talk about PAYING: "within N days" alone can be a dispute period, a delivery time...
const PAYMENT_CUE = /(?:paiement|payable|payer|reglement|regler|betaal|betalen|betaling|payment|\bpay\b|\bnet\s*\d|\d\s*(?:jours?|jrs?|dagen|days?|j|d)\s*net\b)/;
// a long letters+digits token (a payment reference, an order id): a text that carries one is not a wording of terms
const IDENTIFIER = /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{12,}\b/;
const NOT_PAYMENT = /(?:garantie|warranty|retour|return|livraison|delivery|levering|geldig|valable|valid|offre|offer|devis|quote|reclam|expire|delai\s+de\s+(?:livraison|retractation)|bedenktijd|contact|dispute|litige|geschil|claims?\b|complain|plainte|objection|bezwaar|protest|@|www\.|https?:)/;
const FROM_INVOICE = /(?:date\s+(?:de\s+)?(?:la\s+)?facture|factuurdatum|invoice\s+date|from\s+(?:the\s+)?invoice|de\s+la\s+facture|after\s+invoice|na\s+factuur|apres\s+facture|date\s+d'emission|issue\s+date)/;
const FROM_OTHER_EVENT = /(?:reception|ontvangst|receipt|received|livraison|delivery|levering|expedition|shipment|verzending|commande|order\s+date|besteldatum|bill\s+of\s+lading|b\/l)/;

const result = (status, parsed = null) => ({ status, parsed, grammarVersion: GRAMMAR_VERSION });
const term = (kind, days, ref, explicit, eom) => ({ kind, days, referencePoint: ref, referenceExplicit: explicit, endOfMonth: eom });

/** @param {string} text @param {{ labelled?: boolean }} [opts] */
export function parsePaymentTerms(text, { labelled = false } = {}) {
  const t = norm(text);
  if (!t || (!labelled && t.length > UNLABELLED_MAX_LENGTH)) return result('NOT_A_TERM');
  if (!labelled && (NOT_PAYMENT.test(t) || IDENTIFIER.test(t))) return result('NOT_A_TERM');
  const fail = () => result(labelled ? 'OUT_OF_GRAMMAR' : 'NOT_A_TERM');

  if (PREPAID_WHOLE.test(t) || (labelled && PREPAID_ANYWHERE.test(t))) return result('PARSED', term('PREPAID', null, null, false, false));
  if (EXCLUDED.test(t)) return fail();

  // numbers of days present in the text: two different ones is not one term
  const nums = new Set(); for (const m of t.matchAll(DAY_NUMBER)) nums.add(Number(m[1]));
  const net = NET_N.exec(t); if (net) nums.add(Number(net[1]));
  const immediate = IMMEDIATE.test(t);
  if (nums.size > 1 || (nums.size === 1 && immediate)) return result('AMBIGUOUS');

  if (nums.size === 1) {
    const days = [...nums][0];
    if (!labelled && !PAYMENT_CUE.test(t)) return result('NOT_A_TERM');
    if (days > MAX_TERM_DAYS) return fail();
    // the starting point: the invoice date (stated, or by the usual convention when nothing else is said), or another event = not computable
    const fromInvoice = FROM_INVOICE.test(t); const fromOther = FROM_OTHER_EVENT.test(t.replace(FROM_INVOICE, ' '));
    if (fromOther) return fail();
    const eom = EOM.test(t);
    return result('PARSED', term(eom ? 'NET_DAYS_END_OF_MONTH' : 'NET_DAYS', days, 'INVOICE_DATE', fromInvoice, eom));
  }
  if (immediate) {
    if (NOT_INVOICE_EVENT.test(t)) return fail();
    return result('PARSED', term('IMMEDIATE', 0, 'INVOICE_DATE', false, false));
  }
  return fail();
}

/** The same parsed term, whatever the wording: used to tell whether two texts of one document say the same thing. */
export const termSignature = (parsed) => (parsed ? `${parsed.kind}|${parsed.days ?? ''}|${parsed.endOfMonth ? 'EOM' : ''}|${parsed.referencePoint ?? ''}` : '');
