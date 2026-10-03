// Belgian compliance primitives for Finance V1: structured communication (VCS/OGM), the explainable invoice-route decision, and the registry of rules this phase relies on.
// Nordla is not a tax adviser: every fact comes from explicit data; what cannot be decided from facts becomes MANUAL_REVIEW_REQUIRED or COMPLIANCE_BLOCKED, never a guess.
//
// Rule classes (see docs/finance-belgium-compliance.md):  LEGAL MUST | PEPPOL MUST | NORDLA INVARIANT | BACKLOG

import { normalizeBelgianNumber } from './company.js';
import { VAT_REGIMES } from './vat.js';

// ---------------------------------------------------------------- rule registry (every LEGAL / PEPPOL rule carries its source and its verification date)
const E_INV = 'https://einvoice.belgium.be/en';
export const RULES = [
  { id: 'BE-B2B-STRUCTURED-2026', class: 'LEGAL MUST', rule: 'From 2026-01-01, invoices between Belgian enterprises liable to VAT (B2B) must be structured electronic invoices; a PDF sent by e-mail is no longer enough.', source: 'FPS Finance / BOSA e-invoice portal', url: `${E_INV}/article/structured-electronic-invoices-between-companies-are-compulsory-2026`, legalRef: 'VAT Code art. 53 §2bis', verifiedOn: '2026-10-03', component: 'belgium-compliance.js determineInvoiceRoute' },
  { id: 'BE-B2C-OUT-OF-SCOPE', class: 'LEGAL MUST', rule: 'The obligation does not apply to invoices issued to private individuals.', source: 'FPS Finance / BOSA e-invoice portal', url: `${E_INV}/article/structured-electronic-invoices-between-companies-are-compulsory-2026`, legalRef: null, verifiedOn: '2026-10-03', component: 'determineInvoiceRoute (buyer.kind = individual)' },
  { id: 'BE-NON-ESTABLISHED-OUT', class: 'LEGAL MUST', rule: 'VAT-registered persons not established in Belgium (no permanent establishment) are not subject to the obligation; small-business exemption scheme and agricultural scheme users ARE subject.', source: 'FPS Finance / BOSA e-invoice FAQ', url: `${E_INV}/FAQ/general-questions-b2b`, legalRef: 'VAT Code art. 53 §2bis', verifiedOn: '2026-10-03', component: 'determineInvoiceRoute (seller establishment, vat_exempt_small_business stays in scope)' },
  { id: 'BE-ART44-OUT', class: 'LEGAL MUST', rule: 'Taxpayers whose only activities are exempt under VAT Code art. 44 are not required to register for VAT (and therefore have no VAT number): an explicit fact "exempt art. 44 only" takes the buyer out of scope.', source: 'FPS Finance / BOSA e-invoice portal', url: `${E_INV}/FAQ/general-questions-b2b`, legalRef: 'VAT Code art. 44', verifiedOn: '2026-10-03', component: 'determineInvoiceRoute (buyer.exemptArt44Only)' },
  { id: 'BE-ALT-FORMAT-AGREEMENT', class: 'LEGAL MUST', rule: 'Structured invoices are in principle Peppol BIS; a deviation is only possible if BOTH parties agree and the alternative format complies with EN 16931; the agreement should be explicit and in writing.', source: 'FPS Finance / BOSA e-invoice portal', url: `${E_INV}/FAQ/specific-questions-about-e-invoicing`, legalRef: null, verifiedOn: '2026-10-03', component: 'determineInvoiceRoute (agreement fact: reason, evidence, format, timestamp, provenance)' },
  { id: 'BE-CREDIT-NOTE-SAME-FORMAT', class: 'LEGAL MUST', rule: 'A document that modifies the original structured invoice and refers to it unambiguously is itself a structured invoice and is issued in the same format; credit and debit notes are therefore also sent via Peppol.', source: 'FPS Finance / BOSA e-invoice FAQ', url: `${E_INV}/FAQ/specific-questions-about-e-invoicing`, legalRef: 'VAT Code art. 56 §2 (4)', verifiedOn: '2026-10-03', component: 'determineInvoiceRoute (credit note inherits the route of the invoice it corrects)' },
  { id: 'BE-B2G-SEPARATE', class: 'LEGAL MUST', rule: 'E-invoicing to public authorities is governed by separate rules (mandatory for public contracts published after 2024-03-01; Royal Decree of 2022-03-09). B2G is its own route; thresholds and exceptions of public procurement are not evaluated by Nordla V1.', source: 'FPS Finance / BOSA e-invoice portal', url: `${E_INV}/article/structured-electronic-invoices-between-companies-are-compulsory-2026`, legalRef: 'Royal Decree 2022-03-09', verifiedOn: '2026-10-03', component: 'determineInvoiceRoute (B2G_STRUCTURED + manual-review note)' },
  { id: 'BE-TOLERANCE-2026Q1', class: 'LEGAL MUST', rule: 'FPS Finance showed tolerance (no penalty) during 2026-01-01..2026-03-31 for enterprises that acted in a timely and reasonable manner; penalties apply after.', source: 'FPS Finance / BOSA e-invoice portal', url: `${E_INV}/news/period-tolerance-during-first-three-months-2026`, legalRef: null, verifiedOn: '2026-10-03', component: 'documentation only (no code path depends on it)' },
  { id: 'BE-ATTACHMENT-FORMATS', class: 'LEGAL MUST', rule: 'Attachments follow the EN 16931 list (pdf, png, jpg, csv, xlsx, ods); XML is not in that list unless the parties agree.', source: 'FPS Finance / BOSA e-invoice FAQ', url: `${E_INV}/FAQ/specific-questions-about-e-invoicing`, legalRef: null, verifiedOn: '2026-10-03', component: 'peppol-validation.js PEPPOL_RULESETS[*].attachmentMediaTypes' },
  { id: 'PEPPOL-BIS-3.0.21', class: 'PEPPOL MUST', rule: 'Peppol BIS Billing 3.0, May 2026 release, version 3.0.21; CustomizationID urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0 (rule PEPPOL-EN16931-R004).', source: 'OpenPeppol', url: 'https://docs.peppol.eu/poacc/billing/3.0/', legalRef: null, verifiedOn: '2026-10-03', component: 'peppol-validation.js PEPPOL_RULESETS' },
  { id: 'PEPPOL-ATTACHMENT-MEDIA-TYPES', class: 'PEPPOL MUST', rule: 'A receiver accepts attachments with media types application/pdf, image/png, image/jpeg, text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.oasis.opendocument.spreadsheet.', source: 'OpenPeppol BIS Billing 3.0 specification (binary objects)', url: 'https://docs.peppol.eu/poacc/billing/3.0/bis/', legalRef: null, verifiedOn: '2026-10-03', component: 'peppol-validation.js PEPPOL_RULESETS[*].attachmentMediaTypes' },
  { id: 'PEPPOL-OFFICIAL-SCHEMATRON', class: 'PEPPOL MUST', rule: 'Invoices are validated with the official EN 16931 (CEN-EN16931-UBL.sch) and Peppol (PEPPOL-EN16931-UBL.sch) Schematron, executed from the official files (not re-implemented).', source: 'OpenPeppol', url: 'https://docs.peppol.eu/poacc/billing/3.0/files/', legalRef: null, verifiedOn: '2026-10-03', component: 'peppol-validation.js + scripts/build-peppol-validators.mjs' },
  { id: 'FEBELFIN-OGM-VCS', class: 'LEGAL MUST', rule: 'Structured communication OGM/VCS: 12 digits, the last two are the check digits = (first 10 digits) mod 97, 97 when the remainder is 0; printed +++xxx/xxxx/xxxxx+++. (Commercial invoice reference, not other administrations\' structured communications.)', source: 'Febelfin - Additional Optional Service OGM-VCS (EPC AOS1)', url: 'https://www.europeanpaymentscouncil.eu/sites/default/files/inline-files/Febelfin%20-%20AOS-OGMVCS_0.pdf', legalRef: null, verifiedOn: '2026-10-03', component: 'belgium-compliance.js vcs*' },
  { id: 'NORDLA-UBL-XSD', class: 'NORDLA INVARIANT', rule: 'A structured document is validated against the official OASIS UBL 2.1 XSD (Invoice and CreditNote) before the Schematron layers; an XSD failure is never archived as valid, queued or sent.', source: 'OASIS UBL 2.1 (os-UBL-2.1) schemas', url: 'https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip', legalRef: null, verifiedOn: '2026-10-03', component: 'peppol-validation.js (xmllint-wasm)' },
  { id: 'NORDLA-ARTIFACT-INTEGRITY', class: 'NORDLA INVARIANT', rule: 'Every official validation artifact is pinned by SHA-256 in vendor/MANIFEST.json (whose own hash is pinned in code) and verified before validators are built or run; a missing, modified or wrong-version artifact fails closed.', source: 'Nordla architecture', url: null, legalRef: null, verifiedOn: null, component: 'validation-artifacts.js, scripts/pin-validation-artifacts.mjs' },
  { id: 'NORDLA-IMMUTABLE-ISSUE', class: 'NORDLA INVARIANT', rule: 'An issued document, its seller/buyer snapshot, its archived PDF and structured original never change; corrections are credit notes.', source: 'Nordla architecture', url: null, legalRef: null, verifiedOn: null, component: 'fin_documents guard, fin_artifacts immutability' },
  { id: 'NORDLA-ONE-SNAPSHOT', class: 'NORDLA INVARIANT', rule: 'PDF and UBL are produced from the SAME immutable issue snapshot; there is one financial calculator.', source: 'Nordla architecture', url: null, legalRef: null, verifiedOn: null, component: 'legal-artifacts.js' },
  { id: 'NORDLA-NO-SILENT-FALLBACK', class: 'NORDLA INVARIANT', rule: 'A structured document that fails validation is never SENT/DELIVERED, and Nordla never falls back silently to a PDF by e-mail.', source: 'Nordla architecture', url: null, legalRef: null, verifiedOn: null, component: 'peppol-service.js' },
  { id: 'NORDLA-RECEIVE-NOT-VALIDATE', class: 'NORDLA INVARIANT', rule: 'Receiving a structured invoice never validates it accounting-wise: it lands TO_REVIEW with its exact original archived first.', source: 'Nordla architecture', url: null, legalRef: null, verifiedOn: null, component: 'peppol-service.js inbound' },
  { id: 'BACKLOG-E-REPORTING', class: 'BACKLOG', rule: 'Belgian e-reporting (2028) and Intervat are not part of Finance V1.', source: null, url: null, legalRef: null, verifiedOn: null, component: null },
  { id: 'BACKLOG-SELF-BILLING', class: 'BACKLOG', rule: 'Self-billing workflow (the model can recognise the case; no workflow).', source: null, url: null, legalRef: null, verifiedOn: null, component: null },
  { id: 'BACKLOG-RETENTION-DURATIONS', class: 'BACKLOG', rule: 'Retention durations per document type: only a classification is stored; no duration is hard-coded and nothing is deleted automatically.', source: null, url: null, legalRef: null, verifiedOn: null, component: 'legal-artifacts.js RETENTION_CLASSES' },
];

