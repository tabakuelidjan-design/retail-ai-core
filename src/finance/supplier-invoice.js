// Incoming supplier invoices: DATA MODEL ONLY (V1). No accounting classification, no bookkeeping, no OCR/email intake.
// Future sources: upload, email, Peppol. The attachment is an opaque reference (a storage key), never file content in the DB.

export const SUPPLIER_INVOICE_SOURCES = ['manual', 'upload', 'email', 'peppol'];
export const SUPPLIER_PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid'];

/** Validate and normalise a supplier invoice record. Amounts are integer cents; net + VAT must equal the total. */
export function normalizeSupplierInvoice(input) {
  const errors = [];
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  if (!input.supplierName?.trim()) errors.push('SUPPLIER_NAME_MISSING');
  if (!input.invoiceNumber?.trim()) errors.push('INVOICE_NUMBER_MISSING');
  if (!isDate(input.issueDate)) errors.push('ISSUE_DATE_INVALID');
  if (input.dueDate && (!isDate(input.dueDate) || input.dueDate < input.issueDate)) errors.push('DUE_DATE_INVALID');
  for (const k of ['netCents', 'vatCents', 'grossCents']) if (!Number.isInteger(input[k]) || input[k] < 0) errors.push(`${k.toUpperCase()}_INVALID`);
  if (Number.isInteger(input.netCents) && Number.isInteger(input.vatCents) && input.netCents + input.vatCents !== input.grossCents) errors.push('NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL');
  if (!/^[A-Z]{3}$/.test(input.currency ?? '')) errors.push('CURRENCY_INVALID');
  if (!SUPPLIER_INVOICE_SOURCES.includes(input.source ?? 'manual')) errors.push('SOURCE_INVALID');
  if (!SUPPLIER_PAYMENT_STATUSES.includes(input.paymentStatus ?? 'unpaid')) errors.push('PAYMENT_STATUS_INVALID');
  if (errors.length) return { supplierInvoice: null, errors };
  return {
    errors,
    supplierInvoice: {
      merchantId: input.merchantId, supplierName: input.supplierName.trim(), supplierVatNumber: input.supplierVatNumber ?? null, invoiceNumber: input.invoiceNumber.trim(),
      issueDate: input.issueDate, dueDate: input.dueDate ?? null, netCents: input.netCents, vatCents: input.vatCents, grossCents: input.grossCents, currency: input.currency,
      paymentStatus: input.paymentStatus ?? 'unpaid', source: input.source ?? 'manual', attachmentRef: input.attachmentRef ?? null,
    },
  };
}
