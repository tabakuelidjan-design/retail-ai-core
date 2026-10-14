// Essential Bank on a real PostgreSQL 17: accounts, identity and import under concurrency, reconciliation N<->M, partial, reversible, atomic with the payment (deliberate failure injection),
// no last-writer-wins (two users, two documents, partial, reconcile vs unreconcile, void vs reconcile), isolation, audit, upgrade of existing rows, and a randomised property test
// that holds fin_bank_tx_amounts (SQL) equal to bank-ledger.js (JS) with the invariants intact.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openMany, race, seedMerchants, issuedInvoice, record, num, attempt, codeOf, freshDatabase, MERCHANT_A, MERCHANT_B, bankTx, bankReconcile, bankReconcileAndPay, bankUnreconcile, bankIgnore, bankAmounts, netPaidOfInvoice } from './lib/db.js';
import { control } from './lib/classify.js';
import { txAmounts } from '../../src/finance/bank-ledger.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const A = MERCHANT_A; const B = MERCHANT_B;
const has = (settled, code) => settled.status === 'rejected' && new RegExp(code).test(settled.reason.message);
const alloc = (id, cents) => ({ customerDocumentId: id, amountCents: cents });
const st = (a) => `${a.status} matched=${a.matched} ignored=${a.ignored} remaining=${a.remaining}`;
const recSql = 'select fin_bank_reconcile($1,$2,$3,$4,$5,$6) r'; const recArgs = (m, key, tx, items) => [m, key, tx, JSON.stringify(items), null, '{}'];
const payAndRecSql = 'select fin_bank_reconcile_and_pay($1,$2,$3,$4,$5,$6) r'; const payAndRecArgs = (m, key, tx, payment) => [m, key, tx, JSON.stringify(payment), null, '{}'];
const unSql = 'select fin_bank_unreconcile($1,$2,$3,$4,$5) r'; const unArgs = (m, key, items) => [m, key, JSON.stringify(items), 'test', '{}'];
const regCount = (c) => num(c, 'select count(*) s from fin_payment_registry'); const evCount = (c) => num(c, 'select count(*) s from fin_events');

// ===================================================== ACCOUNTS AND IDENTITY =====================================================
control('ACCOUNTS: created on first sight per merchant, one currency, never a full IBAN, one connection can expose several accounts, structurally isolated', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    await bankTx(c, A, { tag: 'a1', account: 'acc-1', source: 'bank' }); await bankTx(c, A, { tag: 'a2', account: 'acc-2', source: 'bank' }); await bankTx(c, A, { tag: 'a3', account: 'acc-1', source: 'bank' }); await bankTx(c, B, { tag: 'b1', account: 'acc-1', source: 'bank' });
    const accs = (await c.query('select merchant_id, external_id, origin, currency from fin_bank_accounts order by merchant_id, external_id')).rows; out.push(`${accs.length} accounts (${accs.filter((a) => a.merchant_id === A).length} for A, same external id "acc-1" for A and B: ${accs.filter((a) => a.external_id === 'acc-1').length})`);
    out.push((await attempt(c, "insert into fin_bank_accounts (merchant_id, external_id, origin, currency, iban_masked) values ($1,'full','PROVIDER','EUR','BE68539007547034')", [A])).code);
    out.push((await attempt(c, "insert into fin_bank_accounts (merchant_id, external_id, origin, currency, iban_masked) values ($1,'masked','PROVIDER','EUR','BE68 **** **** 7034')", [A])).ok ? 'masked ok' : 'masked refused');
    out.push((await attempt(c, "insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, source) values ($1,'acc-1','usd1','2026-09-01',100,'USD','bank')", [A])).code);
    const accB = (await c.query("select id from fin_bank_accounts where merchant_id=$1 and external_id='acc-1'", [B])).rows[0].id;
    out.push((await attempt(c, "insert into fin_bank_transactions (merchant_id, account_id, bank_account_id, provider_tx_id, date, amount_cents, currency, source) values ($1,'acc-1',$2,'x1','2026-09-01',100,'EUR','bank')", [A, accB])).code);
    out.push((await attempt(c, "insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, source) values ($1,'acc-1','zero','2026-09-01',0,'EUR','bank')", [A])).code);
    return { holds: out[0].startsWith('3 accounts') && out[1] === 'fin_bank_accounts_iban_masked_check' && out[2] === 'masked ok' && out[3] === 'FIN_BANK_CURRENCY_MISMATCH' && out[4] === 'FIN_BANK_ACCOUNT_NOT_FOUND' && out[5] === 'fin_bank_tx_amount_nonzero_chk', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('IMPORT identity: eight connections import the same statement at once -> every transaction ONCE, one account; the same provider id again is the same transaction', withDb(async (d) => {
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const rows = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ merchant_id: A, account_id: 'csv-import', provider_tx_id: `imp-${i}`, date: '2026-09-01', amount_cents: 1000 + i, currency: 'EUR', source: 'csv', fingerprint: `fp${i}` })));
    const res = await race(clients, (c) => c.query('insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, source, fingerprint) select merchant_id, account_id, provider_tx_id, date, amount_cents, currency, source, fingerprint from json_populate_recordset(null::fin_bank_transactions, $1) on conflict (merchant_id, account_id, provider_tx_id) do nothing returning id', [rows]));
    const created = res.filter((r) => r.status === 'fulfilled').reduce((s, r) => s + r.value.rowCount, 0); const txs = await num(clients[0], 'select count(*) s from fin_bank_transactions'); const accs = await num(clients[0], 'select count(*) s from fin_bank_accounts');
    return { holds: created === 20 && txs === 20 && accs === 1 && res.every((r) => r.status === 'fulfilled'), evidence: `8 simultaneous imports of 20 rows: created=${created}, stored=${txs}, accounts=${accs}, failures=${res.filter((r) => r.status === 'rejected').map(codeOf).join('|') || 'none'}` };
  } finally { await closeAll(); }
}));