// ---------------------------------------------------------------- VCS / OGM
/** 12 canonical digits from 10 base digits. Integer arithmetic only. */
export function vcsGenerate(base10) {
  const s = String(base10 ?? '');
  if (!/^\d{1,10}$/.test(s)) throw new RangeError('VCS_BASE_INVALID: 1 to 10 digits');
  const base = s.padStart(10, '0'); const rem = Number(BigInt(base) % 97n);
  return base + String(rem === 0 ? 97 : rem).padStart(2, '0');
}
/** Canonical 12 digits from any accepted written form (+++123/1234/12345+++, 123/1234/12345, 123123412345, with spaces), or null. Does NOT check the check digits. */
export function vcsCanonicalize(input) {
  if (input === null || input === undefined) return null;
  const t = String(input).trim(); const m = /^\+\+\+(\d{3})\/(\d{4})\/(\d{5})\+\+\+$/.exec(t) ?? /^(\d{3})\/(\d{4})\/(\d{5})$/.exec(t) ?? /^(\d{3}) (\d{4}) (\d{5})$/.exec(t);
  if (m) return m[1] + m[2] + m[3];
  return /^\d{12}$/.test(t) ? t : null; // anything else (unbalanced plus signs, wrong lengths, letters) is refused
}
export function vcsValid(input) { const d = vcsCanonicalize(input); return d !== null && vcsGenerate(d.slice(0, 10)) === d; }
/** "+++123/1234/12345+++" from a valid reference (any written form); throws on an invalid one. */
export function vcsFormat(input) { const d = vcsCanonicalize(input); if (d === null || !vcsValid(d)) throw new RangeError('VCS_INVALID'); return `+++${d.slice(0, 3)}/${d.slice(3, 7)}/${d.slice(7)}+++`; }
/** The commercial reference of an invoice: derived ONLY from its legal number (last 10 digits), so it is unique wherever the number is unique and identical wherever it is printed. Stored once at archive time, never recomputed by an export. */
export function vcsForInvoiceNumber(number) {
  const digits = String(number ?? '').replace(/\D/g, ''); if (!digits) throw new RangeError('VCS_NUMBER_HAS_NO_DIGITS');
  return vcsGenerate(digits.slice(-10));
}

