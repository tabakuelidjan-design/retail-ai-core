// Phase 0 - P0 REPRODUCERS. They expose KNOWN defects of the current database; they correct nothing.
// Each one resolves { holds, evidence }: holds === true would mean the database protects itself (defect absent).
// A reproduced defect is reported "EXPECTED P0 REPRODUCTION" and counts as a bench success; a defect that is NOT reproduced fails the run (something changed).
import { freshDatabase, openMany, race, seedMerchants, insertDraft, issueDocument, issueSql, issueArgs, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { expectedP0 } from './lib/classify.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const issuedInvoice = async (d, gross = 12100) => { const c = await d.open(); const doc = await insertDraft(c, MERCHANT_A, { gross }); const inv = await issueDocument(c, MERCHANT_A, doc); await c.end(); return inv; };
const paySql = 'insert into fin_payments (merchant_id, document_id, amount_cents, paid_on, method, reference) values ($1,$2,$3,$4,$5,$6) returning id';
const sum = async (c, sql, p) => Number((await c.query(sql, p)).rows[0].s);

expectedP0('P0-2 DOUBLE PAYMENT: two connections pay the full invoice at the same instant', withDb(async (d) => {
  const inv = await issuedInvoice(d); const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const res = await race(clients, (c) => c.query(paySql, [MERCHANT_A, inv.id, inv.gross_cents, '2026-09-30', 'bank', 'virement']));
    const ok = res.filter((r) => r.status === 'fulfilled').length; const total = await sum(clients[0], 'select coalesce(sum(amount_cents),0) s from fin_payments where document_id=$1', [inv.id]);
    return { holds: total <= inv.gross_cents, evidence: `payments accepted=${ok}; paid ${total} cents on an invoice of ${inv.gross_cents} (excess ${total - inv.gross_cents})` };
  } finally { await closeAll(); }
}));

expectedP0('P0-2 DOUBLE CLICK: the same payment submitted twice within milliseconds (same payload)', withDb(async (d) => {
  const inv = await issuedInvoice(d, 20000); const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const args = [MERCHANT_A, inv.id, 15000, '2026-09-30', 'bank', 'REF-1'];
    await race(clients, (c) => c.query(paySql, args));
    const n = (await clients[0].query('select count(*)::int n from fin_payments where document_id=$1 and reference=$2', [inv.id, 'REF-1'])).rows[0].n;
    const total = await sum(clients[0], 'select coalesce(sum(amount_cents),0) s from fin_payments where document_id=$1', [inv.id]);
    return { holds: n === 1, evidence: `identical payloads stored=${n} (no idempotency key exists); recorded ${total} cents of a 20000-cent invoice` };
  } finally { await closeAll(); }
}));

expectedP0('P0-2 NETWORK RETRY: connection lost after COMMIT, the client retries the same payment', withDb(async (d) => {
  const inv = await issuedInvoice(d, 20000); const { clients, closeAll } = await openMany(d.name, 3);
  const [first, retry, admin] = clients;
  try {
    const args = [MERCHANT_A, inv.id, 15000, '2026-09-30', 'bank', 'REF-2'];
    await first.query(paySql, args);                                       // committed (autocommit)
    await admin.query('select pg_terminate_backend($1)', [(await first.query('select pg_backend_pid() p').catch(() => ({ rows: [{ p: 0 }] }))).rows[0].p]).catch(() => {});
    // the client never saw the answer: it retries on a fresh connection with the same payload
    await retry.query(paySql, args);
    const n = (await admin.query('select count(*)::int n from fin_payments where document_id=$1 and reference=$2', [inv.id, 'REF-2'])).rows[0].n;
    return { holds: n === 1, evidence: `after the retry the same payment exists ${n} time(s) (15000 cents x ${n} on a 20000-cent invoice)` };
  } finally { await closeAll(); }
}));

expectedP0('P0-1 CONCURRENT CREDIT: two credit notes issued at the same instant for one invoice', withDb(async (d) => {
  const inv = await issuedInvoice(d); const setup = await d.open();
  const cn = [await insertDraft(setup, MERCHANT_A, { docType: 'credit_note', related: inv.id }), await insertDraft(setup, MERCHANT_A, { docType: 'credit_note', related: inv.id })]; await setup.end();
  const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const res = await race(clients, (c, i) => c.query(issueSql, issueArgs(MERCHANT_A, cn[i], { prefix: 'NC' })));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    const credited = await sum(clients[0], "select coalesce(sum(gross_cents),0) s from fin_documents where doc_type='credit_note' and related_document_id=$1 and number is not null", [inv.id]);
    return { holds: credited <= inv.gross_cents, evidence: `credit notes issued=${ok}; credited ${credited} cents against an invoice of ${inv.gross_cents} (over-credit ${credited - inv.gross_cents})` };
  } finally { await closeAll(); }
}));