control('UPGRADE: rows that predate accounts are linked by the migration (accounts created, transactions and balances attached), and nothing legacy is lost', async () => {
  const db = await freshDatabase({ fromZero: true, upTo: '20261005085959' }); const c = await db.open();
  try {
    await seedMerchants(c);
    await c.query("insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, source, status, matched_kind, matched_document_id, matched_amount_cents) values ($1,'csv-import','old1','2026-08-01',-500,'EUR','csv','MATCHED','SUPPLIER_INVOICE','legacy-doc',500), ($1,'acc-77','old2','2026-08-02',900,'EUR','bank','NEW',null,null,null)", [A]);
    await c.query("insert into fin_bank_balances (merchant_id, account_id, iban, balance_cents, currency, as_of) values ($1,'acc-77','BE68539007547034',123400,'EUR','2026-08-02T08:00:00Z')", [A]);
    const mig = readFileSync(fileURLToPath(new URL('../../supabase/migrations/20261005090000_finance_essential_bank.sql', import.meta.url)), 'utf8').split('\r\n').join('\n'); await c.query(mig);
    const tx = (await c.query('select provider_tx_id, bank_account_id is not null as linked, status, matched_kind, direction from fin_bank_transactions order by provider_tx_id')).rows; const accs = (await c.query('select external_id, origin from fin_bank_accounts order by 1')).rows; const bal = (await c.query('select bank_account_id is not null as linked, source from fin_bank_balances')).rows[0];
    const ok = tx.every((t) => t.linked) && accs.map((x) => `${x.external_id}:${x.origin}`).join() === 'acc-77:PROVIDER,csv-import:CSV' && bal.linked && bal.source === 'provider' && tx[0].status === 'MATCHED' && tx[0].matched_kind === 'SUPPLIER_INVOICE' && tx[0].direction === 'OUT' && tx[1].direction === 'IN';
    return { holds: ok, evidence: `accounts=${accs.map((x) => x.external_id).join(',')}; transactions linked=${tx.filter((t) => t.linked).length}/${tx.length}; legacy claim kept (${tx[0].status}/${tx[0].matched_kind}); balance linked=${bal.linked} source=${bal.source}` };
  } finally { await c.end(); await db.drop(); }
});

// ===================================================== RECONCILIATION: shapes =====================================================
control('RECONCILE 1->1, 1->N, N->1, partial with the exact remainder, later completion, nothing beyond the transaction', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const t1 = await bankTx(c, A, { tag: 't1', amount: 10000 }); const p1 = await record(c, A, 'p1', { amount: 10000 }); await bankReconcile(c, A, 'k1', t1.id, [{ paymentId: p1.payment.id, amountCents: 10000 }]); out.push(st(await bankAmounts(c, A, t1.id)));
    const t2 = await bankTx(c, A, { tag: 't2', amount: 30000 }); const p2a = await record(c, A, 'p2a', { amount: 10000 }); const p2b = await record(c, A, 'p2b', { amount: 20000 }); await bankReconcile(c, A, 'k2', t2.id, [{ paymentId: p2a.payment.id, amountCents: 10000 }, { paymentId: p2b.payment.id, amountCents: 20000 }]); out.push(st(await bankAmounts(c, A, t2.id)));
    const p3 = await record(c, A, 'p3', { amount: 30000 }); const legs = []; for (const [i, x] of [10000, 5000, 15000].entries()) { const t = await bankTx(c, A, { tag: `t3${i}`, amount: x }); await bankReconcile(c, A, `k3${i}`, t.id, [{ paymentId: p3.payment.id, amountCents: x }]); legs.push(t.id); }
    out.push(`payment funded by 3 movements: ${await num(c, 'select coalesce(sum(amount_cents),0) s from fin_bank_reconciliations where payment_id=$1', [p3.payment.id])}`);
    const t4 = await bankTx(c, A, { tag: 't4', amount: 50000 }); const p4 = await record(c, A, 'p4', { amount: 30000 }); await bankReconcile(c, A, 'k4', t4.id, [{ paymentId: p4.payment.id, amountCents: 30000 }]); const part = await bankAmounts(c, A, t4.id); out.push(st(part));
    const row = (await c.query('select status, matched_amount_cents from fin_bank_transactions where id=$1', [t4.id])).rows[0]; out.push(`mirror ${row.status}/${row.matched_amount_cents}`);
    const p4b = await record(c, A, 'p4b', { amount: 20000 }); await bankReconcile(c, A, 'k4b', t4.id, [{ paymentId: p4b.payment.id, amountCents: 20000 }]); out.push(st(await bankAmounts(c, A, t4.id)));
    const over = await attempt(c, recSql, recArgs(A, 'k4c', t4.id, [{ paymentId: p4.payment.id, amountCents: 1 }])); out.push(over.code);
    return { holds: out[0] === 'RECONCILED matched=10000 ignored=0 remaining=0' && out[1] === 'RECONCILED matched=30000 ignored=0 remaining=0' && out[2].endsWith('30000') && out[3] === 'PARTIALLY_RECONCILED matched=30000 ignored=0 remaining=20000' && out[4] === 'mirror NEW/30000' && out[5] === 'RECONCILED matched=50000 ignored=0 remaining=0' && out[6] === 'FIN_BANK_OVER_RECONCILED', evidence: out.join(' | ') };
  } finally { await c.end(); }
}));

