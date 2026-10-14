// Phase 1 - the Phase 0 payment reproducers, kept as they were, now aimed at the LEGACY table fin_payments.
// fin_payments is FROZEN AT CUTOVER: since Phase 1 no application code reads or writes it (every payment goes through fin_record_payment, see 30-p0-regression).
// Its weaknesses are therefore documented, not repaired (a fix here would be a temporary solution around a table that is being retired): each one is reported as
// "KNOWN LEGACY GAP". If one is ever closed, or the table is frozen by trigger, the test fails and must become a control. Production holds 0 rows in this table.
import { openMany, race, seedMerchants, issuedInvoice, freshDatabase, MERCHANT_A, MERCHANT_B, num } from './lib/db.js';
import { control, legacyGap } from './lib/classify.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const paySql = 'insert into fin_payments (merchant_id, document_id, amount_cents, paid_on, method, reference) values ($1,$2,$3,$4,$5,$6) returning id';
const invoice = async (d, gross) => { const c = await d.open(); const inv = await issuedInvoice(c, MERCHANT_A, gross); await c.end(); return inv; };

legacyGap('LEGACY fin_payments: two simultaneous full payments are both stored (no ceiling)', withDb(async (d) => {
  const inv = await invoice(d); const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const res = await race(clients, (c) => c.query(paySql, [MERCHANT_A, inv.id, inv.gross_cents, '2026-09-30', 'bank', 'virement']));
    const total = await num(clients[0], 'select coalesce(sum(amount_cents),0) s from fin_payments where document_id=$1', [inv.id]);
    return { holds: total <= inv.gross_cents, evidence: `accepted=${res.filter((r) => r.status === 'fulfilled').length}; ${total} cents on an invoice of ${inv.gross_cents}` };
  } finally { await closeAll(); }
}));

legacyGap('LEGACY fin_payments: the same payload twice is stored twice (no idempotency key)', withDb(async (d) => {
  const inv = await invoice(d, 20000); const { clients, closeAll } = await openMany(d.name, 2);
  try {
    await race(clients, (c) => c.query(paySql, [MERCHANT_A, inv.id, 15000, '2026-09-30', 'bank', 'REF-1']));
    const n = (await clients[0].query('select count(*)::int n from fin_payments where document_id=$1', [inv.id])).rows[0].n;
    return { holds: n === 1, evidence: `identical payloads stored=${n}` };
  } finally { await closeAll(); }
}));

legacyGap('LEGACY fin_payments: a refund row can repeat without limit (no link to a payment)', withDb(async (d) => {
  const inv = await invoice(d); const setup = await d.open(); await setup.query(paySql, [MERCHANT_A, inv.id, 5000, '2026-09-30', 'bank', 'P']); await setup.end();
  const { clients, closeAll } = await openMany(d.name, 2);
  try {
    await race(clients, (c) => c.query(paySql, [MERCHANT_A, inv.id, -5000, '2026-10-01', 'bank', 'REFUND']));
    const net = await num(clients[0], 'select sum(amount_cents) s from fin_payments where document_id=$1', [inv.id]);
    return { holds: net >= 0, evidence: `net=${net} after two refunds of the same 5000` };
  } finally { await closeAll(); }
}));

// Not a gap any more: the one structural defect of the legacy table that Phase 1 DID close (isolation is a foreign key, it costs nothing and breaks nothing).
control('LEGACY fin_payments: merchant isolation is now enforced (composite foreign key)', withDb(async (d) => {
  const inv = await invoice(d); const c = await d.open();
  try { await c.query(paySql, [MERCHANT_B, inv.id, 100, '2026-09-30', 'bank', 'x']); return { holds: false, evidence: 'merchant B wrote a payment on the invoice of merchant A' }; }
  catch (e) { return { holds: /fin_payments_document_same_merchant_fk/.test(e.message), evidence: e.constraint ?? e.message.slice(0, 80) }; } finally { await c.end(); }
}));
