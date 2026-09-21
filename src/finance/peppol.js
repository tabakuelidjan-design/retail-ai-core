// Peppol / structured e-invoicing readiness, as an ADAPTER BOUNDARY.
//
// Standard targeted: Peppol BIS Billing 3.0 (UBL 2.1, syntax of EN 16931), the format Belgium uses for the mandatory
// B2B e-invoicing in force since 1 January 2026 (penalties since 1 April 2026), exchanged over the Peppol network.
// Belgian participant identifiers use scheme 0208 (enterprise number, 10 digits).
//
// This module builds the payload and validates required structured fields LOCALLY. It is not the official Schematron
// validation and it TRANSMITS NOTHING. Sending is done by an AccessPointAdapter supplied later; provider-specific code
// must live in that adapter, never in the finance core. We do not operate a Peppol Access Point.

import { computeTotals } from './document.js';
import { normalizeBelgianNumber } from './company.js';
import { formatCents, fromScaled } from './money.js';
import { vatCategoryCode } from './vat.js';

export const CUSTOMIZATION_ID = 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
export const PROFILE_ID = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';
export const PEPPOL_STATUSES = ['PREPARED', 'SENT', 'DELIVERED', 'REJECTED', 'FAILED'];

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (cents) => formatCents(cents);
const pct = (bp) => fromScaled(bp, 2);

/** { scheme, id } for a party, or null. Belgian parties derive 0208 from the enterprise/VAT number; others need an explicit peppolId "scheme:id". */
export function endpointOf(party) {
  if (party?.peppolId && /^\d{4}:.+/.test(party.peppolId)) { const [scheme, ...rest] = party.peppolId.split(':'); return { scheme, id: rest.join(':') }; }
  if (party?.address?.countryCode === 'BE' || (party?.vatNumber ?? '').startsWith('BE')) {
    const n = normalizeBelgianNumber(party.enterpriseNumber ?? party.vatNumber);
    if (n.ok) return { scheme: '0208', id: n.digits };
  }
  return null;
}

/** Local structural validation of what a Peppol BIS 3.0 invoice needs. Returns error codes; empty = payload can be built. */
export function validatePeppolReadiness(doc, { originalNumber = null, defaultBuyerReference = null } = {}) {
  const e = [];
  if (doc.type === 'quote') return ['QUOTES_ARE_NOT_E_INVOICES'];
  if (!doc.number || !doc.lockedAt) e.push('DOCUMENT_NOT_ISSUED');
  if ((doc.customer.kind ?? 'business') !== 'business') e.push('PEPPOL_NOT_APPLICABLE_TO_INDIVIDUAL_CUSTOMERS');
  if (!endpointOf(doc.seller)) e.push('SELLER_PEPPOL_ENDPOINT_UNKNOWN');
  if (!endpointOf(doc.customer)) e.push('CUSTOMER_PEPPOL_ENDPOINT_UNKNOWN');
  if (!doc.customer.buyerReference && !defaultBuyerReference) e.push('BUYER_REFERENCE_REQUIRED');
  if (!doc.seller.iban) e.push('SELLER_IBAN_MISSING');
  if (!doc.seller.vatNumber) e.push('SELLER_VAT_NUMBER_MISSING');
  if (!/^[A-Z]{3}$/.test(doc.currency ?? '')) e.push('CURRENCY_INVALID');
  if (doc.type === 'credit_note' && !originalNumber) e.push('CREDIT_NOTE_ORIGINAL_INVOICE_NUMBER_REQUIRED');
  const nonStandard = doc.totals?.lines?.some((l) => vatCategoryCode(doc.vat.regime, l.vatRateBp) !== 'S' && vatCategoryCode(doc.vat.regime, l.vatRateBp) !== 'Z');
  if (nonStandard && !doc.vat.mention) e.push('VAT_EXEMPTION_REASON_REQUIRED');
  try {
    const re = computeTotals(doc.lines);
    if (re.grossCents !== doc.totals.grossCents || re.vatCents !== doc.totals.vatCents || re.netCents !== doc.totals.netCents) e.push('TOTALS_DO_NOT_MATCH_RECOMPUTATION');
  } catch { e.push('TOTALS_NOT_COMPUTABLE'); }
  return [...new Set(e)];
}

const party = (p, tag) => {
  const ep = endpointOf(p);
  const n = normalizeBelgianNumber(p.enterpriseNumber ?? p.vatNumber);
  return `<cac:${tag}><cac:Party>
      ${ep ? `<cbc:EndpointID schemeID="${esc(ep.scheme)}">${esc(ep.id)}</cbc:EndpointID>` : ''}
      <cac:PartyName><cbc:Name>${esc(p.name)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress><cbc:StreetName>${esc(p.address?.street)}</cbc:StreetName><cbc:CityName>${esc(p.address?.city)}</cbc:CityName><cbc:PostalZone>${esc(p.address?.postalCode)}</cbc:PostalZone><cac:Country><cbc:IdentificationCode>${esc(p.address?.countryCode)}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
      ${p.vatNumber ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(p.vatNumber)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>${n.ok ? `<cbc:CompanyID schemeID="0208">${esc(n.digits)}</cbc:CompanyID>` : ''}</cac:PartyLegalEntity>
    </cac:Party></cac:${tag}>`;
};