control('RECONCILE through Payments: 1 transaction 300 -> payment allocated to invoice A 100 and B 200; 3 transactions 100+50+150 -> 3 payments -> one invoice 300; surplus of the transaction stays visible', withDb(async (d) => {
  const c = await d.open();
  try {
    const a = await issuedInvoice(c, A, 10000); const b = await issuedInvoice(c, A, 20000); const t = await bankTx(c, A, { tag: 'big', amount: 30000 });
    const r = await bankReconcileAndPay(c, A, 'one-to-many', t.id, { amountCents: 30000, method: 'bank_transfer', allocations: [alloc(a.id, 10000), alloc(b.id, 20000)] }); const na = await netPaidOfInvoice(c, a.id); const nb = await netPaidOfInvoice(c, b.id);
    const inv = await issuedInvoice(c, A, 30000); const parts = []; for (const [i, x] of [10000, 5000, 15000].entries()) { const tt = await bankTx(c, A, { tag: `m${i}`, amount: x }); await bankReconcileAndPay(c, A, `many-to-one-${i}`, tt.id, { amountCents: x, allocations: [alloc(inv.id, x)] }); parts.push(tt.id); }
    const sur = await bankTx(c, A, { tag: 'surplus', amount: 50000 }); const inv2 = await issuedInvoice(c, A, 30000); await bankReconcileAndPay(c, A, 'surplus-1', sur.id, { amountCents: 30000, allocations: [alloc(inv2.id, 30000)] }); const sa = await bankAmounts(c, A, sur.id);
    return { holds: r.payment.source === 'bank' && na === 10000 && nb === 20000 && await netPaidOfInvoice(c, inv.id) === 30000 && sa.remaining === 20000 && sa.status === 'PARTIALLY_RECONCILED', evidence: `payment source=${r.payment.source}, A paid ${na}, B paid ${nb}; invoice funded by 3 payments = ${await netPaidOfInvoice(c, inv.id)}; transaction of 500 with 300 reconciled -> ${st(sa)} (nothing lost)` };
  } finally { await c.end(); }
}));

// ===================================================== ATOMICITY: claim -> payment =====================================================
control('ATOMICITY (the Payments gap): a refused payment leaves the bank transaction, the registry, the allocations and the audit trail exactly as they were', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const inv = await issuedInvoice(c, A, 5000); const t = await bankTx(c, A, { tag: 'atom', amount: 20000 }); const snap = async () => [await regCount(c), await num(c, 'select count(*) s from fin_payment_allocations'), await evCount(c), await num(c, 'select count(*) s from fin_bank_reconciliations')];
    const before = await snap(); const a1 = await attempt(c, payAndRecSql, payAndRecArgs(A, 'atom-1', t.id, { amountCents: 20000, allocations: [alloc(inv.id, 5001)] })); // payment refused (more than the invoice)
    const small = await bankTx(c, A, { tag: 'small', amount: 300 }); const a2 = await attempt(c, payAndRecSql, payAndRecArgs(A, 'atom-2', small.id, { amountCents: 500, allocations: [] })); // payment would succeed, reconciliation refused (more than the transaction)
    const a3 = await attempt(c, payAndRecSql, payAndRecArgs(A, 'atom-3', t.id, { amountCents: 20000, method: 'paypal', allocations: [] })); // refused method
    const after = await snap(); const row = (await c.query('select status, matched_amount_cents from fin_bank_transactions where id = any($1)', [[t.id, small.id]])).rows;
    return { holds: [a1.code, a2.code, a3.code].join() === 'FIN_ALLOCATION_EXCEEDS_REMAINING,FIN_BANK_OVER_RECONCILED,fin_payment_registry_method_chk' && before.join() === after.join() && row.every((r) => r.status === 'NEW' && r.matched_amount_cents === null), evidence: `${a1.code} / ${a2.code} / ${a3.code}; (registry, allocations, events, reconciliations) before=${before} after=${after}; transactions still NEW` };
  } finally { await c.end(); }
}));

