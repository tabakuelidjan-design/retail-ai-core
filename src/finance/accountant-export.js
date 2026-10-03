// Accountant Export V1 (data package). PURE and deterministic: it assembles, controls and documents truths that already exist; it creates none.
//
//   Payments (registry + allocations)  ->  payments.csv, payment-allocations.csv, refunds-reversals.csv, payment status of every document
//   Invoices / credit notes            ->  sales.csv, credit-notes.csv           (amounts through the Payments engine: settlement() = invoiceAmounts)
//   Supplier invoices                  ->  purchases.csv                          (remaining = gross - net allocations)
//   Bank (accounts, tx, reconciliations)-> bank-accounts.csv, bank-transactions.csv, bank-reconciliations.csv   (derived reconciliation state, never matched_*)
//   Cash                               ->  cash.csv
//   Documents                          ->  vat-summary.csv (INFORMATIONAL, not a VAT return), missing-artifacts.csv, manifest.json, SHA256SUMS.txt, README.txt
//
// No Treasury figure (forecast, scenario) ever appears here: realised data only. No accounting engine: no ledger, no journal entries, no VAT return.
// Whitelist only: every column is listed below; no table is dumped. Money is written as a decimal string with a dot and 2 decimals ("-1234.50"), the currency in its own
// column; never a float, never summed across currencies. Dates are civil dates (YYYY-MM-DD, merchant calendar); technical instants are ISO 8601 UTC.
// Reproducibility: the CSV bytes depend only on the data and the period (ordering, columns, formats are fixed); only manifest.json / README.txt carry generated_at.

import { createHash } from 'node:crypto';
import { settlement } from './document.js';
import { settlementOf } from './payables/status.js';
import { civilDateIn } from './civil-date.js';
import { formatCents } from './money.js';
import { toCsv } from './export-csv.js';
import { txAmounts } from './bank-ledger.js';
import { maskIban } from './bank.js';
import { unzip, zip } from './xlsx.js';

export const EXPORT_VERSION = '1.0';
export const EXPORT_SCHEMA = 'nordla.accountant-export/1';
export const VAT_LABEL = 'INFORMATIONAL VAT SUMMARY - not a VAT return';
export const EXPORT_ACTION = 'ACCOUNTANT_EXPORT_GENERATED';
export const FORMATS = { encoding: 'UTF-8 with BOM', csvDelimiter: ',', lineEnding: 'CRLF', money: 'decimal with a dot and 2 decimals, explicit minus sign, no thousands separator (e.g. -1234.50); currency in its own column', dates: 'civil dates YYYY-MM-DD in the merchant time zone', instants: 'ISO 8601 UTC (technical timestamps)' };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const inRange = (d, a, b) => typeof d === 'string' && d.slice(0, 10) >= a && d.slice(0, 10) <= b;
const money = (c) => (Number.isInteger(c) ? formatCents(c) : '');
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const byKey = (...ks) => (a, b) => { for (const k of ks) { const x = String(a[k] ?? ''); const y = String(b[k] ?? ''); if (x !== y) return x < y ? -1 : 1; } return 0; };
// defence in depth: an own-bank identifier leaves this package only masked, whatever a store holds
const masked = (v) => (!v ? '' : String(v).includes('*') ? v : (maskIban(v) ?? ''));
const joinIds = (xs) => [...new Set(xs.filter(Boolean))].sort().join('; ');
const col = (...keys) => keys.map((k) => ({ key: k, header: k }));

