import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { READ_ONLY_SCOPES, assertReadOnlyAdapter, createConsentVault, createFakeBankAdapter, loadVaultKey, parseBankCsv } from '../src/finance/bank.js';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { structuredCommunication } from '../src/finance/pdf.js';
import { suggestForCredit, suggestForDebit } from '../src/finance/reconcile.js';
import { buildTreasury } from '../src/finance/treasury.js';
import { baseSettings, invoiceBody, startApp } from './finance-dashboard-helpers.js';

// SYNTHETIC only: invented customers, invented IBAN, an invented token.
const KEY = randomBytes(32);
const TOKEN = 'synthetic-read-only-token-0123456789';
const tx = (id, date, amountCents, over = {}) => ({ id, accountId: 'acc-1', date, amountCents, currency: 'EUR', counterpartyName: '', reference: '', ...over });

async function harness({ transactions = [], adapter, vaultKey = KEY, today = '2026-09-21', grants } = {}) {
  const bank = adapter ?? createFakeBankAdapter({ transactions, grants });
  const audits = []; const a = await startApp({ bankAdapter: bank, bankVaultKey: vaultKey, today, audit: async (e) => { audits.push(e); } });
  const c = await a.authed();
  const issue = async (lines, over = {}) => { const d = (await c.post('/api/documents', invoiceBody({ lines, ...over }))).data; await c.post(`/api/documents/${d.id}/submit`, {}); const r = await c.post(`/api/documents/${d.id}/approve`, {}); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  const connect = async () => { await c.post('/api/bank/connect', {}); return c.post('/api/bank/consent', { code: 'auth-code', state: 'st-1' }); };
  return { a, c, bank, audits, issue, connect, close: () => a.close() };
}
const line = (price) => [{ description: 'Service', quantity: '1', unitPrice: price, vatRate: '21' }];
const withH = (cfg, fn) => async () => { const h = await harness(cfg); try { await fn(h); } finally { await h.close(); } };
const sync = (h) => h.c.post('/api/bank/sync', {});

// ---------- read-only boundary ----------
test('READ ONLY: an adapter that exposes any payment / transfer / beneficiary / scheduling capability, or a non read-only scope, is refused', () => {
  const ok = createFakeBankAdapter(); assert.ok(assertReadOnlyAdapter(ok));
  assert.deepEqual([...ok.scopes].sort(), [...READ_ONLY_SCOPES].sort());
  for (const bad of ['initiatePayment', 'createTransfer', 'addBeneficiary', 'schedulePayment', 'approvePayment', 'payments', 'pay', 'sendMoney', 'setStandingOrder', 'debitAccount', 'withdraw']) assert.throws(() => assertReadOnlyAdapter({ ...ok, [bad]: () => {} }), /BANK_ADAPTER_MUST_BE_READ_ONLY/, bad);
  assert.throws(() => assertReadOnlyAdapter({ ...ok, scopes: ['accounts:read', 'payments:write'] }), /BANK_ADAPTER_SCOPE_NOT_READ_ONLY/);
  assert.throws(() => assertReadOnlyAdapter({ name: 'x', label: 'x', configured: true, scopes: [] }), /BANK_ADAPTER_INCOMPLETE/);
});
test('READ ONLY by construction: no payment-initiation code, route or column exists anywhere in the bank module, the server or the schema', () => {
  const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['bank.js', 'bank-service.js', 'reconcile.js', 'treasury.js']) {
    // the guard's own deny-list (FORBIDDEN) is the only place these words are allowed to appear
    const src = strip(readFileSync(new URL(`../src/finance/${f}`, import.meta.url), 'utf8')).split('\n').filter((l) => !l.includes('const FORBIDDEN')).join('\n');
    assert.ok(!/initiatePayment|createPayment|paymentInitiation\s*[:=]\s*true|\/payments|\/transfers|beneficiar|standingOrder|payment_initiation|PISP/i.test(src.replace(/paymentInitiation: false/g, '')), `${f} must not contain payment initiation`);
  }
  const server = readFileSync(new URL('../src/finance/server/app.js', import.meta.url), 'utf8');
  const routes = [...server.matchAll(/on\('(?:GET|POST|PUT)',\s*[`'](\/api\/(?:bank|cash|treasury)[^`']*)/g)].map((m) => m[1]);
  assert.ok(routes.length >= 10); assert.ok(routes.every((r) => !/pay|transfer|initiat|beneficiar|schedul/i.test(r.replace(/\/api\/bank\/transactions\/\$\{P\}\/(confirm|ignore)/, ''))), routes.join(', '));
  const sql = readFileSync(new URL('../supabase/migrations/20260922220000_finance_bank_treasury.sql', import.meta.url), 'utf8');
  assert.match(sql, /scopes <@ array\['accounts:read', 'balances:read', 'transactions:read'\]/); assert.ok(!/payment_initiation|beneficiar/i.test(sql.replace(/--.*$/gm, '')));
});
test('status states it plainly: read only, no payment initiation, scopes listed', withH({}, async (h) => {
  const st = (await h.c.get('/api/bank/status')).data;
  assert.equal(st.readOnly, true); assert.equal(st.paymentInitiation, false); assert.deepEqual(st.adapter.scopes, READ_ONLY_SCOPES); assert.equal(st.state, 'NOT_CONNECTED'); assert.equal(st.csvImportAvailable, true);
}));

// ---------- token security ----------
test('the bank token never reaches the browser: no endpoint returns it (or its ciphertext), status shows metadata only', withH({}, async (h) => {
  await h.issue(line('100.00'));
  const consent = await h.connect(); assert.equal(consent.status, 200); assert.equal(consent.data.connected, true);
  await sync(h);
  const bodies = [consent.data, (await h.c.get('/api/bank/status')).data, (await h.c.get('/api/bank/transactions')).data, (await h.c.get('/api/bank/suggestions')).data, (await h.c.get('/api/treasury')).data, (await h.c.get('/api/connectors')).data, (await h.c.get('/api/actions')).data];
  const all = JSON.stringify(bodies); const stored = await h.a.store.getBankConnection('merchant-test-1');
  assert.ok(!all.includes(TOKEN) && !all.includes(stored.tokenCipher) && !/tokenCipher|token_ciphertext|access_token/i.test(all));
  assert.deepEqual(Object.keys(consent.data).sort(), ['accountIds', 'connected', 'expiresAt', 'grantedAt', 'lastUsedAt', 'provider', 'revokedAt', 'scopes', 'state']);
}));
test('the token is encrypted at rest (AES-256-GCM, key outside the database) and unusable without the key; the key must be 32 bytes', async () => {
  const store = createMemoryStore(); const vault = createConsentVault({ store, merchantId: 'm1', key: KEY });
  await vault.save({ provider: 'p', token: TOKEN, expiresAt: '2027-01-01T00:00:00Z', accountIds: ['a'], scopes: READ_ONLY_SCOPES });
  const row = await store.getBankConnection('m1'); assert.ok(!row.tokenCipher.includes(TOKEN) && !Buffer.from(row.tokenCipher, 'base64').includes(Buffer.from(TOKEN)));
  assert.equal(await vault.use(async (t) => t === TOKEN), true);
  await assert.rejects(() => createConsentVault({ store, merchantId: 'm1', key: randomBytes(32) }).use(async () => 1)); // wrong key: authentication fails
  await assert.rejects(() => createConsentVault({ store, merchantId: 'm1', key: null }).use(async () => 1), /BANK_VAULT_NOT_CONFIGURED/);
  await assert.rejects(() => vault.save({ provider: 'p', token: 't', scopes: ['accounts:read', 'payments:write'] }), /BANK_SCOPE_NOT_READ_ONLY/);
  assert.equal(loadVaultKey({}), null); assert.throws(() => loadVaultKey({ BANK_VAULT_KEY: Buffer.alloc(16).toString('base64') }), /32_BYTES/); assert.equal(loadVaultKey({ BANK_VAULT_KEY: KEY.toString('base64') }).length, 32);
  assert.equal((await vault.view()).connected, true); assert.ok(!JSON.stringify(await vault.view()).includes(TOKEN));
});
test('the token is never logged: nothing printed and no audit entry contains it, through connect, sync, use and disconnect', async () => {
  const logs = []; const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
  const h = await harness({ transactions: [tx('t1', '2026-09-20', 12100, { reference: 'x' })] });
  try { await h.connect(); await sync(h); await h.c.post('/api/bank/disconnect', {}); } finally { Object.assign(console, orig); await h.close(); }
  assert.ok(![...logs, JSON.stringify(h.audits)].join('\n').includes(TOKEN)); assert.ok(h.audits.some((e) => e.action === 'BANK_CONSENT_GRANTED') && h.audits.some((e) => e.action === 'BANK_SYNC') && h.audits.some((e) => e.action === 'BANK_DISCONNECTED'), 'every use is audited');
});
test('revoking: the local token is wiped, later reads refuse without calling the bank; a failing remote revocation still revokes locally', async () => {
  for (const grants of ['ok', 'revoke-fails']) {
    const h = await harness({ grants, transactions: [tx('t1', '2026-09-20', 100)] });
    try {
      await h.connect(); assert.equal((await sync(h)).status, 200); const before = h.bank.calls.transactions;
      const r = (await h.c.post('/api/bank/disconnect', {})).data; assert.equal(r.revoked, true); assert.equal(r.remote, grants === 'ok' ? 'REVOKED' : 'REMOTE_REVOCATION_FAILED'); assert.equal(h.bank.calls.revoked, 1);
      assert.equal((await h.a.store.getBankConnection('merchant-test-1')).tokenCipher, null, 'the encrypted token is wiped');
      const s = await sync(h); assert.equal(s.status, 409); assert.equal(s.data.error.code, 'BANK_CONSENT_REVOKED'); assert.equal(h.bank.calls.transactions, before, 'the bank is not contacted after revocation');
      assert.equal((await h.c.get('/api/bank/status')).data.state, 'REVOKED');
    } finally { await h.close(); }
  }
});
test('an expired consent is refused before any bank call and reported as EXPIRED', async () => {
  const h = await harness({ today: '2027-02-01' }); // the synthetic consent expires 2026-12-31
  try {
    await h.a.store.saveBankConnection({ merchantId: 'merchant-test-1', provider: 'fake-bank', tokenCipher: 'x', tokenFingerprint: 'f', scopes: READ_ONLY_SCOPES, accountIds: [], grantedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-31T00:00:00.000Z' });
    assert.equal((await h.c.get('/api/bank/status')).data.state, 'EXPIRED');
    const s = await sync(h); assert.equal(s.data.error.code, 'BANK_CONSENT_EXPIRED'); assert.equal(h.bank.calls.accounts, 0);
  } finally { await h.close(); }
});

// ---------- reconciliation ----------
test('EXACT: the structured communication and the amount match one open invoice; nothing is recorded until the merchant confirms, then the invoice is PAID', async () => {
  const h = await harness({}); try {
    const inv = await h.issue(line('100.00'), { dueDate: '2026-09-25' }); const ogm = structuredCommunication(inv.number);
    h.bank.transactions = async () => [tx('t-exact', '2026-09-20', 12100, { reference: ogm, counterpartyName: 'Client Exemple SA' })];
    await h.connect(); await sync(h);
    const s = (await h.c.get('/api/bank/suggestions')).data.rows[0]; assert.equal(s.status, 'EXACT'); assert.equal(s.confidence, 1); assert.equal(s.candidates[0].documentId, inv.id); assert.ok(s.candidates[0].reasons.includes('STRUCTURED_REFERENCE_MATCHES'));
    assert.equal((await h.c.get(`/api/documents/${inv.id}`)).data.status, 'ISSUED', 'suggesting never records a payment');
    const c = await h.c.post(`/api/bank/transactions/${s.transactionId}/confirm`, { documentId: inv.id }); assert.equal(c.status, 200); assert.equal(c.data.amountCents, 12100);
    const d = (await h.c.get(`/api/documents/${inv.id}`)).data; assert.equal(d.status, 'PAID'); assert.match(d.payments[0].reference, /^bank:t-exact$/);
    assert.equal((await h.c.get('/api/bank/suggestions')).data.rows.length, 0);
    assert.equal((await h.c.post(`/api/bank/transactions/${s.transactionId}/confirm`, { documentId: inv.id })).status, 409, 'a transaction is reconciled once'); assert.equal((await h.c.get(`/api/documents/${inv.id}`)).data.payments.length, 1);
  } finally { await h.close(); }
});
test('AMBIGUOUS: two equal invoices for the same customer -> no automatic choice, the merchant picks', async () => {
  const h = await harness({}); try {
    const a = await h.issue(line('100.00')); const b = await h.issue(line('100.00'));
    h.bank.transactions = async () => [tx('t-amb', '2026-09-20', 12100, { counterpartyName: 'Client Exemple SA', reference: 'paiement' })];
    await h.connect(); await sync(h);
    const s = (await h.c.get('/api/bank/suggestions')).data.rows[0]; assert.equal(s.status, 'AMBIGUOUS'); assert.equal(s.candidates.length, 2);
    assert.equal((await h.c.post(`/api/bank/transactions/${s.transactionId}/confirm`, { documentId: b.id })).status, 200);
    assert.equal((await h.c.get(`/api/documents/${b.id}`)).data.status, 'PAID'); assert.equal((await h.c.get(`/api/documents/${a.id}`)).data.status, 'ISSUED');
  } finally { await h.close(); }
});
test('PARTIAL and OVERPAYMENT: a partial payment is recorded as such; nothing above what is due is ever recorded', async () => {
  const h = await harness({}); try {
    const inv = await h.issue(line('100.00')); const ogm = structuredCommunication(inv.number);
    h.bank.transactions = async () => [tx('t-part', '2026-09-18', 5000, { reference: ogm })];
    await h.connect(); await sync(h);
    const part = (await h.c.get('/api/bank/suggestions')).data.rows[0];
    assert.equal(part.status, 'PARTIAL'); assert.equal(part.shortfallCents, 7100);
    assert.equal((await h.c.post(`/api/bank/transactions/${part.transactionId}/confirm`, { documentId: inv.id })).status, 200);
    const d = (await h.c.get(`/api/documents/${inv.id}`)).data; assert.equal(d.status, 'PARTIALLY_PAID'); assert.equal(d.settlement.remainingCents, 7100);
  } finally { await h.close(); }
  const h2 = await harness({}); try {
    const inv = await h2.issue(line('100.00')); const ogm = structuredCommunication(inv.number);
    h2.bank.transactions = async () => [tx('t-over', '2026-09-19', 15000, { reference: ogm })];
    await h2.connect(); await sync(h2);
    const s = (await h2.c.get('/api/bank/suggestions')).data.rows[0]; assert.equal(s.status, 'OVERPAYMENT'); assert.equal(s.surplusCents, 2900);
    assert.equal((await h2.c.post(`/api/bank/transactions/${s.transactionId}/confirm`, { documentId: inv.id, amount: '150.00' })).status, 422, 'cannot record more than is due');
    const ok = await h2.c.post(`/api/bank/transactions/${s.transactionId}/confirm`, { documentId: inv.id }); assert.equal(ok.data.amountCents, 12100); assert.equal(ok.data.surplusCents, 2900);
    assert.equal((await h2.c.get(`/api/documents/${inv.id}`)).data.status, 'PAID');
  } finally { await h2.close(); }
});
test('idempotent: syncing or importing the same transactions again stores nothing twice', async () => {
  const h = await harness({ transactions: [tx('t1', '2026-09-20', 100), tx('t2', '2026-09-20', 200)] }); try {
    await h.connect(); assert.equal((await sync(h)).data.created, 2); assert.equal((await sync(h)).data.created, 0); assert.equal((await h.c.get('/api/bank/transactions')).data.rows.length, 2);
    const csv = 'Date;Montant;Communication;Contrepartie\n2026-09-10;121,00;+++000/0000/00097+++;Client Exemple SA\n2026-09-11;-50,00;achat;Fournisseur\n';
    assert.equal((await h.c.post('/api/bank/import-csv', { csv })).data.created, 2); const again = (await h.c.post('/api/bank/import-csv', { csv })).data; assert.equal(again.created, 0); assert.equal(again.duplicates, 2);
  } finally { await h.close(); }
});
test('supplier payment: a debit with the supplier payment reference marks the validated supplier invoice PAID once confirmed', async () => {
  const h = await harness({}); try {
    const ubl = Buffer.from('<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>F-9</cbc:ID><cbc:IssueDate>2026-09-10</cbc:IssueDate><cbc:DueDate>2026-09-24</cbc:DueDate><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Fournisseur Exemple SRL</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty><cac:PaymentMeans><cbc:PaymentID>+++111/2222/33344+++</cbc:PaymentID></cac:PaymentMeans><cac:TaxTotal><cbc:TaxAmount currencyID="EUR">21.00</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">121.00</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal></Invoice>');
    const it = (await h.c.post('/api/inbox/upload', { fileName: 'f.xml', dataBase64: ubl.toString('base64') })).data.item; await h.c.post(`/api/inbox/${it.id}/validate`, {});
    h.bank.transactions = async () => [tx('t-out', '2026-09-21', -12100, { reference: '+++111/2222/33344+++', counterpartyName: 'Fournisseur Exemple SRL' })];
    await h.connect(); await sync(h);
    const s = (await h.c.get('/api/bank/suggestions')).data.rows[0]; assert.equal(s.side, 'OUT'); assert.equal(s.status, 'EXACT');
    assert.equal((await h.c.post(`/api/bank/transactions/${s.transactionId}/confirm`, { itemId: it.id })).status, 200);
    const done = (await h.c.get(`/api/inbox/${it.id}`)).data; assert.equal(done.status, 'PAID'); assert.equal(done.paidReference, 'bank:t-out');
  } finally { await h.close(); }
});
test('matching rules (pure): invoice number in the text, name+amount, unrelated credits, debits', () => {
  const open = [{ documentId: 'd1', number: 'INV-2026-0007', customer: 'Atelier Exemple SRL', remainingCents: 5000, dueDate: '2026-09-30' }, { documentId: 'd2', number: 'INV-2026-0008', customer: 'Boutique Autre SA', remainingCents: 7000, dueDate: '2026-09-30' }];
  assert.equal(suggestForCredit(tx('a', '2026-09-20', 5000, { reference: 'Facture INV-2026-0007 merci' }), open).status, 'PROBABLE');
  assert.equal(suggestForCredit(tx('b', '2026-09-20', 7000, { counterpartyName: 'BOUTIQUE AUTRE' }), open).status, 'PROBABLE');
  assert.equal(suggestForCredit(tx('c', '2026-09-20', 123, { counterpartyName: 'Inconnu', reference: 'cadeau' }), open).status, 'NO_MATCH');
  assert.equal(suggestForDebit(tx('d', '2026-09-20', -100), []).status, 'NO_MATCH');
});
test('tenant isolation: another merchant cannot confirm or see a transaction', async () => {
  const store = createMemoryStore(); const { createBankService } = await import('../src/finance/bank-service.js');
  const mk = (merchantId) => createBankService({ store, merchantId, adapter: createFakeBankAdapter(), vault: createConsentVault({ store, merchantId, key: KEY }), finance: { listInvoices: async () => [], recordPayment: async () => ({}) }, inbox: { list: async () => [], pay: async () => ({}), markToPay: async () => ({}) } });
  const a = mk('m1'); const b = mk('m2'); const m = { type: 'merchant' };
  const { row } = await store.insertBankTransaction({ merchantId: 'm1', accountId: 'x', providerTxId: '1', date: '2026-09-01', amountCents: 100, status: 'NEW' });
  assert.equal((await b.transactions()).length, 0); await assert.rejects(() => b.confirm(row.id, { documentId: 'd' }, m), /BANK_TRANSACTION_NOT_FOUND/); assert.equal((await a.transactions()).length, 1);
  await assert.rejects(() => a.confirm(row.id, { documentId: 'd' }, { type: 'agent' }), /THIS_STEP_REQUIRES_A_MERCHANT_ACTOR/);
});
test('CSV import: French / Dutch / English headers, ; or , delimiters, decimal comma, structured reference detected, bad rows reported', () => {
  const r = parseBankCsv('Datum;Bedrag;Mededeling;Naam\n21/09/2026;1.234,50;+++000/0000/00097+++;Klant\nfout;x;y;z\n');
  assert.equal(r.rows.length, 1); assert.deepEqual([r.rows[0].date, r.rows[0].amountCents, r.rows[0].structuredReference, r.rows[0].counterpartyName], ['2026-09-21', 123450, '000000000097', 'Klant']); assert.equal(r.errors.length, 1);
  assert.equal(parseBankCsv('date,amount,reference\n2026-09-01,-45.20,loyer\n').rows[0].amountCents, -4520);
  assert.throws(() => parseBankCsv('a,b\n1,2\n'), /BANK_CSV_COLUMNS_NOT_FOUND/); assert.throws(() => parseBankCsv('x'), /BANK_CSV_EMPTY/);
});

// ---------- treasury ----------
test('TREASURY: bank + physical cash = liquidity; expected in/out are labelled EXPECTED; overdue receivables are ASSUMED and NOT in the projection', () => {
  const t = buildTreasury({ asOf: '2026-09-21', bank: [{ accountId: 'a', balanceCents: 787000, asOf: '2026-09-21T08:00:00Z' }], cashCount: { amountCents: 50000, countedOn: '2026-09-18' },
    cashMovements: [{ date: '2026-09-19', kind: 'CASH_IN', amountCents: 7000 }, { date: '2026-09-20', kind: 'DEPOSIT_TO_BANK', amountCents: 2000 }, { date: '2026-09-10', kind: 'CASH_OUT', amountCents: 999 }],
    receivables: [{ number: 'A', dueDate: '2026-09-24', remainingCents: 214000 }, { number: 'B', dueDate: '2026-09-30', remainingCents: 5000 }, { number: 'C', dueDate: '2026-09-01', remainingCents: 30000 }],
    payables: [{ invoiceNumber: 'P1', supplierName: 'S', dueDate: '2026-09-25', grossCents: 132000 }, { invoiceNumber: 'P2', supplierName: 'S', dueDate: '2026-11-01', grossCents: 999 }] });
  assert.equal(t.observed.bankCents, 787000); assert.equal(t.observed.cashCents, 55000, 'count + movements after the count only'); assert.equal(t.observed.liquidCents, 842000);
  assert.deepEqual([t.expected.incomingCents, t.expected.outgoingCents], [214000, 132000]); assert.deepEqual([t.assumed.overdueReceivablesCents, t.assumed.note], [30000, 'NOT_INCLUDED_IN_THE_PROJECTION']);
  assert.equal(t.projection.cents, 842000 + 214000 - 132000); assert.equal(t.projection.basis, 'PROJECTED');
  const basis = Object.fromEntries(t.items.map((i) => [i.key, i.basis])); assert.deepEqual(basis, { bank: 'OBSERVED', cash: 'OBSERVED', liquid: 'OBSERVED', receivables_due: 'EXPECTED', payables_due: 'EXPECTED', overdue_receivables: 'ASSUMED', projection: 'PROJECTED' });
  assert.equal(t.series.length, 8); assert.equal(t.series.at(-1).balanceCents, t.projection.cents); assert.equal(t.series[0].basis, 'OBSERVED_PLUS_EXPECTED'); assert.ok(t.series.slice(1).every((s) => s.basis === 'PROJECTED')); assert.equal(t.disclaimer, 'SHORT_TERM_LIQUIDITY_VIEW_NOT_ACCOUNTING_CASH_FLOW');
});
test('TREASURY: what is missing is said, never assumed as zero (no bank, no cash count)', () => {
  const t = buildTreasury({ asOf: '2026-09-21', bank: null, cashCount: null, receivables: [{ number: 'A', dueDate: '2026-09-22', remainingCents: 1000 }], payables: [] });
  assert.equal(t.observed.bankCents, null); assert.equal(t.observed.cashCents, null); assert.equal(t.observed.liquidCents, null); assert.equal(t.projection.cents, null); assert.deepEqual(t.warnings, ['NO_BANK_BALANCE_AVAILABLE', 'NO_CASH_COUNT_CONFIRMED']); assert.equal(t.expected.incomingCents, 1000);
  assert.equal(buildTreasury({ asOf: '2026-09-21', bank: null, cashCount: { amountCents: 500, countedOn: '2026-09-20' }, receivables: [], payables: [] }).observed.liquidCents, 500);
});
test('TREASURY endpoint and physical cash: only confirmed counts and recorded movements; POS sales are never assumed to stay in the till', withH({}, async (h) => {
  const inv = await h.issue(line('100.00'), { dueDate: '2026-09-24' });
  h.bank.transactions = async () => []; await h.connect(); await sync(h);
  let t = (await h.c.get('/api/treasury')).data; assert.equal(t.observed.bankCents, 842000); assert.equal(t.observed.cashCents, null); assert.ok(t.warnings.includes('NO_CASH_COUNT_CONFIRMED')); assert.equal(t.expected.incomingCents, 12100);
  assert.equal((await h.c.post('/api/cash/counts', { amount: '550.00', countedOn: '2026-09-20' })).status, 201); assert.equal((await h.c.post('/api/cash/movements', { kind: 'CASH_OUT', amount: '50.00', date: '2026-09-21' })).status, 201);
  t = (await h.c.get('/api/treasury')).data; assert.equal(t.observed.cashCents, 50000); assert.equal(t.observed.liquidCents, 892000); assert.equal(t.projection.cents, 892000 + 12100);
  assert.equal((await h.c.post('/api/cash/counts', { amount: 'x', countedOn: '2026-09-20' })).status, 422); assert.equal((await h.c.post('/api/cash/movements', { kind: 'STEAL', amount: '1.00', date: '2026-09-21' })).status, 422);
  assert.ok(inv.id);
}));