control('ATOMICITY under injected failure: a crash raised AFTER the payment was created rolls everything back; after the cause is removed the same key succeeds exactly once', withDb(async (d) => {
  const c = await d.open();
  try {
    const inv = await issuedInvoice(c, A, 5000); const t = await bankTx(c, A, { tag: 'boom', amount: 5000 }); const base = [await regCount(c), await evCount(c)];
    await c.query("create function pg_temp.dummy() returns int language sql as 'select 1'");
    await c.query("create function public.test_boom() returns trigger language plpgsql as $$ begin raise exception 'INJECTED_FAILURE_AFTER_PAYMENT'; end $$; create trigger test_boom_trg before insert on fin_bank_reconciliations for each row execute function public.test_boom()");
    const failed = await attempt(c, payAndRecSql, payAndRecArgs(A, 'boom-key', t.id, { amountCents: 5000, allocations: [alloc(inv.id, 5000)] }));
    const mid = [await regCount(c), await evCount(c)]; const midRow = (await c.query('select status from fin_bank_transactions where id=$1', [t.id])).rows[0].status; const midPaid = await netPaidOfInvoice(c, inv.id); const midStatus = (await c.query('select status from fin_documents where id=$1', [inv.id])).rows[0].status;
    await c.query('drop trigger test_boom_trg on fin_bank_reconciliations'); await c.query('drop function public.test_boom()');
    const ok = await bankReconcileAndPay(c, A, 'boom-key', t.id, { amountCents: 5000, allocations: [alloc(inv.id, 5000)] }); const again = await bankReconcileAndPay(c, A, 'boom-key', t.id, { amountCents: 5000, allocations: [alloc(inv.id, 5000)] });
    return { holds: !failed.ok && /INJECTED_FAILURE/.test(failed.message) && mid.join() === base.join() && midRow === 'NEW' && midPaid === 0 && midStatus === 'ISSUED' && !ok.duplicate && again.duplicate && ok.payment.id === again.payment.id && await regCount(c) === base[0] + 1 && await netPaidOfInvoice(c, inv.id) === 5000,
      evidence: `injected failure -> registry/events unchanged (${mid}), transaction ${midRow}, invoice paid ${midPaid} (${midStatus}); retry with the same key: created once (duplicate=${again.duplicate}), registry ${base[0]}->${await regCount(c)}` };
  } finally { await c.end(); }
}));

control('NETWORK AMBIGUITY: the connection dies after COMMIT, the retry with the same key returns the committed payment and reconciliation; the same key on another transaction is refused', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s, A, 5000); const t = await bankTx(s, A, { tag: 'net1', amount: 5000 }); const t2 = await bankTx(s, A, { tag: 'net2', amount: 5000 }); await s.end();
  const { clients, closeAll } = await openMany(d.name, 3); const [first, retry, admin] = clients;
  try {
    const pid = (await first.query('select pg_backend_pid() p')).rows[0].p; const a = await bankReconcileAndPay(first, A, 'net-key', t.id, { amountCents: 5000, allocations: [alloc(inv.id, 5000)] }); await admin.query('select pg_terminate_backend($1)', [pid]).catch(() => {});
    const b = await bankReconcileAndPay(retry, A, 'net-key', t.id, { amountCents: 5000, allocations: [alloc(inv.id, 5000)] }); const other = await attempt(retry, payAndRecSql, payAndRecArgs(A, 'net-key', t2.id, { amountCents: 5000, allocations: [alloc(inv.id, 5000)] }));
    return { holds: b.duplicate === true && b.payment.id === a.payment.id && b.reconciliation.id === a.reconciliation.id && await regCount(admin) === 1 && !other.ok && other.code === 'FIN_IDEMPOTENCY_KEY_REUSED', evidence: `retry duplicate=${b.duplicate}, same payment and reconciliation; registry=${await regCount(admin)}; same key on another transaction -> ${other.code}` };
  } finally { await closeAll(); }
}));

// ===================================================== NO LAST-WRITER-WINS =====================================================
control('CONCURRENT: two users reconcile the same bank amount with two different payments at once -> exactly one wins, matched never exceeds the transaction', withDb(async (d) => {
  const s = await d.open(); const t = await bankTx(s, A, { tag: 'race1', amount: 100000 }); const ps = [await record(s, A, 'r1a', { amount: 100000 }), await record(s, A, 'r1b', { amount: 100000 })]; await s.end(); const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const res = await race(clients, (c, i) => c.query(recSql, recArgs(A, `race-${i}`, t.id, [{ paymentId: ps[i].payment.id, amountCents: 100000 }]))); const a = await bankAmounts(clients[0], A, t.id);
    return { holds: res.filter((r) => r.status === 'fulfilled').length === 1 && a.matched === 100000 && a.remaining === 0 && res.some((r) => has(r, 'FIN_BANK_OVER_RECONCILED')), evidence: `${res.map(codeOf).join(' / ')}; ${st(a)}` };
  } finally { await closeAll(); }
}));

control('CONCURRENT: two documents at once through the atomic path (700 each on a 1000 transaction) -> one wins, the loser leaves NO payment behind', withDb(async (d) => {
  const s = await d.open(); const i1 = await issuedInvoice(s, A, 700); const i2 = await issuedInvoice(s, A, 700); const t = await bankTx(s, A, { tag: 'race2', amount: 1000 }); const before = await regCount(s); await s.end(); const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const res = await race(clients, (c, i) => c.query(payAndRecSql, payAndRecArgs(A, `two-docs-${i}`, t.id, { amountCents: 700, allocations: [alloc((i ? i2 : i1).id, 700)] }))); const a = await bankAmounts(clients[0], A, t.id); const regs = await regCount(clients[0]) - before; const paid = (await netPaidOfInvoice(clients[0], i1.id)) + (await netPaidOfInvoice(clients[0], i2.id));
    return { holds: res.filter((r) => r.status === 'fulfilled').length === 1 && regs === 1 && paid === 700 && a.matched === 700, evidence: `${res.map(codeOf).join(' / ')}; payments created=${regs}; total paid on the two invoices=${paid}; ${st(a)}` };
  } finally { await closeAll(); }
}));