// ---------------------------------------------------------------- file layouts (fixed: columns never depend on the data)
export const LAYOUT = {
  'sales.csv': col('document_id', 'number', 'issue_date', 'due_date', 'document_status', 'payment_status', 'currency', 'customer_name', 'customer_vat_number', 'net', 'vat', 'rounding', 'gross', 'credited', 'effective_due', 'allocated', 'refunded', 'retained', 'remaining', 'revenue_basis', 'payment_ids', 'payment_references', 'source_snapshot_sha256', 'pdf_status'),
  'credit-notes.csv': col('document_id', 'number', 'issue_date', 'document_status', 'currency', 'customer_name', 'customer_vat_number', 'original_invoice_id', 'original_invoice_number', 'net', 'vat', 'rounding', 'gross', 'refunded', 'refund_payment_ids', 'source_snapshot_sha256', 'pdf_status'),
  'purchases.csv': col('purchase_id', 'document_type', 'validation_status', 'supplier_name', 'supplier_vat_number', 'supplier_iban', 'invoice_number', 'issue_date', 'due_date', 'due_origin', 'currency', 'net', 'vat', 'gross', 'accounting_sign', 'allocated', 'remaining', 'payment_state', 'payment_reference', 'source_document_status', 'source_document_sha256', 'source_document_file'),
  'payments.csv': col('payment_id', 'direction', 'paid_on', 'amount', 'currency', 'method', 'reference', 'source', 'bank_reference', 'structured_reference', 'external_reference', 'refund_of_payment_id', 'reversal_of_payment_id', 'allocated', 'unallocated', 'bank_reconciled', 'created_at'),
  'payment-allocations.csv': col('allocation_id', 'payment_id', 'target_type', 'target_id', 'target_number', 'amount', 'currency', 'reverses_allocation_id', 'reason', 'allocation_date', 'created_at'),
  'refunds-reversals.csv': col('kind', 'record_id', 'date', 'amount', 'currency', 'direction', 'linked_document_number', 'reverses_id', 'refund_of_payment_id', 'reason', 'explanation'),
  'bank-accounts.csv': col('account_id', 'external_id', 'origin', 'provider', 'display_name', 'iban_masked', 'currency', 'status'),
  'bank-transactions.csv': col('transaction_id', 'account_id', 'account_external_id', 'date', 'value_date', 'amount', 'currency', 'direction', 'counterparty_name', 'counterparty_account_masked', 'reference', 'structured_reference', 'bank_reference', 'provider_tx_id', 'provenance', 'imported_at', 'reconciliation_status', 'reconciled', 'set_aside', 'remaining', 'linked_payment_ids'),
  'bank-reconciliations.csv': col('reconciliation_id', 'bank_transaction_id', 'payment_id', 'kind', 'amount', 'currency', 'reverses_id', 'method', 'actor_type', 'reason', 'created_at'),
  'cash.csv': col('record_type', 'record_id', 'date', 'kind', 'amount', 'currency', 'note', 'created_at'),
  'vat-summary.csv': col('stream', 'currency', 'rate_percent', 'taxable_base', 'vat_amount', 'documents', 'treatment', 'label'),
  'missing-artifacts.csv': col('type', 'source_id', 'document_number', 'expected_artifact', 'status', 'reason', 'alternative_provided'),
};
const DESCRIPTION = {
  'sales.csv': 'Issued customer invoices of the period, amounts and payment status derived from the payment registry (as of generation)', 'credit-notes.csv': 'Issued credit notes of the period', 'purchases.csv': 'Supplier documents dated in the period, with validation state and remaining amount',
  'payments.csv': 'Payment registry rows dated in the period (customer receipts, supplier payments, refunds, reversals)', 'payment-allocations.csv': 'How each payment is allocated to documents (append-only; reversals are negative rows)', 'refunds-reversals.csv': 'Refunds, voided payments and reversed allocations, explained',
  'bank-accounts.csv': 'Bank accounts (masked identifiers only)', 'bank-transactions.csv': 'Bank transactions dated in the period with their derived reconciliation state', 'bank-reconciliations.csv': 'Reconciliation rows linking bank transactions to payments (append-only)',
  'cash.csv': 'Confirmed cash counts and recorded cash movements of the period', 'vat-summary.csv': VAT_LABEL, 'missing-artifacts.csv': 'Documents expected but absent (never hidden)', 'README.txt': 'Explanation for the accountant', 'SHA256SUMS.txt': 'SHA-256 of every file (standard format, verifiable with sha256sum)',
};

