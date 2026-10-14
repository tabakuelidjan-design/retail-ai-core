// ONE place that says how a price may be worded. A price is an amount AND a currency; each is CONFIRMED (a fact of the case), only PROPOSED (the supplier said it, nobody confirmed it), or UNKNOWN.
// "$" never means USD by itself: a currency read from a symbol is a proposal until the owner accepts it. Pure; nothing here confirms or invents anything.
import { factStatusBoard } from './case-facts.js';

export const PRICE_STATUS = Object.freeze({ CONFIRMED: 'CONFIRMED', CURRENCY_TO_CONFIRM: 'CURRENCY_TO_CONFIRM', PRICE_TO_CONFIRM: 'PRICE_TO_CONFIRM', UNKNOWN: 'UNKNOWN' });
const amountText = (v) => (v === null || v === undefined || v === '' ? null : String(v));

/**
 * Wording of a price from what is known about each half. `currency` is the CONFIRMED currency (or null).
 * @param {{ amount: any, amountConfirmed: boolean, currency: string|null, proposedCurrency?: string|null }} p
 * @returns {{ status: string, amount: string|null, currency: string|null, proposedCurrency: string|null, text: string, note: string }}
 */
export function priceWording({ amount, amountConfirmed, currency = null, proposedCurrency = null }) {
  const a = amountText(amount); const cur = currency || null; const prop = !cur && proposedCurrency ? proposedCurrency : null;
  if (a === null) return { status: PRICE_STATUS.UNKNOWN, amount: null, currency: cur, proposedCurrency: prop, text: 'inconnu', note: '' };
  if (!amountConfirmed) {
    const note = cur ? 'prix à confirmer' : 'prix et devise à confirmer';
    return { status: PRICE_STATUS.PRICE_TO_CONFIRM, amount: a, currency: cur, proposedCurrency: prop, text: `${a}${cur ? ` ${cur}` : ''} — ${note}`, note };
  }
  if (!cur) return { status: PRICE_STATUS.CURRENCY_TO_CONFIRM, amount: a, currency: null, proposedCurrency: prop, text: `${a} — devise à confirmer`, note: 'devise à confirmer' };
  return { status: PRICE_STATUS.CONFIRMED, amount: a, currency: cur, proposedCurrency: null, text: `${a} ${cur}`, note: '' };
}

/** The price of a case as the owner may read it, from the same fact board every screen uses. */
export function priceOfCase(state, locale = 'fr') {
  const b = Object.fromEntries(factStatusBoard(state, { locale, types: ['PRICE', 'CURRENCY'] }).map((x) => [x.fact_type, x]));
  const P = b.PRICE; const C = b.CURRENCY;
  const confirmed = P?.state === 'CONFIRMED'; const proposed = P?.state === 'PROPOSED' && P.proposedValueText;
  const curConfirmed = C?.state === 'CONFIRMED' ? String(C.value) : null; const curProposed = C?.state === 'PROPOSED' ? String(C.proposedValueText ?? '') || null : null;
  return priceWording({ amount: confirmed ? P.value : proposed ? P.proposedValueText : null, amountConfirmed: confirmed, currency: curConfirmed, proposedCurrency: curProposed });
}

/** Same wording for a plain quote object (price + currency typed or confirmed): an absent currency is never replaced by a default. */
export const priceOfQuote = (amount, currency) => priceWording({ amount, amountConfirmed: true, currency: currency || null });
