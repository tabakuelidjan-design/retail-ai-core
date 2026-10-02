// THE definition of the amounts of a customer invoice. Integer cents of ONE currency; no float, no rounding, no second formula anywhere.
// Its SQL twin is fin_invoice_amounts() (migration 20261004090000); test/finance-amounts.test.js holds the two equal on a matrix of cases.
//
//   document_total = gross + rounding of the invoice
//   credited       = sum of document_total of its ISSUED credit notes
//   effective_due  = max(0, document_total - credited)
//   allocated      = net (positive - reversed) IN allocations to the invoice
//   refunded       = net OUT allocations to its credit notes (money handed back)
//   retained       = allocated - refunded            what the customer has paid and not got back
//   remaining_due  = max(0, effective_due - retained)
//   refundable     = max(0, retained - effective_due) what may still be refunded
//
// INVARIANTS (enforced by PostgreSQL; checked here for the memory store and for explanation):
//   retained >= 0                                   money already given back cannot be taken back (reverse the refund first)
//   a new allocation never makes retained > effective_due   (an invoice can never be over-paid by allocation)
//   a refund <= refundable and <= its credit note and <= the payment it gives back
//   Over-payment can only come from a credit note issued AFTER payment (then refundable > 0), never from an allocation.
//
// Worked examples (invoice 100,00): paid 100 then credit 30 -> effective_due 70, retained 100, remaining 0, refundable 30; refund 30 -> retained 70, refundable 0.
// credit 30 before payment -> effective_due 70, paid 70 -> PAID. Reversal of 40 on a paid invoice -> retained 60 -> remaining 10 (if nothing was refunded).

const isInt = (x) => Number.isInteger(x);

export function invoiceAmounts({ documentTotal, credited = 0, allocated = 0, refunded = 0 }) {
  for (const [k, v] of Object.entries({ documentTotal, credited, allocated, refunded })) if (!isInt(v)) throw new TypeError(`amounts are integer cents: ${k}=${v}`);
  const effectiveDue = Math.max(0, documentTotal - credited);
  const retained = allocated - refunded;
  return { documentTotal, credited, effectiveDue, allocated, refunded, retained, remainingDue: Math.max(0, effectiveDue - retained), refundable: Math.max(0, retained - effectiveDue) };
}

/** The invariants as a list of violations (empty = consistent). Used in tests and by the memory store's explanation of a refusal. */
export function amountViolations(a) {
  const v = [];
  if (a.retained < 0) v.push('RETAINED_NEGATIVE');
  if (a.allocated < 0) v.push('ALLOCATED_NEGATIVE');
  if (a.refunded < 0) v.push('REFUNDED_NEGATIVE');
  if (a.remainingDue > 0 && a.refundable > 0) v.push('DUE_AND_REFUNDABLE_AT_ONCE');
  return v;
}

export const sumCents = (rows) => rows.reduce((s, r) => s + r.amountCents, 0);
