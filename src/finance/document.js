// Deterministic document engine for quotes, invoices and credit notes. Pure functions: every transition returns a
// NEW document and an audit event, never mutates its input, and a locked (issued / sent) document is deep-frozen.
// All amounts are integers (see money.js). No language model calculates or judges anything here.

import { createHash, randomUUID } from 'node:crypto';
import { fromScaled, lineGrossCents, percentOfCents, toCents, toPriceMicro, toQtyMilli, percentToBp } from './money.js';
import { validateVat, vatBreakdown, VAT_REGIMES } from './vat.js';

export const DOC_TYPES = ['quote', 'invoice', 'credit_note'];
export const REVENUE_BASES = ['linked_source_order', 'standalone_b2b'];

export class FinanceError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail ?? null; }
}

// ---------- helpers ----------
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
const clone = (o) => structuredClone(o);

// ---------- lines and totals ----------
/**
 * Normalise a human line { description, quantity, unitPrice, discountPercent?, discountAmount?, vatRate } (decimal strings or
 * numbers, VAT and discount in percent) into integers. Inputs with too many decimals are rejected, never rounded.
 */
export function normalizeLine(input, position) {
  const errors = [];
  const qtyMilli = toQtyMilli(input.quantity);
  const priceMicro = toPriceMicro(input.unitPrice);
  if (qtyMilli === null || qtyMilli <= 0) errors.push(`LINE_${position}_QUANTITY_INVALID`);
  if (priceMicro === null || priceMicro < 0) errors.push(`LINE_${position}_UNIT_PRICE_INVALID`);
  if (!input.description || !String(input.description).trim()) errors.push(`LINE_${position}_DESCRIPTION_MISSING`);
  const discountBp = input.discountPercent == null ? 0 : percentToBp(input.discountPercent);
  const discountCents = input.discountAmount == null ? 0 : toCents(input.discountAmount);
  if (discountBp === null || discountBp < 0 || discountBp > 10000) errors.push(`LINE_${position}_DISCOUNT_PERCENT_INVALID`);
  if (discountCents === null || discountCents < 0) errors.push(`LINE_${position}_DISCOUNT_AMOUNT_INVALID`);
  if (discountBp > 0 && discountCents > 0) errors.push(`LINE_${position}_DISCOUNT_PERCENT_AND_AMOUNT_BOTH_SET`);
  const vatRateBp = input.vatRate == null ? null : percentToBp(input.vatRate);
  return {
    line: { position, description: String(input.description ?? '').trim(), qtyMilli, priceMicro, discountBp: discountBp ?? 0, discountCents: discountCents ?? 0, vatRateBp, unit: input.unit ?? null, sku: input.sku ?? null },
    errors,
  };
}

/** Compute one line's amounts. Discount is taken off the rounded line gross; net can never be negative. */
export function computeLine(l) {
  const gross = lineGrossCents(l.qtyMilli, l.priceMicro);
  const discount = l.discountBp > 0 ? percentOfCents(gross, l.discountBp) : l.discountCents;
  if (discount > gross) throw new FinanceError('DISCOUNT_EXCEEDS_LINE_AMOUNT', `line ${l.position}`);
  return { grossCents: gross, discountCents: discount, netCents: gross - discount };
}

/** Deterministic totals: lines -> per-rate VAT (rounded once per rate group) -> document totals. */
export function computeTotals(lines) {
  const computed = lines.map((l) => ({ ...l, ...computeLine(l) }));
  const breakdown = vatBreakdown(computed.map((l) => ({ netCents: l.netCents, vatRateBp: l.vatRateBp })));
  const netCents = computed.reduce((a, l) => a + l.netCents, 0);
  const vatCents = breakdown.reduce((a, g) => a + g.vatCents, 0);
  return {
    lines: computed, vatBreakdown: breakdown,
    grossBeforeDiscountCents: computed.reduce((a, l) => a + l.grossCents, 0),
    discountCents: computed.reduce((a, l) => a + l.discountCents, 0),
    netCents, vatCents, grossCents: netCents + vatCents,
  };
}

// ---------- creation ----------
/**
 * Create a DRAFT. Returns { doc, errors } where errors are input-shape problems (not issuance validation).
 * @param {object} p type, merchantId, customer, lines[], currency, language, issueDate?, dueDate?, paymentTermsDays?, paymentTerms?, notes?,
 *   vat{regime, confirmed, mention}, revenueBasis?, sourceOrderId?, validUntil?
 */
