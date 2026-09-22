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
import { createFinanceService } from '../service.js';
import { configFromSettings } from '../settings.js';
import { createInboxService, createMemoryAttachmentStore } from '../inbox.js';
import { randomBytes } from 'node:crypto';

const MERCHANT = 'demo-merchant';
const DEMO_COMPANIES = [
  { name: 'Atelier Exemple SRL', digits: '0000000196', enterprise: '0000.000.196', vies: true, address: { street: 'Rue des Tests 5', postalCode: '5000', city: 'Namur', countryCode: 'BE' } },
  { name: 'Boutique Exemple SA', digits: '0000000097', enterprise: '0000.000.097', vies: true, address: { street: 'Place Demo 1', postalCode: '4000', city: 'Liege', countryCode: 'BE' } },
  { name: 'Exemple Sans TVA ASBL', digits: '0000000295', enterprise: '0000.000.295', vies: false, address: null },
];
const DEMO_PRICES = { 'demo://variant/1': { amount: '25.00', taxesIncluded: true }, 'demo://variant/2': { amount: '25.00', taxesIncluded: true }, 'demo://variant/3': { amount: '49.00', taxesIncluded: true }, 'demo://variant/4': { amount: '40.00', taxesIncluded: true } };
const PORT = Number(process.env.FINANCE_DEMO_PORT || 4311);
export const DEMO_TOKEN = 'demo-token-demo-token-demo-token';

function demoData() {
  const products = [
    { id: 'prod-demo-case', title: 'Demo case (personalised)', handle: 'demo-case', product_type: 'Cases', source_status: 'ACTIVE', source_id: 'demo://product/1' },
    { id: 'prod-demo-bottle', title: 'Demo bottle', handle: 'demo-bottle', product_type: 'Bottles', source_status: 'ACTIVE', source_id: 'demo://product/2' },
    { id: 'prod-demo-frame', title: 'Demo photo frame', handle: 'demo-frame', product_type: 'Frames', source_status: 'ACTIVE', source_id: 'demo://product/3' },
  ];
  const variants = [
    { id: 'var-demo-case-a', product_id: 'prod-demo-case', sku: 'CASE-A', title: 'Model A', source_id: 'demo://variant/1' },
    { id: 'var-demo-case-b', product_id: 'prod-demo-case', sku: 'CASE-B', title: 'Model B', source_id: 'demo://variant/2' },
    { id: 'var-demo-bottle', product_id: 'prod-demo-bottle', sku: 'BOT-500', title: 'Default Title', source_id: 'demo://variant/3' },
    { id: 'var-demo-frame', product_id: 'prod-demo-frame', sku: null, title: 'Default Title', source_id: 'demo://variant/4' }, // never sold: no VAT history, no SKU
  ];
  const day = (n) => `2026-09-${String(n).padStart(2, '0')}T10:00:00Z`;
  const mk = (id, n, ch) => ({ id, ordered_at: day(n), status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, source_name: ch, channel_handle: ch, customer_order_index: 1, journey_ready: true });
  const orders = [mk('ord-1001', 3, 'pos'), mk('ord-1002', 6, 'web'), mk('ord-1003', 9, 'pos'), mk('ord-1004', 14, 'web'), mk('ord-1005', 18, 'pos')];
  const line = (id, o, v, q, price, tax) => ({ id, order_id: o, variant_id: v, title_snapshot: v === 'var-demo-case-a' ? 'Demo case (personalised)' : 'Demo bottle', sku_snapshot: 'S', quantity: q, unit_price: price, discount_amount: 0, tax_amount: tax, tax_rate_bp: 2100 });
  const orderLines = [line('l1', 'ord-1001', 'var-demo-case-a', 1, 25, 4.34), line('l2', 'ord-1002', 'var-demo-bottle', 2, 30, 10.41), line('l3', 'ord-1003', 'var-demo-case-a', 2, 25, 8.68), line('l4', 'ord-1004', 'var-demo-bottle', 1, 30, 5.21), line('l5', 'ord-1005', 'var-demo-case-a', 1, 25, 4.34)];
  return { locations: [{ id: 'loc-1', name: 'Demo shop', type: 'physical', source_id: 'demo://location/1' }], products, variants, orders, orderLines, orderAttribution: [], refunds: [], refundLines: [], costs: [], snapshots: [{ variant_id: 'var-demo-case-a', location_id: 'loc-1', quantity: 12, synced_at: '2026-09-20T08:00:00Z' }, { variant_id: 'var-demo-case-a', location_id: 'loc-2', quantity: 3, synced_at: '2026-09-20T08:00:00Z' }, { variant_id: 'var-demo-case-b', location_id: 'loc-1', quantity: 2, synced_at: '2026-09-20T08:00:00Z' }, { variant_id: 'var-demo-bottle', location_id: 'loc-1', quantity: 0, synced_at: '2026-09-20T08:00:00Z' }], collections: [] };
}

