// Server-side validation and sanitising of everything the browser sends. The browser is never trusted: only whitelisted keys
// survive (no mass assignment of id / status / number / totals / merchantId), text is stripped of control characters and capped,
// numbers must match strict decimal patterns, and identifiers must look like identifiers. This is SHAPE validation; the finance
// engine remains the only authority for amounts, VAT and lifecycle rules.

import { normalizeBelgianNumber } from './company.js';
import { REVENUE_BASES } from './document.js';
import { sanitizeText } from './settings.js';
import { VAT_REGIMES } from './vat.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUIDISH = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/;
const QTY = /^\d{1,9}(\.\d{1,3})?$/;
const PRICE = /^\d{1,9}(\.\d{1,4})?$/;
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;
const isDate = (s) => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Decimal input as a string, or null when it is not a plain non-negative decimal of the allowed precision. */
function decimal(v, re) {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(',', '.');
  return re.test(s) ? s : null;
}

export function cleanAddress(a, errors, prefix) {
  const out = { street: null, postalCode: null, city: null, countryCode: null };
  if (!plain(a)) return out;
  out.street = sanitizeText(a.street, 120); out.postalCode = sanitizeText(a.postalCode, 20); out.city = sanitizeText(a.city, 80);
  out.countryCode = sanitizeText(a.countryCode, 2)?.toUpperCase() ?? null;
  if (out.countryCode && !/^[A-Z]{2}$/.test(out.countryCode)) errors.push({ field: `${prefix}.countryCode`, code: 'COUNTRY_CODE_INVALID' });
  return out;
}

/** Company identity fields shared by the directory and the invoice customer block. */
export function cleanCompany(c, errors, prefix = 'customer', { identityFromDirectory = false } = {}) {
  if (!plain(c)) { errors.push({ field: prefix, code: 'REQUIRED' }); return {}; }
  const out = { kind: c.kind === 'individual' ? 'individual' : 'business', name: sanitizeText(c.name, 120), address: cleanAddress(c.address, errors, `${prefix}.address`) };
  // With a directory company id the identity (name, numbers, address) is loaded server-side, so the client need not send it.
  if (!out.name && !(identityFromDirectory && typeof c.companyId === 'string')) errors.push({ field: `${prefix}.name`, code: 'REQUIRED' });
  for (const k of ['vatNumber', 'enterpriseNumber']) {
    const raw = sanitizeText(c[k], 30);
    if (!raw) continue;
    const n = normalizeBelgianNumber(raw);
    const belgian = out.address.countryCode === 'BE' || /^BE/i.test(raw) || k === 'enterpriseNumber';
    if (belgian) { if (!n.ok) errors.push({ field: `${prefix}.${k}`, code: `BELGIAN_NUMBER_${n.reason}` }); else { out[k] = k === 'vatNumber' ? n.vatNumber : n.enterpriseNumber; out.peppolId = n.peppolId; } }
    else out[k] = raw.toUpperCase();
  }
  const email = sanitizeText(c.email, 200);
  if (email) { if (EMAIL.test(email)) out.email = email; else errors.push({ field: `${prefix}.email`, code: 'EMAIL_INVALID' }); }
  const ref = sanitizeText(c.buyerReference, 60);
  if (ref) out.buyerReference = ref;
  if (c.companyId != null) { if (typeof c.companyId === 'string' && UUIDISH.test(c.companyId)) out.companyId = c.companyId; else errors.push({ field: `${prefix}.companyId`, code: 'ID_INVALID' }); }
  return out;
}

/** Traceability reference to the Retail Core product/variant a line was picked from. Copied data only; never looked up again. */
export function cleanCatalogRef(c) {
  if (!plain(c) || c.source !== 'retail_core') return null;
  const id = (v) => { const t = sanitizeText(v, 64); return t && /^[A-Za-z0-9_-]{8,64}$/.test(t) ? t : null; };
  const out = { source: 'retail_core', productId: id(c.productId), variantId: id(c.variantId), productTitle: sanitizeText(c.productTitle, 200), variantTitle: sanitizeText(c.variantTitle, 200), sku: sanitizeText(c.sku, 80) };
  if (!out.productId || !out.variantId) return null;
  if (plain(c.priceSnapshot)) { const amount = sanitizeText(c.priceSnapshot.amount, 20); if (amount && /^\d+(\.\d{1,4})?$/.test(amount)) out.priceSnapshot = { amount, taxesIncluded: c.priceSnapshot.taxesIncluded === true, at: sanitizeText(c.priceSnapshot.at, 40) }; }
  return out;
}