export function createDraft(p) {
  const errors = [];
  if (!DOC_TYPES.includes(p.type)) errors.push('DOC_TYPE_INVALID');
  const lines = [];
  (p.lines ?? []).forEach((input, i) => { const r = normalizeLine(input, i + 1); lines.push(r.line); errors.push(...r.errors); });
  const doc = {
    id: p.id ?? null, merchantId: p.merchantId, type: p.type, status: 'DRAFT', number: null,
    currency: p.currency ?? null, language: p.language ?? 'fr', issueDate: p.issueDate ?? null, dueDate: p.dueDate ?? null, validUntil: p.validUntil ?? null,
    paymentTermsDays: p.paymentTermsDays ?? null, paymentTerms: p.paymentTerms ?? null, notes: p.notes ?? null,
    customer: clone(p.customer ?? {}), seller: p.seller ? clone(p.seller) : null, lines,
    vat: { regime: p.vat?.regime ?? null, confirmed: p.vat?.confirmed === true, mention: p.vat?.mention ?? null },
    revenueBasis: p.revenueBasis ?? null, sourceOrderId: p.sourceOrderId ?? null, acknowledgedNotDuplicate: p.acknowledgedNotDuplicate === true,
    relatedDocumentId: p.relatedDocumentId ?? null, creditReason: p.creditReason ?? null, convertedInvoiceId: null,
    lockedAt: null, snapshotHash: null, totals: null, version: 1,
  };
  if (doc.paymentTermsDays != null && !doc.dueDate && doc.issueDate && isDate(doc.issueDate)) doc.dueDate = addDays(doc.issueDate, doc.paymentTermsDays);
  const ok = lines.every((l) => l.qtyMilli !== null && l.priceMicro !== null && l.qtyMilli > 0 && l.priceMicro >= 0 && l.discountBp >= 0 && l.discountCents >= 0);
  if (ok && lines.length && lines.every((l) => l.vatRateBp !== null)) { try { doc.totals = computeTotals(lines); } catch (e) { errors.push(e.code ?? 'TOTALS_FAILED'); } }
  return { doc, errors };
}

const COMMERCIAL = ['type', 'number', 'currency', 'language', 'issueDate', 'dueDate', 'validUntil', 'paymentTermsDays', 'paymentTerms', 'notes', 'customer', 'seller', 'lines', 'vat', 'revenueBasis', 'sourceOrderId', 'relatedDocumentId', 'creditReason'];

/** The canonical commercial content that is hashed at lock time. Lifecycle fields (status, payments) are excluded on purpose. */
export function snapshotOf(doc) {
  const s = Object.fromEntries(COMMERCIAL.map((k) => [k, doc[k] ?? null]));
  s.totals = doc.totals ? { netCents: doc.totals.netCents, vatCents: doc.totals.vatCents, grossCents: doc.totals.grossCents, vatBreakdown: doc.totals.vatBreakdown } : null;
  return canon(s);
}
/** The exact string that is hashed. The database hashes the same string (with the number substituted) inside the issue transaction. */
export const canonicalSnapshot = (doc) => JSON.stringify(snapshotOf(doc));
export const hashSnapshot = (doc) => createHash('sha256').update(canonicalSnapshot(doc)).digest('hex');
/** A unique stand-in for the document number while the number is being allocated atomically by the store. */
export const makeNumberPlaceholder = () => `__FIN_NUMBER_${randomUUID()}__`;
export function verifyIntegrity(doc) { return doc.lockedAt ? { ok: hashSnapshot(doc) === doc.snapshotHash } : { ok: true, note: 'not locked' }; }

