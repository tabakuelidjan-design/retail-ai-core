// Test harness for the finance dashboard: a REAL http server (ephemeral port, loopback) around createFinanceApp with in-memory
// stores, a fake retail source and in-memory settings. Synthetic data only.

import http from 'node:http';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createRetailAccess } from '../src/finance/retail-access.js';
import { DEFAULT_SETTINGS } from '../src/finance/settings.js';
import { createFinanceApp } from '../src/finance/server/app.js';
import { makeMarketingData } from './fixtures/marketing-sample.js';

export const TOKEN = 'test-token-test-token-test-token';
export const VALID_IBAN = 'BE68 5390 0754 7034';

export function baseSettings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.seller = { name: 'Example Seller SRL', vatNumber: 'BE0000000097', enterpriseNumber: '0000.000.097', iban: VALID_IBAN, bic: null, email: 'billing@seller.example', phone: null, address: { street: 'Rue Exemple 1', postalCode: '1000', city: 'Bruxelles', countryCode: 'BE' } };
  s.vat.allowedRatesBp = [2100, 600, 0];
  s.defaults.paymentTerms = 'Payable within 30 days by bank transfer';
  return s;
}

export function makeRetail() {
  const data = makeMarketingData();
  data.orderLines = data.orderLines.map((l) => ({ ...l, tax_rate_bp: 2100 }));
  const ledger = buildLedger(data, { config: mergeConfig({}) });
  const refs = new Map(data.orders.map((o, i) => [o.id, String(1001 + i)]));
  return { data, ledger, retail: createRetailAccess({ loadRetail: async () => ({ data, ledger }), listOrderRefs: async () => refs, ttlMs: 0 }) };
}

/** @param {{merchantId?: string, store?: object, settings?: object, retail?: object|null, today?: string, lookupProviders?: Function, audit?: Function}} o */
export async function startApp(o = {}) {
  const store = o.store ?? createMemoryStore();
  let settings = o.settings ?? baseSettings();
  const fake = o.retail === undefined ? makeRetail() : null;
  const retail = o.retail === undefined ? fake.retail : o.retail;
  const clockRef = { today: o.today ?? '2026-09-21' };
  const audits = [];
  const logos = [];
  const app = createFinanceApp({
    merchantId: o.merchantId ?? 'merchant-test-1', store, token: TOKEN, retail, retailConfig: mergeConfig({}), timeZone: 'UTC',
    clock: { now: () => `${clockRef.today}T10:00:00.000Z`, today: () => clockRef.today },
    retailHistory: async () => o.history ?? null,
    settings: { load: async () => structuredClone(settings), save: async (s) => { settings = structuredClone(s); }, saveLogo: async ({ ext, bytes }) => { logos.push(bytes.length); return `data/local/finance/logo.${ext}`; } },
    audit: o.audit ?? (async (e) => { audits.push(e); }),
    lookupProviders: o.lookupProviders, companySearchProvider: o.companySearchProvider, companyRegistry: o.companyRegistry, priceSource: o.priceSource, stockApplier: o.stockApplier, mailAdapter: o.mailAdapter, accessPoint: o.accessPoint, bankAdapter: o.bankAdapter, bankVaultKey: o.bankVaultKey,
    ...(o.deps ?? {}),
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /** A logged-in (or anonymous) API client with its own cookie jar and CSRF token. */
  function client() {
    const c = { cookie: null, csrf: null };
    c.raw = async (method, path, body, extra = {}) => {
      const headers = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...(c.csrf && !extra.noCsrf ? { 'X-CSRF-Token': c.csrf } : {}), ...(extra.headers ?? {}) };
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : (extra.rawBody ?? JSON.stringify(body)) });
      const ct = res.headers.get('content-type') ?? '';
      const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers };
    };
    c.login = async (token = TOKEN) => { const r = await c.raw('POST', '/api/login', { token }, { noCsrf: true }); if (r.status === 200) { c.cookie = r.headers.get('set-cookie').split(';')[0]; c.csrf = r.data.csrf; } return r; };
    for (const m of ['GET', 'POST', 'PUT']) c[m.toLowerCase()] = (path, body) => c.raw(m, path, body);
    return c;
  }
  const authed = async () => { const c = client(); const r = await c.login(); if (r.status !== 200) throw new Error('login failed'); return c; };
  return { base, port, server, store, app, client, authed, audits, logos, fake, setToday: (d) => { clockRef.today = d; }, getSettings: () => settings, setSettings: (s) => { settings = s; }, close: () => new Promise((r) => server.close(r)) };
}

export const CUSTOMER_BODY = { kind: 'business', name: 'Client Exemple SA', vatNumber: 'BE0000000196', address: { street: 'Avenue Test 2', postalCode: '5000', city: 'Namur', countryCode: 'BE' } };
export const LINES_BODY = [
  { description: 'Item A', quantity: '2', unitPrice: '10.00', vatRate: '21' },
  { description: 'Item B', quantity: '1', unitPrice: '50.00', vatRate: '6', discountPercent: '10' },
];
export const invoiceBody = (over = {}) => ({ type: 'invoice', customer: CUSTOMER_BODY, lines: LINES_BODY, vat: { regime: 'domestic', confirmed: true }, revenueBasis: 'standalone_b2b', issueDate: '2026-09-21', ...over });
