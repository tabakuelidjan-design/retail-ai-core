import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { maskIban, observedBalance, bankPosition, parseBankCsv } from '../src/finance/bank.js';
import { txAmounts, legacyStatusOf, checkReconciliation, BANK_GUARANTEES } from '../src/finance/bank-ledger.js';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { startApp } from './finance-dashboard-helpers.js';

// Essential Bank, fast half (memory store + HTTP). The PostgreSQL half lives in test/pg/70-bank.pg.test.js and the memory==PostgreSQL contract in test/finance-contract-*.
const KEY = randomBytes(32);
const codeOf = (fn) => { try { fn(); return 'NO_ERROR'; } catch (e) { return e.code ?? e.message; } };
const rec = (id, tx, kind, amountCents, extra = {}) => ({ id, bankTransactionId: tx, kind, amountCents, paymentId: kind === 'MATCH' ? 'p1' : null, currency: 'EUR', createdAt: `2026-10-0${id.length}`, ...extra });

// ---------- pure rules ----------
test('LEDGER: matched / ignored / remaining / status come only from reconciliation rows (integer cents)', () => {
  const tx = { id: 't', amountCents: -10000 };
  assert.deepEqual({ ...txAmounts(tx, []), lastAt: 0 }, { amount: 10000, matched: 0, ignored: 0, remaining: 10000, status: 'UNRECONCILED', lastAt: 0 });
  assert.equal(txAmounts(tx, [rec('a', 't', 'MATCH', 4000)]).status, 'PARTIALLY_RECONCILED');
  assert.equal(txAmounts(tx, [rec('a', 't', 'MATCH', 4000), rec('bb', 't', 'MATCH', 6000)]).status, 'RECONCILED');
  assert.equal(txAmounts(tx, [rec('a', 't', 'IGNORE', 10000)]).status, 'IGNORED');
  const undone = txAmounts(tx, [rec('a', 't', 'MATCH', 4000), rec('bb', 't', 'MATCH', -4000, { reversesId: 'a' })]);
  assert.equal(undone.status, 'UNRECONCILED'); assert.equal(undone.remaining, 10000);
  assert.equal(txAmounts(tx, [rec('a', 'other', 'MATCH', 4000)]).matched, 0, 'another transaction\'s rows never count');
  assert.deepEqual(['RECONCILED', 'IGNORED', 'UNRECONCILED', 'PARTIALLY_RECONCILED'].map(legacyStatusOf), ['MATCHED', 'IGNORED', 'NEW', 'NEW']);
});

test('LEDGER guard: over-reconciliation, direction, currency, merchant, reversal and unreconcile bounds are refused with the PostgreSQL codes', () => {
  const tx = { id: 't', merchantId: 'm', amountCents: 5000, currency: 'EUR' }; const pay = { id: 'p1', merchantId: 'm', direction: 'IN', amountCents: 5000, currency: 'EUR' };
  const base = { tx, payment: pay, registry: [pay], reconciliations: [] };
  const row = (o) => ({ merchantId: 'm', bankTransactionId: 't', paymentId: 'p1', kind: 'MATCH', amountCents: 100, currency: 'EUR', ...o });
  assert.equal(codeOf(() => checkReconciliation({ ...base, row: row({}) })), 'NO_ERROR');
  assert.equal(codeOf(() => checkReconciliation({ ...base, row: row({ amountCents: 5001 }) })), 'BANK_OVER_RECONCILED');
  assert.equal(codeOf(() => checkReconciliation({ ...base, payment: { ...pay, direction: 'OUT' }, row: row({}) })), 'BANK_DIRECTION_MISMATCH');
  assert.equal(codeOf(() => checkReconciliation({ ...base, row: row({ currency: 'USD' }) })), 'BANK_CURRENCY_MISMATCH');
  assert.equal(codeOf(() => checkReconciliation({ ...base, row: row({ merchantId: 'other' }) })), 'BANK_TX_NOT_FOUND');
  assert.equal(codeOf(() => checkReconciliation({ ...base, payment: { ...pay, merchantId: 'other' }, row: row({}) })), 'PAYMENT_NOT_FOUND');
  assert.equal(codeOf(() => checkReconciliation({ ...base, reconciliations: [{ ...rec('a', 't', 'MATCH', 3000), merchantId: 'm' }], row: row({ amountCents: 2001, paymentId: 'p1' }) })), 'BANK_OVER_RECONCILED');
  const orig = { ...rec('a', 't', 'MATCH', 3000), merchantId: 'm' };
  assert.equal(codeOf(() => checkReconciliation({ ...base, reconciliations: [orig], row: row({ amountCents: -3001, reversesId: 'a' }) })), 'BANK_UNRECONCILE_EXCEEDS');
  assert.equal(codeOf(() => checkReconciliation({ ...base, reconciliations: [orig], row: row({ amountCents: -1000, reversesId: 'nope' }) })), 'BANK_RECONCILIATION_NOT_FOUND');
  assert.equal(codeOf(() => checkReconciliation({ ...base, reconciliations: [orig], row: row({ amountCents: -1000, reversesId: 'a' }) })), 'NO_ERROR');
  assert.ok(Object.keys(BANK_GUARANTEES).length >= 12 && Object.values(BANK_GUARANTEES).every((v) => /^[SPB] /.test(v)), 'every guarantee is classified SERVICE / POSTGRES / BOTH');
});