/** Edit a draft. Locked documents can never be edited: use a credit note (invoice) or a new revision (quote). */
export function updateDraft(doc, patch) {
  if (doc.lockedAt) throw new FinanceError('DOCUMENT_LOCKED', `${doc.type} ${doc.number ?? ''} is ${doc.status}: issued documents are immutable; use a credit note or a new document`);
  if (doc.status !== 'DRAFT') throw new FinanceError('ONLY_DRAFT_CAN_BE_EDITED', doc.status);
  const merged = { ...clone(doc), ...clone(patch) };
  const { doc: rebuilt, errors } = createDraft({ ...merged, lines: patch.lines ?? doc.lines.map(lineToInput), customer: merged.customer, vat: merged.vat, id: doc.id });
  return { doc: { ...rebuilt, version: doc.version }, errors };
}
const lineToInput = (l) => ({
  description: l.description, quantity: fromScaled(l.qtyMilli, 3), unitPrice: fromScaled(l.priceMicro, 4),
  discountPercent: l.discountBp ? fromScaled(l.discountBp, 2) : undefined, discountAmount: l.discountCents ? fromScaled(l.discountCents, 2) : undefined,
  vatRate: fromScaled(l.vatRateBp, 2), unit: l.unit, sku: l.sku,
});

// ---------- issuance validation ----------
const REQUIRED_ADDRESS = ['street', 'postalCode', 'city', 'countryCode'];
/**
 * Everything that must be true before a document may be issued (invoice / credit note) or sent (quote).
 * Returns error codes; an empty list means it is valid. Nothing is auto-corrected.
 */
export function validateForIssue(doc, ctx = {}) {
  const e = [];
  if (!doc.merchantId) e.push('MERCHANT_MISSING');
  if (!/^[A-Z]{3}$/.test(doc.currency ?? '')) e.push('CURRENCY_INVALID');
  if (!doc.lines?.length) e.push('NO_LINES');
  if (!doc.totals) e.push('TOTALS_NOT_COMPUTABLE');
  if (!isDate(doc.issueDate)) e.push('ISSUE_DATE_MISSING_OR_INVALID');
  const c = doc.customer ?? {};
  if (!c.name || !String(c.name).trim()) e.push('CUSTOMER_NAME_MISSING');
  for (const k of REQUIRED_ADDRESS) if (!c.address?.[k]) e.push(`CUSTOMER_ADDRESS_${k.toUpperCase()}_MISSING`);
  if ((c.kind ?? 'business') === 'business' && !c.vatNumber && !c.enterpriseNumber) e.push('CUSTOMER_COMPANY_NUMBER_MISSING');
  const s = doc.seller ?? {};
  if (!s.name) e.push('SELLER_NAME_MISSING');
  for (const k of REQUIRED_ADDRESS) if (!s.address?.[k]) e.push(`SELLER_ADDRESS_${k.toUpperCase()}_MISSING`);
  if (doc.type !== 'quote') {
    if (!doc.dueDate || !isDate(doc.dueDate)) e.push('DUE_DATE_MISSING_OR_INVALID');
    else if (isDate(doc.issueDate) && doc.dueDate < doc.issueDate) e.push('DUE_DATE_BEFORE_ISSUE_DATE');
    if (!REVENUE_BASES.includes(doc.revenueBasis)) e.push('REVENUE_BASIS_NOT_DECLARED');
    if (doc.revenueBasis === 'linked_source_order' && !doc.sourceOrderId) e.push('LINKED_BASIS_WITHOUT_SOURCE_ORDER');
    if (doc.revenueBasis === 'standalone_b2b' && doc.sourceOrderId) e.push('STANDALONE_BASIS_WITH_SOURCE_ORDER');
    if (!s.iban && !doc.paymentTerms) e.push('PAYMENT_INSTRUCTIONS_MISSING');
  } else if (doc.validUntil && (!isDate(doc.validUntil) || (isDate(doc.issueDate) && doc.validUntil < doc.issueDate))) e.push('VALID_UNTIL_INVALID');
  if (doc.type === 'credit_note') {
    if (!doc.relatedDocumentId) e.push('CREDIT_NOTE_WITHOUT_ORIGINAL_INVOICE');
    if (!doc.creditReason) e.push('CREDIT_REASON_MISSING');
  }
  e.push(...validateVat({ regime: doc.vat.regime, regimeConfirmed: doc.vat.confirmed, lines: doc.lines, customer: c, mention: doc.vat.mention, vatConfig: ctx.vatConfig, sellerVatNumber: s.vatNumber }));
  if (doc.vat.regime && !VAT_REGIMES[doc.vat.regime]) e.push('VAT_REGIME_UNKNOWN');
  return [...new Set(e)];
}

