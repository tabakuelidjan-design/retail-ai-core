// Stable, extensible vocabulary of payment methods. A METHOD is a business type of means of payment; it is never a provider.
// Providers (SumUp, Shopify, a bank, ...) are provenance: payment.source ("manual", "bank", "provider:sumup", ...) and payment.externalReference. Finance does not model them.
// No payment secret (card number, token, mandate secret) is ever stored: only references that identify an operation.
// Adding a method = add it here AND in the CHECK of fin_payment_registry.method (one migration); nothing else depends on the list.

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'bancontact', 'direct_debit', 'other'];
/** 'unspecified' is the neutral default when a caller gives no method (older API calls); it is stored, never offered in the interface. */
export const STORED_METHODS = [...PAYMENT_METHODS, 'unspecified'];

export const isPaymentMethod = (m) => STORED_METHODS.includes(m);

const SOURCE = /^[a-z][a-z0-9_:.-]{0,39}$/;
/** Provenance label: lower-case token, e.g. manual | bank | provider:sumup. Anything else is refused (never guessed, never a free text). */
export const isPaymentSource = (s) => typeof s === 'string' && SOURCE.test(s);
export const DEFAULT_SOURCE = 'manual';
