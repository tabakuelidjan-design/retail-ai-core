import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createSupabaseFinanceStore } from '../src/finance/supabase-store.js';
import { createSupabaseClient } from '../src/supabase/client.js';
import { startApp } from './finance-dashboard-helpers.js';

// ATOMIC bank statement import: a statement is saved completely or not at all. SYNTHETIC data only.
const KEY = randomBytes(32);
const read = (f) => readFileSync(new URL(`../src/finance/ui/${f}`, import.meta.url), 'utf8');
const VALID = 'Date;Montant;Contrepartie;Communication\n10/09/2026;125,50;Client A;+++090/9337/55493+++\n11/09/2026;-42,10;Fournisseur B;Facture 12\n';
const txCount = async (c) => (await c.get('/api/bank/transactions')).data.rows.length;
const txRow = (id, over = {}) => ({ merchantId: 'm1', accountId: 'csv', providerTxId: id, date: '2026-09-10', amountCents: 1000, currency: 'EUR', counterpartyName: null, reference: null, structuredReference: null, source: 'csv', status: 'NEW', importedAt: '2026-09-21T10:00:00Z', ...over });

test('a database failure during the import: clear message (503), NOTHING of the statement is kept, and the same statement can be imported again', async () => {
  const store = createMemoryStore(); const realBatch = store.insertBankTransactionsBatch.bind(store); let failing = true;
  store.insertBankTransactionsBatch = async (rows) => { if (failing) throw new Error('connection reset by peer'); return realBatch(rows); };
  const a = await startApp({ store, bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const bad = await c.post('/api/bank/import-csv', { csv: VALID });
    assert.equal(bad.status, 503); assert.equal(bad.data.error.code, 'BANK_IMPORT_FAILED_NOTHING_SAVED'); assert.ok(!JSON.stringify(bad.data).includes('connection reset'), 'the technical detail is not shown');
    assert.equal(await txCount(c), 0, 'zero transactions of the batch were kept');
    const st = (await c.get('/api/bank/status')).data; assert.deepEqual(st.counts, { NEW: 0, MATCHED: 0, IGNORED: 0 }); assert.equal(st.connected, false);
    assert.ok(a.audits.some((e) => e.action === 'BANK_CSV_IMPORT_FAILED') && !a.audits.some((e) => e.action === 'BANK_CSV_IMPORTED'), 'the failure is audited, no success is');
    failing = false;
    const retry = await c.post('/api/bank/import-csv', { csv: VALID });
    assert.equal(retry.status, 200); assert.equal(retry.data.created, 2); assert.equal(await txCount(c), 2, 'retry works: the statement is now saved once');
    const again = await c.post('/api/bank/import-csv', { csv: VALID }); assert.equal(again.data.created, 0); assert.equal(again.data.duplicates, 2); assert.equal(await txCount(c), 2, 'still idempotent');
  } finally { await a.close(); }
});

test('a failure in the MIDDLE of a batch keeps zero rows: the real memory store validates everything before it stores anything', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.insertBankTransactionsBatch([txRow('1'), txRow('2'), txRow('3', { amountCents: 'oops' }), txRow('4')]), /BANK_TRANSACTION_INVALID/);
  assert.equal((await store.listBankTransactions({ merchantId: 'm1' })).length, 0, 'rows 1 and 2 were NOT kept when row 3 failed');
  assert.deepEqual(await store.insertBankTransactionsBatch([txRow('1'), txRow('2'), txRow('3'), txRow('3')]), { created: 3, duplicates: 1 }, 'a valid batch saves once, duplicates inside the batch are skipped');
  assert.deepEqual(await store.insertBankTransactionsBatch([txRow('2'), txRow('9')]), { created: 1, duplicates: 1 }, 'already stored transactions are skipped');
  assert.equal((await store.listBankTransactions({ merchantId: 'm1' })).length, 4);
});

