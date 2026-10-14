// Cutover READINESS (nothing is deployed): the script supabase/cutover/payments-cutover.sql maps legacy payment truth to the new one. Proven here on a real PostgreSQL 17 with
// legacy rows that were legal before the integrity migrations (overpayments, corrections, PAID suppliers with no allocation), in a dry run, for real, and a second time.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedMerchants, insertDraft, issueDocument, insertSupplier, num, amountsOf, freshDatabase, MERCHANT_A } from './lib/db.js';
import { control } from './lib/classify.js';

const SCRIPT = readFileSync(fileURLToPath(new URL('../../supabase/cutover/payments-cutover.sql', import.meta.url)), 'utf8');
const A = MERCHANT_A;
const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const json = async (c, sql) => (await c.query(sql)).rows[0].r;
const legacy = (c, doc, cents, paidOn, method, ref) => c.query('insert into fin_payments (merchant_id, document_id, amount_cents, paid_on, method, reference, actor) values ($1,$2,$3,$4,$5,$6,$7)', [A, doc, cents, paidOn, method, ref, JSON.stringify({ type: 'merchant' })]);
const issued = async (c, gross, status) => { const inv = await issueDocument(c, A, await insertDraft(c, A, { gross })); if (status) await c.query('update fin_documents set status=$2 where id=$1', [inv.id, status]); return inv; };
// legacy supplier invoices were written PAID by hand: the truth guard that now forbids it is switched off ONLY to reproduce what production data could look like
const legacySupplier = async (c, over, paidCols) => { await c.query('alter table fin_supplier_invoices disable trigger fin_supplier_invoice_truth_guard_trg'); const s = await insertSupplier(c, A, { status: 'PAID', ...over });
  await c.query('update fin_supplier_invoices set paid_at=$2, paid_amount_cents=$3, paid_reference=$4, payment_status=$5 where id=$1', [s.id, paidCols.at, paidCols.amount, paidCols.ref, 'paid']); await c.query('alter table fin_supplier_invoices enable trigger fin_supplier_invoice_truth_guard_trg'); return s; };

async function seedLegacy(c, { dirty }) {
  const x = await issued(c, 10000, 'PAID'); await legacy(c, x.id, 4000, '2026-09-01', 'bank_transfer', 'virement 1'); await legacy(c, x.id, 6000, '2026-09-05', 'virement', 'cash desk'); // unknown legacy method -> other
  const y = await issued(c, 5000, 'PARTIALLY_PAID'); await legacy(c, y.id, 5000, '2026-09-02', 'card', 'carte'); await legacy(c, y.id, -1500, '2026-09-03', 'other', 'oops');
  const s1 = await legacySupplier(c, { gross: 12100 }, { at: '2026-09-10', amount: 12100, ref: 'F1' });
  const out = { x, y, s1 };
  if (dirty) {
    out.w = await issued(c, 5000, 'PAID'); await legacy(c, out.w.id, 6000, '2026-09-04', 'cash', 'overpaid in the legacy model');
    out.v = await issued(c, 4000, 'PARTIALLY_PAID'); await legacy(c, out.v.id, 1000, '2026-09-04', 'cash', 'p'); await legacy(c, out.v.id, -3000, '2026-09-06', 'cash', 'correction larger than the payment');
    out.s2 = await legacySupplier(c, { gross: 12100 }, { at: '2026-09-11', amount: 5, ref: 'partial amount in a PAID field' }); out.s3 = await legacySupplier(c, { gross: 12100 }, { at: null, amount: null, ref: null });
  }
  return out;
}
const snapshot = async (c) => ({ legacyRows: await num(c, 'select count(*) s from fin_payments'), legacySum: await num(c, 'select coalesce(sum(amount_cents),0) s from fin_payments'), suppliers: await num(c, 'select count(*) s from fin_supplier_invoices') });