control('CONCURRENT partial: eight reconciliations of 300 on a 1000 transaction -> exactly three, remaining 100; the same key from eight connections is ONE effect', withDb(async (d) => {
  const s = await d.open(); const t = await bankTx(s, A, { tag: 'race3', amount: 1000 }); const t2 = await bankTx(s, A, { tag: 'race3b', amount: 1000 }); const ps = []; for (let i = 0; i < 8; i++) ps.push(await record(s, A, `r3p${i}`, { amount: 300 })); const pk = await record(s, A, 'r3same', { amount: 300 }); await s.end();
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c, i) => c.query(recSql, recArgs(A, `r3-${i}`, t.id, [{ paymentId: ps[i].payment.id, amountCents: 300 }]))); const a = await bankAmounts(clients[0], A, t.id);
    const same = await race(clients, (c) => c.query(recSql, recArgs(A, 'r3-same-key', t2.id, [{ paymentId: pk.payment.id, amountCents: 300 }]))); const sa = await bankAmounts(clients[0], A, t2.id); const fresh = same.filter((r) => r.status === 'fulfilled' && r.value.rows[0].r.duplicate === false).length;
    return { holds: res.filter((r) => r.status === 'fulfilled').length === 3 && a.matched === 900 && a.remaining === 100 && same.every((r) => r.status === 'fulfilled') && fresh === 1 && sa.matched === 300, evidence: `8 different payments: accepted=${res.filter((r) => r.status === 'fulfilled').length}, ${st(a)}; same key x8: fresh=${fresh}, matched=${sa.matched}` };
  } finally { await closeAll(); }
}));

control('CONCURRENT reconcile vs unreconcile: the amounts stay coherent whoever wins (10 rounds); never negative, never above the transaction', withDb(async (d) => {
  let bad = 0; const seen = new Set();
  for (let round = 0; round < 10; round++) {
    const s = await d.open(); const t = await bankTx(s, A, { tag: `ru${round}`, amount: 1000 }); const p = await record(s, A, `rup${round}`, { amount: 1000 }); const q = await record(s, A, `ruq${round}`, { amount: 1000 }); const r = await bankReconcile(s, A, `rur${round}`, t.id, [{ paymentId: p.payment.id, amountCents: 1000 }]); await s.end();
    const { clients, closeAll } = await openMany(d.name, 2);
    try {
      const res = await race(clients, (c, i) => (i === 0 ? c.query(unSql, unArgs(A, `ru-un-${round}`, [{ reconciliationId: r.reconciliations[0].id, amountCents: null }])) : c.query(recSql, recArgs(A, `ru-rec-${round}`, t.id, [{ paymentId: q.payment.id, amountCents: 1000 }]))));
      const a = await bankAmounts(clients[0], A, t.id); const net = await num(clients[0], "select coalesce(sum(amount_cents),0) s from fin_bank_reconciliations where bank_transaction_id=$1 and kind='MATCH'", [t.id]);
      seen.add(`${res.map((x) => (x.status === 'fulfilled' ? 'ok' : 'refused')).join('/')}->${a.matched}`);
      if (a.matched < 0 || a.matched > 1000 || a.remaining < 0 || a.matched !== net || res[0].status !== 'fulfilled') bad++;
    } finally { await closeAll(); }
  }
  return { holds: bad === 0, evidence: `10 rounds, inconsistent=${bad}; observed outcomes: ${[...seen].join(', ')}` };
}));

control('CONCURRENT unreconcile bounded: eight unreconciles of 300 on a 1000 reconciliation -> exactly three; and void vs reconcile on one payment never leaves a link to money that was voided', withDb(async (d) => {
  const s = await d.open(); const t = await bankTx(s, A, { tag: 'ub', amount: 1000 }); const p = await record(s, A, 'ubp', { amount: 1000 }); const r = await bankReconcile(s, A, 'ubr', t.id, [{ paymentId: p.payment.id, amountCents: 1000 }]); await s.end();
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c, i) => c.query(unSql, unArgs(A, `ub-${i}`, [{ reconciliationId: r.reconciliations[0].id, amountCents: 300 }]))); const a = await bankAmounts(clients[0], A, t.id);
    let bad = 0; for (let round = 0; round < 8; round++) {
      const tt = await bankTx(clients[0], A, { tag: `vr${round}`, amount: 1000 }); const pp = await record(clients[0], A, `vrp${round}`, { amount: 1000 });
      const out = await race(clients.slice(0, 2), (c, i) => (i === 0 ? c.query('select fin_void_payment($1,$2,$3,$4,$5,$6) r', [A, `vrv${round}`, pp.payment.id, '2026-10-01', 'x', '{}']) : c.query(recSql, recArgs(A, `vrr${round}`, tt.id, [{ paymentId: pp.payment.id, amountCents: 1000 }]))));
      const reconciled = await num(clients[0], 'select coalesce(sum(amount_cents),0) s from fin_bank_reconciliations where payment_id=$1', [pp.payment.id]); const reversed = await num(clients[0], 'select coalesce(sum(amount_cents),0) s from fin_payment_registry where reversal_of_id=$1', [pp.payment.id]);
      if (out.filter((x) => x.status === 'fulfilled').length !== 1 || reconciled + reversed > 1000) bad++;
    }
    return { holds: res.filter((r2) => r2.status === 'fulfilled').length === 3 && a.matched === 100 && bad === 0, evidence: `unreconcile x8 of 300: accepted=${res.filter((r2) => r2.status === 'fulfilled').length}, still matched ${a.matched}; void vs reconcile (8 rounds): exactly one wins each time, inconsistent=${bad}` };
  } finally { await closeAll(); }
}));

