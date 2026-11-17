// The optional bank connection of the hosted Finance service: OFF by default, chosen by environment variables, tested on SIMULATED Enable Banking answers only (no network, no bank, no real key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NoBankAdapter } from '../src/finance/bank.js';
import { bankAdapterFromEnv, PILOT_BANK } from '../src/finance/bank-provider-env.js';
import { structuredCommunication } from '../src/finance/pdf.js';
import { invoiceBody, startApp } from './finance-dashboard-helpers.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const VAULT = randomBytes(32);
const NOW = () => new Date('2026-11-17T09:00:00Z');
const ENV = { FINANCE_BANK_PROVIDER: 'enable-banking', ENABLE_BANKING_APPLICATION_ID: 'app-pilot-1', ENABLE_BANKING_PRIVATE_KEY: PEM, BANK_VAULT_KEY: VAULT.toString('base64') };

/** A scripted Enable Banking for KBC (simulated answers). `txs` = the booked transactions of the one business account. */
function kbc(txs) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url); seen.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
    if (u.pathname === '/auth') return reply(200, { url: 'https://auth.kbc.example.test/consent?x=1' });
    if (u.pathname === '/sessions') return reply(200, { session_id: 'sess-kbc-1', accounts: [{ uid: 'uid-kbc-1', account_id: { iban: 'BE68539007547034' }, name: 'Compte professionnel HABB', currency: 'EUR' }], access: { valid_until: '2027-02-15T09:00:00Z' } });
    if (u.pathname.endsWith('/balances')) return reply(200, { balances: [{ balance_type: 'CLBD', balance_amount: { amount: '842.10', currency: 'EUR' }, reference_date: '2026-11-16' }] });
    if (u.pathname.endsWith('/transactions')) return reply(200, { transactions: txs });
    return reply(404, {});
  };
  return { fetchImpl, seen };
}
const TX = (id, date, amount, dbit, remit, who) => ({ entry_reference: id, booking_date: date, value_date: date, status: 'BOOK', credit_debit_indicator: dbit ? 'DBIT' : 'CRDT', transaction_amount: { amount, currency: 'EUR' }, debtor: { name: who }, creditor: { name: who }, remittance_information: [remit] });