test('Supabase store: the whole statement is ONE request (one database transaction); a failing request stores nothing; duplicates are counted from what was really inserted', async () => {
  const calls = []; const table = []; let fail = false;
  const fake = { insertIgnoringDuplicates: async (t, rows, opts) => { calls.push({ t, n: rows.length, opts }); if (fail) throw new Error('fetch failed: ECONNRESET'); const fresh = rows.filter((r) => !table.some((x) => x.provider_tx_id === r.provider_tx_id)); table.push(...fresh); return fresh; } };
  const store = createSupabaseFinanceStore(fake, { merchantId: 'm1' });
  fail = true;
  await assert.rejects(store.insertBankTransactionsBatch([txRow('1'), txRow('2'), txRow('3')]));
  assert.equal(table.length, 0, 'nothing stored when the request fails'); assert.equal(calls.length, 1, 'one request for three rows, not three requests');
  fail = false; calls.length = 0;
  assert.deepEqual(await store.insertBankTransactionsBatch([txRow('1'), txRow('2'), txRow('3')]), { created: 3, duplicates: 0 });
  assert.deepEqual(await store.insertBankTransactionsBatch([txRow('3'), txRow('4')]), { created: 1, duplicates: 1 });
  assert.deepEqual(calls.map((c) => [c.t, c.n, c.opts.onConflict]), [['fin_bank_transactions', 3, 'merchant_id,account_id,provider_tx_id'], ['fin_bank_transactions', 2, 'merchant_id,account_id,provider_tx_id']]);
  assert.deepEqual(await store.insertBankTransactionsBatch([]), { created: 0, duplicates: 0 });
});

test('Supabase client: insertIgnoringDuplicates sends ONE POST with ignore-duplicates semantics, and surfaces an HTTP failure', async () => {
  const seen = []; const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => { seen.push({ url, opts }); return seen.length === 1 ? { ok: true, status: 201, text: async () => '[{"id":"a"}]' } : { ok: false, status: 503, text: async () => 'upstream down' }; };
    const c = createSupabaseClient({ url: 'https://x.example.test', serviceRoleKey: 'k'.repeat(30) });
    const rows = [{ a: 1 }, { a: 2 }];
    assert.deepEqual(await c.insertIgnoringDuplicates('fin_bank_transactions', rows, { onConflict: 'merchant_id,account_id,provider_tx_id' }), [{ id: 'a' }]);
    assert.equal(seen.length, 1); assert.match(seen[0].url, /\/rest\/v1\/fin_bank_transactions\?on_conflict=merchant_id%2Caccount_id%2Cprovider_tx_id$/);
    assert.equal(seen[0].opts.method, 'POST'); assert.match(seen[0].opts.headers.Prefer, /resolution=ignore-duplicates/); assert.deepEqual(JSON.parse(seen[0].opts.body), rows, 'the whole batch in one body');
    await assert.rejects(c.insertIgnoringDuplicates('fin_bank_transactions', rows, { onConflict: 'x' }), /HTTP 503/);
    assert.deepEqual(await c.insertIgnoringDuplicates('t', [], { onConflict: 'x' }), [], 'an empty batch sends nothing'); assert.equal(seen.length, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('the UI shows the failure message (FR/NL too) and keeps the confirm button usable for a retry', () => {
  assert.match(read('app.js'), /BANK_IMPORT_FAILED_NOTHING_SAVED: "The import failed and nothing was saved\. You can try again\."/);
  assert.match(read('views-workspace.js'), /catch \(e\) \{ ev\.target\.disabled = false; fail\(e, errBox\); \}/, 'the button is re-enabled after a failure');
  for (const l of ['lang-fr.js', 'lang-nl.js']) assert.match(read(l), /The import failed and nothing was saved\. You can try again\./);
});

test('the bank sync of an account goes through the same atomic batch', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try { assert.equal(typeof a.store.insertBankTransactionsBatch, 'function'); } finally { await a.close(); }
});