// ---------- lifecycle ----------
const ev = (doc, action, from, to, actor, detail = {}) => ({ documentId: doc.id, merchantId: doc.merchantId, at: detail.at ?? null, actor, action, fromStatus: from, toStatus: to, detail: { ...detail, at: undefined } });
const need = (doc, statuses, action) => { if (!statuses.includes(doc.status)) throw new FinanceError('INVALID_TRANSITION', `${action} not allowed from ${doc.status} for a ${doc.type}`); };
function lock(doc, number, at) {
  const locked = { ...clone(doc), number, lockedAt: at, version: doc.version + 1 };
  locked.snapshotHash = hashSnapshot(locked);
  return deepFreeze(locked);
}

/** Invoice / credit note: DRAFT -> READY_FOR_APPROVAL, only if fully valid. The agent may prepare; it cannot approve. */
export function submitForApproval(doc, { actor, ctx = {} }) {
  if (doc.type === 'quote') throw new FinanceError('QUOTES_HAVE_NO_APPROVAL_STEP', 'use sendQuote');
  need(doc, ['DRAFT'], 'submit');
  const errors = validateForIssue(doc, ctx);
  if (errors.length) throw new FinanceError('NOT_READY_FOR_APPROVAL', errors.join(', '));
  return { doc: { ...clone(doc), status: 'READY_FOR_APPROVAL', version: doc.version + 1 }, event: ev(doc, 'SUBMIT_FOR_APPROVAL', doc.status, 'READY_FOR_APPROVAL', actor) };
}

/**
 * The merchant's decision on a READY_FOR_APPROVAL document. APPROVE issues it (assigns the number, freezes it);
 * MODIFY returns it to DRAFT; REJECT cancels it (no number is ever consumed).
 * @param {{decision: 'APPROVE'|'MODIFY'|'REJECT', actor: {type: 'merchant', id: string}, number?: string, at: string, note?: string, ctx?: object}} p
 */
export function decide(doc, p) {
  if (doc.type === 'quote') throw new FinanceError('QUOTES_HAVE_NO_APPROVAL_STEP');
  need(doc, ['READY_FOR_APPROVAL'], 'decide');
  if (p.actor?.type !== 'merchant') throw new FinanceError('APPROVAL_REQUIRES_A_MERCHANT_ACTOR', 'an automated agent cannot approve');
  if (p.decision === 'MODIFY') return { doc: { ...clone(doc), status: 'DRAFT', version: doc.version + 1 }, event: ev(doc, 'MODIFY', doc.status, 'DRAFT', p.actor, { note: p.note ?? null, at: p.at }) };
  if (p.decision === 'REJECT') return { doc: { ...clone(doc), status: 'CANCELLED', version: doc.version + 1 }, event: ev(doc, 'REJECT', doc.status, 'CANCELLED', p.actor, { note: p.note ?? null, at: p.at }) };
  if (p.decision !== 'APPROVE') throw new FinanceError('DECISION_INVALID', String(p.decision));
  const errors = validateForIssue(doc, p.ctx);
  if (errors.length) throw new FinanceError('NOT_READY_TO_ISSUE', errors.join(', '));
  if (!p.number) throw new FinanceError('DOCUMENT_NUMBER_REQUIRED');
  const issued = lock({ ...doc, status: 'ISSUED' }, p.number, p.at);
  return { doc: issued, event: ev(doc, 'APPROVE_AND_ISSUE', doc.status, 'ISSUED', p.actor, { number: p.number, snapshotHash: issued.snapshotHash, at: p.at }) };
}

/** Records that the merchant has themselves sent the issued invoice/credit note. The system sends nothing in V1. */
export function markSent(doc, { actor, at, channel = 'manual' }) {
  if (doc.type === 'quote') throw new FinanceError('USE_SEND_QUOTE');
  need(doc, ['ISSUED'], 'markSent');
  return { doc: deepFreeze({ ...clone(doc), status: 'SENT', version: doc.version + 1 }), event: ev(doc, 'MARK_SENT', doc.status, 'SENT', actor, { channel, at }) };
}

export function cancelDraft(doc, { actor, at, reason }) {
  need(doc, ['DRAFT', 'READY_FOR_APPROVAL'], 'cancel');
  if (doc.lockedAt) throw new FinanceError('ISSUED_DOCUMENTS_CANNOT_BE_CANCELLED', 'issue a credit note instead');
  return { doc: { ...clone(doc), status: 'CANCELLED', version: doc.version + 1 }, event: ev(doc, 'CANCEL', doc.status, 'CANCELLED', actor, { reason: reason ?? null, at }) };
}