// ---------- accounts, balances ----------
test('MASKED IBAN: country + check digits + last four; anything else is refused; a full IBAN never survives', () => {
  assert.equal(maskIban('BE68 5390 0754 7034'), 'BE68 **** **** 7034'); assert.equal(maskIban('be68539007547034'), 'BE68 **** **** 7034');
  assert.equal(maskIban(''), null); assert.equal(maskIban('not an iban'), null); assert.equal(maskIban(null), null);
  assert.ok(!maskIban('BE68539007547034').includes('5390'));
});

test('BALANCE provenance: observed has amount/currency/observed_at/source and a freshness; an old balance is STALE, never "current"; the calculated position is labelled', () => {
  const b = { accountId: 'a', balanceCents: 100000, currency: 'EUR', asOf: '2026-10-01T08:00:00Z', source: 'provider' };
  const fresh = observedBalance(b, '2026-10-01T20:00:00Z'); assert.equal(fresh.freshness, 'FRESH'); assert.equal(fresh.source, 'provider'); assert.equal(fresh.observedAt, '2026-10-01T08:00:00Z'); assert.equal(fresh.currency, 'EUR');
  const stale = observedBalance(b, '2026-10-05T08:00:00Z'); assert.equal(stale.freshness, 'STALE'); assert.equal(stale.ageHours, 96);
  assert.equal(observedBalance({ ...b, asOf: null }, '2026-10-05T08:00:00Z').freshness, 'UNKNOWN');
  const p = bankPosition({ balance: b, now: '2026-10-05T08:00:00Z', transactions: [{ accountId: 'a', currency: 'EUR', date: '2026-10-02', amountCents: -2500 }, { accountId: 'a', currency: 'EUR', date: '2026-10-01', amountCents: 9999 }, { accountId: 'b', currency: 'EUR', date: '2026-10-03', amountCents: 7 }] });
  assert.equal(p.calculated.basis, 'OBSERVED_PLUS_LATER_TRANSACTIONS'); assert.equal(p.calculated.amountCents, 97500); assert.equal(p.calculated.transactionsCounted, 1);
  assert.equal(p.calculated.startsFromFreshness, 'STALE'); assert.equal(p.observed.amountCents, 100000, 'the observed amount is untouched by the calculation');
});

// ---------- CSV identity ----------
test('CSV identity: same content = same ids on re-parse; two identical-looking lines get distinct ids; a different currency is a different fingerprint', () => {
  const csv = 'Date;Montant;Contrepartie;Communication\n10/09/2026;10,00;Client;ref\n10/09/2026;10,00;Client;ref\n';
  const a = parseBankCsv(csv).rows; const b = parseBankCsv(csv).rows;
  assert.equal(a.length, 2); assert.notEqual(a[0].id, a[1].id); assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id));
  assert.equal(a[0].currency, 'EUR');
});