/** A few synthetic documents so every screen has something to show. Nothing real. */
async function seedDemo({ store, attachmentStore, settings, cfg }) {
  const merchant = { type: 'merchant', id: 'demo' };
  const clock = { now: () => '2026-09-21T09:00:00.000Z', today: () => '2026-09-21' };
  const svc = createFinanceService({ store, config: configFromSettings(settings, MERCHANT), clock });
  const cust = (name, digits, city) => ({ kind: 'business', name, vatNumber: `BE${digits}`, address: { street: 'Rue des Tests 5', postalCode: '5000', city, countryCode: 'BE' } });
  const line = (description, qty, price, over = {}) => ({ description, quantity: String(qty), unitPrice: price, vatRate: '21', ...over });
  const mk = async (type, customer, lines, over = {}) => svc.create({ type, customer, lines, vat: { regime: 'domestic', confirmed: true }, revenueBasis: type === 'invoice' ? 'standalone_b2b' : undefined, ...over }, merchant);
  const issue = async (d) => { await svc.submit(d.id, merchant); return svc.decide(d.id, 'APPROVE', merchant); };
  const a = await issue(await mk('invoice', cust('Atelier Exemple SRL', '0000000196', 'Namur'), [line('Coques personnalisées', 12, '20.6612', { priceOrigin: 'GROSS_CATALOGUE', grossUnitPrice: '25.00', grossVatRate: '21', unitPrice: undefined, catalog: { source: 'retail_core', productId: 'prod-demo-case', variantId: 'var-demo-case-a', productTitle: 'Demo case (personalised)', variantTitle: 'Model A', sku: 'CASE-A' } }), line('Design', 3, '75.00')], { issueDate: '2026-08-12', dueDate: '2026-09-11' }));
  await svc.recordPayment(a.id, { amountCents: 10000, paidOn: '2026-09-02', method: 'bank_transfer' }, merchant).catch(() => {});
  await issue(await mk('invoice', cust('Boutique Exemple SA', '0000000097', 'Liège'), [line('Support de stand', 2, '140.00'), line('Livraison', 1, '18.00')], { issueDate: '2026-09-15', dueDate: '2026-10-15' }));
  await mk('invoice', cust('Exemple Sans TVA ASBL', '0000000295', 'Mons'), [line('Affiches', 20, '3.50')], { issueDate: '2026-09-20' });
  const q = await mk('quote', cust('Atelier Exemple SRL', '0000000196', 'Namur'), [line('Coffret cadeaux', 30, '48.00')], { issueDate: '2026-09-18' });
  await svc.sendQuote(q.id, merchant);
  // finance inbox / purchases
  const inbox = createInboxService({ store, attachments: attachmentStore, merchantId: MERCHANT, now: clock.now });
  const ubl = (id, net, vat) => Buffer.from(`<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>${id}</cbc:ID><cbc:IssueDate>2026-09-10</cbc:IssueDate><cbc:DueDate>2026-10-10</cbc:DueDate><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>BE0000000097</cbc:CompanyID></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>Fournisseur Exemple SRL</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty><cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${vat}</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">${net}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${(Number(net) + Number(vat)).toFixed(2)}</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal></Invoice>`);
  const one = (await inbox.ingest({ fileName: 'facture-F-2026-0042.xml', data: ubl('F-2026-0042', '250.00', '52.50'), source: 'peppol' })).item;
  await inbox.ingest({ fileName: 'scan-fournisseur.pdf', data: Buffer.from('%PDF-1.4\n% synthetic demo scan\n%%EOF\n') });
  const two = (await inbox.ingest({ fileName: 'facture-F-2026-0043.xml', data: ubl('F-2026-0043', '80.00', '16.80'), source: 'email' })).item;
  await inbox.validate(two.id, merchant); await inbox.markToPay(two.id, merchant);
  const three = (await inbox.ingest({ fileName: 'facture-F-2026-0041.xml', data: ubl('F-2026-0041', '100.00', '21.00'), source: 'upload' })).item;
  await inbox.validate(three.id, merchant); await inbox.markToPay(three.id, merchant); await inbox.pay(three.id, { paidOn: '2026-09-19', amountCents: 12100, reference: 'Virement demo' }, merchant);
  void one;
}