// ===================================================== REVERSIBLE, IGNORE, AUDIT =====================================================
control('UNRECONCILE: explicit, audited, history kept (negative linked rows), the mirror returns to NEW, the payment stays valid, amounts available again', withDb(async (d) => {
  const c = await d.open();
  try {
    const t = await bankTx(c, A, { tag: 'ur', amount: 5000 }); const p = await record(c, A, 'urp', { amount: 5000 }); const r = await bankReconcile(c, A, 'urr', t.id, [{ paymentId: p.payment.id, amountCents: 5000 }]);
    const un = await bankUnreconcile(c, A, 'urx', [{ reconciliationId: r.reconciliations[0].id, amountCents: 2000 }], 'wrong customer'); const rows = (await c.query('select amount_cents, reverses_id, kind, reason from fin_bank_reconciliations where bank_transaction_id=$1 order by created_at, amount_cents desc', [t.id])).rows;
    await bankUnreconcile(c, A, 'urx2', [{ reconciliationId: r.reconciliations[0].id, amountCents: null }], 'all of it'); const a = await bankAmounts(c, A, t.id); const mir = (await c.query('select status, matched_amount_cents, matched_at from fin_bank_transactions where id=$1', [t.id])).rows[0];
    const ev = (await c.query("select action, detail from fin_events where action in ('BANK_RECONCILE','BANK_UNRECONCILE') order by at, id")).rows; const pay = (await c.query('select amount_cents from fin_payment_registry where id=$1', [p.payment.id])).rows.length;
    const dele = await attempt(c, 'delete from fin_bank_reconciliations where bank_transaction_id=$1', [t.id]);
    return { holds: un.transaction.remaining === 2000 && rows.length === 2 && rows[1].reverses_id === r.reconciliations[0].id && String(rows[1].amount_cents) === '-2000' && (a.status === 'UNRECONCILED' && a.remaining === 5000 && mir.status === 'NEW' && mir.matched_amount_cents === null && mir.matched_at === null && pay === 1 && ev.length === 3 && ev.some((e) => e.detail.reason === 'wrong customer') && !dele.ok),
      evidence: `after partial unreconcile remaining=${un.transaction.remaining}; rows=${rows.length} before the second step (original + 1 linked negative, nothing deleted: delete -> ${dele.code}); final ${st(a)}; mirror ${mir.status}/${mir.matched_amount_cents}; payment kept; audit events=${ev.length} (${ev.map((e) => e.action).join(',')})` };
  } finally { await c.end(); }
}));

control('IGNORE: set aside on purpose, bounded by what is left, reversible, never together with more than the transaction', withDb(async (d) => {
  const c = await d.open();
  try {
    const t = await bankTx(c, A, { tag: 'ig', amount: -800 }); const p = await record(c, A, 'igp', { direction: 'OUT', amount: 300 }); await bankReconcile(c, A, 'igr', t.id, [{ paymentId: p.payment.id, amountCents: 300 }]);
    const ig = await bankIgnore(c, A, 'ig1', t.id, null, 'bank fee booked elsewhere'); const a1 = ig.transaction; const more = await attempt(c, 'select fin_bank_ignore($1,$2,$3,$4,$5,$6) r', [A, 'ig2', t.id, 1, 'x', '{}']);
    await bankUnreconcile(c, A, 'ig-undo', [{ reconciliationId: ig.reconciliation.id, amountCents: null }], 'it was not a fee'); const a2 = await bankAmounts(c, A, t.id);
    return { holds: a1.status === 'RECONCILED' && a1.ignored === 500 && a1.matched === 300 && a1.remaining === 0 && !more.ok && more.code === 'FIN_BANK_OVER_RECONCILED' && a2.status === 'PARTIALLY_RECONCILED' && a2.remaining === 500, evidence: `300 matched + 500 set aside -> ${st(a1)}; one cent more -> ${more.code}; after un-ignoring: ${st(a2)}` };
  } finally { await c.end(); }
}));