// ---------------------------------------------------------------- invoice route
export const ROUTES = ['PEPPOL_REQUIRED', 'PEPPOL_PREFERRED', 'B2G_STRUCTURED', 'NON_STRUCTURED_ALLOWED', 'ALTERNATIVE_EN16931_AGREED', 'MANUAL_REVIEW_REQUIRED', 'COMPLIANCE_BLOCKED'];
export const STRUCTURED_ROUTES = ['PEPPOL_REQUIRED', 'PEPPOL_PREFERRED', 'B2G_STRUCTURED', 'ALTERNATIVE_EN16931_AGREED'];
const IN_SCOPE_REGIMES = ['domestic', 'vat_exempt_small_business'];
const isBeVat = (v) => typeof v === 'string' && /^BE/i.test(v) && normalizeBelgianNumber(v).ok;

/**
 * Explainable route decision from FACTS.
 * @param {object} c
 * @param {{kind?: 'invoice'|'credit_note'}} c.document
 * @param {{country?: string, vatNumber?: string, permanentEstablishmentInBelgium?: boolean, enterpriseNumber?: string, iban?: string, peppolId?: string}} c.seller
 * @param {{kind?: 'business'|'individual'|'public_authority', country?: string, vatNumber?: string, exemptArt44Only?: boolean, peppolId?: string}} c.buyer
 * @param {string} c.vatRegime one of VAT_REGIMES (explicit merchant choice)
 * @param {{format: string, en16931Compliant: boolean, reason: string, evidence: string, agreedAt: string, recordedBy: string}|null} [c.agreement]
 * @param {{route: string}|null} [c.originalInvoice] for a credit note: the decision of the invoice it corrects
 * @returns {{route: string, reasons: string[], rules: string[], missingFacts: string[], notes: string[], facts: object}}
 */