control('CUTOVER dry run: plan, backfill and validate inside one transaction, then ROLLBACK -> nothing is kept, the legacy tables are untouched', withDb(async (d) => {
  const c = await d.open();
  try {
    const seeded = await seedLegacy(c, { dirty: true }); const before = await snapshot(c);
    await c.query('begin'); await c.query(SCRIPT);
    const plan = await json(c, 'select pg_temp.cutover_plan() r'); const rep = await json(c, 'select pg_temp.cutover_backfill() r'); const during = await num(c, 'select count(*) s from fin_payment_registry'); await c.query('rollback');
    const after = await snapshot(c); const kept = await num(c, 'select count(*) s from fin_payment_registry'); const trig = (await c.query("select tgenabled from pg_trigger where tgname='fin_payment_allocation_guard_trg'")).rows[0].tgenabled;
    return { holds: plan.legacy_customer_payments_positive === 5 && plan.legacy_customer_payments_negative === 2 && plan.supplier_paid_rows === 3 && plan.supplier_paid_consistent === 1 && plan.supplier_paid_anomalies.length === 2 && plan.expected_new_registry_rows === 6
      && rep.customer_payments_created === 5 && rep.customer_corrections_created === 2 && rep.supplier_payments_created === 1 && during === 6 && kept === 0 && JSON.stringify(before) === JSON.stringify(after) && trig === 'O' && seeded.x.id !== undefined,
      evidence: `plan: ${plan.legacy_customer_payments_positive}+ / ${plan.legacy_customer_payments_negative}- customer rows, supplier PAID ${plan.supplier_paid_consistent}/${plan.supplier_paid_rows} consistent, expected new registry rows ${plan.expected_new_registry_rows}; backfill created ${rep.customer_payments_created} payments + ${rep.customer_corrections_created} corrections + ${rep.supplier_payments_created} supplier; inside the transaction ${during} registry rows, after ROLLBACK ${kept}; legacy before==after: ${JSON.stringify(before) === JSON.stringify(after)}; guard trigger re-enabled=${trig}` };
  } finally { await c.end(); }
}));

control('CUTOVER for real on messy legacy data: clean rows migrate exactly, every anomaly is LISTED and not guessed, validation flags exactly those, a second run changes nothing', withDb(async (d) => {
  const c = await d.open();
  try {
    const s = await seedLegacy(c, { dirty: true }); const before = await snapshot(c);
    await c.query(SCRIPT); const rep = await json(c, 'select pg_temp.cutover_backfill() r'); const val = await json(c, 'select pg_temp.cutover_validate() r');
    const codes = (val.problems).map((p) => p.code).sort(); const exCodes = rep.exceptions.map((e) => e.code).sort();
    const ax = await amountsOf(c, A, s.x.id); const ay = await amountsOf(c, A, s.y.id); const sup = (await c.query('select status, payment_status, paid_amount_cents from fin_supplier_invoices where id=$1', [s.s1.id])).rows[0];
    const methods = (await c.query("select method, count(*)::int n from fin_payment_registry where direction='IN' group by method order by method")).rows.map((r) => `${r.method}:${r.n}`).join(',');
    const src = await num(c, "select count(*) s from fin_payment_registry where source like 'legacy:%'"); const regs = await num(c, 'select count(*) s from fin_payment_registry');
    const rep2 = await json(c, 'select pg_temp.cutover_backfill() r'); const regs2 = await num(c, 'select count(*) s from fin_payment_registry'); const after = await snapshot(c);
    return { holds: JSON.stringify(exCodes) === JSON.stringify(['CORRECTION_EXCEEDS_PAID', 'SUPPLIER_PAID_INCONSISTENT', 'SUPPLIER_PAID_INCONSISTENT'])
      && JSON.stringify(codes) === JSON.stringify(['CUSTOMER_NET_DIFFERS', 'LEGACY_OVERPAID_BEYOND_TOTAL', 'SUPPLIER_NET_DIFFERS', 'SUPPLIER_NET_DIFFERS']) && val.ok === false
      && ax.allocated === 10000 && ax.remaining_due === 0 && ay.allocated === 3500 && ay.remaining_due === 1500 && sup.status === 'PAID' && sup.payment_status === 'paid' && Number(sup.paid_amount_cents) === 12100
      && methods === 'bank_transfer:1,card:1,cash:2,other:1' // the unknown legacy method "virement" became "other"
      && rep2.customer_payments_created === 0 && rep2.supplier_payments_created === 0 && rep2.customer_corrections_created === 0 && regs2 === regs && JSON.stringify(before) === JSON.stringify(after) && src === regs,
      evidence: `exceptions=${exCodes.join('|')}; validation problems=${codes.join('|')} (ok=${val.ok}); clean invoice X allocated ${ax.allocated}/remaining ${ax.remaining_due}, Y allocated ${ay.allocated}/remaining ${ay.remaining_due}; supplier ${sup.status}/${sup.payment_status}; IN methods ${methods}; all ${src}/${regs} registry rows are legacy-sourced; 2nd run created ${rep2.customer_payments_created + rep2.supplier_payments_created + rep2.customer_corrections_created}, registry ${regs}->${regs2}; legacy tables unchanged=${JSON.stringify(before) === JSON.stringify(after)}` };
  } finally { await c.end(); }
}));