// ---------------------------------------------------------------- helpers over the facts
const paymentStatusOf = (s) => (s.creditedCents >= s.grossCents && s.grossCents > 0 ? 'CREDITED' : s.refundableCents > 0 ? 'OVERPAID' : s.effectiveDueCents > 0 && s.remainingCents === 0 ? 'PAID' : (s.retainedCents ?? s.paidCents) > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
const SUPPLIER_STATES = { PAID: 'PAID', PARTIALLY_PAID: 'PARTIALLY_PAID', UNPAID: 'UNPAID', UNKNOWN: 'UNKNOWN', NOT_PAYABLE: 'NOT_PAYABLE' };
const docTypeOfPurchase = (r) => (['INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'EXPENSE'].includes(r.documentType) ? r.documentType : r.extraction?.capture?.kind === 'expense' ? 'RECEIPT' : 'INVOICE');
const dueOriginOf = (r) => (!r.dueDate ? 'UNKNOWN' : r.extraction?.provenance?.dueDate?.source === 'user' ? 'MANUAL' : r.extraction?.provenance?.dueDate?.source === 'computed' ? 'COMPUTED_FROM_TERMS' : r.extraction?.provenance?.dueDate ? 'PRINTED' : 'MANUAL');

/**
 * @param {object} i
 * @param {{id: string, name?: string}} i.merchant @param {{kind: string, start: string, end: string, label: string}} i.period @param {string} i.timeZone @param {string} i.generatedAt ISO instant
 * @param {Array} i.documents [{doc, payments, creditNotes, refunds}]  @param {Array} i.suppliers  @param {Array} i.registry  @param {Array} i.allocations
 * @param {Array} i.bankAccounts @param {Array} i.bankTransactions (with derived reconciliation fields) @param {Array} i.reconciliations @param {Array} i.cashCounts @param {Array} i.cashMovements
 * @param {{sales?: Map, credit_notes?: Map, purchases?: Map}} [i.artifacts] per source id: { status, data?, fileName?, sha256?, reason? }
 * @param {string} [i.sourceSchemaVersion]
 */
export function buildAccountantExport(i) {
  const { period, timeZone } = i; const mid = i.merchant.id; const own = (r) => r && (r.merchantId === undefined || r.merchantId === mid);
  const docsAll = (i.documents ?? []).filter((x) => own(x.doc)); const docById = new Map(docsAll.map((x) => [x.doc.id, x.doc]));
  const registry = (i.registry ?? []).filter(own); const allocations = (i.allocations ?? []).filter(own); const suppliers = (i.suppliers ?? []).filter(own);
  const recsAll = (i.reconciliations ?? []).filter(own); const artifacts = i.artifacts ?? {};
  const supById = new Map(suppliers.map((s) => [s.id, s]));
  const allocByPayment = new Map(); for (const a of allocations) (allocByPayment.get(a.paymentId) ?? allocByPayment.set(a.paymentId, []).get(a.paymentId)).push(a);
  const allocByDoc = new Map(); for (const a of allocations) if (a.customerDocumentId) (allocByDoc.get(a.customerDocumentId) ?? allocByDoc.set(a.customerDocumentId, []).get(a.customerDocumentId)).push(a);
  const payById = new Map(registry.map((p) => [p.id, p]));
  const recsByPayment = new Map(); for (const r of recsAll) if (r.paymentId) (recsByPayment.get(r.paymentId) ?? recsByPayment.set(r.paymentId, []).get(r.paymentId)).push(r);
  const files = new Map(); const rows = {}; const warnings = []; const missing = [];
  const put = (name, list) => { rows[name] = list.length; files.set(name, Buffer.from(toCsv(list, LAYOUT[name]), 'utf8')); };
  const payRefs = (docId) => { const ps = (allocByDoc.get(docId) ?? []).map((a) => payById.get(a.paymentId)).filter(Boolean); return { ids: joinIds(ps.map((p) => p.id)), refs: joinIds(ps.map((p) => p.reference ?? p.bankReference ?? p.structuredReference)) }; };
  const pdfStatusOf = (kind, id) => artifacts[kind]?.get(id)?.status ?? 'MISSING';
  const integrityBad = [];

  // ---- SALES + CREDIT NOTES
  const issued = docsAll.filter(({ doc }) => doc.lockedAt && ['invoice', 'credit_note'].includes(doc.type) && inRange(doc.issueDate, period.start, period.end));
  const sales = []; const credits = [];
  for (const { doc, payments, creditNotes, refunds } of issued.sort((a, b) => byKey('issueDate', 'number', 'id')(a.doc, b.doc))) {
    const t = doc.totals ?? {}; if (doc.snapshotHash === undefined) integrityBad.push(doc.number);
    if (doc.type === 'invoice') {
      const s = settlement(doc, payments ?? [], creditNotes ?? [], refunds ?? []); const pr = payRefs(doc.id);
      sales.push({ document_id: doc.id, number: doc.number, issue_date: doc.issueDate, due_date: doc.dueDate ?? '', document_status: doc.status, payment_status: paymentStatusOf(s), currency: doc.currency, customer_name: doc.customer?.name ?? '', customer_vat_number: doc.customer?.vatNumber ?? '', net: money(t.netCents), vat: money(t.vatCents), rounding: money(t.roundingCents ?? 0), gross: money(s.grossCents),
        credited: money(s.creditedCents), effective_due: money(s.effectiveDueCents), allocated: money(s.allocatedCents), refunded: money(s.refundedCents), retained: money(s.retainedCents), remaining: money(s.remainingCents), revenue_basis: doc.revenueBasis ?? '', payment_ids: pr.ids, payment_references: pr.refs, source_snapshot_sha256: doc.snapshotHash ?? '', pdf_status: pdfStatusOf('sales', doc.id) });
      missing.push({ type: 'CUSTOMER_INVOICE', source_id: doc.id, document_number: doc.number, expected_artifact: 'PDF_ARCHIVED_ORIGINAL', status: 'MISSING', reason: 'NOT_ARCHIVED_AT_ISSUANCE', alternative_provided: pdfStatusOf('sales', doc.id) === 'REGENERATED_COPY' ? 'REGENERATED_COPY' : 'NONE' });
    } else {
      const orig = docById.get(doc.relatedDocumentId); const refundAllocs = (allocByDoc.get(doc.id) ?? []); const refunded = sum(refundAllocs, (a) => a.amountCents);
      credits.push({ document_id: doc.id, number: doc.number, issue_date: doc.issueDate, document_status: doc.status, currency: doc.currency, customer_name: doc.customer?.name ?? '', customer_vat_number: doc.customer?.vatNumber ?? '', original_invoice_id: doc.relatedDocumentId ?? '', original_invoice_number: orig?.number ?? '', net: money(t.netCents), vat: money(t.vatCents), rounding: money(t.roundingCents ?? 0), gross: money(t.grossCents),
        refunded: money(refunded), refund_payment_ids: joinIds(refundAllocs.map((a) => a.paymentId)), source_snapshot_sha256: doc.snapshotHash ?? '', pdf_status: pdfStatusOf('credit_notes', doc.id) });
      missing.push({ type: 'CREDIT_NOTE', source_id: doc.id, document_number: doc.number, expected_artifact: 'PDF_ARCHIVED_ORIGINAL', status: 'MISSING', reason: 'NOT_ARCHIVED_AT_ISSUANCE', alternative_provided: pdfStatusOf('credit_notes', doc.id) === 'REGENERATED_COPY' ? 'REGENERATED_COPY' : 'NONE' });
    }
  }
  put('sales.csv', sales); put('credit-notes.csv', credits);

  // ---- PURCHASES
  const purchases = []; const purchaseSrc = suppliers.filter((r) => inRange(r.issueDate, period.start, period.end)).sort(byKey('issueDate', 'invoiceNumber', 'id'));
  for (const r of purchaseSrc) {
    const s = settlementOf(r); const type = docTypeOfPurchase(r); const art = artifacts.purchases?.get(r.id); const hasRef = !!r.attachmentRef;
    const srcStatus = art ? art.status : hasRef ? 'ARCHIVED_ORIGINAL' : 'MISSING';
    purchases.push({ purchase_id: r.id, document_type: type, validation_status: r.status, supplier_name: r.supplierName ?? '', supplier_vat_number: r.supplierVatNumber ?? '', supplier_iban: r.supplierIban ?? '', invoice_number: r.invoiceNumber ?? '', issue_date: r.issueDate ?? '', due_date: r.dueDate ?? '', due_origin: dueOriginOf(r), currency: r.currency ?? '',
      net: money(r.netCents), vat: money(r.vatCents), gross: money(r.grossCents), accounting_sign: type === 'CREDIT_NOTE' ? -1 : 1, allocated: money(s.paidCents), remaining: s.remainingCents === null ? '' : money(s.remainingCents), payment_state: SUPPLIER_STATES[s.state] ?? s.state, payment_reference: r.paymentReference ?? '', source_document_status: srcStatus, source_document_sha256: r.sha256 ?? art?.sha256 ?? '', source_document_file: art?.fileName ?? r.fileName ?? '' });
    if (['VALIDATED', 'TO_PAY', 'PAID'].includes(r.status) && srcStatus === 'MISSING') missing.push({ type: 'SUPPLIER_INVOICE', source_id: r.id, document_number: r.invoiceNumber ?? '', expected_artifact: 'SOURCE_DOCUMENT', status: 'MISSING', reason: art?.reason ?? (hasRef ? 'ATTACHMENT_FILE_NOT_FOUND' : 'NO_ATTACHMENT'), alternative_provided: 'NONE' });
  }
  put('purchases.csv', purchases);

  // ---- PAYMENTS (registry only; the legacy table is never exported as a truth)
  const netAlloc = (id) => sum(allocByPayment.get(id) ?? [], (a) => a.amountCents);
  const payRows = registry.filter((p) => inRange(p.paidOn, period.start, period.end)).sort(byKey('paidOn', 'createdAt', 'id'));
  put('payments.csv', payRows.map((p) => ({ payment_id: p.id, direction: p.direction, paid_on: p.paidOn, amount: money(p.direction === 'OUT' ? -p.amountCents : p.amountCents), currency: p.currency, method: p.method ?? '', reference: p.reference ?? '', source: p.source ?? '', bank_reference: p.bankReference ?? '', structured_reference: p.structuredReference ?? '', external_reference: p.externalReference ?? '',
    refund_of_payment_id: p.refundOfPaymentId ?? '', reversal_of_payment_id: p.reversalOfId ?? '', allocated: money(netAlloc(p.id)), unallocated: money(p.amountCents - netAlloc(p.id)), bank_reconciled: money(sum(recsByPayment.get(p.id) ?? [], (r) => (r.kind === 'MATCH' ? r.amountCents : 0))), created_at: p.createdAt ?? '' })));
  const periodPay = new Set(payRows.map((p) => p.id));
  const allocDate = (a) => (a.createdAt ? civilDateIn(a.createdAt, timeZone) : '');
  const allocRows = allocations.filter((a) => periodPay.has(a.paymentId) || (a.reversesAllocationId && inRange(allocDate(a), period.start, period.end))).sort(byKey('createdAt', 'id'));
  const targetNo = (a) => (a.customerDocumentId ? docById.get(a.customerDocumentId)?.number : supById.get(a.supplierInvoiceId)?.invoiceNumber) ?? '';
  put('payment-allocations.csv', allocRows.map((a) => ({ allocation_id: a.id, payment_id: a.paymentId, target_type: a.customerDocumentId ? 'CUSTOMER_DOCUMENT' : 'SUPPLIER_INVOICE', target_id: a.customerDocumentId ?? a.supplierInvoiceId ?? '', target_number: targetNo(a), amount: money(a.amountCents), currency: a.currency ?? payById.get(a.paymentId)?.currency ?? '', reverses_allocation_id: a.reversesAllocationId ?? '', reason: a.reason ?? '', allocation_date: allocDate(a), created_at: a.createdAt ?? '' })));

  // ---- REFUNDS / REVERSALS (explained)
  const rr = [];
  for (const p of payRows) {
    const toCredit = (allocByPayment.get(p.id) ?? []).filter((a) => a.customerDocumentId && docById.get(a.customerDocumentId)?.type === 'credit_note');
    if (p.reversalOfId) rr.push({ kind: 'PAYMENT_VOID', record_id: p.id, date: p.paidOn, amount: money(p.direction === 'OUT' ? -p.amountCents : p.amountCents), currency: p.currency, direction: p.direction, linked_document_number: '', reverses_id: p.reversalOfId, refund_of_payment_id: '', reason: '', explanation: 'REVERSAL_OF_A_PAYMENT: this row cancels the payment it points to; the original row is never deleted' });
    else if (p.direction === 'OUT' && toCredit.length) rr.push({ kind: 'REFUND', record_id: p.id, date: p.paidOn, amount: money(-p.amountCents), currency: p.currency, direction: p.direction, linked_document_number: joinIds(toCredit.map((a) => docById.get(a.customerDocumentId)?.number)), reverses_id: '', refund_of_payment_id: p.refundOfPaymentId ?? '', reason: '', explanation: 'REFUND_OF_A_CREDIT_NOTE: money given back to the customer against an issued credit note' });
  }
  for (const a of allocRows.filter((x) => x.reversesAllocationId)) rr.push({ kind: 'ALLOCATION_REVERSAL', record_id: a.id, date: allocDate(a), amount: money(a.amountCents), currency: a.currency ?? '', direction: payById.get(a.paymentId)?.direction ?? '', linked_document_number: targetNo(a), reverses_id: a.reversesAllocationId, refund_of_payment_id: '', reason: a.reason ?? '', explanation: 'ALLOCATION_REVERSED: part of a payment is no longer attributed to this document' });
  put('refunds-reversals.csv', rr.sort(byKey('date', 'kind', 'record_id')));

  // ---- BANK (Essential Bank only)
  const accById = new Map((i.bankAccounts ?? []).filter(own).map((a) => [a.id, a]));
  put('bank-accounts.csv', [...accById.values()].sort(byKey('externalId', 'id')).map((a) => ({ account_id: a.id, external_id: a.externalId, origin: a.origin, provider: a.provider ?? '', display_name: a.displayName ?? '', iban_masked: masked(a.ibanMasked), currency: a.currency, status: a.status })));
  const txs = (i.bankTransactions ?? []).filter(own).filter((t) => inRange(t.date, period.start, period.end)).sort(byKey('date', 'providerTxId', 'id'));
  const recsOfTx = new Map(); for (const r of recsAll) (recsOfTx.get(r.bankTransactionId) ?? recsOfTx.set(r.bankTransactionId, []).get(r.bankTransactionId)).push(r);
  const txRows = txs.map((t) => { const a = t.reconciliationStatus ? { status: t.reconciliationStatus, matched: t.reconciledCents, ignored: t.ignoredCents, remaining: t.remainingCents } : txAmounts(t, recsAll); const mine = recsOfTx.get(t.id) ?? [];
    const linked = new Map(); for (const r of mine) if (r.kind === 'MATCH' && r.paymentId) linked.set(r.paymentId, (linked.get(r.paymentId) ?? 0) + r.amountCents);
    return { transaction_id: t.id, account_id: t.bankAccountId ?? '', account_external_id: t.accountId ?? '', date: t.date, value_date: t.valueDate ?? '', amount: money(t.amountCents), currency: t.currency ?? '', direction: t.amountCents >= 0 ? 'IN' : 'OUT', counterparty_name: t.counterpartyName ?? '', counterparty_account_masked: masked(t.counterpartyAccountMasked), reference: t.reference ?? '', structured_reference: t.structuredReference ?? '', bank_reference: t.bankReference ?? '', provider_tx_id: t.providerTxId ?? '', provenance: t.source ?? '', imported_at: t.importedAt ?? '',
      reconciliation_status: a.status, reconciled: money(a.matched), set_aside: money(a.ignored), remaining: money(a.remaining), linked_payment_ids: joinIds([...linked].filter(([, c]) => c > 0).map(([id]) => id)) }; });
  put('bank-transactions.csv', txRows);
  const txIds = new Set(txs.map((t) => t.id));
  put('bank-reconciliations.csv', recsAll.filter((r) => txIds.has(r.bankTransactionId)).sort(byKey('createdAt', 'id')).map((r) => ({ reconciliation_id: r.id, bank_transaction_id: r.bankTransactionId, payment_id: r.paymentId ?? '', kind: r.kind, amount: money(r.amountCents), currency: r.currency, reverses_id: r.reversesId ?? '', method: r.method ?? '', actor_type: r.actor?.type ?? '', reason: r.reason ?? '', created_at: r.createdAt ?? '' })));

  // ---- CASH
  const cashRows = [...(i.cashCounts ?? []).filter(own).filter((c) => inRange(c.countedOn, period.start, period.end)).map((c) => ({ record_type: 'COUNT', record_id: c.id, date: c.countedOn, kind: 'CONFIRMED_COUNT', amount: money(c.amountCents), currency: i.cashCurrency ?? 'EUR', note: c.note ?? '', created_at: c.createdAt ?? '' })),
    ...(i.cashMovements ?? []).filter(own).filter((m) => inRange(m.date, period.start, period.end)).map((m) => ({ record_type: 'MOVEMENT', record_id: m.id, date: m.date, kind: m.kind, amount: money(m.kind === 'CASH_IN' ? m.amountCents : -m.amountCents), currency: i.cashCurrency ?? 'EUR', note: m.note ?? '', created_at: m.createdAt ?? '' }))].sort(byKey('date', 'record_type', 'record_id'));
  put('cash.csv', cashRows);

  // ---- INFORMATIONAL VAT SUMMARY (documents only; never a return; no deductibility decision)
  const groups = new Map(); const add = (stream, cur, rate, base, vat, treatment) => { const k = `${stream}|${cur}|${rate}|${treatment}`; const g = groups.get(k) ?? { stream, currency: cur, rate_percent: rate, base: 0, vat: 0, docs: 0, treatment }; g.base += base ?? 0; g.vat += vat ?? 0; g.docs += 1; groups.set(k, g); };
  for (const { doc } of issued) { const stream = doc.type === 'invoice' ? 'SALES' : 'CREDIT_NOTES'; for (const g of doc.totals?.vatBreakdown ?? []) add(stream, doc.currency, g.vatRateBp / 100, g.taxableCents, g.vatCents, 'RATE_FROM_DOCUMENT'); }
  for (const r of purchaseSrc.filter((x) => ['VALIDATED', 'TO_PAY', 'PAID'].includes(x.status))) {
    const type = docTypeOfPurchase(r); const stream = type === 'CREDIT_NOTE' ? 'PURCHASE_CREDIT_NOTES' : 'PURCHASES'; const bd = Array.isArray(r.vatBreakdown) ? r.vatBreakdown.filter((x) => Number.isInteger(x.taxableCents) && Number.isInteger(x.vatCents) && Number.isInteger(x.rateBp)) : [];
    if (bd.length && sum(bd, (x) => Math.abs(x.vatCents)) === (r.vatCents ?? NaN)) for (const g of bd) add(stream, r.currency ?? '', g.rateBp / 100, Math.abs(g.taxableCents), Math.abs(g.vatCents), 'RATE_FROM_DOCUMENT');
    else add(stream, r.currency ?? '', '', r.netCents ?? 0, r.vatCents ?? 0, 'RATE_NOT_RECORDED');
  }
  const vatRows = [...groups.values()].sort((a, b) => byKey('stream', 'currency', 'treatment')(a, b) || Number(a.rate_percent || -1) - Number(b.rate_percent || -1)).map((g) => ({ stream: g.stream, currency: g.currency, rate_percent: g.rate_percent === '' ? '' : String(g.rate_percent), taxable_base: money(g.base), vat_amount: money(g.vat), documents: g.docs, treatment: g.treatment, label: VAT_LABEL }));
  put('vat-summary.csv', vatRows);

  // ---- missing artifacts, warnings, totals
  put('missing-artifacts.csv', missing.sort(byKey('type', 'document_number', 'source_id')));
  const w = (code, count, detail) => { if (count) warnings.push({ code, count, ...(detail ? { detail } : {}) }); };
  const realMissing = missing.filter((m) => m.type === 'SUPPLIER_INVOICE').length;
  w('SOURCE_DOCUMENT_MISSING', realMissing); w('PDF_NOT_ARCHIVED_AT_ISSUANCE', missing.filter((m) => m.type !== 'SUPPLIER_INVOICE').length, 'issued PDFs are not archived at issuance in this version: only regenerated copies can be provided, they are not the historical originals');
  const unrec = txRows.filter((t) => t.reconciliation_status !== 'RECONCILED' && t.reconciliation_status !== 'IGNORED'); w('UNRECONCILED_BANK_TRANSACTIONS', unrec.length, `${unrec.filter((t) => t.reconciliation_status === 'PARTIALLY_RECONCILED').length} partially reconciled`);
  w('UNVALIDATED_PURCHASES', purchaseSrc.filter((r) => !['VALIDATED', 'TO_PAY', 'PAID'].includes(r.status)).length, 'received or to review: not included in the VAT summary');
  w('PURCHASES_WITHOUT_VAT_RATE', vatRows.filter((v) => v.treatment === 'RATE_NOT_RECORDED').reduce((a, v) => a + v.documents, 0));
  w('SNAPSHOT_HASH_MISSING', integrityBad.length);
  const currencies = [...new Set([...sales, ...credits, ...purchases, ...payRows.map((p) => ({ currency: p.currency })), ...txRows].map((r) => r.currency).filter(Boolean))].sort();
  if (currencies.length > 1) warnings.push({ code: 'MIXED_CURRENCIES', count: currencies.length, detail: `${currencies.join(', ')}: totals are given per currency, never added together` });
  if (!txRows.length && !(i.bankAccounts ?? []).length) warnings.push({ code: 'NO_BANK_DATA', count: 0, detail: 'no bank account or transaction recorded in Nordla for this period' });
  warnings.sort(byKey('code'));
  const per = (cur) => ({ salesGross: money(sum(sales.filter((r) => r.currency === cur), (r) => Math.round(Number(r.gross) * 100))), salesNet: money(sum(sales.filter((r) => r.currency === cur), (r) => Math.round(Number(r.net) * 100))), salesVat: money(sum(sales.filter((r) => r.currency === cur), (r) => Math.round(Number(r.vat) * 100))),
    creditNotesGross: money(sum(credits.filter((r) => r.currency === cur), (r) => Math.round(Number(r.gross) * 100))), salesRemaining: money(sum(sales.filter((r) => r.currency === cur), (r) => Math.round(Number(r.remaining) * 100))) });
  const totalsByCurrency = Object.fromEntries(currencies.map((c) => [c, per(c)]));

  // ---- documents (copies/originals actually present; nothing is fabricated)
  const docEntries = [];
  for (const [kind, folder] of [['sales', 'documents/sales'], ['credit_notes', 'documents/credit-notes'], ['purchases', 'documents/purchases']]) {
    for (const [id, a] of [...(artifacts[kind] ?? new Map())].sort(([x], [y]) => (x < y ? -1 : 1))) if (a.data) docEntries.push({ path: `${folder}/${a.fileName}`, data: Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data), status: a.status, sourceId: id, kind });
  }
  const documents = docEntries.map((d) => ({ path: d.path, sourceId: d.sourceId, category: d.kind, status: d.status, bytes: d.data.length, sha256: sha(d.data) }));
  for (const d of docEntries) files.set(d.path, d.data);

  // ---- manifest + sums + README
  const csvNames = Object.keys(LAYOUT);
  const contentFingerprint = sha(csvNames.map((n) => `${n}:${sha(files.get(n))}`).join('\n')); // business content only: identical data + period => identical value
  const pdfArchive = { archivedOriginal: documents.filter((d) => d.status === 'ARCHIVED_ORIGINAL' && d.category !== 'purchases').length, regeneratedCopy: documents.filter((d) => d.status === 'REGENERATED_COPY').length, missing: missing.filter((m) => m.type !== 'SUPPLIER_INVOICE' && m.alternative_provided === 'NONE').length, note: 'issued invoice and credit note PDFs are regenerated on demand; no original is archived at issuance in this version' };
  const fileEntry = (name, data) => ({ path: name, bytes: data.length, rows: rows[name] ?? null, sha256: sha(data), description: DESCRIPTION[name] ?? null });
  const readme = Buffer.from(buildReadme({ merchant: i.merchant, period, timeZone, generatedAt: i.generatedAt, rows, warnings, vatRows: rows['vat-summary.csv'], documents, contentFingerprint, totalsByCurrency, pdfArchive }), 'utf8'); files.set('README.txt', readme);
  const sums = Buffer.from([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, d]) => `${sha(d)}  ${n}`).join('\n') + '\n', 'utf8'); files.set('SHA256SUMS.txt', sums);
  const listed = [...files.entries()].filter(([n]) => n !== 'SHA256SUMS.txt').sort(([a], [b]) => (a < b ? -1 : 1));
  const manifest = {
    schema: EXPORT_SCHEMA, exportVersion: EXPORT_VERSION, sourceSchemaVersion: i.sourceSchemaVersion ?? null, kind: 'ACCOUNTANT_EXPORT_DATA',
    merchant: { id: mid, name: i.merchant.name ?? null }, period: { kind: period.kind, start: period.start, end: period.end, label: period.label }, timeZone, generatedAt: i.generatedAt,
    realisedDataOnly: true, treasuryForecastIncluded: false, formats: FORMATS, contentFingerprint,
    files: [...listed.map(([n, d]) => fileEntry(n, d)), { path: 'SHA256SUMS.txt', bytes: sums.length, rows: null, sha256: sha(sums), description: DESCRIPTION['SHA256SUMS.txt'] }].sort(byKey('path')),
    rowCounts: rows, documents, missingArtifacts: { count: missing.length, supplierSourceDocuments: realMissing, issuedPdfNotArchived: missing.length - realMissing, file: 'missing-artifacts.csv' }, pdfArchive,
    vat: { label: VAT_LABEL, official: false }, currencies, totalsByCurrency, warnings,
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'); files.set('manifest.json', manifestBuf);
  const root = `accountant-export_${period.label}`; const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, d]) => ({ name: `${root}/${n}`, data: d }));
  const zipped = zip(entries);
  return { fileName: `${root}.zip`, root, zip: zipped, sha256: sha(zipped), size: zipped.length, files, manifest, warnings, rowCounts: rows, contentFingerprint };
}