export async function startDemo(port = PORT) {
  const data = demoData();
  const cfg = mergeConfig({});
  const ledger = buildLedger(data, { config: cfg });
  const retail = createRetailAccess({ loadRetail: async () => ({ data, ledger }), listOrderRefs: async () => new Map(data.orders.map((o, i) => [o.id, String(1001 + i)])) });
  let settings = validateSettings({
    seller: { name: 'Demo Seller SRL', vatNumber: 'BE0000000097', enterpriseNumber: '0000.000.097', iban: 'BE68 5390 0754 7034', email: 'billing@demo-seller.example', address: { street: 'Rue de la Demo 1', postalCode: '5000', city: 'Namur', countryCode: 'BE' } },
    vat: { allowedRatesPercent: ['21', '12', '6', '0'] }, defaults: { language: 'fr', paymentTermsDays: 30, paymentTerms: 'Payable within 30 days by bank transfer' },
    accountant: { name: 'Comptable Exemple', email: 'comptable@cabinet.example', preferredFormat: 'zip', software: 'Logiciel Exemple', packageName: 'DEMO' },
    stock: { mode: 'live', locationId: null }, inbox: { financeAddress: 'finance@demo-seller.example', allowedSenders: ['invoices@fournisseur.example'] },
  }, DEFAULT_SETTINGS).settings;
  const store = createMemoryStore();
  const attachmentStore = createMemoryAttachmentStore();
  const stockCalls = [];
  const app = createFinanceApp({
    merchantId: MERCHANT, store, attachmentStore, token: DEMO_TOKEN, cookieName: 'fin_demo_sid',
    stockApplier: { async hasScope() { return true; }, async lookup(id) { return { inventoryItemId: `item-${id}`, tracked: true }; }, async adjust(a) { stockCalls.push(a); return { ok: true, adjustmentId: `demo://adjustment/${stockCalls.length}` }; } }, retail, retailConfig: cfg, timeZone: 'UTC',
    clock: { now: () => new Date().toISOString(), today: () => '2026-09-21' },
    retailHistory: async () => ({ completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-10-05T00:00:00.000Z' }),
    settings: { load: async () => structuredClone(settings), save: async (s) => { settings = structuredClone(s); }, saveLogo: async () => null },
    // Synthetic providers so the search can be tried without any network: three made-up companies, one of them not VAT-registered.
    lookupProviders: () => [{ name: 'demo-vat', async lookup(q) { const d = String(q.vatNumber ?? '').replace(/\D/g, '').slice(-10); const hit = DEMO_COMPANIES.find((c) => c.digits === d && c.vies); return hit ? { status: 'FOUND', source: 'vies', company: { name: hit.name, vatNumber: `BE${hit.digits}`, enterpriseNumber: hit.enterprise, address: hit.address, source: 'vies' } } : { status: q.vatNumber ? 'NOT_FOUND' : 'MANUAL_ENTRY_REQUIRED', company: null }; } }],
    priceSource: async (ids) => Object.fromEntries(ids.map((id) => [id, DEMO_PRICES[id]]).filter(([, v]) => v)),
    companyRegistry: () => ({ name: 'demo-registry', label: 'Demo register (synthetic)',
      async getByNumber(d) { const c = DEMO_COMPANIES.find((x) => x.digits === d); return c ? { status: 'FOUND', company: { name: c.name, enterpriseNumber: c.enterprise, digits: c.digits, status: 'Active', active: true, legalForm: null, personalData: false, address: c.address ?? { street: 'Rue Exemple 9', postalCode: '7000', city: 'Mons', countryCode: 'BE' } } } : { status: 'NOT_FOUND' }; },
      async search({ query }) { const t = query.toLowerCase(); return { status: 'OK', companies: DEMO_COMPANIES.filter((c) => c.name.toLowerCase().includes(t)).map((c) => ({ name: c.name, enterpriseNumber: c.enterprise, digits: c.digits, status: 'Active', active: true, legalForm: null, personalData: false, address: c.address ?? { street: 'Rue Exemple 9', postalCode: '7000', city: 'Mons', countryCode: 'BE' } })) }; } }),
    companySearchProvider: () => ({ name: 'demo-name', label: 'Demo directory (synthetic)', async search({ query }) { const t = query.toLowerCase(); return { status: 'OK', results: DEMO_COMPANIES.filter((c) => c.name.toLowerCase().includes(t)).map((c) => ({ name: c.name, enterpriseNumber: c.digits, status: 'Registered on Peppol since 2025-06-02' })) }; } }),
  });
  await seedDemo({ store, attachmentStore, settings, cfg });
  // DEMO ONLY (synthetic data, loopback): the demo signs the browser in itself so it can be looked at without typing the demo token.
  const handler = (req, res) => {
    // A stale cookie from a previous run of this demo (in-memory sessions are wiped on restart) must not be mistaken for "already signed in".
    const existing = /fin_demo_sid=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (req.method === 'GET' && req.url === '/' && (!existing || !app.sessions.has(existing))) {
      const sid = randomBytes(24).toString('hex'); app.sessions.set(sid, { csrf: randomBytes(24).toString('hex'), expires: Date.now() + 8 * 3600_000 });
      const orig = res.writeHead.bind(res); res.writeHead = (status, hdrs = {}) => orig(status, { ...hdrs, 'Set-Cookie': `fin_demo_sid=${sid}; HttpOnly; SameSite=Strict; Path=/` });
    }
    return app.handler(req, res);
  };
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, app, port };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { port } = await startDemo();
  console.log(`SYNTHETIC finance dashboard demo: http://127.0.0.1:${port}   token: ${DEMO_TOKEN}`);
}