/** Validate the line editor rows. Returns the cleaned lines, or null (with errors recorded) when the array itself is unusable. */
export function cleanLines(rawLines, errors) {
  const e = (field, code) => errors.push({ field, code });
  if (!Array.isArray(rawLines) || rawLines.length === 0) { e('lines', 'AT_LEAST_ONE_LINE_REQUIRED'); return null; }
  if (rawLines.length > 100) { e('lines', 'TOO_MANY_LINES'); return null; }
  return rawLines.map((l, i) => {
    const p = `lines[${i}]`;
    if (!plain(l)) { e(p, 'LINE_INVALID'); return {}; }
    const line = { description: sanitizeText(l.description, 500), unit: sanitizeText(l.unit, 20), sku: sanitizeText(l.sku, 80), catalog: cleanCatalogRef(l.catalog) };
    if (!line.description) e(`${p}.description`, 'REQUIRED');
    line.quantity = decimal(l.quantity, QTY); if (line.quantity === null) e(`${p}.quantity`, 'QUANTITY_INVALID');
    if (l.priceOrigin === 'GROSS_CATALOGUE') {
      // the catalogue price incl. VAT is authoritative; the ex-VAT price is derived by the finance engine
      line.priceOrigin = 'GROSS_CATALOGUE';
      line.grossUnitPrice = decimal(l.grossUnitPrice, PRICE); if (line.grossUnitPrice === null) e(`${p}.grossUnitPrice`, 'GROSS_PRICE_INVALID');
      if (l.grossVatRate != null && l.grossVatRate !== '') { line.grossVatRate = decimal(l.grossVatRate, PERCENT); if (line.grossVatRate === null) e(`${p}.grossVatRate`, 'VAT_RATE_INVALID'); }
    } else {
      line.unitPrice = decimal(l.unitPrice, PRICE); if (line.unitPrice === null) e(`${p}.unitPrice`, 'UNIT_PRICE_INVALID');
    }
    line.vatRate = decimal(l.vatRate, PERCENT); if (line.vatRate === null) e(`${p}.vatRate`, 'VAT_RATE_INVALID');
    if (l.discountPercent != null && l.discountPercent !== '') { line.discountPercent = decimal(l.discountPercent, PERCENT); if (line.discountPercent === null) e(`${p}.discountPercent`, 'DISCOUNT_INVALID'); }
    if (l.discountAmount != null && l.discountAmount !== '') { line.discountAmount = decimal(l.discountAmount, MONEY); if (line.discountAmount === null) e(`${p}.discountAmount`, 'DISCOUNT_INVALID'); }
    return line;
  });
}

/** VAT treatment block: regime must be a known one; the merchant confirmation is an explicit boolean. */
export function cleanVat(v, errors) {
  const x = plain(v) ? v : {};
  if (x.regime != null && !VAT_REGIMES[x.regime]) errors.push({ field: 'vat.regime', code: 'VAT_REGIME_UNKNOWN' });
  return { regime: VAT_REGIMES[x.regime] ? x.regime : null, confirmed: x.confirmed === true, mention: sanitizeText(x.mention, 300) };
}

/** @returns {{input: object, errors: Array<{field: string, code: string}>}} */
export function cleanDocumentInput(body) {
  const errors = [];
  const e = (field, code) => errors.push({ field, code });
  const b = plain(body) ? body : {};
  const input = {};
  if (!['quote', 'invoice'].includes(b.type)) e('type', 'TYPE_MUST_BE_QUOTE_OR_INVOICE'); else input.type = b.type;
  input.customer = cleanCompany(b.customer, errors, 'customer', { identityFromDirectory: true });
  for (const k of ['issueDate', 'dueDate', 'validUntil']) { if (b[k] == null || b[k] === '') continue; if (isDate(b[k])) input[k] = b[k]; else e(k, 'DATE_INVALID'); }
  if (b.paymentTermsDays != null && b.paymentTermsDays !== '') { const n = Number(b.paymentTermsDays); if (Number.isInteger(n) && n >= 0 && n <= 365) input.paymentTermsDays = n; else e('paymentTermsDays', 'PAYMENT_TERMS_INVALID'); }
  input.paymentTerms = sanitizeText(b.paymentTerms, 500);
  input.notes = sanitizeText(b.notes, 2000);
  if (b.currency != null) { const c = sanitizeText(b.currency, 3)?.toUpperCase(); if (c && /^[A-Z]{3}$/.test(c)) input.currency = c; else e('currency', 'CURRENCY_INVALID'); }
  if (b.language != null) { if (['fr', 'nl', 'en'].includes(b.language)) input.language = b.language; else e('language', 'LANGUAGE_INVALID'); }
  input.vat = cleanVat(b.vat, errors);
  if (b.revenueBasis != null) { if (REVENUE_BASES.includes(b.revenueBasis)) input.revenueBasis = b.revenueBasis; else e('revenueBasis', 'REVENUE_BASIS_INVALID'); }
  if (b.sourceOrderId != null && b.sourceOrderId !== '') { if (typeof b.sourceOrderId === 'string' && UUIDISH.test(b.sourceOrderId)) input.sourceOrderId = b.sourceOrderId; else e('sourceOrderId', 'ID_INVALID'); }
  input.acknowledgedNotDuplicate = b.acknowledgedNotDuplicate === true;

  const cleaned = cleanLines(b.lines, errors);
  if (cleaned) input.lines = cleaned;
  return { input, errors };
}

export function cleanPaymentInput(b) {
  const errors = [];
  const p = plain(b) ? b : {};
  const amount = decimal(p.amount, MONEY);
  if (amount === null && !(typeof p.amount === 'string' && /^-\d{1,9}(\.\d{1,2})?$/.test(p.amount.trim()))) errors.push({ field: 'amount', code: 'AMOUNT_INVALID' });
  if (!isDate(p.paidOn)) errors.push({ field: 'paidOn', code: 'DATE_INVALID' });
  const method = sanitizeText(p.method, 40);
  const METHODS = ['bank_transfer', 'cash', 'card', 'other'];
  if (method && !METHODS.includes(method)) errors.push({ field: 'method', code: 'METHOD_INVALID' });
  return { errors, payment: { amount: amount ?? String(p.amount ?? '').trim(), paidOn: p.paidOn, method: method ?? 'other', reference: sanitizeText(p.reference, 100) ?? undefined }, note: sanitizeText(p.note, 300) };
}

export { isDate };
