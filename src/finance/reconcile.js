// Bank reconciliation: SUGGESTS which bank transaction pays which invoice. Deterministic rules, integer cents, no LLM, nothing applied here.
//
// Confidence classes (each with the reasons that produced it):
//   EXACT       structured communication matches ONE open invoice AND the amount equals what is still due
//   PROBABLE    the invoice number appears in the reference (or one unique amount + counterparty match) AND the amount equals what is still due
//   PARTIAL     the reference points at ONE invoice but the amount is LESS than what is still due
//   OVERPAYMENT the reference points at ONE invoice but the amount is MORE than what is still due (nothing is recorded above what is due)
//   AMBIGUOUS   several invoices fit equally well: a person chooses
//   NO_MATCH    nothing fits
// In V1 every suggestion needs the merchant's confirmation; a future merchant setting may allow automatic recording of EXACT only.

import { structuredCommunication } from './pdf.js';

const digits = (s) => String(s ?? '').replace(/\D/g, '');
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(sa|srl|sprl|nv|bv|asbl|vzw|sc|scrl|ltd)\b/g, ' ').replace(/\s+/g, ' ').trim();
const sameName = (a, b) => { const x = norm(a).split(' ').filter((t) => t.length > 2); const y = new Set(norm(b).split(' ').filter((t) => t.length > 2)); return x.length > 0 && x.filter((t) => y.has(t)).length / x.length >= 0.6; };
const OGM = /\+{3}\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*\+{3}/;

/**
 * @param {{id: string, date: string, amountCents: number, counterpartyName?: string, reference?: string, structuredReference?: string|null}} tx a CREDIT (money in)
 * @param {Array<{documentId: string, number: string, customer: string, remainingCents: number, dueDate?: string}>} open open invoices
 */
export function suggestForCredit(tx, open) {
  const ref = String(tx.reference ?? ''); const refDigits = digits(tx.structuredReference ?? (OGM.exec(ref) ?? []).slice(1).join(''));
  const scored = open.map((inv) => {
    const reasons = []; let score = 0;
    const ogm = digits(structuredCommunication(inv.number));
    if (refDigits && ogm && refDigits === ogm) { score += 100; reasons.push('STRUCTURED_REFERENCE_MATCHES'); }
    if (inv.number && new RegExp(`(^|[^A-Za-z0-9])${inv.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(ref)) { score += 60; reasons.push('INVOICE_NUMBER_IN_REFERENCE'); }
    if (tx.amountCents === inv.remainingCents) { score += 25; reasons.push('AMOUNT_EQUALS_AMOUNT_DUE'); }
    if (sameName(inv.customer, tx.counterpartyName)) { score += 20; reasons.push('COUNTERPARTY_MATCHES_CUSTOMER'); }
    return { ...inv, score, reasons };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score || String(a.dueDate).localeCompare(String(b.dueDate)));
  if (!scored.length) return { status: 'NO_MATCH', confidence: 0, candidates: [] };
  const top = scored[0]; const tied = scored.filter((c) => c.score === top.score);
  const referenced = top.reasons.includes('STRUCTURED_REFERENCE_MATCHES') || top.reasons.includes('INVOICE_NUMBER_IN_REFERENCE');
  const candidates = scored.slice(0, 5).map((c) => ({ documentId: c.documentId, number: c.number, customer: c.customer, remainingCents: c.remainingCents, score: c.score, reasons: c.reasons }));
  if (tied.length > 1) return { status: 'AMBIGUOUS', confidence: 0.3, candidates };
  if (referenced && tx.amountCents < top.remainingCents) return { status: 'PARTIAL', confidence: 0.8, candidates, surplusCents: 0, shortfallCents: top.remainingCents - tx.amountCents };
  if (referenced && tx.amountCents > top.remainingCents) return { status: 'OVERPAYMENT', confidence: 0.7, candidates, surplusCents: tx.amountCents - top.remainingCents };
  if (top.reasons.includes('STRUCTURED_REFERENCE_MATCHES') && tx.amountCents === top.remainingCents) return { status: 'EXACT', confidence: 1, candidates };
  if (referenced && tx.amountCents === top.remainingCents) return { status: 'PROBABLE', confidence: 0.9, candidates };
  if (top.reasons.includes('AMOUNT_EQUALS_AMOUNT_DUE') && top.reasons.includes('COUNTERPARTY_MATCHES_CUSTOMER')) return { status: 'PROBABLE', confidence: 0.75, candidates };
  return { status: 'AMBIGUOUS', confidence: 0.3, candidates };
}

/** Supplier side: a DEBIT that matches a supplier invoice waiting to be paid (payment reference, else exact amount + supplier name). */
export function suggestForDebit(tx, payables) {
  const abs = Math.abs(tx.amountCents); const refDigits = digits(tx.structuredReference ?? (OGM.exec(String(tx.reference ?? '')) ?? []).slice(1).join(''));
  const scored = payables.map((p) => {
    const reasons = []; let score = 0;
    if (refDigits && digits(p.paymentReference) === refDigits) { score += 100; reasons.push('PAYMENT_REFERENCE_MATCHES'); }
    if (p.invoiceNumber && String(tx.reference ?? '').includes(p.invoiceNumber)) { score += 60; reasons.push('INVOICE_NUMBER_IN_REFERENCE'); }
    if (abs === p.grossCents) { score += 25; reasons.push('AMOUNT_EQUALS_INVOICE_TOTAL'); }
    if (sameName(p.supplierName, tx.counterpartyName)) { score += 20; reasons.push('COUNTERPARTY_MATCHES_SUPPLIER'); }
    return { ...p, score, reasons };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { status: 'NO_MATCH', confidence: 0, candidates: [] };
  const top = scored[0]; const tied = scored.filter((c) => c.score === top.score);
  const candidates = scored.slice(0, 5).map((c) => ({ itemId: c.itemId, invoiceNumber: c.invoiceNumber, supplierName: c.supplierName, grossCents: c.grossCents, score: c.score, reasons: c.reasons }));
  if (tied.length > 1) return { status: 'AMBIGUOUS', confidence: 0.3, candidates };
  if (abs === top.grossCents && (top.reasons.includes('PAYMENT_REFERENCE_MATCHES') || top.reasons.includes('INVOICE_NUMBER_IN_REFERENCE') || top.reasons.includes('COUNTERPARTY_MATCHES_SUPPLIER'))) return { status: top.reasons.includes('PAYMENT_REFERENCE_MATCHES') ? 'EXACT' : 'PROBABLE', confidence: top.reasons.includes('PAYMENT_REFERENCE_MATCHES') ? 1 : 0.85, candidates };
  return { status: 'AMBIGUOUS', confidence: 0.3, candidates };
}

export function suggest(transactions, { openInvoices, payables }) {
  return transactions.map((tx) => ({ transactionId: tx.id, ...(tx.amountCents >= 0 ? { side: 'IN', ...suggestForCredit(tx, openInvoices) } : { side: 'OUT', ...suggestForDebit(tx, payables) }) }));
}
