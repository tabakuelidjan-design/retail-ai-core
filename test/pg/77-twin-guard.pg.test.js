// SQL guard against unresolved identical movements (migration 20261119100000_finance_bank_twin_guard.sql), on a real PostgreSQL 17, disposable database.
// Controls: a twin cannot be reconciled through the SQL functions while the other is unresolved; two genuinely distinct movements (different reliable
// bank references) both stay reconcilable; setting one aside (IGNORED) releases the other; merchants are isolated; two concurrent reconciliations of
// identical movements cannot both succeed; provider accounts are out of scope. Synthetic data only. No real bank data, no production.
import { seedMerchants, num, freshDatabase, race, issuedInvoice, record, bankReconcile, bankIgnore, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { control } from './lib/classify.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };

// A file movement exactly as the service stores it (csv pseudo-account, file source). bankRef is the bank's own reference, or null.
const tx = (c, merchantId, { tag, ref = 'INV 2026 0001', cp = 'Client Exemple SA', amount = 3000, bankRef = null, account = 'csv-import' }) =>
  c.query(`insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, reference, counterparty_name, bank_reference, source)
           values ($1,$2,$3,'2026-09-22',$4,'EUR',$5,$6,$7,'csv') returning *`, [merchantId, account, tag, amount, ref, cp, bankRef]).then((r) => r.rows[0]);

// Runs an operation and reports the database error message (or null when it succeeded).
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };

