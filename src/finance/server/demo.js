#!/usr/bin/env node
// SYNTHETIC demo of the finance dashboard: in-memory store, made-up companies, made-up orders, no network, no real data.
// For reviewing the UI and workflow safely:  npm run finance:demo   ->  http://127.0.0.1:4311  (token: demo-token-demo-token-demo-token)

import http from 'node:http';
import { mergeConfig } from '../../metrics/config.js';
import { buildLedger } from '../../metrics/ledger.js';
import { createMemoryStore } from '../memory-store.js';
import { createRetailAccess } from '../retail-access.js';
import { DEFAULT_SETTINGS, validateSettings } from '../settings.js';
import { createFinanceApp } from './app.js';

const MERCHANT = 'demo-merchant';
const DEMO_COMPANIES = [
  { name: 'Atelier Exemple SRL', digits: '0000000196', enterprise: '0000.000.196', vies: true, address: { street: 'Rue des Tests 5', postalCode: '5000', city: 'Namur', countryCode: 'BE' } },
  { name: 'Boutique Exemple SA', digits: '0000000097', enterprise: '0000.000.097', vies: true, address: { street: 'Place Demo 1', postalCode: '4000', city: 'Liege', countryCode: 'BE' } },
  { name: 'Exemple Sans TVA ASBL', digits: '0000000295', enterprise: '0000.000.295', vies: false, address: null },
];
const PORT = Number(process.env.FINANCE_DEMO_PORT || 4311);
export const DEMO_TOKEN = 'demo-token-demo-token-demo-token';

function demoData() {
  const products = [{ id: 'p1', title: 'Demo case (personalised)', handle: 'demo-case', product_type: 'Cases' }, { id: 'p2', title: 'Demo bottle', handle: 'demo-bottle', product_type: 'Bottles' }];
  const variants = [{ id: 'v1', product_id: 'p1', sku: 'A' }, { id: 'v2', product_id: 'p2', sku: 'B' }];
  const day = (n) => `2026-09-${String(n).padStart(2, '0')}T10:00:00Z`;
  const mk = (id, n, ch) => ({ id, ordered_at: day(n), status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, source_name: ch, channel_handle: ch, customer_order_index: 1, journey_ready: true });
  const orders = [mk('ord-1001', 3, 'pos'), mk('ord-1002', 6, 'web'), mk('ord-1003', 9, 'pos'), mk('ord-1004', 14, 'web'), mk('ord-1005', 18, 'pos')];
  const line = (id, o, v, q, price, tax) => ({ id, order_id: o, variant_id: v, title_snapshot: v === 'v1' ? 'Demo case (personalised)' : 'Demo bottle', sku_snapshot: 'S', quantity: q, unit_price: price, discount_amount: 0, tax_amount: tax, tax_rate_bp: 2100 });
  const orderLines = [line('l1', 'ord-1001', 'v1', 1, 25, 4.34), line('l2', 'ord-1002', 'v2', 2, 30, 10.41), line('l3', 'ord-1003', 'v1', 2, 25, 8.68), line('l4', 'ord-1004', 'v2', 1, 30, 5.21), line('l5', 'ord-1005', 'v1', 1, 25, 4.34)];
  return { products, variants, orders, orderLines, orderAttribution: [], refunds: [], refundLines: [], costs: [], snapshots: [], collections: [] };
}

export async function startDemo(port = PORT) {
  const data = demoData();
  const cfg = mergeConfig({});
  const ledger = buildLedger(data, { config: cfg });
  const retail = createRetailAccess({ loadRetail: async () => ({ data, ledger }), listOrderRefs: async () => new Map(data.orders.map((o, i) => [o.id, String(1001 + i)])) });
  let settings = validateSettings({
    seller: { name: 'Demo Seller SRL', vatNumber: 'BE0000000097', enterpriseNumber: '0000.000.097', iban: 'BE68 5390 0754 7034', email: 'billing@demo-seller.example', address: { street: 'Rue de la Demo 1', postalCode: '5000', city: 'Namur', countryCode: 'BE' } },
    vat: { allowedRatesPercent: ['21', '12', '6', '0'] }, defaults: { language: 'fr', paymentTermsDays: 30, paymentTerms: 'Payable within 30 days by bank transfer' },
  }, DEFAULT_SETTINGS).settings;
  const app = createFinanceApp({
    merchantId: MERCHANT, store: createMemoryStore(), token: DEMO_TOKEN, retail, retailConfig: cfg, timeZone: 'UTC',
    clock: { now: () => new Date().toISOString(), today: () => '2026-09-21' },
    retailHistory: async () => ({ completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-10-05T00:00:00.000Z' }),
    settings: { load: async () => structuredClone(settings), save: async (s) => { settings = structuredClone(s); }, saveLogo: async () => null },
    // Synthetic providers so the search can be tried without any network: three made-up companies, one of them not VAT-registered.
    lookupProviders: () => [{ name: 'demo-vat', async lookup(q) { const d = String(q.vatNumber ?? '').replace(/\D/g, '').slice(-10); const hit = DEMO_COMPANIES.find((c) => c.digits === d && c.vies); return hit ? { status: 'FOUND', source: 'vies', company: { name: hit.name, vatNumber: `BE${hit.digits}`, enterpriseNumber: hit.enterprise, address: hit.address, source: 'vies' } } : { status: q.vatNumber ? 'NOT_FOUND' : 'MANUAL_ENTRY_REQUIRED', company: null }; } }],
    companyRegistry: () => ({ name: 'demo-registry', label: 'Demo register (synthetic)',
      async getByNumber(d) { const c = DEMO_COMPANIES.find((x) => x.digits === d); return c ? { status: 'FOUND', company: { name: c.name, enterpriseNumber: c.enterprise, digits: c.digits, status: 'Active', active: true, legalForm: null, personalData: false, address: c.address ?? { street: 'Rue Exemple 9', postalCode: '7000', city: 'Mons', countryCode: 'BE' } } } : { status: 'NOT_FOUND' }; },
      async search({ query }) { const t = query.toLowerCase(); return { status: 'OK', companies: DEMO_COMPANIES.filter((c) => c.name.toLowerCase().includes(t)).map((c) => ({ name: c.name, enterpriseNumber: c.enterprise, digits: c.digits, status: 'Active', active: true, legalForm: null, personalData: false, address: c.address ?? { street: 'Rue Exemple 9', postalCode: '7000', city: 'Mons', countryCode: 'BE' } })) }; } }),
    companySearchProvider: () => ({ name: 'demo-name', label: 'Demo directory (synthetic)', async search({ query }) { const t = query.toLowerCase(); return { status: 'OK', results: DEMO_COMPANIES.filter((c) => c.name.toLowerCase().includes(t)).map((c) => ({ name: c.name, enterpriseNumber: c.digits, status: 'Registered on Peppol since 2025-06-02' })) }; } }),
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, app, port };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { port } = await startDemo();
  console.log(`SYNTHETIC finance dashboard demo: http://127.0.0.1:${port}   token: ${DEMO_TOKEN}`);
}