function buildReadme({ merchant, period, timeZone, generatedAt, rows, warnings, documents, contentFingerprint, totalsByCurrency, pdfArchive }) {
  const L = (n) => `  ${n.padEnd(26)} ${DESCRIPTION[n]} (${rows[n] ?? 0} ligne(s))`; const names = Object.keys(LAYOUT);
  return `DOSSIER COMPTABLE — ${merchant.name ?? merchant.id}
Période : ${period.start} au ${period.end} (${period.label}) — fuseau horaire : ${timeZone}
Généré le : ${generatedAt}
Version du format : ${EXPORT_VERSION}

CE QUE CONTIENT CE DOSSIER
${names.map(L).join('\n')}
  documents/                 ${documents.length} pièce(s) réellement disponible(s) (jamais fabriquées)
  manifest.json              inventaire : fichiers, nombre de lignes, empreintes SHA-256, avertissements
  SHA256SUMS.txt             empreintes SHA-256 au format standard

CONVENTIONS
  Encodage UTF-8 (avec BOM), séparateur « , », fin de ligne CRLF.
  Montants : décimal avec point et 2 décimales, signe moins explicite, sans séparateur de milliers ; la devise est dans sa propre colonne.
  Les devises ne sont jamais additionnées entre elles${Object.keys(totalsByCurrency).length > 1 ? ` (devises présentes : ${Object.keys(totalsByCurrency).join(', ')})` : ''}.
  Dates : dates civiles AAAA-MM-JJ (fuseau du commerçant). Les colonnes created_at / imported_at sont des instants techniques ISO 8601 UTC.
  Statuts de paiement et montants restants : calculés à la date de génération à partir du registre des paiements (pas d'ancien champ « payé »).
  Les montants des notes de crédit sont présentés séparément ; rien n'est compensé automatiquement.
  Les virements bancaires : état de rapprochement dérivé (rapproché / partiel / non rapproché), avec les paiements liés.

TVA — ${VAT_LABEL}
  vat-summary.csv est une synthèse informative calculée uniquement à partir des documents existants (base et TVA par taux).
  Ce n'est PAS une déclaration TVA, aucune règle fiscale (déductibilité, régime) n'y est appliquée. Un achat sans ventilation de TVA est signalé « RATE_NOT_RECORDED ».

PIÈCES
  Les PDF des factures et notes de crédit émises sont régénérés à la demande : ${pdfArchive.note}.
  ${pdfArchive.regeneratedCopy} copie(s) régénérée(s) incluse(s) (REGENERATED_COPY) ; elles ne sont pas les originaux historiques.
  Les pièces attendues mais absentes sont listées dans missing-artifacts.csv.

AVERTISSEMENTS (${warnings.length})
${warnings.length ? warnings.map((w) => `  [${w.code}] ${w.count}${w.detail ? ` — ${w.detail}` : ''}`).join('\n') : '  aucun'}

VÉRIFIER QUE LE DOSSIER N'A PAS ÉTÉ MODIFIÉ
  Dans le dossier décompressé :  sha256sum -c SHA256SUMS.txt   (ou : shasum -a 256 -c SHA256SUMS.txt)
  Chaque ligne doit afficher « OK ». L'empreinte du contenu métier (indépendante de la date de génération) est : ${contentFingerprint}
  Ce dossier prépare des données fiables pour votre logiciel comptable ; il ne remplace ni un grand livre, ni une déclaration TVA.
`;
}