control('AUDIT: origin, import date, account, amount/currency, structured reference, who reconciled, the payment created, the suggestion evidence, allocations, retries - without any secret', withDb(async (d) => {
  const c = await d.open();
  try {
    const inv = await issuedInvoice(c, A, 12100); const t = await bankTx(c, A, { tag: 'aud', amount: 12100, ref: '+++000/0000/00097+++ INV', structured: '000000000097', source: 'bank', account: 'acc-1' });
    const evidence = { status: 'EXACT', confidence: 1, reasons: ['STRUCTURED_REFERENCE_MATCHES', 'AMOUNT_EQUALS_AMOUNT_DUE'], at: '2026-10-03T10:00:00Z' };
    const r = await bankReconcileAndPay(c, A, 'aud-1', t.id, { amountCents: 12100, method: 'bancontact', reference: 'virement', allocations: [alloc(inv.id, 12100)] }, evidence);
    const tx = (await c.query('select source, imported_at is not null as imported, bank_account_id is not null as account, amount_cents, currency, structured_reference from fin_bank_transactions where id=$1', [t.id])).rows[0];
    const rec = (await c.query('select method, suggestion, actor, idempotency_key, payment_id from fin_bank_reconciliations where bank_transaction_id=$1', [t.id])).rows[0];
    const pay = (await c.query('select source, bank_reference, structured_reference, method, idempotency_key from fin_payment_registry where id=$1', [r.payment.id])).rows[0];
    const events = (await c.query("select action from fin_events where action in ('RECORD_PAYMENT','BANK_RECONCILE') order by action")).rows.map((e) => e.action); const text = JSON.stringify([tx, rec, pay]);
    return { holds: tx.source === 'bank' && tx.imported && tx.account && rec.method === 'SUGGESTION_CONFIRMED' && rec.suggestion.status === 'EXACT' && rec.suggestion.reasons.includes('STRUCTURED_REFERENCE_MATCHES') && rec.actor !== null && rec.payment_id === r.payment.id && pay.source === 'bank' && pay.bank_reference === 'aud' && pay.structured_reference === '000000000097' && pay.method === 'bancontact'
      && events.join() === 'BANK_RECONCILE,RECORD_PAYMENT' && !/token|secret|password|BE68539007547034/.test(text), evidence: `transaction: ${tx.source}/imported/account linked; reconciliation: ${rec.method} with the suggestion evidence (${rec.suggestion.status}); payment: source=${pay.source}, bank_reference=${pay.bank_reference}, structured=${pay.structured_reference}; events: ${events.join(', ')}; no secret in the rows` };
  } finally { await c.end(); }
}));

// ===================================================== ISOLATION =====================================================
control('ISOLATION: merchant B can neither reconcile A\'s transaction, nor use A\'s payment, nor create a payment on A\'s documents through the bank; foreign keys hold alone', withDb(async (d) => {
  const c = await d.open(); const out = []; const fk = [];
  try {
    const inv = await issuedInvoice(c, A, 1000); const tA = await bankTx(c, A, { tag: 'isoA', amount: 1000 }); const tB = await bankTx(c, B, { tag: 'isoB', amount: 1000 }); const pA = await record(c, A, 'isopa', { amount: 1000 }); const pB = await record(c, B, 'isopb', { amount: 1000 });
    out.push((await attempt(c, recSql, recArgs(B, 'iso-1', tA.id, [{ paymentId: pB.payment.id, amountCents: 1000 }]))).code, (await attempt(c, recSql, recArgs(A, 'iso-2', tA.id, [{ paymentId: pB.payment.id, amountCents: 1000 }]))).code, (await attempt(c, recSql, recArgs(B, 'iso-3', tB.id, [{ paymentId: pA.payment.id, amountCents: 1000 }]))).code,
      (await attempt(c, payAndRecSql, payAndRecArgs(B, 'iso-4', tB.id, { amountCents: 1000, allocations: [alloc(inv.id, 1000)] }))).code);
    await c.query('alter table fin_bank_reconciliations disable trigger fin_bank_reconciliation_guard_trg');
    const ins = (m, tx, pay) => attempt(c, "insert into fin_bank_reconciliations (merchant_id, bank_transaction_id, payment_id, kind, amount_cents, currency, idempotency_key) values ($1,$2,$3,'MATCH',100,'EUR',$4)", [m, tx, pay, `fk-${Math.random()}`]);
    fk.push((await ins(B, tA.id, pB.payment.id)).code, (await ins(B, tB.id, pA.payment.id)).code); await c.query('alter table fin_bank_reconciliations enable trigger fin_bank_reconciliation_guard_trg');
    return { holds: out.every((x) => /^FIN_(BANK_TX|PAYMENT|DOCUMENT)_NOT_FOUND$|^FIN_[A-Z_]*NOT_FOUND$/.test(x)) && fk.join() === 'fin_bank_reconciliations_tx_fk,fin_bank_reconciliations_payment_fk', evidence: `RPC: ${out.join(' / ')}; with the guard disabled the foreign keys alone: ${fk.join(' / ')}` };
  } finally { await c.end(); }
}));

