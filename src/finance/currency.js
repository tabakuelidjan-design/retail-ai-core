// Finance v1 is EUR-only for every dashboard total and calculation. There is NO currency conversion anywhere in this product:
//   - an amount in the Finance currency (settings.defaults.currency, EUR) is added as is;
//   - a foreign-currency document keeps its original amount and currency, and is EXCLUDED from EUR totals;
//   - the one exception: a captured expense whose EUR amount was typed by the merchant (for example the amount actually charged
//     on the card statement) counts for that EUR amount - never for a computed one;
//   - no exchange rate is ever invented or fetched.
// Every aggregate that mixes documents goes through these helpers, so a total can never silently add EUR + USD + CNY.

/** A sales document is summed only when it is in the Finance currency. */
export const isNative = (doc, cur = 'EUR') => (doc.currency ?? cur) === cur;

/** EUR cents a supplier document contributes to Finance totals, or null when it must be left out (foreign currency, no typed EUR amount). */
export function eurOfSupplier(r, cur = 'EUR') {
  if ((r.currency ?? cur) === cur) return r.grossCents ?? 0;
  const typed = r.extraction?.capture?.eurAmountCents;
  return cur === 'EUR' && Number.isInteger(typed) && typed > 0 ? typed : null;
}

/** EUR cents actually paid for a paid supplier document (null = left out). A typed EUR amount is what left the account. */
export function eurPaidOfSupplier(r, cur = 'EUR') {
  if ((r.currency ?? cur) === cur) return r.paidAmountCents ?? r.grossCents ?? 0;
  return eurOfSupplier(r, cur);
}

/** Number of supplier documents in `rows` that cannot enter EUR totals. */
export const countForeignSupplier = (rows, cur = 'EUR') => rows.filter((r) => eurOfSupplier(r, cur) === null).length;

/** Sum of a list of supplier documents in EUR (documents left out contribute nothing; count them with countForeignSupplier). */
export const sumEur = (rows, cur = 'EUR') => rows.reduce((a, r) => a + (eurOfSupplier(r, cur) ?? 0), 0);