export function determineInvoiceRoute(c) {
  const out = (route, reasons, rules, extra = {}) => ({ route, reasons, rules, missingFacts: extra.missingFacts ?? [], notes: extra.notes ?? [], facts: { buyerKind: c.buyer?.kind ?? null, buyerCountry: c.buyer?.country ?? null, sellerCountry: c.seller?.country ?? null, vatRegime: c.vatRegime ?? null } });
  const { seller = {}, buyer = {} } = c;
  if (c.document?.kind === 'credit_note') {
    if (!c.originalInvoice?.route) return out('MANUAL_REVIEW_REQUIRED', ['CREDIT_NOTE_ORIGINAL_ROUTE_UNKNOWN'], ['BE-CREDIT-NOTE-SAME-FORMAT'], { missingFacts: ['originalInvoice.route'] });
    return out(c.originalInvoice.route, ['CREDIT_NOTE_FOLLOWS_THE_INVOICE_IT_CORRECTS'], ['BE-CREDIT-NOTE-SAME-FORMAT']);
  }
  if (!buyer.kind) return out('MANUAL_REVIEW_REQUIRED', ['BUYER_KIND_UNKNOWN'], [], { missingFacts: ['buyer.kind'] });
  if (buyer.kind === 'individual') return out('NON_STRUCTURED_ALLOWED', ['BUYER_IS_A_PRIVATE_INDIVIDUAL'], ['BE-B2C-OUT-OF-SCOPE']);
  if (buyer.kind === 'public_authority') return out('B2G_STRUCTURED', ['BUYER_IS_A_PUBLIC_AUTHORITY'], ['BE-B2G-SEPARATE'], { notes: ['B2G_THRESHOLDS_AND_EXCEPTIONS_NOT_EVALUATED'] });
  if (!seller.country) return out('MANUAL_REVIEW_REQUIRED', ['SELLER_COUNTRY_UNKNOWN'], [], { missingFacts: ['seller.country'] });
  if (seller.country !== 'BE' && seller.permanentEstablishmentInBelgium !== true) return out('MANUAL_REVIEW_REQUIRED', ['SELLER_NOT_ESTABLISHED_IN_BELGIUM_ESTABLISHMENT_UNKNOWN'], ['BE-NON-ESTABLISHED-OUT'], { missingFacts: ['seller.permanentEstablishmentInBelgium'] });
  if (buyer.exemptArt44Only === true) return out('NON_STRUCTURED_ALLOWED', ['BUYER_ONLY_PERFORMS_ART44_EXEMPT_ACTIVITIES'], ['BE-ART44-OUT'], { notes: ['VOLUNTARY_PEPPOL_POSSIBLE'] });
  if (!buyer.country) return out('MANUAL_REVIEW_REQUIRED', ['BUYER_COUNTRY_UNKNOWN'], [], { missingFacts: ['buyer.country'] });
  const beBuyer = buyer.country === 'BE'; const beVat = isBeVat(buyer.vatNumber);
  if (!beBuyer) {
    if (beVat) return out('MANUAL_REVIEW_REQUIRED', ['FOREIGN_ADDRESS_WITH_BELGIAN_VAT_NUMBER'], ['BE-B2B-STRUCTURED-2026'], { missingFacts: ['buyer.establishmentInBelgium'] });
    return out(buyer.peppolId ? 'PEPPOL_PREFERRED' : 'NON_STRUCTURED_ALLOWED', ['BUYER_NOT_A_BELGIAN_ENTERPRISE', ...(buyer.peppolId ? ['BUYER_HAS_A_PEPPOL_ID_VOLUNTARY_USE'] : [])], ['BE-B2B-STRUCTURED-2026'], { notes: ['VOLUNTARY_PEPPOL_POSSIBLE'] });
  }
  if (!beVat) return out('MANUAL_REVIEW_REQUIRED', ['BELGIAN_BUSINESS_BUYER_WITHOUT_A_VALID_VAT_NUMBER'], ['BE-B2B-STRUCTURED-2026', 'BE-ART44-OUT'], { missingFacts: ['buyer.vatNumber or buyer.exemptArt44Only'] });
  if (!IN_SCOPE_REGIMES.includes(c.vatRegime)) return out('MANUAL_REVIEW_REQUIRED', [VAT_REGIMES[c.vatRegime] ? 'VAT_REGIME_NOT_EVALUATED_FOR_DOMESTIC_B2B' : 'VAT_REGIME_UNKNOWN'], ['BE-B2B-STRUCTURED-2026'], { missingFacts: VAT_REGIMES[c.vatRegime] ? [] : ['vatRegime'] });
  if (c.agreement) {
    const a = c.agreement; const missing = ['format', 'reason', 'evidence', 'agreedAt', 'recordedBy'].filter((k) => !a[k]);
    if (!missing.length && a.en16931Compliant === true) return out('ALTERNATIVE_EN16931_AGREED', ['BOTH_PARTIES_AGREED_AN_EN16931_ALTERNATIVE'], ['BE-ALT-FORMAT-AGREEMENT'], { notes: [`AGREEMENT_FORMAT_${a.format}`] });
    return out('COMPLIANCE_BLOCKED', ['ALTERNATIVE_AGREEMENT_INCOMPLETE_OR_NOT_EN16931'], ['BE-ALT-FORMAT-AGREEMENT'], { missingFacts: [...missing.map((k) => `agreement.${k}`), ...(a.en16931Compliant === true ? [] : ['agreement.en16931Compliant'])] });
  }
  const missingFacts = [...(seller.vatNumber || c.vatRegime === 'vat_exempt_small_business' ? [] : ['seller.vatNumber']), ...(seller.iban ? [] : ['seller.iban'])];
  if (missingFacts.length) return out('COMPLIANCE_BLOCKED', ['STRUCTURED_INVOICE_REQUIRED_BUT_SELLER_FACTS_MISSING'], ['BE-B2B-STRUCTURED-2026'], { missingFacts });
  return out('PEPPOL_REQUIRED', ['BELGIAN_B2B_BETWEEN_VAT_LIABLE_ENTERPRISES'], ['BE-B2B-STRUCTURED-2026']);
}

