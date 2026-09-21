// Synthetic finance fixtures only: made-up companies, made-up VAT numbers, made-up IBAN. No real customer or invoice data.

import { createMemoryStore } from '../src/finance/memory-store.js';
import { createFinanceService } from '../src/finance/service.js';

export const MERCHANT = 'merchant-test-1';
export const MERCHANT_ACTOR = { type: 'merchant', id: 'owner' };
export const AGENT_ACTOR = { type: 'agent', id: 'finance-agent' };

export const SELLER = {
  name: 'Example Seller SRL', vatNumber: 'BE0000000097', enterpriseNumber: '0000.000.097', iban: 'BE00 0000 0000 0000', bic: 'EXAMPLEB',
  address: { street: 'Rue Exemple 1', postalCode: '1000', city: 'Bruxelles', countryCode: 'BE' }, email: 'billing@seller.example',
};

export const CUSTOMER = {
  kind: 'business', name: 'Client Exemple SA', vatNumber: 'BE0000000196', enterpriseNumber: '0000.000.196',
  address: { street: 'Avenue Test 2', postalCode: '5000', city: 'Namur', countryCode: 'BE' },
};

export const CONFIG = {
  merchantId: MERCHANT, seller: SELLER, vat: { allowedRatesBp: [2100, 600, 0] },
  defaults: { currency: 'EUR', language: 'fr', paymentTermsDays: 30 },
};

export const LINES = [
  { description: 'Item A', quantity: '2', unitPrice: '10.00', vatRate: '21' },
  { description: 'Item B', quantity: '1', unitPrice: '50.00', vatRate: '6', discountPercent: '10' },
];
export const VAT_OK = { regime: 'domestic', confirmed: true };

export function makeService({ ledger = null, today = '2026-09-21', config = CONFIG } = {}) {
  const store = createMemoryStore();
  let t = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 8, 21, 10, 0, t++)).toISOString(), today: () => today };
  const clockRef = { today };
  const svc = createFinanceService({ store, config, clock: { now: clock.now, today: () => clockRef.today }, ledgerProvider: async () => ledger });
  return { store, svc, setToday: (d) => { clockRef.today = d; } };
}

export const draftInvoice = (over = {}) => ({ type: 'invoice', customer: CUSTOMER, lines: LINES, vat: VAT_OK, revenueBasis: 'standalone_b2b', issueDate: '2026-09-21', ...over });

/** Create, submit and approve an invoice; returns the issued document. */
export async function issueInvoice(svc, over = {}) {
  const d = await svc.create(draftInvoice(over), AGENT_ACTOR);
  await svc.submit(d.id, AGENT_ACTOR);
  return svc.decide(d.id, 'APPROVE', MERCHANT_ACTOR);
}
