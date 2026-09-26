// Purchase document intelligence - Phase 1: the COMMON document model every incoming purchase document converges on
// (supplier invoice, supplier credit note, receipt / ticket, other expense proof), the structured UBL / Peppol reader, and
// the deterministic checks run on that model.
//
// Principles:
//   - Amounts are ALWAYS stored positive (integer cents). The accounting direction comes only from the document type:
//     INVOICE / RECEIPT / EXPENSE = +1 (a cost), CREDIT_NOTE = -1 (reduces the cost). Nothing ever depends on a negative stored amount.
//   - Every extracted field carries { value, confidence, source, path, page, zone }: where it was read and how sure the reader is.
//     page / zone stay null for structured XML; they are reserved for the local PDF reader of a later phase.
//   - The reader never decides and never guesses: a value that is absent stays absent, an inconsistent document is flagged,
//     and a person validates. No supplier contact is created here (contacts are matched elsewhere, and only proposed).
//   - Everything runs locally. No document leaves the server.

import { normalizeBelgianNumber } from './company.js';
import { isValidIban } from './settings.js';
import { percentToBp, toCents } from './money.js';

export const DOCUMENT_TYPES = ['INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'EXPENSE'];
/** The type of a stored record. Records written before the type existed are invoices, or receipts when they are a captured expense. */
export const documentTypeOf = (r) => (DOCUMENT_TYPES.includes(r?.documentType) ? r.documentType : r?.extraction?.capture?.kind === 'expense' ? 'RECEIPT' : 'INVOICE');
/** +1 for a cost, -1 for a supplier credit note. The ONLY place the accounting direction of a purchase document is decided. */
export const accountingSign = (r) => (documentTypeOf(r) === 'CREDIT_NOTE' ? -1 : 1);

// Belgian VAT rates in force (basis points). Another rate is not refused, only pointed out for review.
export const BE_VAT_RATES_BP = [0, 600, 1200, 2100];
const MAX_LINES = 500;

// ---------- minimal, safe XML reader ----------
// Enough for UBL: elements, attributes, text, CDATA, comments, processing instructions, the five predefined entities and
// numeric character references. A DOCTYPE (and so any entity declaration / external entity) is refused outright.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
  return ENT[e] ?? '';
});
const localName = (n) => n.slice(n.indexOf(':') + 1);

export class XmlError extends Error { constructor(code) { super(code); this.code = code; } }

/** Parse XML into { name (local, no prefix), attrs, children, text }. Throws XmlError on anything malformed or unsafe. */
export function parseXml(input) {
  const xml = String(input).replace(/^\uFEFF/, '');
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new XmlError('XML_DOCTYPE_NOT_ALLOWED');
  const root = { name: '#root', attrs: {}, children: [], text: '' }; const stack = [root]; let i = 0; let depth = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt === -1) { if (xml.slice(i).trim()) throw new XmlError('XML_TEXT_OUTSIDE_ROOT'); break; }
    if (lt > i) { const t = xml.slice(i, lt); if (stack.length > 1) top.text += decode(t); else if (t.trim()) throw new XmlError('XML_TEXT_OUTSIDE_ROOT'); }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); if (e === -1) throw new XmlError('XML_MALFORMED'); i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); if (e === -1) throw new XmlError('XML_MALFORMED'); top.text += xml.slice(lt + 9, e); i = e + 3; continue; }
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt + 2); if (e === -1) throw new XmlError('XML_MALFORMED'); i = e + 2; continue; }
    if (xml.startsWith('<!', lt)) throw new XmlError('XML_MALFORMED');
    let gt = -1; let q = null; // end of the tag, ignoring a '>' inside a quoted attribute value
    for (let j = lt + 1; j < xml.length; j += 1) { const ch = xml[j]; if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') { gt = j; break; } }
    if (gt === -1) throw new XmlError('XML_MALFORMED');
    const raw = xml.slice(lt + 1, gt);
    if (raw.startsWith('/')) {
      const name = localName(raw.slice(1).trim());
      const open = stack.pop(); depth -= 1;
      if (!open || open === root || open.name !== name) throw new XmlError('XML_MALFORMED');
      i = gt + 1; continue;
    }
    const selfClose = raw.endsWith('/');
    const m = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(selfClose ? raw.slice(0, -1) : raw);
    if (!m) throw new XmlError('XML_MALFORMED');
    const attrs = {}; const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g; let a;
    const rest = m[2]; const consumed = rest.replace(re, '');
    if (consumed.trim()) throw new XmlError('XML_MALFORMED');
    while ((a = re.exec(rest))) attrs[localName(a[1])] = decode(a[3] ?? a[4] ?? '');
    const el = { name: localName(m[1]), attrs, children: [], text: '' };
    if (stack.length === 1 && root.children.length) throw new XmlError('XML_MULTIPLE_ROOTS');
    top.children.push(el);
    if (!selfClose) { stack.push(el); depth += 1; if (depth > 64) throw new XmlError('XML_TOO_DEEP'); }
    i = gt + 1;
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new XmlError('XML_MALFORMED');
  return root.children[0];
}
const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0] ?? null;
/** Follow a path of local names ("PartyLegalEntity/RegistrationName"), always taking the first match. */
const at = (el, path) => path.split('/').reduce((e, n) => kid(e, n), el);
const txt = (el) => { const t = el?.text?.trim(); return t ? t : null; };