test('BP-1 OFF by default: no variable = today\'s behaviour (no bank), and an incomplete or invalid setting never stops the service and never logs a value', () => {
  assert.equal(bankAdapterFromEnv({}), NoBankAdapter); assert.equal(bankAdapterFromEnv({ FINANCE_BANK_PROVIDER: '' }), NoBankAdapter);
  const logs = []; const log = (l) => logs.push(l);
  assert.equal(bankAdapterFromEnv({ FINANCE_BANK_PROVIDER: 'enable-banking' }, { log }), NoBankAdapter);
  assert.equal(bankAdapterFromEnv({ ...ENV, ENABLE_BANKING_PRIVATE_KEY: 'SUPER-SECRET-NOT-A-KEY' }, { log }), NoBankAdapter);
  assert.equal(bankAdapterFromEnv({ ...ENV, ENABLE_BANKING_BANK: 'not-a-bank' }, { log }), NoBankAdapter);
  assert.equal(bankAdapterFromEnv({ ...ENV, BANK_VAULT_KEY: '' }, { log }), NoBankAdapter);
  assert.equal(bankAdapterFromEnv({ FINANCE_BANK_PROVIDER: 'other' }, { log }), NoBankAdapter);
  assert.equal(logs.length, 5); assert.ok(logs.every((l) => /NOT enabled/.test(l)));
  assert.ok(!logs.join('\n').includes('SUPER-SECRET') && !logs.join('\n').includes('PRIVATE KEY') && !logs.join('\n').includes('app-pilot-1'), 'only names are logged, never a value');
  assert.match(logs[0], /ENABLE_BANKING_APPLICATION_ID missing/); assert.match(logs[1], /not a readable PEM/); assert.match(logs[2], /not a bank of the catalogue/); assert.match(logs[3], /BANK_VAULT_KEY missing/);
  const wired = readFileSync(new URL('../src/finance/server/index.js', import.meta.url), 'utf8'); assert.match(wired, /bankAdapter: bankAdapterFromEnv\(env/, 'the Finance server takes its bank adapter from the environment');
});

test('BP-2 ON: complete settings give the read-only Enable Banking adapter for KBC (the pilot bank); a one-line PEM with \\n sequences is accepted; the other catalogue banks are selectable', () => {
  const a = bankAdapterFromEnv(ENV, { now: NOW }); assert.equal(a.configured, true); assert.equal(a.name, 'enable-banking'); assert.match(a.label, /KBC/); assert.equal(PILOT_BANK, 'kbc');
  assert.deepEqual([...a.scopes].sort(), ['accounts:read', 'balances:read', 'transactions:read']);
  const lg = []; assert.equal(bankAdapterFromEnv({ ...ENV, ENABLE_BANKING_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') }, { log: (l) => lg.push(l) }).configured, true, lg.join());
  for (const k of ['cbc', 'belfius', 'bnp-paribas-fortis', 'ing', 'argenta', 'beobank', 'axa']) assert.equal(bankAdapterFromEnv({ ...ENV, ENABLE_BANKING_BANK: k }).configured, true, k);
});

test('BP-3 SIMULATED JOURNEY in the real Finance app: status, connect (KBC, business, redirect to the app root), consent, first import shown in Finance, second pass without duplicates, balance, and a reconciliation of a bank credit to an invoice', async () => {
  const app0 = await startApp({ bankVaultKey: VAULT, today: '2026-11-17' });
  let inv; let ogm; let c0;
  try { c0 = await app0.authed(); const d = (await c0.post('/api/documents', invoiceBody({ issueDate: '2026-11-10' }))).data; await c0.post(`/api/documents/${d.id}/submit`, {}); inv = (await c0.post(`/api/documents/${d.id}/approve`, {})).data; ogm = structuredCommunication(inv.number); } finally { await app0.close(); }
  const sim = kbc([TX('kbc-1', '2026-11-12', '71.90', false, ogm, 'Client Exemple SA'), TX('kbc-2', '2026-11-13', '45.50', true, 'Achat fournitures', 'Fournisseur Test'), TX('kbc-3', '2026-11-14', '10.00', false, 'Virement divers', 'Autre Client')]);
  const adapter = bankAdapterFromEnv({ ...ENV, ENABLE_BANKING_BANK: 'kbc' }, { fetchImpl: sim.fetchImpl, now: NOW });
  const app = await startApp({ bankAdapter: adapter, bankVaultKey: VAULT, today: '2026-11-17' });
  try {
    const c = await app.authed();
    const st = (await c.get('/api/bank/status')).data; assert.equal(st.adapter.configured, true); assert.match(st.adapter.label, /KBC/); assert.equal(st.readOnly, true); assert.equal(st.paymentInitiation, false); assert.equal(st.state, 'NOT_CONNECTED');
    // the invoice of this journey (re-created in this app: a fresh store) so the credit can be matched
    const d = (await c.post('/api/documents', invoiceBody({ issueDate: '2026-11-10' }))).data; await c.post(`/api/documents/${d.id}/submit`, {}); const inv2 = (await c.post(`/api/documents/${d.id}/approve`, {})).data; assert.equal(structuredCommunication(inv2.number), ogm, 'same numbering: the simulated credit carries this invoice\'s structured communication');
    const conn = await c.post('/api/bank/connect', {}); assert.equal(conn.status, 200); assert.match(conn.data.authorizationUrl, /^https:\/\/auth\.kbc\.example\.test\//);
    const auth = sim.seen.find((r) => r.path === '/auth').body; assert.deepEqual(auth.aspsp, { name: 'KBC', country: 'BE' }); assert.equal(auth.psu_type, 'business'); assert.match(auth.redirect_url, /^https?:\/\/[^/]+\/$/, 'the return address is the app root, without a fragment');
    const ok = await c.post('/api/bank/consent', { code: 'code-kbc', state: conn.data.state }); assert.equal(ok.status, 200); assert.equal(ok.data.connected, true);
    const rows = async () => (await c.get('/api/bank/transactions')).data.rows;
    assert.equal((await c.post('/api/bank/sync', {})).status, 200);
    const list = await rows(); assert.equal(list.length, 3, 'the first import shows 3 transactions in Finance');
    const byRef = Object.fromEntries(list.map((t) => [t.providerTxId ?? t.id, t])); const credit = list.find((t) => t.amountCents === 7190); assert.ok(credit && credit.direction === 'IN'); assert.ok(list.some((t) => t.amountCents === -4550 && t.direction === 'OUT'));
    void byRef;
    assert.equal((await c.post('/api/bank/sync', {})).status, 200); assert.equal((await rows()).length, 3, 'the second pass adds nothing');
    const treasury = (await c.get('/api/treasury')).data; assert.match(JSON.stringify(treasury), /842|84210/, 'the bank balance (842,10 EUR) reaches the treasury view');
    const sug = (await c.get('/api/bank/suggestions')).data.rows.find((s) => s.candidates?.some((x) => x.documentId === inv2.id)); assert.ok(sug, 'the 71,90 credit is suggested against the invoice'); assert.equal(sug.status, 'EXACT');
    assert.equal((await c.get(`/api/documents/${inv2.id}`)).data.status, 'ISSUED', 'a suggestion never records a payment');
    const conf = await c.post(`/api/bank/transactions/${sug.transactionId}/confirm`, { documentId: inv2.id }); assert.equal(conf.status, 200); assert.equal((await c.get(`/api/documents/${inv2.id}`)).data.status, 'PAID');
    const everything = JSON.stringify([conn.data, ok.data, st, list, treasury]); assert.ok(!everything.includes('sess-kbc-1') && !everything.includes('PRIVATE KEY'), 'no session id, token or key in any response');
  } finally { await app.close(); }
});

test('BP-4 the wiring edit left the rest of the Finance server arguments alive (a trailing // comment once swallowed retail, priceSource and salesConnector)', () => {
  const src = readFileSync(new URL('../src/finance/server/index.js', import.meta.url), 'utf8');
  const code = src.split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n'); // comments removed: only live code is checked
  for (const needle of ['bankAdapter: bankAdapterFromEnv(env', 'retail: rt.retail', 'priceSource: createShopifyPriceSource(rt.shopify)', 'salesConnector: rt.shopify', 'merchantId: rt.merchant.id']) assert.ok(code.includes(needle), needle);
});