// ---------- quotes ----------
/** DRAFT quote -> SENT: numbered and locked. A quote is never accounting revenue. */
export function sendQuote(doc, { actor, number, at, ctx }) {
  if (doc.type !== 'quote') throw new FinanceError('NOT_A_QUOTE');
  need(doc, ['DRAFT'], 'sendQuote');
  const errors = validateForIssue(doc, ctx);
  if (errors.length) throw new FinanceError('QUOTE_NOT_READY', errors.join(', '));
  const sent = lock({ ...doc, status: 'SENT' }, number, at);
  return { doc: sent, event: ev(doc, 'SEND_QUOTE', doc.status, 'SENT', actor, { number, at }) };
}
const quoteStatus = (doc, to, action, allowed, actor, at) => { if (doc.type !== 'quote') throw new FinanceError('NOT_A_QUOTE'); need(doc, allowed, action); return { doc: deepFreeze({ ...clone(doc), status: to, version: doc.version + 1 }), event: ev(doc, action, doc.status, to, actor, { at }) }; };
export const acceptQuote = (doc, { actor, at }) => quoteStatus(doc, 'ACCEPTED', 'ACCEPT_QUOTE', ['SENT'], actor, at);
export const rejectQuote = (doc, { actor, at }) => quoteStatus(doc, 'REJECTED', 'REJECT_QUOTE', ['SENT'], actor, at);
export const quoteExpired = (doc, today) => doc.type === 'quote' && doc.status === 'SENT' && !!doc.validUntil && today > doc.validUntil;

/** ACCEPTED quote -> new invoice DRAFT reusing all commercial data; quote becomes CONVERTED and points at the invoice. */
export function convertQuoteToInvoice(quote, { invoiceId, actor, at, issueDate, revenueBasis = 'standalone_b2b', sourceOrderId = null }) {
  if (quote.type !== 'quote') throw new FinanceError('NOT_A_QUOTE');
  need(quote, ['ACCEPTED'], 'convert');
  if (quote.convertedInvoiceId) throw new FinanceError('QUOTE_ALREADY_CONVERTED', quote.convertedInvoiceId);
  const { doc: invoice, errors } = createDraft({
    id: invoiceId, merchantId: quote.merchantId, type: 'invoice', currency: quote.currency, language: quote.language, customer: quote.customer, seller: quote.seller,
    lines: quote.lines.map(lineToInput), vat: quote.vat, paymentTermsDays: quote.paymentTermsDays, paymentTerms: quote.paymentTerms, notes: quote.notes,
    issueDate: issueDate ?? null, relatedDocumentId: quote.id, revenueBasis, sourceOrderId,
  });
  if (errors.length) throw new FinanceError('CONVERSION_FAILED', errors.join(', '));
  if (JSON.stringify(invoice.totals.vatBreakdown) !== JSON.stringify(quote.totals.vatBreakdown) || invoice.totals.grossCents !== quote.totals.grossCents) throw new FinanceError('CONVERSION_TOTALS_DIFFER_FROM_QUOTE');
  const converted = deepFreeze({ ...clone(quote), status: 'CONVERTED', convertedInvoiceId: invoiceId, version: quote.version + 1 });
  return { invoice, quote: converted, event: ev(quote, 'CONVERT_TO_INVOICE', quote.status, 'CONVERTED', actor, { invoiceId, at }) };
}

// ---------- credit notes ----------
/** Credited gross of an invoice from its ISSUED/SENT credit notes. */
export const creditedCents = (creditNotes) => creditNotes.filter((c) => ['ISSUED', 'SENT'].includes(c.status)).reduce((a, c) => a + c.totals.grossCents, 0);

/**
 * Draft a credit note against an issued invoice. `lines` omitted = full credit. The total credited (including earlier
 * credit notes) can never exceed the invoice gross.
 */