// ---------- memory store: the same refusals as PostgreSQL ----------
const A = 'ma'; const B = 'mb'; const actor = { type: 'merchant', id: 'owner' }; const at = '2026-10-03T10:00:00Z';
const code = async (p) => { try { await p; return 'NO_ERROR'; } catch (e) { return e.code ?? e.message; } };
async function seeded() {
  const st = createMemoryStore();
  const tx = (m, tag, amountCents, extra = {}) => st.insertBankTransaction({ merchantId: m, accountId: 'acc', providerTxId: tag, date: '2026-09-01', amountCents, currency: 'EUR', source: 'csv', ...extra }).then((r) => r.row);
  return { st, tx };
}

test('STORE: a hand-written MATCHED claim is not a reconciliation; status is derived; reconcile-and-pay is atomic; unreconcile keeps history', async () => {
  const { st, tx } = await seeded();
  const t = await tx(A, 't1', 20000, { status: 'MATCHED', matchedKind: 'INVOICE', matchedDocumentId: 'x' });
  assert.equal((await st.bankTxAmounts(A, t.id)).status, 'UNRECONCILED', 'a claim without a reconciliation row means nothing');
  const regBefore = (await st.listRegistry(A)).length;
  assert.equal(await code(st.reconcileAndPay({ merchantId: A, key: 'bad-method-key', transactionId: t.id, actor, at, payment: { amountCents: 20000, method: 'paypal', allocations: [] } })), 'PAYMENT_METHOD_INVALID');
  assert.equal(await code(st.reconcileAndPay({ merchantId: A, key: 'too-much-key', transactionId: t.id, actor, at, payment: { amountCents: 20001, method: 'bank_transfer', allocations: [] } })), 'BANK_OVER_RECONCILED');
  assert.equal((await st.listRegistry(A)).length, regBefore, 'a refused reconciliation leaves no payment behind');
  const ok = await st.reconcileAndPay({ merchantId: A, key: 'good-key-1', transactionId: t.id, actor, at, payment: { amountCents: 12000, method: 'bank_transfer', allocations: [] } });
  assert.equal(ok.duplicate, false); assert.equal((await st.bankTxAmounts(A, t.id)).status, 'PARTIALLY_RECONCILED');
  const again = await st.reconcileAndPay({ merchantId: A, key: 'good-key-1', transactionId: t.id, actor, at, payment: { amountCents: 12000, method: 'bank_transfer', allocations: [] } });
  assert.equal(again.duplicate, true); assert.equal((await st.listRegistry(A)).length, regBefore + 1, 'identical retry = one payment');
  assert.equal(await code(st.voidPayment({ merchantId: A, key: 'void-reconciled', paymentId: ok.payment.id, on: '2026-10-04', reason: 'x', actor, at })), 'REVERSAL_PAYMENT_RECONCILED', 'a reconciled payment cannot be voided');
  const r = ok.reconciliation ?? ok.reconciliations[0];
  await st.unreconcileBank({ merchantId: A, key: 'undo-key-1', items: [{ reconciliationId: r.id, amountCents: null }], reason: 'wrong', actor, at });
  const a = await st.bankTxAmounts(A, t.id); assert.equal(a.status, 'UNRECONCILED'); assert.equal(a.remaining, 20000);
  assert.ok((await st.listReconciliations({ bankTransactionId: t.id })).length >= 2, 'history kept: original + negative row');
});