control('CUTOVER on clean legacy data: validation is OK, the new application reads the same truth (amounts, statuses), and from then on the new guards apply', withDb(async (d) => {
  const c = await d.open();
  try {
    const s = await seedLegacy(c, { dirty: false }); await c.query(SCRIPT); const rep = await json(c, 'select pg_temp.cutover_backfill() r'); const val = await json(c, 'select pg_temp.cutover_validate() r');
    const ay = await amountsOf(c, A, s.y.id); const over = await c.query('select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r', [A, 'post-cutover-1', 'IN', 1501, 'EUR', '2026-10-05', 'cash', null, '{}', JSON.stringify([{ customerDocumentId: s.y.id, amountCents: 1501 }])]).then(() => 'ACCEPTED', (e) => /FIN_[A-Z_]+/.exec(e.message)[0]);
    const ok = await c.query('select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r', [A, 'post-cutover-2', 'IN', 1500, 'EUR', '2026-10-05', 'cash', null, '{}', JSON.stringify([{ customerDocumentId: s.y.id, amountCents: 1500 }])]).then(() => 'ok', () => 'REFUSED');
    const supEdit = await c.query("update fin_supplier_invoices set supplier_name='Renamed' where id=$1", [s.s1.id]).then(() => 'edit ok', (e) => e.message.slice(0, 60));
    return { holds: rep.exceptions.length === 0 && val.ok === true && val.problems.length === 0 && ay.remaining_due === 1500 && over === 'FIN_ALLOCATION_EXCEEDS_REMAINING' && ok === 'ok' && supEdit === 'edit ok', evidence: `exceptions=${rep.exceptions.length}, validation ok=${val.ok}; after cutover the new ceiling applies (1501 on a 1500 balance -> ${over}; 1500 -> ${ok}); a migrated PAID supplier invoice stays editable (${supEdit})` };
  } finally { await c.end(); }
}));

control('CUTOVER PRECONDITION: a legacy PAID supplier invoice WITHOUT allocation cannot even be edited once the integrity migration is applied -> it must be migrated (or fixed) before the new code runs', withDb(async (d) => {
  const c = await d.open();
  try {
    const s = await legacySupplier(c, { gross: 12100 }, { at: '2026-09-10', amount: 12100, ref: 'F1' });
    const blocked = await c.query("update fin_supplier_invoices set supplier_name='Renamed' where id=$1", [s.id]).then(() => 'edit ok', (e) => /FIN_[A-Z_]+/.exec(e.message)?.[0] ?? e.message.slice(0, 50));
    await c.query(SCRIPT); await json(c, 'select pg_temp.cutover_backfill() r'); const fixed = await c.query("update fin_supplier_invoices set supplier_name='Renamed' where id=$1", [s.id]).then(() => 'edit ok', (e) => e.message.slice(0, 50));
    return { holds: blocked === 'FIN_PAID_REQUIRES_ALLOCATIONS' && fixed === 'edit ok', evidence: `before the backfill: ${blocked}; after: ${fixed}. Pre-flight must count status='PAID' supplier rows (production is expected to hold none).` };
  } finally { await c.end(); }
}));