// ---------- UBL / Peppol reader ----------
const money = (s) => { if (s == null) return null; const c = toCents(s.trim()); return Number.isInteger(c) ? c : null; };
const rateBp = (s) => { if (s == null) return null; const b = percentToBp(s.trim()); return Number.isInteger(b) ? b : null; };
const compact = (s) => (s == null ? null : String(s).replace(/\s+/g, '').toUpperCase());

/**
 * Read a UBL 2.1 / Peppol BIS Billing 3.0 Invoice or CreditNote.
 * @returns {{ extractor: 'ubl', fields: Record<string, {value:any, confidence:number, source:string, path:string, page:null, zone:null}>, warnings: string[] }}
 */
export function extractUbl(data) {
  const warnings = []; const f = {};
  let doc;
  try { doc = parseXml(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch (e) { return { extractor: 'ubl', fields: {}, warnings: [e instanceof XmlError ? e.code : 'XML_MALFORMED'] }; }
  if (!['Invoice', 'CreditNote'].includes(doc.name)) return { extractor: 'ubl', fields: {}, warnings: ['NOT_A_UBL_INVOICE_OR_CREDIT_NOTE'] };
  const R = doc.name;
  const put = (k, value, path, confidence = 0.98) => { if (value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)) f[k] = { value, confidence, source: 'ubl', path: `${R}/${path}`, page: null, zone: null }; };

  // identity of the document
  put('invoiceNumber', txt(kid(doc, 'ID')), 'ID');
  put('issueDate', txt(kid(doc, 'IssueDate')), 'IssueDate');
  const due = txt(kid(doc, 'DueDate')); if (due) put('dueDate', due, 'DueDate'); else put('dueDate', txt(at(doc, 'PaymentMeans/PaymentDueDate')), 'PaymentMeans/PaymentDueDate', 0.95);
  put('currency', compact(txt(kid(doc, 'DocumentCurrencyCode'))), 'DocumentCurrencyCode');
  const typeCode = R === 'CreditNote' ? txt(kid(doc, 'CreditNoteTypeCode')) : txt(kid(doc, 'InvoiceTypeCode'));
  put('orderReference', txt(at(doc, 'OrderReference/ID')), 'OrderReference/ID');
  put('billingReference', txt(at(doc, 'BillingReference/InvoiceDocumentReference/ID')), 'BillingReference/InvoiceDocumentReference/ID');

  // supplier
  const party = at(doc, 'AccountingSupplierParty/Party');
  const legal = kid(party, 'PartyLegalEntity');
  const name = txt(kid(legal, 'RegistrationName')); if (name) put('supplierName', name, 'AccountingSupplierParty/Party/PartyLegalEntity/RegistrationName'); else put('supplierName', txt(at(party, 'PartyName/Name')), 'AccountingSupplierParty/Party/PartyName/Name', 0.95);
  const schemes = kids(party, 'PartyTaxScheme');
  const vatScheme = schemes.find((s) => compact(txt(at(s, 'TaxScheme/ID'))) === 'VAT') ?? schemes[0];
  put('supplierVatNumber', compact(txt(kid(vatScheme, 'CompanyID'))), 'AccountingSupplierParty/Party/PartyTaxScheme/CompanyID');
  // Belgian enterprise number: the legal registration (scheme 0208), else the Peppol endpoint / party identification under 0208.
  const legalId = kid(legal, 'CompanyID'); const endpoint = kid(party, 'EndpointID'); const pid = kids(party, 'PartyIdentification').map((p) => kid(p, 'ID')).find((x) => x?.attrs.schemeID === '0208');
  const ent = legalId && (!legalId.attrs.schemeID || legalId.attrs.schemeID === '0208') ? [legalId, 'AccountingSupplierParty/Party/PartyLegalEntity/CompanyID', 0.98]
    : endpoint?.attrs.schemeID === '0208' ? [endpoint, 'AccountingSupplierParty/Party/EndpointID', 0.95]
      : pid ? [pid, 'AccountingSupplierParty/Party/PartyIdentification/ID', 0.95] : null;
  if (ent) { const raw = txt(ent[0]); const n = normalizeBelgianNumber(raw); put('supplierEnterpriseNumber', n.ok ? n.enterpriseNumber : raw, ent[1], n.ok ? ent[2] : 0.4); }

  // postal address (kept as read: a secondary matching signal and a prefill for "create this supplier"; not stored as a column)
  const pa = kid(party, 'PostalAddress');
  if (pa) {
    const street = [txt(kid(pa, 'StreetName')), txt(kid(pa, 'AdditionalStreetName'))].filter(Boolean).join(', ') || null;
    const addr = { street, postalCode: txt(kid(pa, 'PostalZone')), city: txt(kid(pa, 'CityName')), countryCode: compact(txt(at(pa, 'Country/IdentificationCode'))) };
    if (Object.values(addr).some(Boolean)) put('supplierAddress', addr, 'AccountingSupplierParty/Party/PostalAddress', 0.95);
  }

  // payment
  const means = kids(doc, 'PaymentMeans');
  const pm = means.find((m) => kid(m, 'PayeeFinancialAccount')) ?? means[0];
  put('supplierIban', compact(txt(at(pm, 'PayeeFinancialAccount/ID'))), 'PaymentMeans/PayeeFinancialAccount/ID', 0.95);
  put('paymentReference', txt(kid(pm, 'PaymentID')), 'PaymentMeans/PaymentID', 0.9);

  // totals
  const cur = f.currency?.value ?? null;
  const totals = kid(doc, 'LegalMonetaryTotal');
  // A document may carry a second TaxTotal in the tax currency: take the one in the document currency.
  const taxTotals = kids(doc, 'TaxTotal');
  const taxTotal = taxTotals.find((t) => kid(t, 'TaxAmount')?.attrs.currencyID === cur) ?? taxTotals[0] ?? null;
  const amounts = { netCents: money(txt(kid(totals, 'TaxExclusiveAmount'))), grossCents: money(txt(kid(totals, 'TaxInclusiveAmount'))), vatCents: money(txt(kid(taxTotal, 'TaxAmount'))),
    lineExtensionCents: money(txt(kid(totals, 'LineExtensionAmount'))), payableCents: money(txt(kid(totals, 'PayableAmount'))) };
  const paths = { netCents: 'LegalMonetaryTotal/TaxExclusiveAmount', grossCents: 'LegalMonetaryTotal/TaxInclusiveAmount', vatCents: 'TaxTotal/TaxAmount', lineExtensionCents: 'LegalMonetaryTotal/LineExtensionAmount', payableCents: 'LegalMonetaryTotal/PayableAmount' };

  // document type: a CreditNote root, or an Invoice with type code 381, is a credit note. An Invoice whose totals are all
  // negative is a credit note written as a negative invoice: amounts are read as positive, the type is proposed, both flagged.
  let type = R === 'CreditNote' || typeCode === '381' ? 'CREDIT_NOTE' : 'INVOICE'; let typeConfidence = 0.98;
  const headline = [amounts.netCents, amounts.grossCents].filter((v) => v !== null);
  const negative = headline.length > 0 && headline.every((v) => v < 0);
  if (negative) {
    if (type === 'INVOICE') { type = 'CREDIT_NOTE'; typeConfidence = 0.5; warnings.push('NEGATIVE_INVOICE_READ_AS_CREDIT_NOTE'); } else warnings.push('NEGATIVE_AMOUNTS_ON_CREDIT_NOTE');
  }
  const sign = negative ? -1 : 1;
  for (const [k, v] of Object.entries(amounts)) if (v !== null) put(k, v * sign, paths[k], negative ? 0.5 : 0.98);
  put('documentType', type, R === 'CreditNote' ? 'CreditNoteTypeCode' : 'InvoiceTypeCode', typeConfidence);

  // VAT broken down by rate
  const breakdown = kids(taxTotal, 'TaxSubtotal').map((s) => ({
    taxableCents: money(txt(kid(s, 'TaxableAmount'))) === null ? null : money(txt(kid(s, 'TaxableAmount'))) * sign,
    vatCents: money(txt(kid(s, 'TaxAmount'))) === null ? null : money(txt(kid(s, 'TaxAmount'))) * sign,
    rateBp: rateBp(txt(at(s, 'TaxCategory/Percent'))), category: txt(at(s, 'TaxCategory/ID')), exemptionReason: txt(at(s, 'TaxCategory/TaxExemptionReason')),
  }));
  put('vatBreakdown', breakdown, 'TaxTotal/TaxSubtotal', 0.98);

  // lines
  const lineName = R === 'CreditNote' ? 'CreditNoteLine' : 'InvoiceLine'; const qtyName = R === 'CreditNote' ? 'CreditedQuantity' : 'InvoicedQuantity';
  const rawLines = kids(doc, lineName);
  if (rawLines.length > MAX_LINES) warnings.push('TOO_MANY_LINES_TRUNCATED');
  const lines = rawLines.slice(0, MAX_LINES).map((l, idx) => {
    const q = kid(l, qtyName); const net = money(txt(kid(l, 'LineExtensionAmount')));
    return { position: idx + 1, id: txt(kid(l, 'ID')), description: txt(at(l, 'Item/Name')) ?? txt(at(l, 'Item/Description')), quantity: txt(q), unitCode: q?.attrs.unitCode ?? null,
      unitPrice: txt(at(l, 'Price/PriceAmount')), netCents: net === null ? null : net * sign, rateBp: rateBp(txt(at(l, 'Item/ClassifiedTaxCategory/Percent'))), category: txt(at(l, 'Item/ClassifiedTaxCategory/ID')) };
  });
  put('lines', lines, lineName, 0.98);

  return { extractor: 'ubl', fields: f, warnings };
}

// ---------- deterministic checks on the common model ----------
/** A stored record as the common model: its type, plus the totals read from the document that are kept only in the provenance. */
export const purchaseModelOf = (r) => { const pv = r?.extraction?.provenance ?? {}; return { ...r, documentType: r?.documentType ?? null, lineExtensionCents: pv.lineExtensionCents?.value ?? null, payableCents: pv.payableCents?.value ?? null }; };
const isInt = Number.isInteger;
const sumOf = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
const isBelgian = (s) => /^BE/i.test(String(s ?? '').replace(/\s+/g, ''));

/**
 * Checks on a purchase document record (flat fields + documentType + vatBreakdown + lines).
 * `errors` block validation (a person must correct them); `warnings` are shown for review and never block.
 * Each finding names the fields it concerns, so their confidence can be lowered.
 */
export function checkPurchaseDocument(r) {
  const errors = []; const warnings = []; const fieldsAffected = new Set();
  const err = (code, ...fields) => { errors.push(code); fields.forEach((x) => fieldsAffected.add(x)); };
  const warn = (code, ...fields) => { warnings.push(code); fields.forEach((x) => fieldsAffected.add(x)); };

  if (r.documentType != null && !DOCUMENT_TYPES.includes(r.documentType)) err('DOCUMENT_TYPE_INVALID', 'documentType');
  if (r.supplierIban && !isValidIban(r.supplierIban)) err('SUPPLIER_IBAN_INVALID', 'supplierIban');
  if (r.supplierEnterpriseNumber && !normalizeBelgianNumber(r.supplierEnterpriseNumber).ok) err('SUPPLIER_ENTERPRISE_NUMBER_INVALID', 'supplierEnterpriseNumber');
  // Only a Belgian VAT number can be checked (mod 97); a foreign one is kept as written.
  if (r.supplierVatNumber && isBelgian(r.supplierVatNumber) && !normalizeBelgianNumber(r.supplierVatNumber).ok) err('SUPPLIER_VAT_NUMBER_INVALID', 'supplierVatNumber');
  if (r.supplierVatNumber && r.supplierEnterpriseNumber && isBelgian(r.supplierVatNumber)) {
    const v = normalizeBelgianNumber(r.supplierVatNumber); const e = normalizeBelgianNumber(r.supplierEnterpriseNumber);
    if (v.ok && e.ok && v.digits !== e.digits) warn('VAT_AND_ENTERPRISE_NUMBER_DIFFER', 'supplierVatNumber', 'supplierEnterpriseNumber');
  }

  const bd = Array.isArray(r.vatBreakdown) ? r.vatBreakdown : [];
  if (bd.length) {
    const complete = bd.every((b) => isInt(b.taxableCents) && isInt(b.vatCents));
    if (!complete) warn('VAT_BREAKDOWN_INCOMPLETE', 'vatBreakdown');
    else {
      if (isInt(r.netCents) && sumOf(bd, 'taxableCents') !== r.netCents) warn('VAT_BREAKDOWN_TAXABLE_DOES_NOT_MATCH_NET', 'vatBreakdown', 'netCents');
      if (isInt(r.vatCents) && sumOf(bd, 'vatCents') !== r.vatCents) warn('VAT_BREAKDOWN_DOES_NOT_MATCH_VAT', 'vatBreakdown', 'vatCents');
      // per rate: VAT = taxable x rate, rounded to the cent; one cent of rounding either way is accepted
      if (bd.some((b) => isInt(b.rateBp) && Math.abs(Math.round((b.taxableCents * b.rateBp) / 10000) - b.vatCents) > 1)) warn('VAT_RATE_AMOUNT_MISMATCH', 'vatBreakdown');
    }
    if (bd.some((b) => b.taxableCents < 0 || b.vatCents < 0)) err('VAT_BREAKDOWN_NEGATIVE', 'vatBreakdown');
    if (isBelgian(r.supplierVatNumber) && bd.some((b) => isInt(b.rateBp) && !BE_VAT_RATES_BP.includes(b.rateBp))) warn('VAT_RATE_UNUSUAL_FOR_BELGIUM', 'vatBreakdown');
  }

  const lines = Array.isArray(r.lines) ? r.lines : [];
  if (lines.length && lines.every((l) => isInt(l.netCents))) {
    const target = isInt(r.lineExtensionCents) ? r.lineExtensionCents : null;
    if (target !== null && sumOf(lines, 'netCents') !== target) warn('LINES_DO_NOT_ADD_UP', 'lines');
  }

  if (isInt(r.payableCents) && isInt(r.grossCents) && r.payableCents !== r.grossCents) warn('PAYABLE_DIFFERS_FROM_TOTAL', 'grossCents');
  if (documentTypeOf(r) === 'CREDIT_NOTE' && !r.billingReference) warn('CREDIT_NOTE_WITHOUT_INVOICE_REFERENCE', 'billingReference');
  return { errors, warnings, fieldsAffected: [...fieldsAffected] };
}

/**
 * Extract + check in one step: the confidence of every field concerned by a finding is lowered (never raised), so the review
 * screen can point at it. Also keeps the historical TOTALS_DO_NOT_ADD_UP rule (net + VAT = total).
 */
export function readUblDocument(data) {
  const ex = extractUbl(data); const f = ex.fields; const warnings = [...ex.warnings];
  if (!Object.keys(f).length) return ex;
  const flat = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
  const lower = (k, c) => { if (f[k]) f[k].confidence = Math.min(f[k].confidence, c); };
  if (isInt(flat.netCents) && isInt(flat.vatCents) && isInt(flat.grossCents) && flat.netCents + flat.vatCents !== flat.grossCents) { warnings.push('TOTALS_DO_NOT_ADD_UP'); for (const k of ['netCents', 'vatCents', 'grossCents']) lower(k, 0.4); }
  // The model checks themselves are recomputed on every read (they follow the person's corrections); here they only lower confidence.
  for (const k of checkPurchaseDocument(flat).fieldsAffected) lower(k, 0.5);
  return { extractor: 'ubl', fields: f, warnings: [...new Set(warnings)] };
}