control('PERMISSIONS: anon and authenticated can neither read the bank tables nor call the bank RPCs; service_role can', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const t = await bankTx(c, A, { tag: 'perm', amount: 1000 }); const p = await record(c, A, 'permp', { amount: 1000 });
    for (const role of ['anon', 'authenticated']) { await c.query(`set role ${role}`); out.push(`${role}:rpc=${(await attempt(c, recSql, recArgs(A, `perm-${role}`, t.id, [{ paymentId: p.payment.id, amountCents: 100 }]))).ok ? 'ALLOWED' : 'refused'}`, `${role}:read=${(await attempt(c, 'select * from fin_bank_reconciliations')).ok ? 'ALLOWED' : 'refused'}`, `${role}:accounts=${(await attempt(c, 'select * from fin_bank_accounts')).ok ? 'ALLOWED' : 'refused'}`); await c.query('reset role'); }
    await c.query('set role service_role'); const ok = await attempt(c, recSql, recArgs(A, 'perm-svc', t.id, [{ paymentId: p.payment.id, amountCents: 100 }])); await c.query('reset role');
    return { holds: out.every((x) => x.endsWith('refused')) && ok.ok, evidence: `${out.join(', ')}, service_role:rpc=${ok.ok ? 'allowed' : ok.code}` };
  } finally { await c.end(); }
}));

// ===================================================== PROPERTY TEST =====================================================
const rng = (seed) => { let x = seed; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
for (const seed of [7, 2025, 31337]) {
  control(`PROPERTY (seed ${seed}): after 60 random reconciliations, unreconciliations, ignores, voids and payments, fin_bank_tx_amounts (SQL) == bank-ledger.js (JS) and the invariants hold`, withDb(async (d) => {
    const c = await d.open(); const rnd = rng(seed); const pick = (a) => a[Math.floor(rnd() * a.length)]; const txs = []; const pays = []; let ok = 0; let refused = 0; let mismatches = 0; const bad = [];
    try {
      for (let i = 0; i < 3; i++) txs.push(await bankTx(c, A, { tag: `pt${i}`, amount: 1000 * (i + 1) * (i === 2 ? -1 : 1) }));
      for (let step = 0; step < 60; step++) {
        const roll = rnd(); const key = `pp-${seed}-${step}`; let r;
        if (roll < 0.2) { const dir = rnd() < 0.7 ? 'IN' : 'OUT'; try { pays.push(await record(c, A, key, { direction: dir, amount: 200 + Math.floor(rnd() * 1800) })); r = { ok: true }; } catch { r = { ok: false }; } }
        else if (roll < 0.55 && pays.length) { const t = pick(txs); const p = pick(pays); r = await attempt(c, recSql, recArgs(A, key, t.id, [{ paymentId: p.payment.id, amountCents: 1 + Math.floor(rnd() * 1200) }])); }
        else if (roll < 0.75) { const rows = (await c.query("select id from fin_bank_reconciliations where amount_cents > 0")).rows; if (rows.length) r = await attempt(c, unSql, unArgs(A, key, [{ reconciliationId: pick(rows).id, amountCents: rnd() < 0.5 ? null : 1 + Math.floor(rnd() * 800) }])); else r = { ok: false }; }
        else if (roll < 0.85) r = await attempt(c, 'select fin_bank_ignore($1,$2,$3,$4,$5,$6) r', [A, key, pick(txs).id, rnd() < 0.5 ? null : 1 + Math.floor(rnd() * 500), 'fuzz', '{}']);
        else if (pays.length) r = await attempt(c, 'select fin_void_payment($1,$2,$3,$4,$5,$6) r', [A, key, pick(pays).payment.id, '2026-10-01', 'fuzz', '{}']); else r = { ok: false };
        if (r.ok) ok++; else refused++;
        const recs = (await c.query('select * from fin_bank_reconciliations')).rows.map((x) => ({ id: x.id, bankTransactionId: x.bank_transaction_id, paymentId: x.payment_id, kind: x.kind, amountCents: Number(x.amount_cents), createdAt: String(x.created_at), reversesId: x.reverses_id }));
        for (const t of txs) {
          const sql = await bankAmounts(c, A, t.id); const js = txAmounts({ id: t.id, amountCents: Number(t.amount_cents) }, recs); const same = sql.amount === js.amount && sql.matched === js.matched && sql.ignored === js.ignored && sql.remaining === js.remaining && sql.status === js.status;
          if (!same) { mismatches++; bad.push(`step ${step}: sql=${st(sql)} js=${JSON.stringify(js)}`); }
          if (sql.remaining < 0 || sql.matched < 0 || sql.ignored < 0 || sql.matched + sql.ignored > sql.amount) bad.push(`step ${step}: invariant ${st(sql)}`);
          const mir = (await c.query('select status from fin_bank_transactions where id=$1', [t.id])).rows[0].status; const expected = sql.status === 'RECONCILED' ? 'MATCHED' : sql.status === 'IGNORED' ? 'IGNORED' : 'NEW'; if (mir !== expected) bad.push(`step ${step}: mirror ${mir} != ${expected}`);
        }
        const over = (await c.query("select p.id from fin_payment_registry p where p.reversal_of_id is null and coalesce((select sum(amount_cents) from fin_bank_reconciliations r where r.payment_id=p.id),0) > p.amount_cents - coalesce((select sum(amount_cents) from fin_payment_registry x where x.reversal_of_id=p.id),0)")).rows; if (over.length) bad.push(`step ${step}: a payment is reconciled beyond what is left of it`);
      }
      return { holds: mismatches === 0 && bad.length === 0, evidence: `60 operations (${ok} accepted, ${refused} refused by the database), SQL==JS at every step: ${mismatches === 0}; violations: ${bad.length}${bad.length ? ' ' + bad[0] : ''}` };
    } finally { await c.end(); }
  }));
}
