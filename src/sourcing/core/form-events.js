// The events the Expert / Quick forms produce from what the owner TYPED. Pure (the screen and the tests build the same events). Every one carries `origin: 'expert'`: the QUOTE reducer then records, in the
// ledger, only the fields whose value CHANGED as the owner's edit; a field that was merely shown (prefilled) and saved again is not an edit and does not change who said it (core/case-facts.js).
export const num = (v) => (v === '' || v === undefined || v === null ? null : String(v).replace(',', '.'));
const int = (v) => (num(v) ? Number(num(v)) : null);
/** the 'quote' form (Case / Money) */
export const quoteFormEvent = (d, origin = 'expert') => ({ type: 'QUOTE', origin, quote: { unitPrice: num(d.unitPrice), ...(d.currency ? { currency: d.currency } : {}), qty: int(d.qty), moq: int(d.moq), incoterm: d.incoterm || null, leadTimeDays: num(d.leadTimeDays), carton: d.carton || null } });
/** the Quick form: a price is only recorded when one was typed; "I would buy" defaults to the MOQ for the economics */
export const quickQuoteEvent = (d, origin = 'expert') => (num(d.unitPrice) === null ? null : { type: 'QUOTE', origin, quote: { unitPrice: num(d.unitPrice), ...(d.currency ? { currency: d.currency } : {}), qty: int(d.qty) ?? int(d.moq), moq: int(d.moq), incoterm: d.incoterm || null } });