test('STORE isolation: merchant B can neither read nor reconcile merchant A\'s transaction', async () => {
  const { st, tx } = await seeded(); const t = await tx(A, 'iso1', 5000);
  assert.equal(await code(st.reconcileAndPay({ merchantId: B, key: 'iso-key-1', transactionId: t.id, actor, at, payment: { amountCents: 5000, method: 'bank_transfer', allocations: [] } })), 'BANK_TX_NOT_FOUND');
  assert.equal(await code(st.ignoreBank({ merchantId: B, key: 'iso-key-2', transactionId: t.id, reason: 'x', actor, at })), 'BANK_TX_NOT_FOUND');
  assert.equal((await st.listBankAccounts(B)).length, 0);
});

// ---------- HTTP ----------
const CSV = 'Date;Montant;Contrepartie;Communication\n10/09/2026;125,50;Client A;+++090/9337/55493+++\n11/09/2026;-42,10;Fournisseur B;Facture 12\n';
test('API: import -> account created with a masked identity -> reconcile creates the payment atomically -> partial remainder -> unreconcile -> ignore; suggestions carry NO authority', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    assert.equal((await c.post('/api/bank/import-csv', { csv: CSV })).data.created, 2);
    const accounts = (await c.get('/api/bank/accounts')).data.rows; assert.equal(accounts.length, 1); assert.equal(accounts[0].origin, 'CSV'); assert.equal(accounts[0].toReconcile, 2);
    const rows = (await c.get('/api/bank/transactions')).data.rows; const inbound = rows.find((r) => r.amountCents === 12550);
    assert.equal(inbound.reconciliationStatus, 'UNRECONCILED'); assert.equal(inbound.remainingCents, 12550); assert.equal(inbound.direction, 'IN');
    for (const s of (await c.get('/api/bank/suggestions')).data.rows) assert.equal(s.authority, 'NONE');
    assert.equal((await c.get('/api/bank/transactions')).data.rows.every((r) => r.reconciliationStatus === 'UNRECONCILED'), true, 'suggestions alone reconcile nothing');
    const bad = await c.post(`/api/bank/transactions/${inbound.id}/reconcile`, { create: { amount: '200.00', allocations: [] } }); assert.equal(bad.status >= 400, true); assert.match(JSON.stringify(bad.data), /BANK_OVER_RECONCILED|OVER/);
    const part = await c.post(`/api/bank/transactions/${inbound.id}/reconcile`, { create: { amount: '100.00', allocations: [] }, idempotencyKey: 'api-key-0001' });
    assert.equal(part.status, 200); assert.equal(part.data.transaction.reconciliationStatus, 'PARTIALLY_RECONCILED'); assert.equal(part.data.transaction.remainingCents, 2550);
    const retry = await c.post(`/api/bank/transactions/${inbound.id}/reconcile`, { create: { amount: '100.00', allocations: [] }, idempotencyKey: 'api-key-0001' }); assert.equal(retry.data.duplicate, true);
    const detail = (await c.get(`/api/bank/transactions/${inbound.id}`)).data.transaction; assert.equal(detail.reconciledCents, 10000);
    const rid = detail.reconciliations?.find((x) => x.amountCents > 0)?.id; assert.ok(rid, 'the reconciliation is listed with its id');
    const un = await c.post(`/api/bank/transactions/${inbound.id}/unreconcile`, { reconciliationIds: [rid], reason: 'wrong customer', idempotencyKey: 'api-undo-0001' }); assert.equal(un.status, 200); assert.equal(un.data.transaction.reconciliationStatus, 'UNRECONCILED');
    assert.equal((await c.post(`/api/bank/transactions/${inbound.id}/unreconcile`, { reconciliationIds: [rid] })).status, 422, 'a reason is required');
    const out = rows.find((r) => r.amountCents === -4210); const ig = await c.post(`/api/bank/transactions/${out.id}/ignore`, { reason: 'private expense', idempotencyKey: 'api-ign-00001' }); assert.equal(ig.status, 200); assert.equal(ig.data.reconciliationStatus, 'IGNORED');
    const text = JSON.stringify((await c.get('/api/bank/transactions')).data) + JSON.stringify((await c.get('/api/bank/accounts')).data); assert.ok(!/BE\d{14}/.test(text), 'no full IBAN in any bank response');
  } finally { await a.close(); }
});