/** Verify a generated package: every listed file present and unmodified, nothing unlisted. Pure. */
export function verifyExportPackage(zipBuffer) {
  const entries = unzip(zipBuffer); const names = [...entries.keys()]; const root = names.find((n) => n.endsWith('/manifest.json'))?.slice(0, -'manifest.json'.length);
  if (!root) return { ok: false, problems: [{ code: 'MANIFEST_MISSING' }] };
  let manifest; try { manifest = JSON.parse(entries.get(`${root}manifest.json`).toString('utf8')); } catch { return { ok: false, problems: [{ code: 'MANIFEST_UNREADABLE' }] }; }
  const problems = []; const listed = new Set();
  for (const f of manifest.files) { listed.add(f.path); const d = entries.get(root + f.path); if (!d) problems.push({ code: 'FILE_MISSING', path: f.path }); else if (sha(d) !== f.sha256 || d.length !== f.bytes) problems.push({ code: 'FILE_MODIFIED', path: f.path }); }
  for (const d of manifest.documents ?? []) { listed.add(d.path); const b = entries.get(root + d.path); if (!b) problems.push({ code: 'FILE_MISSING', path: d.path }); else if (sha(b) !== d.sha256) problems.push({ code: 'FILE_MODIFIED', path: d.path }); }
  listed.add('manifest.json');
  for (const n of names) if (!listed.has(n.slice(root.length))) problems.push({ code: 'FILE_NOT_IN_MANIFEST', path: n.slice(root.length) });
  const sums = entries.get(`${root}SHA256SUMS.txt`); if (!sums) problems.push({ code: 'SHA256SUMS_MISSING' });
  else for (const line of sums.toString('utf8').split('\n').filter(Boolean)) { const [h, ...p] = line.split('  '); const path = p.join('  '); const d = entries.get(root + path); if (!d || sha(d) !== h) problems.push({ code: 'SHA256SUMS_MISMATCH', path }); }
  return { ok: problems.length === 0, problems, manifest };
}
