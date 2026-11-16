// Stock / Achats -> Finance: a RECEIVED purchase order becomes ONE supplier-invoice record in the Finance inbox, status TO_REVIEW, that carries the order number
// (orderReference) so the person can match the real invoice to the order. It is the "invoice expected" step: nothing is invented.
//  - the supplier name and currency come from the order; the invoice number, issue date and amounts are NOT known (they are on the supplier's invoice) and stay empty:
//    Finance itself refuses to validate the record until a person fills them in from the real document;
//  - idempotent: the order number is the key; a second call returns the record already created (never a second one);
//  - nothing is validated, scheduled for payment or paid here: paying stays in Finance (FINANCE.pay_supplier).
import { validationErrorsFor } from '../finance/inbox.js';

/** @param {{ inbox: object }} deps  the Finance inbox service of the merchant (same Supabase project and merchant as the Core sign-in) */
export function createFinanceHandoff({ inbox }) {
  return async function handoff({ po, supplierName }, person) {
    const orderReference = String(po?.number ?? '').trim();
    const name = String(supplierName ?? '').trim();
    if (!orderReference || !name) throw Object.assign(new Error('the order needs a number and a supplier name'), { code: 'HANDOFF_INCOMPLETE' });
    const existing = (await inbox.list({ source: 'manual' })).find((r) => r.orderReference === orderReference);
    const row = existing ?? await inbox.createManual({ supplierName: name, currency: po.currency, orderReference }, { type: 'merchant', id: String(person?.id ?? 'nordla') });
    return {
      created: !existing,
      financeItem: { id: row.id, status: row.status, source: row.source, supplierName: row.supplierName, currency: row.currency ?? null, orderReference: row.orderReference },
      stillNeededFromTheInvoice: validationErrorsFor(row), // what a person must read from the real invoice before Finance lets it be validated
    };
  };
}