/** Facts for the routing decision from an issued (or issuing) document snapshot. Only what the document explicitly says; nothing is inferred about tax status. */
export function routingContextOf(doc, { agreement = null, originalInvoiceRoute = null, buyerFacts = {} } = {}) {
  const country = (p) => p?.address?.countryCode ?? null;
  return { document: { kind: doc.type }, vatRegime: doc.vat?.regime ?? null, agreement,
    originalInvoice: originalInvoiceRoute ? { route: originalInvoiceRoute } : null,
    seller: { country: country(doc.seller), vatNumber: doc.seller?.vatNumber ?? null, iban: doc.seller?.iban ?? null, enterpriseNumber: doc.seller?.enterpriseNumber ?? null, permanentEstablishmentInBelgium: doc.seller?.permanentEstablishmentInBelgium, peppolId: doc.seller?.peppolId ?? null },
    buyer: { kind: doc.customer?.kind === 'individual' ? 'individual' : doc.customer?.kind === 'public_authority' ? 'public_authority' : doc.customer?.kind === 'business' || doc.customer?.kind === undefined ? 'business' : null, country: country(doc.customer), vatNumber: doc.customer?.vatNumber ?? null, peppolId: doc.customer?.peppolId ?? null, exemptArt44Only: doc.customer?.exemptArt44Only, ...buyerFacts } };
}