control('TWIN BLOCKED IN SQL: two unresolved identical movements cannot be booked through the SQL functions, by a direct database call', withDb(async (d) => {
  const c = await d.open();
  try {
    const inv = await issuedInvoice(c, MERCHANT_A, 30000);
    const x = await tx(c, MERCHANT_A, { tag: 'csv-X' }); const y = await tx(c, MERCHANT_A, { tag: 'csv-Y' });
    const p1 = await record(c, MERCHANT_A, 'pay-1', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const p2 = await record(c, MERCHANT_A, 'pay-2', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const first = await refusal(() => bankReconcile(c, MERCHANT_A, 'rec-x', x.id, [{ paymentId: p1.payment.id, amountCents: 3000 }]));
    const twin = await refusal(() => bankReconcile(c, MERCHANT_A, 'rec-y', y.id, [{ paymentId: p2.payment.id, amountCents: 3000 }]));
    const bookings = await num(c, `select count(*) s from fin_bank_reconciliations where merchant_id='${MERCHANT_A}' and kind='MATCH' and amount_cents > 0`);
    // Two unresolved identical movements are AMBIGUOUS: neither is booked until one is set aside (same rule as the service, both directions).
    const holds = first !== null && /FIN_BANK_POSSIBLE_DUPLICATE/.test(first) && twin !== null && /FIN_BANK_POSSIBLE_DUPLICATE/.test(twin) && bookings === 0;
    return { holds, evidence: `first=${first === null ? 'accepted' : 'refused'} twin=${twin ? twin.split('\n')[0] : 'ACCEPTED (defect)'} bookings=${bookings}` };
  } finally { await c.end(); }
}));

control('DISTINCT MOVEMENTS: two identical-looking movements with DIFFERENT reliable bank references are both reconcilable', withDb(async (d) => {
  const c = await d.open();
  try {
    const inv = await issuedInvoice(c, MERCHANT_A, 30000);
    const x = await tx(c, MERCHANT_A, { tag: 'csv-R1', bankRef: 'BANK-REF-1' }); const y = await tx(c, MERCHANT_A, { tag: 'csv-R2', bankRef: 'BANK-REF-2' });
    const p1 = await record(c, MERCHANT_A, 'dist-1', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const p2 = await record(c, MERCHANT_A, 'dist-2', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const rx = await refusal(() => bankReconcile(c, MERCHANT_A, 'dist-rec-x', x.id, [{ paymentId: p1.payment.id, amountCents: 3000 }]));
    const ry = await refusal(() => bankReconcile(c, MERCHANT_A, 'dist-rec-y', y.id, [{ paymentId: p2.payment.id, amountCents: 3000 }]));
    return { holds: rx === null && ry === null, evidence: `x=${rx ? rx.split('\n')[0] : 'accepted'} y=${ry ? ry.split('\n')[0] : 'accepted'}` };
  } finally { await c.end(); }
}));

control('SET ASIDE RELEASES: setting one twin aside (IGNORED) lets the other be reconciled, and the set-aside one cannot be booked', withDb(async (d) => {
  const c = await d.open();
  try {
    const inv = await issuedInvoice(c, MERCHANT_A, 30000);
    const x = await tx(c, MERCHANT_A, { tag: 'csv-X2' }); const y = await tx(c, MERCHANT_A, { tag: 'csv-Y2' });
    const p1 = await record(c, MERCHANT_A, 'aside-1', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const p2 = await record(c, MERCHANT_A, 'aside-2', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    await bankIgnore(c, MERCHANT_A, 'aside-ig', y.id, null, 'doublon du même virement');
    const rx = await refusal(() => bankReconcile(c, MERCHANT_A, 'aside-rec-x', x.id, [{ paymentId: p1.payment.id, amountCents: 3000 }]));
    const ry = await refusal(() => bankReconcile(c, MERCHANT_A, 'aside-rec-y', y.id, [{ paymentId: p2.payment.id, amountCents: 3000 }]));
    return { holds: rx === null && ry !== null, evidence: `x=${rx ? rx.split('\n')[0] : 'accepted'} set-aside y=${ry ? ry.split('\n')[0] : 'accepted (defect)'}` };
  } finally { await c.end(); }
}));

control('MERCHANT ISOLATION: a twin of merchant A never blocks merchant B', withDb(async (d) => {
  const c = await d.open();
  try {
    await tx(c, MERCHANT_A, { tag: 'iso-A' }); // A holds an unresolved movement with the same identity
    const z = await tx(c, MERCHANT_B, { tag: 'iso-B' });
    const inv = await issuedInvoice(c, MERCHANT_B, 30000);
    const p = await record(c, MERCHANT_B, 'iso-pay', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const rz = await refusal(() => bankReconcile(c, MERCHANT_B, 'iso-rec', z.id, [{ paymentId: p.payment.id, amountCents: 3000 }]));
    return { holds: rz === null, evidence: `merchant B reconciles its own movement: ${rz ? rz.split('\n')[0] : 'accepted'}` };
  } finally { await c.end(); }
}));

control('CONCURRENT TWINS: two simultaneous reconciliations of identical unresolved movements: neither is booked', withDb(async (d) => {
  const setup = await d.open();
  const inv = await issuedInvoice(setup, MERCHANT_A, 30000);
  const x = await tx(setup, MERCHANT_A, { tag: 'race-X' }); const y = await tx(setup, MERCHANT_A, { tag: 'race-Y' });
  const p1 = await record(setup, MERCHANT_A, 'race-1', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
  const p2 = await record(setup, MERCHANT_A, 'race-2', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
  await setup.end();
  const clients = await Promise.all([d.open(), d.open()]);
  try {
    const settled = await race(clients, (c, i) => bankReconcile(c, MERCHANT_A, `race-rec-${i}`, (i === 0 ? x : y).id, [{ paymentId: (i === 0 ? p1 : p2).payment.id, amountCents: 3000 }]));
    const ok = settled.filter((s) => s.status === 'fulfilled').length;
    const refused = settled.filter((s) => s.status === 'rejected' && /FIN_BANK_POSSIBLE_DUPLICATE/.test(String(s.reason?.message))).length;
    const booked = await num(clients[0], `select count(*) s from fin_bank_reconciliations where merchant_id='${MERCHANT_A}' and kind='MATCH' and amount_cents > 0`);
    return { holds: ok === 0 && refused === 2 && booked === 0, evidence: `accepted=${ok} refused_as_twin=${refused} booked=${booked} (both unresolved: neither wins)` };
  } finally { await Promise.all(clients.map((c) => c.end())); }
}));

control('SCOPE: provider accounts are out of the twin rule (identical provider movements are not blocked by the file rule)', withDb(async (d) => {
  const c = await d.open();
  try {
    const x = await tx(c, MERCHANT_A, { tag: 'prov-X', account: 'acc-provider-1' }); const y = await tx(c, MERCHANT_A, { tag: 'prov-Y', account: 'acc-provider-1' });
    const inv = await issuedInvoice(c, MERCHANT_A, 30000);
    const p1 = await record(c, MERCHANT_A, 'prov-1', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const p2 = await record(c, MERCHANT_A, 'prov-2', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const rx = await refusal(() => bankReconcile(c, MERCHANT_A, 'prov-rec-x', x.id, [{ paymentId: p1.payment.id, amountCents: 3000 }]));
    const ry = await refusal(() => bankReconcile(c, MERCHANT_A, 'prov-rec-y', y.id, [{ paymentId: p2.payment.id, amountCents: 3000 }]));
    return { holds: rx === null && ry === null, evidence: `provider x=${rx ? rx.split('\n')[0] : 'accepted'} y=${ry ? ry.split('\n')[0] : 'accepted'}` };
  } finally { await c.end(); }
}));

control('ALL WRITE PATHS: an upsert (ON CONFLICT) cannot book an unresolved twin, and a reconciliation row cannot be updated afterwards', withDb(async (d) => {
  const c = await d.open();
  try {
    const inv = await issuedInvoice(c, MERCHANT_A, 30000);
    const x = await tx(c, MERCHANT_A, { tag: 'up-X', ref: 'UP-REF-X' }); const y = await tx(c, MERCHANT_A, { tag: 'up-Y', ref: 'UP-REF-X' });
    const p1 = await record(c, MERCHANT_A, 'up-pay-1', { amount: 3000, allocations: [{ customerDocumentId: inv.id, amountCents: 3000 }] });
    const upsert = await refusal(() => c.query(`insert into fin_bank_reconciliations (merchant_id, bank_transaction_id, payment_id, kind, amount_cents, currency, method, idempotency_key, actor, created_at)
      values ($1,$2,$3,'MATCH',3000,'EUR','MANUAL','upsert-probe-1','{}'::jsonb, now()) on conflict (merchant_id, idempotency_key) do nothing`, [MERCHANT_A, x.id, p1.payment.id]));
    const booked = await num(c, `select count(*) s from fin_bank_reconciliations where merchant_id='${MERCHANT_A}' and kind='MATCH' and amount_cents > 0`);
    await bankIgnore(c, MERCHANT_A, 'up-ig', y.id, null, 'doublon');
    const ignoreRow = (await c.query(`select id from fin_bank_reconciliations where merchant_id=$1 and kind='IGNORE' limit 1`, [MERCHANT_A])).rows[0];
    const update = await refusal(() => c.query(`update fin_bank_reconciliations set amount_cents = 1 where id = $1`, [ignoreRow.id]));
    const refusedUpsert = upsert !== null && /FIN_BANK_POSSIBLE_DUPLICATE/.test(upsert);
    return { holds: refusedUpsert && booked === 0 && update !== null, evidence: `upsert=${upsert ? upsert.split('\n')[0] : 'ACCEPTED (defect)'} booked=${booked} update=${update ? update.split('\n')[0] : 'ACCEPTED (defect)'}` };
  } finally { await c.end(); }
}));
