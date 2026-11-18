import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startApp, invoiceBody } from './finance-dashboard-helpers.js';
import { structuredCommunication } from '../src/finance/pdf.js';

// End-to-end CSV statement path on the deployed Finance line (release/finance-staging): import -> suggestions -> manual confirmation -> partial payment
// -> reimport without duplicate -> merchant isolation. SYNTHETIC statement only: its column names are NOT verified against a real KBC export.
const KEY = randomBytes(32);
const ogmOf = (number) => structuredCommunication(number); // the same Febelfin rule the invoice PDF prints

async function issue(c) {
  const d = (await c.post('/api/documents', invoiceBody({}))).data;
  await c.post(`/api/documents/${d.id}/submit`, {});
  const r = await c.post(`/api/documents/${d.id}/approve`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return (await c.get(`/api/documents/${d.id}`)).data;
}
const csvFor = ({ ogm1 }) => [
  'Date;Montant;Contrepartie;Communication',
  `22/09/2026;71,90;Client Exemple SA;${ogm1}`,       // structured communication of invoice 1, exact amount
  '23/09/2026;30,00;Client Exemple SA;acompte',       // no reference: two open invoices fit equally -> AMBIGUOUS
  '24/09/2026;-12,50;Fournisseur X;frais bancaires',  // outgoing, no supplier invoice
  '',
].join('\n');

test('CSV e2e: import, suggestions, manual confirmation, partial payment, reimport without duplicate, isolation', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const inv1 = await issue(c); const inv2 = await issue(c);
    assert.equal(inv1.number, 'INV-2026-0001'); assert.equal(inv1.grossCents, 7190); assert.equal(inv2.grossCents, 7190);
    const csv = csvFor({ ogm1: ogmOf(inv1.number) });

    // 1. preview writes nothing, import stores 3 transactions
    const pv = await c.post('/api/bank/import-csv/preview', { csv }); assert.equal(pv.status, 200); assert.equal(pv.data.importable, 3); assert.deepEqual(pv.data.invalid, []);
    const imp = await c.post('/api/bank/import-csv', { csv }); assert.equal(imp.status, 200, JSON.stringify(imp.data)); assert.equal(imp.data.created, 3);

    // 2. suggestions: exact structured match, ambiguous amount-only match, outgoing without a document
    const sug = (await c.get('/api/bank/suggestions')).data.rows; const txs = (await c.get('/api/bank/transactions')).data.rows;
    const byAmount = (cents) => txs.find((t) => t.amountCents === cents);
    const s1 = sug.find((s) => s.transactionId === byAmount(7190).id); const s2 = sug.find((s) => s.transactionId === byAmount(3000).id);
    assert.equal(s1.status, 'EXACT', JSON.stringify(s1)); assert.equal(s1.authority, 'NONE');
    assert.equal(s2.status, 'AMBIGUOUS', JSON.stringify(s2));
    assert.equal(sug.find((s) => s.transactionId === byAmount(-1250).id)?.status ?? 'NO_MATCH', 'NO_MATCH');

    // 3. manual confirmation of the exact match: payment recorded, invoice PAID, nothing applied by the suggestion alone
    const conf = await c.post(`/api/bank/transactions/${byAmount(7190).id}/confirm`, { documentId: inv1.id, idempotencyKey: 'e2e-confirm-0001' });
    assert.equal(conf.status, 200, JSON.stringify(conf.data));
    const paid = (await c.get(`/api/documents/${inv1.id}`)).data; assert.equal(paid.status, 'PAID'); assert.equal(paid.remainingCents, 0);

    // 4. partial payment of invoice 2 with the ambiguous 30,00 line, chosen by a person
    const part = await c.post(`/api/bank/transactions/${byAmount(3000).id}/confirm`, { documentId: inv2.id, amount: '30.00', idempotencyKey: 'e2e-partial-0001' });
    assert.equal(part.status, 200, JSON.stringify(part.data));
    const inv2Now = (await c.get(`/api/documents/${inv2.id}`)).data; assert.equal(inv2Now.status, 'PARTIALLY_PAID'); assert.equal(inv2Now.remainingCents, 7190 - 3000);

    // 5. reimport the same file: nothing new, no second payment
    const again = await c.post('/api/bank/import-csv', { csv }); assert.equal(again.status, 200); assert.equal(again.data.created, 0); assert.equal(again.data.duplicates, 3);
    assert.equal((await c.get('/api/bank/transactions')).data.rows.length, 3);
    assert.equal((await c.get(`/api/documents/${inv1.id}`)).data.payments.length, 1, 'reimport did not create a second payment');

    // 6. re-confirming the already matched line is refused
    const dup = await c.post(`/api/bank/transactions/${byAmount(7190).id}/confirm`, { documentId: inv1.id, idempotencyKey: 'e2e-confirm-0002' });
    assert.ok(dup.status >= 400, 'a handled transaction cannot be confirmed twice');

    // 7. isolation: another merchant on the same store sees and touches nothing
    const b = await startApp({ bankVaultKey: KEY, merchantId: 'merchant-test-2', store: a.store });
    try {
      const cb = await b.authed();
      assert.equal((await cb.get('/api/bank/transactions')).data.rows.length, 0, 'other merchant sees no transaction');
      const x = await cb.post(`/api/bank/transactions/${byAmount(-1250).id}/ignore`, { reason: 'test', idempotencyKey: 'e2e-iso-00001' });
      assert.ok(x.status >= 400, 'other merchant cannot act on this transaction');
    } finally { await b.close(); }
  } finally { await a.close(); }
});

test('CSV e2e regression: two genuinely identical lines in one statement are two transactions (not merged)', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const csv = ['Date;Montant;Contrepartie;Communication', '25/09/2026;25,00;Boutique X;', '25/09/2026;25,00;Boutique X;'].join('\n');
    const imp = await c.post('/api/bank/import-csv', { csv }); assert.equal(imp.status, 200, JSON.stringify(imp.data));
    assert.equal(imp.data.created, 2, 'two identical bank lines must both be stored');
  } finally { await a.close(); }
});