expectedP0('P0-1 CREDIT CEILING (sequential): the database has no ceiling at all, even without concurrency', withDb(async (d) => {
  const inv = await issuedInvoice(d); const c = await d.open(); let n = 0;
  for (let i = 0; i < 3; i++) { const cn = await insertDraft(c, MERCHANT_A, { docType: 'credit_note', related: inv.id }); try { await issueDocument(c, MERCHANT_A, cn, { prefix: 'NC' }); n++; } catch { /* refused */ } }
  const credited = await sum(c, "select coalesce(sum(gross_cents),0) s from fin_documents where doc_type='credit_note' and related_document_id=$1 and number is not null", [inv.id]); await c.end();
  return { holds: credited <= inv.gross_cents, evidence: `${n} full credit notes issued one after the other: ${credited} cents credited on a ${inv.gross_cents}-cent invoice` };
}));

expectedP0('CONCURRENT RECONCILIATION: two connections claim the same bank transaction for two different invoices', withDb(async (d) => {
  const setup = await d.open();
  const tx = (await setup.query(`insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, source) values ($1,'csv-import','tx-9','2026-09-01',-1210,'EUR','csv') returning id`, [MERCHANT_A])).rows[0].id; await setup.end();
  const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const targets = ['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b'];
    const res = await race(clients, (c, i) => c.query(`update fin_bank_transactions set status='MATCHED', matched_kind='SUPPLIER_INVOICE', matched_document_id=$2, matched_amount_cents=1210 where id=$1`, [tx, targets[i]]));
    const ok = res.filter((r) => r.status === 'fulfilled').length; const row = (await clients[0].query('select matched_document_id from fin_bank_transactions where id=$1', [tx])).rows[0];
    return { holds: ok === 1, evidence: `claims accepted=${ok} of 2; final owner=${row.matched_document_id.slice(-1)} (the other claimant was told it succeeded: lost update, no reconciliation ledger)` };
  } finally { await closeAll(); }
}));

expectedP0('CONCURRENT REVERSAL: two connections refund the same 5000-cent payment in full', withDb(async (d) => {
  const inv = await issuedInvoice(d); const setup = await d.open(); await setup.query(paySql, [MERCHANT_A, inv.id, 5000, '2026-09-30', 'bank', 'P']); await setup.end();
  const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const res = await race(clients, (c) => c.query(paySql, [MERCHANT_A, inv.id, -5000, '2026-10-01', 'bank', 'REFUND']));
    const ok = res.filter((r) => r.status === 'fulfilled').length; const net = await sum(clients[0], 'select sum(amount_cents) s from fin_payments where document_id=$1', [inv.id]);
    return { holds: net >= 0 && ok === 1, evidence: `refund rows accepted=${ok}; net paid=${net} cents (a payment of 5000 was reversed ${ok} times; legacy has no reversal link, so nothing ties a refund to its payment)` };
  } finally { await closeAll(); }
}));

expectedP0('CROSS-MERCHANT: merchant B writes against the documents of merchant A', withDb(async (d) => {
  const inv = await issuedInvoice(d); const c = await d.open(); const found = [];
  const tries = [
    ['payment of B on invoice of A', () => c.query(paySql, [MERCHANT_B, inv.id, 100, '2026-09-30', 'bank', 'x'])],
    ['event of B on invoice of A', () => c.query("insert into fin_events (merchant_id, document_id, action) values ($1,$2,'X')", [MERCHANT_B, inv.id])],
    ['credit note of B pointing at invoice of A', () => c.query("insert into fin_documents (merchant_id, doc_type, status, body, related_document_id) values ($1,'credit_note','DRAFT','{}',$2)", [MERCHANT_B, inv.id])],
  ];
  for (const [name, fn] of tries) { try { await fn(); found.push(`${name}: ACCEPTED`); } catch { found.push(`${name}: refused`); } }
  await c.end(); return { holds: found.every((x) => x.endsWith('refused')), evidence: found.join('; ') };
}));

expectedP0('P0-3 SUPPLIER PAID WITHOUT PAYMENT: a supplier invoice can be written PAID with no allocation', withDb(async (d) => {
  const c = await d.open();
  let ok = true; try { await c.query(`insert into fin_supplier_invoices (merchant_id, supplier_name, invoice_number, issue_date, net_cents, vat_cents, gross_cents, currency, status) values ($1,'F','F-1','2026-09-01',1000,210,1210,'EUR','PAID')`, [MERCHANT_A]); } catch { ok = false; }
  const row = (await c.query('select status, paid_at, paid_amount_cents from fin_supplier_invoices')).rows[0]; await c.end();
  return { holds: !ok, evidence: `PAID accepted=${ok}; stored paid_at=${row?.paid_at}, paid_amount_cents=${row?.paid_amount_cents} (status PAID with no payment evidence at all)` };
}));