/** Build the UBL 2.1 document (Invoice or CreditNote). Call validatePeppolReadiness first; this does not repair anything. */
export function buildUbl(doc, { originalNumber = null, defaultBuyerReference = null, unitCode = 'C62' } = {}) {
  const cn = doc.type === 'credit_note';
  const root = cn ? 'CreditNote' : 'Invoice';
  const ns = cn ? 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2' : 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
  const cur = doc.currency;
  const lineTag = cn ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = cn ? 'CreditedQuantity' : 'InvoicedQuantity';
  const taxCat = (regime, bp) => {
    const code = vatCategoryCode(regime, bp);
    return { code, percent: code === 'S' ? pct(bp) : '0.00' };
  };
  const cat = (c, reason) => `<cac:TaxCategory><cbc:ID>${c.code}</cbc:ID><cbc:Percent>${c.percent}</cbc:Percent>${c.code !== 'S' && c.code !== 'Z' && reason ? `<cbc:TaxExemptionReason>${esc(reason)}</cbc:TaxExemptionReason>` : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>`;
  const lines = doc.totals.lines.map((l) => {
    const c = taxCat(doc.vat.regime, l.vatRateBp);
    return `<cac:${lineTag}><cbc:ID>${l.position}</cbc:ID><cbc:${qtyTag} unitCode="${unitCode}">${fromScaled(l.qtyMilli, 3)}</cbc:${qtyTag}><cbc:LineExtensionAmount currencyID="${cur}">${amt(l.netCents)}</cbc:LineExtensionAmount>`
      + (l.discountCents > 0 ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount currencyID="${cur}">${amt(l.discountCents)}</cbc:Amount><cbc:BaseAmount currencyID="${cur}">${amt(l.grossCents)}</cbc:BaseAmount></cac:AllowanceCharge>` : '')
      + `<cac:Item><cbc:Name>${esc(l.description)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${c.code}</cbc:ID><cbc:Percent>${c.percent}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`
      + `<cac:Price><cbc:PriceAmount currencyID="${cur}">${fromScaled(l.priceMicro, 4)}</cbc:PriceAmount></cac:Price></cac:${lineTag}>`;
  }).join('\n  ');
  const subtotals = doc.totals.vatBreakdown.map((g) => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${cur}">${amt(g.taxableCents)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${cur}">${amt(g.vatCents)}</cbc:TaxAmount>${cat(taxCat(doc.vat.regime, g.vatRateBp), doc.vat.mention)}</cac:TaxSubtotal>`).join('');
  const buyerRef = doc.customer.buyerReference ?? (defaultBuyerReference === 'document_number' ? doc.number : defaultBuyerReference);
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${PROFILE_ID}</cbc:ProfileID>
  <cbc:ID>${esc(doc.number)}</cbc:ID>
  <cbc:IssueDate>${doc.issueDate}</cbc:IssueDate>
  ${cn ? '' : `<cbc:DueDate>${doc.dueDate}</cbc:DueDate>`}
  <cbc:${cn ? 'CreditNoteTypeCode>381</cbc:CreditNoteTypeCode' : 'InvoiceTypeCode>380</cbc:InvoiceTypeCode'}>
  ${doc.notes ? `<cbc:Note>${esc(doc.notes)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${esc(buyerRef)}</cbc:BuyerReference>
  ${cn ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(originalNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}
  ${party(doc.seller, 'AccountingSupplierParty')}
  ${party(doc.customer, 'AccountingCustomerParty')}
  <cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>${cn ? `<cbc:PaymentDueDate>${doc.dueDate}</cbc:PaymentDueDate>` : ''}<cac:PayeeFinancialAccount><cbc:ID>${esc(String(doc.seller.iban).replace(/\s/g, ''))}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
  ${doc.paymentTerms ? `<cac:PaymentTerms><cbc:Note>${esc(doc.paymentTerms)}</cbc:Note></cac:PaymentTerms>` : ''}
  <cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${amt(doc.totals.vatCents)}</cbc:TaxAmount>${subtotals}</cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${cur}">${amt(doc.totals.netCents)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="${cur}">${amt(doc.totals.netCents)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="${cur}">${amt(doc.totals.grossCents)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="${cur}">${amt(doc.totals.grossCents)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
  ${lines}
</${root}>
`;
}

/** Prepare (never send) a transmission: validate, build, and report. */
export function prepareTransmission(doc, opts = {}) {
  const errors = validatePeppolReadiness(doc, opts);
  if (errors.length) return { status: 'BLOCKED', errors, payloadXml: null, sender: null, receiver: null, transmitted: false };
  return { status: 'PREPARED', errors: [], payloadXml: buildUbl(doc, opts), sender: endpointOf(doc.seller), receiver: endpointOf(doc.customer), transmitted: false,
    note: 'Locally validated only (not the official Schematron). Submit through an approved Access Point provider.' };
}

/** The boundary a future provider implements. Nothing in the finance core knows any provider. */
export const ACCESS_POINT_ADAPTER_CONTRACT = {
  name: 'string',
  submit: 'async ({ payloadXml, sender, receiver, documentNumber }) => { providerMessageId }',
  fetchStatus: 'async (providerMessageId) => { status: one of PEPPOL_STATUSES, at: ISO string, detail?: string }',
};

export const NullAccessPointAdapter = {
  name: 'none',
  async submit() { throw new Error('NO_ACCESS_POINT_CONFIGURED: nothing is transmitted in V1; an approved provider adapter is required'); },
  async fetchStatus() { return { status: 'FAILED', detail: 'NO_ACCESS_POINT_CONFIGURED' }; },
};

/** Audit-trail event for a transmission status change reported by a provider (recorded by the service via appendEvent). */
export function transmissionEvent(documentId, merchantId, { status, at, providerMessageId = null, detail = null }) {
  if (!PEPPOL_STATUSES.includes(status)) throw new Error(`unknown peppol status ${status}`);
  return { documentId, merchantId, actor: { type: 'provider', id: 'access_point' }, action: `PEPPOL_${status}`, fromStatus: null, toStatus: null, detail: { providerMessageId, detail }, at };
}