export function creditNoteFromInvoice(invoice, { creditNoteId, reason, lines, existingCreditNotes = [], actor, at }) {
  if (invoice.type !== 'invoice') throw new FinanceError('NOT_AN_INVOICE');
  if (!invoice.lockedAt || !['ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CREDITED'].includes(invoice.status)) throw new FinanceError('ONLY_ISSUED_INVOICES_CAN_BE_CREDITED');
  const inputs = lines ?? invoice.lines.map(lineToInput);
  const { doc, errors } = createDraft({
    id: creditNoteId, merchantId: invoice.merchantId, type: 'credit_note', currency: invoice.currency, language: invoice.language, customer: invoice.customer, seller: invoice.seller,
    lines: inputs, vat: invoice.vat, paymentTermsDays: 0, issueDate: null, relatedDocumentId: invoice.id, creditReason: reason ?? null,
    revenueBasis: invoice.revenueBasis, sourceOrderId: invoice.sourceOrderId, notes: invoice.notes,
  });
  if (errors.length) throw new FinanceError('CREDIT_NOTE_INVALID', errors.join(', '));
  const remaining = invoice.totals.grossCents - creditedCents(existingCreditNotes);
  if (doc.totals.grossCents > remaining) throw new FinanceError('CREDIT_EXCEEDS_INVOICE', `credit ${doc.totals.grossCents} > creditable ${remaining} (cents)`);
  return { doc, event: ev(doc, 'CREATE_CREDIT_NOTE', null, 'DRAFT', actor, { invoiceId: invoice.id, at }) };
}

// ---------- payments and settlement ----------
/** Amounts owed on an invoice after credit notes and payments. */
export function settlement(invoice, payments, creditNotes = []) {
  const credited = creditedCents(creditNotes);
  const paid = payments.reduce((a, p) => a + p.amountCents, 0);
  const payable = Math.max(0, invoice.totals.grossCents - credited);
  return { grossCents: invoice.totals.grossCents, creditedCents: credited, payableCents: payable, paidCents: paid, remainingCents: Math.max(0, payable - paid), overpaidCents: Math.max(0, paid - payable) };
}

/** Lifecycle status implied by settlement (never OVERDUE: that is derived, see effectiveStatus). */
export function settledStatus(invoice, s) {
  if (s.creditedCents >= s.grossCents) return 'CREDITED';
  if (s.payableCents > 0 && s.remainingCents === 0) return 'PAID';
  if (s.paidCents > 0) return 'PARTIALLY_PAID';
  return invoice.status === 'PARTIALLY_PAID' || invoice.status === 'PAID' ? 'SENT' : invoice.status;
}

/** Validate and shape a manual payment. The invoice status is re-derived by the service after saving it. */
export function makePayment(invoice, payments, creditNotes, { amount, paidOn, method, reference, actor }) {
  if (invoice.type !== 'invoice') throw new FinanceError('PAYMENTS_APPLY_TO_INVOICES');
  if (!['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(invoice.status)) throw new FinanceError('INVOICE_NOT_OPEN_FOR_PAYMENT', invoice.status);
  const amountCents = toCents(amount);
  if (amountCents === null || amountCents === 0) throw new FinanceError('PAYMENT_AMOUNT_INVALID');
  if (!isDate(paidOn)) throw new FinanceError('PAYMENT_DATE_INVALID');
  if (amountCents < 0 && !reference) throw new FinanceError('CORRECTION_REQUIRES_A_REFERENCE');
  const s = settlement(invoice, payments, creditNotes);
  if (amountCents > s.remainingCents) throw new FinanceError('PAYMENT_EXCEEDS_REMAINING', `${amountCents} > ${s.remainingCents} (cents)`);
  return { documentId: invoice.id, merchantId: invoice.merchantId, amountCents, paidOn, method: method ?? 'unspecified', reference: reference ?? null, actor };
}

/** OVERDUE is derived from the due date and what remains, never stored. */
export function effectiveStatus(invoice, s, today) {
  if (['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(invoice.status) && invoice.dueDate && invoice.dueDate < today && s.remainingCents > 0) return 'OVERDUE';
  return invoice.status;
}

/** Lifecycle-only status change for an issued invoice (settlement). Commercial data and hash are untouched. */
export function applyStatus(doc, status, { actor, at, reason }) {
  if (!doc.lockedAt) throw new FinanceError('ONLY_LOCKED_DOCUMENTS_CHANGE_STATUS_THIS_WAY');
  if (doc.status === status) return { doc, event: null };
  return { doc: deepFreeze({ ...clone(doc), status, version: doc.version + 1 }), event: ev(doc, 'STATUS_CHANGE', doc.status, status, actor, { reason: reason ?? null, at }) };
}
