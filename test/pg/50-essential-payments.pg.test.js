// Essential Payments on a real PostgreSQL 17: refunds, credit-note interaction, late allocation, one payment -> many documents, vocabulary and provenance,
// locking order under mixed concurrent operations, and a randomised property test holding fin_invoice_amounts (SQL) equal to amounts.js (JS) with the invariants intact.
import { openMany, race, seedMerchants, insertDraft, issueDocument, issueSql, issueArgs, issuedInvoice, insertSupplier, record, reverseAllocations, voidPayment, allocateLater, amountsOf, netPaidOfInvoice, netPaidOfSupplier,
  num, attempt, codeOf, freshDatabase, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { control } from './lib/classify.js';
import { amountsOfInvoice } from '../../src/finance/payment-ledger.js';
import { amountViolations } from '../../src/finance/amounts.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const A = MERCHANT_A; const B = MERCHANT_B;
const alloc = (id, cents) => ({ customerDocumentId: id, amountCents: cents });
const salloc = (id, cents) => ({ supplierInvoiceId: id, amountCents: cents });
const has = (settled, code) => settled.status === 'rejected' && new RegExp(code).test(settled.reason.message);
const issueCn = async (c, inv, gross, merchant = A) => { const d = await insertDraft(c, merchant, { docType: 'credit_note', related: inv.id, gross }); return issueDocument(c, merchant, d, { prefix: 'NC' }); };
const refund = (c, cn, key, cents, extra = {}) => record(c, A, key, { direction: 'OUT', amount: cents, allocations: [alloc(cn.id, cents)], ...extra });
const refundSql = 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,$11) r';
const refundArgs = (merchant, key, cn, cents, meta = null) => [merchant, key, 'OUT', cents, 'EUR', '2026-10-01', 'bank_transfer', null, '{}', JSON.stringify([alloc(cn.id, cents)]), meta ? JSON.stringify(meta) : null];
const am = (a) => `due=${a.effective_due} allocated=${a.allocated} refunded=${a.refunded} retained=${a.retained} remaining=${a.remaining_due} refundable=${a.refundable}`;

// ===================================================== REFUNDS (credit note != refund != reversal) =====================================================
control('REFUND: a credit note creates no money movement; the refund is a separate, explicit, bounded, linked OUT payment', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 10000); const pay = await record(c, A, 'rf-pay', { amount: 10000, allocations: [alloc(inv.id, 10000)] });
  try {
    const cn = await issueCn(c, inv, 3000); const afterCredit = await amountsOf(c, A, inv.id); const regsAfterCredit = await num(c, 'select count(*) s from fin_payment_registry');
    const r1 = await refund(c, cn, 'rf-1', 3000, { meta: { refundOfPaymentId: pay.payment.id } }); const a1 = await amountsOf(c, A, inv.id); const more = await attempt(c, refundSql, refundArgs(A, 'rf-2', cn, 1));
    const ev = await num(c, "select count(*) s from fin_events where action='RECORD_REFUND'");
    return { holds: afterCredit.refundable === 3000 && afterCredit.refunded === 0 && regsAfterCredit === 1 && r1.payment.direction === 'OUT' && r1.payment.refund_of_payment_id === pay.payment.id && a1.refunded === 3000 && a1.retained === 7000 && a1.refundable === 0 && a1.remaining_due === 0 && !more.ok && more.code === 'FIN_REFUND_EXCEEDS_CREDIT_NOTE' && ev === 1,
      evidence: `after credit: ${am(afterCredit)} (no payment created: registry=${regsAfterCredit}); after refund 3000: ${am(a1)}; one cent more -> ${more.code}; RECORD_REFUND events=${ev}` };
  } finally { await c.end(); }
}));

control('REFUND preconditions: not for a draft credit note, not when nothing was paid beyond what is due, not for an invoice, not with an IN payment', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 10000); const out = [];
  try {
    const draft = await insertDraft(c, A, { docType: 'credit_note', related: inv.id, gross: 2000 });
    out.push((await attempt(c, refundSql, refundArgs(A, 'pre-1', draft, 100))).code);
    const cn = await issueCn(c, inv, 2000); out.push((await attempt(c, refundSql, refundArgs(A, 'pre-2', cn, 100))).code); // credited before any payment: due 8000, nothing paid -> nothing refundable
    await record(c, A, 'pre-pay', { amount: 8000, allocations: [alloc(inv.id, 8000)] }); out.push((await attempt(c, refundSql, refundArgs(A, 'pre-3', cn, 100))).code); // paid exactly what is due
    out.push((await attempt(c, refundSql, refundArgs(A, 'pre-4', inv, 100))).code); // an OUT payment cannot settle an invoice
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'pre-5', 'IN', 100, 'EUR', '2026-10-01', 'cash', null, '{}', JSON.stringify([alloc(cn.id, 100)])])).code); // an IN payment cannot settle a credit note
    return { holds: out.join() === 'FIN_TARGET_NOT_OPEN,FIN_REFUND_EXCEEDS_REFUNDABLE,FIN_REFUND_EXCEEDS_REFUNDABLE,FIN_DIRECTION_MISMATCH,FIN_DIRECTION_MISMATCH', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('REFUND link to the payment it gives back: never more than that payment, only an IN payment of the same merchant and currency', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 10000); const p1 = await record(c, A, 'lk-p1', { amount: 9000, allocations: [alloc(inv.id, 9000)] }); const p2 = await record(c, A, 'lk-p2', { amount: 1000, allocations: [alloc(inv.id, 1000)] });
  const out = [];
  try {
    const cn = await issueCn(c, inv, 3000);
    out.push((await attempt(c, refundSql, refundArgs(A, 'lk-1', cn, 1500, { refundOfPaymentId: p2.payment.id }))).code ?? 'OK'); // 1500 > the 1000 of p2
    out.push((await attempt(c, refundSql, refundArgs(A, 'lk-2', cn, 1000, { refundOfPaymentId: p2.payment.id }))).code ?? 'OK');
    out.push((await attempt(c, refundSql, refundArgs(A, 'lk-3', cn, 1, { refundOfPaymentId: p2.payment.id }))).code ?? 'OK'); // p2 is fully given back
    const refundPay = await record(c, A, 'lk-out', { direction: 'OUT', amount: 100 }); out.push((await attempt(c, refundSql, refundArgs(A, 'lk-4', cn, 100, { refundOfPaymentId: refundPay.payment.id }))).code); // an OUT payment cannot be refunded
    out.push((await attempt(c, refundSql, refundArgs(B, 'lk-5', cn, 100, { refundOfPaymentId: p1.payment.id }))).code); // another merchant
    return { holds: out.join() === 'FIN_REFUND_EXCEEDS_PAYMENT,OK,FIN_REFUND_EXCEEDS_PAYMENT,FIN_REFUND_MISMATCH,FIN_PAYMENT_NOT_FOUND', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('REFUND concurrency: eight simultaneous refunds of 700 for a 3000 credit note -> exactly four, never more than the credit note or the refundable amount', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s, A, 10000); await record(s, A, 'cc-pay', { amount: 10000, allocations: [alloc(inv.id, 10000)] }); const cn = await issueCn(s, inv, 3000); await s.end();
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c, i) => c.query(refundSql, refundArgs(A, `cc-rf-${i}`, cn, 700))); const ok = res.filter((r) => r.status === 'fulfilled').length; const a = await amountsOf(clients[0], A, inv.id);
    return { holds: ok === 4 && a.refunded === 2800 && a.retained === 7200 && a.refundable === 200, evidence: `accepted=${ok}; ${am(a)}; refused with: ${[...new Set(res.filter((r) => r.status === 'rejected').map(codeOf))].join(' / ')}` };
  } finally { await closeAll(); }
}));

control('REFUND retry: eight simultaneous submissions of the same refund (same key) -> ONE refund, eight identical answers', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s, A, 10000); await record(s, A, 'cr-pay', { amount: 10000, allocations: [alloc(inv.id, 10000)] }); const cn = await issueCn(s, inv, 3000); await s.end();
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c) => c.query(refundSql, refundArgs(A, 'cr-same', cn, 1200))); const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value.rows[0].r); const a = await amountsOf(clients[0], A, inv.id);
    return { holds: ok.length === 8 && new Set(ok.map((r) => r.payment.id)).size === 1 && ok.filter((r) => !r.duplicate).length === 1 && a.refunded === 1200, evidence: `answers=${ok.length}, distinct refunds=${new Set(ok.map((r) => r.payment.id)).size}, refunded=${a.refunded}` };
  } finally { await closeAll(); }
}));

control('REFUND x REVERSAL race: refunding and un-paying at the same instant can never leave the customer with negative retained money (10 rounds)', withDb(async (d) => {
  let bad = 0; const seen = new Set();
  for (let round = 0; round < 10; round++) {
    const s = await d.open(); const inv = await issuedInvoice(s, A, 10000); const p = await record(s, A, `rr-pay-${round}`, { amount: 10000, allocations: [alloc(inv.id, 10000)] }); const cn = await issueCn(s, inv, 3000); await s.end();
    const { clients, closeAll } = await openMany(d.name, 2);
    try {
      const res = await race(clients, (c, i) => (i === 0 ? c.query(refundSql, refundArgs(A, `rr-rf-${round}`, cn, 3000)) : reverseAllocations(c, A, `rr-undo-${round}`, [{ allocationId: p.allocations[0].id, amountCents: null }])));
      const a = await amountsOf(clients[0], A, inv.id); const ok = res.filter((r) => r.status === 'fulfilled').length; seen.add(`${ok} won`);
      if (ok !== 1 || a.retained < 0 || a.refunded > a.allocated) bad++;
    } finally { await closeAll(); }
  }
  return { holds: bad === 0, evidence: `10 rounds, inconsistent outcomes=${bad}; every round exactly one of the two operations won (${[...seen].join(', ')})` };
}));

control('LOCKING ORDER: payments, late allocations, refunds and reversals mixed on the same invoices by four connections for 15 rounds -> no deadlock, amounts coherent', withDb(async (d) => {
  const s = await d.open(); const i1 = await issuedInvoice(s, A, 10000); const i2 = await issuedInvoice(s, A, 10000); const cn1 = await issueCn(s, i1, 2000); const cn2 = await issueCn(s, i1, 1000); const pay = await record(s, A, 'mx-big', { amount: 30000, allocations: [alloc(i1.id, 4000), alloc(i2.id, 4000)] }); await s.end();
  const { clients, closeAll } = await openMany(d.name, 4); let dead = 0; let failed = 0;
  try {
    for (let r = 0; r < 15; r++) {
      const res = await race(clients, (c, i) => {
        if (i === 0) return record(c, A, `mx-a-${r}`, { amount: 300, allocations: [alloc(i2.id, 150), alloc(i1.id, 150)] });
        if (i === 1) return record(c, A, `mx-b-${r}`, { amount: 300, allocations: [alloc(i1.id, 150), alloc(i2.id, 150)] });
        if (i === 2) return c.query(refundSql, refundArgs(A, `mx-rf-${r}`, r % 2 ? cn1 : cn2, 100));
        return allocateLater(c, A, `mx-late-${r}`, pay.payment.id, [alloc(i2.id, 100)]);
      });
      for (const x of res) if (x.status === 'rejected') { failed++; if (/deadlock/i.test(x.reason.message)) dead++; }
    }
    const a1 = await amountsOf(clients[0], A, i1.id); const a2 = await amountsOf(clients[0], A, i2.id);
    const ok = [a1, a2].every((a) => a.retained >= 0 && a.retained <= a.document_total && a.refunded <= a.allocated);
    return { holds: dead === 0 && ok, evidence: `rounds=15, deadlocks=${dead}, ordinary refusals (ceilings reached)=${failed}; invoice 1: ${am(a1)}; invoice 2: ${am(a2)}` };
  } finally { await closeAll(); }
}));

// ===================================================== LATE ALLOCATION / ONE PAYMENT -> MANY DOCUMENTS =====================================================
control('ALLOCATE LATER concurrency: 1000 unallocated, eight connections each allocate 300 to a different invoice -> exactly three fit, the surplus never disappears', withDb(async (d) => {
  const s = await d.open(); const invs = []; for (let i = 0; i < 8; i++) invs.push(await issuedInvoice(s, A, 5000)); const p = await record(s, A, 'late-pay', { amount: 1000 }); await s.end();
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c, i) => allocateLater(c, A, `late-${i}`, p.payment.id, [alloc(invs[i].id, 300)])); const ok = res.filter((r) => r.status === 'fulfilled').length;
    const allocated = await num(clients[0], 'select coalesce(sum(amount_cents),0) s from fin_payment_allocations where payment_id=$1', [p.payment.id]);
    return { holds: ok === 3 && allocated === 900 && res.filter((r) => r.status === 'rejected').every((r) => has(r, 'FIN_PAYMENT_OVER_ALLOCATED')), evidence: `accepted=${ok}, allocated=${allocated} of 1000 (unallocated ${1000 - allocated}); refused: ${[...new Set(res.filter((r) => r.status === 'rejected').map(codeOf))].join(' / ')}` };
  } finally { await closeAll(); }
}));

control('ALLOCATE LATER retry: the same key from eight connections is one allocation; the same key with another amount is refused; nothing is allocated automatically', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s, A, 5000); const p = await record(s, A, 'lr-pay', { amount: 1000 }); await s.end(); const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const before = await num(clients[0], 'select count(*) s from fin_payment_allocations');
    const res = await race(clients, (c) => allocateLater(c, A, 'lr-key', p.payment.id, [alloc(inv.id, 400)])); const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const other = await attempt(clients[0], allocateSqlText, [A, 'lr-key', p.payment.id, JSON.stringify([alloc(inv.id, 500)]), '{}']);
    return { holds: before === 0 && ok.length === 8 && ok.filter((r) => !r.duplicate).length === 1 && await netPaidOfInvoice(clients[0], inv.id) === 400 && !other.ok && other.code === 'FIN_IDEMPOTENCY_KEY_REUSED', evidence: `a payment recorded without allocations created ${before} allocation(s); 8 callers -> fresh=${ok.filter((r) => !r.duplicate).length}; net on the invoice=${await netPaidOfInvoice(clients[0], inv.id)}; other amount under the same key -> ${other.code}` };
  } finally { await closeAll(); }
}));
const allocateSqlText = 'select fin_allocate_payment($1,$2,$3,$4,$5) r';

control('ALLOCATE LATER respects every rule: same merchant, same currency, direction, document remaining, never beyond the payment', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 5000); const invB = await issuedInvoice(c, B, 5000); const sup = await insertSupplier(c, A); const out = [];
  try {
    const p = await record(c, A, 'ar-pay', { amount: 1000 });
    const run = (key, merchant, pay, allocs) => attempt(c, allocateSqlText, [merchant, key, pay, JSON.stringify(allocs), '{}']);
    out.push((await run('ar-1', A, p.payment.id, [alloc(invB.id, 100)])).code); // another merchant's invoice
    out.push((await run('ar-2', B, p.payment.id, [alloc(invB.id, 100)])).code); // another merchant's payment
    out.push((await run('ar-3', A, p.payment.id, [salloc(sup.id, 100)])).code); // IN cannot pay a supplier
    out.push((await run('ar-4', A, p.payment.id, [alloc(inv.id, 5001)])).code); // beyond the invoice
    out.push((await run('ar-5', A, p.payment.id, [alloc(inv.id, 1001)])).code); // beyond the payment
    const usd = await record(c, A, 'ar-usd', { amount: 500, currency: 'USD' }); out.push((await run('ar-6', A, usd.payment.id, [alloc(inv.id, 100)])).code); // currency
    const sp = await record(c, A, 'ar-out', { direction: 'OUT', amount: 500 }); out.push((await run('ar-7', A, sp.payment.id, [alloc(inv.id, 100)])).code); // OUT cannot settle an invoice
    out.push((await run('ar-8', A, p.payment.id, [])).code ?? 'OK');
    return { holds: out.join() === 'FIN_TARGET_NOT_FOUND,FIN_PAYMENT_NOT_FOUND,FIN_DIRECTION_MISMATCH,FIN_ALLOCATION_EXCEEDS_REMAINING,FIN_PAYMENT_OVER_ALLOCATED,FIN_CURRENCY_MISMATCH,FIN_DIRECTION_MISMATCH,FIN_AMOUNT_INVALID', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('ONE payment -> several documents and SEVERAL payments -> one document, with the exact surplus (300 -> 100+120+50, 30 left; 100+50+150 -> 300)', withDb(async (d) => {
  const c = await d.open(); const a = await issuedInvoice(c, A, 10000); const b = await issuedInvoice(c, A, 12000); const e = await issuedInvoice(c, A, 5000); const f = await issuedInvoice(c, A, 30000);
  try {
    const p = await record(c, A, 'one-many', { amount: 30000, allocations: [alloc(a.id, 10000), alloc(b.id, 12000), alloc(e.id, 5000)] });
    const unalloc = 30000 - p.allocations.reduce((s, x) => s + x.amount_cents, 0);
    for (const [i, x] of [[0, 10000], [1, 5000], [2, 15000]]) await record(c, A, `many-one-${i}`, { amount: x, allocations: [alloc(f.id, x)] });
    const amounts = [await amountsOf(c, A, a.id), await amountsOf(c, A, b.id), await amountsOf(c, A, e.id), await amountsOf(c, A, f.id)];
    return { holds: unalloc === 3000 && amounts.every((x) => x.remaining_due === 0 && x.retained === x.document_total), evidence: `unallocated=${unalloc}; all four invoices fully paid: ${amounts.map((x) => x.retained + '/' + x.document_total).join(', ')}` };
  } finally { await c.end(); }
}));

// ===================================================== VOID x REFUND =====================================================
control('VOID interplay: a refunded payment cannot be voided until its refund is voided; then the whole chain unwinds to zero', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 10000); const pay = await record(c, A, 'vd-pay', { amount: 10000, allocations: [alloc(inv.id, 10000)] }); const cn = await issueCn(c, inv, 3000);
  try {
    const rf = await refund(c, cn, 'vd-rf', 3000); const blocked = await attempt(c, 'select fin_void_payment($1,$2,$3,$4,$5,$6)', [A, 'vd-v1', pay.payment.id, '2026-10-02', 'mistake', '{}']);
    await voidPayment(c, A, 'vd-v2', rf.payment.id); const mid = await amountsOf(c, A, inv.id); await voidPayment(c, A, 'vd-v3', pay.payment.id); const end = await amountsOf(c, A, inv.id);
    return { holds: !blocked.ok && blocked.code === 'FIN_REVERSAL_BREAKS_REFUND' && mid.refunded === 0 && mid.refundable === 3000 && end.allocated === 0 && end.retained === 0 && end.remaining_due === 7000, evidence: `void of the refunded payment -> ${blocked.code}; after voiding the refund: ${am(mid)}; after voiding the payment: ${am(end)} (credit note still reduces the due to 7000)` };
  } finally { await c.end(); }
}));

// ===================================================== VOCABULARY, PROVENANCE, ISOLATION, ATOMICITY =====================================================
control('METHODS and PROVENANCE: the vocabulary is enforced by the database; source, external, structured and bank references are stored and part of the request fingerprint', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 100000); const out = [];
  try {
    for (const m of ['cash', 'bank_transfer', 'card', 'bancontact', 'direct_debit', 'other']) out.push((await attempt(c, recordSqlText, [A, `m-${m}`, 'IN', 100, 'EUR', '2026-10-01', m, null, '{}', JSON.stringify([alloc(inv.id, 100)]), null])).ok ? 'ok' : 'REFUSED');
    const bad = await attempt(c, recordSqlText, [A, 'm-bad', 'IN', 100, 'EUR', '2026-10-01', 'paypal', null, '{}', '[]', null]);
    const badSource = await attempt(c, recordSqlText, [A, 's-bad', 'IN', 100, 'EUR', '2026-10-01', 'cash', null, '{}', '[]', JSON.stringify({ source: 'Manual Entry!' })]);
    const meta = { source: 'provider:sumup', externalReference: 'SU-9', structuredReference: '+++000/0000/00097+++', bankReference: 'BANKTX-1' };
    const p = await record(c, A, 'prov-1', { amount: 500, method: 'bancontact', meta }); const row = (await c.query('select source, external_reference, structured_reference, bank_reference, method from fin_payment_registry where id=$1', [p.payment.id])).rows[0];
    const reused = await attempt(c, recordSqlText, [A, 'prov-1', 'IN', 500, 'EUR', '2026-09-30', 'bancontact', null, '{}', '[]', JSON.stringify({ ...meta, externalReference: 'SU-10' })]);
    const dflt = await record(c, A, 'prov-2', { amount: 100 });
    return { holds: out.every((x) => x === 'ok') && !bad.ok && /fin_payment_registry_method_chk/.test(bad.message) && !badSource.ok && row.source === 'provider:sumup' && row.external_reference === 'SU-9' && row.structured_reference === '+++000/0000/00097+++' && row.bank_reference === 'BANKTX-1' && !reused.ok && reused.code === 'FIN_IDEMPOTENCY_KEY_REUSED' && dflt.payment.source === 'manual',
      evidence: `six methods accepted; 'paypal' -> ${bad.code}; malformed source -> ${badSource.code}; stored: ${JSON.stringify(row)}; same key with another external reference -> ${reused.code}; default source=${dflt.payment.source}` };
  } finally { await c.end(); }
}));
const recordSqlText = 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,$11) r';

control('REFUND isolation: B can neither refund a credit note of A nor link a refund to a payment of A; a refused refund leaves no payment, no allocation, no event', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 10000); const pay = await record(c, A, 'iso-pay', { amount: 10000, allocations: [alloc(inv.id, 10000)] }); const cn = await issueCn(c, inv, 3000); const out = [];
  try {
    const before = [await num(c, 'select count(*) s from fin_payment_registry'), await num(c, 'select count(*) s from fin_payment_allocations'), await num(c, 'select count(*) s from fin_events')];
    out.push((await attempt(c, refundSql, refundArgs(B, 'iso-1', cn, 100))).code);
    out.push((await attempt(c, refundSql, refundArgs(A, 'iso-2', cn, 3001))).code);
    out.push((await attempt(c, refundSql, refundArgs(B, 'iso-3', cn, 100, { refundOfPaymentId: pay.payment.id }))).code);
    const after = [await num(c, 'select count(*) s from fin_payment_registry'), await num(c, 'select count(*) s from fin_payment_allocations'), await num(c, 'select count(*) s from fin_events')];
    return { holds: out.join() === 'FIN_TARGET_NOT_FOUND,FIN_REFUND_EXCEEDS_CREDIT_NOTE,FIN_PAYMENT_NOT_FOUND' && before.join() === after.join(), evidence: `${out.join(' / ')}; rows before/after (registry, allocations, events): ${before.join(',')} / ${after.join(',')}` };
  } finally { await c.end(); }
}));

// ===================================================== SUPPLIER SYMMETRY =====================================================
control('SUPPLIER: one payment across several supplier invoices in opposite orders never deadlocks; partial payments from eight connections are bounded', withDb(async (d) => {
  const s = await d.open(); const s1 = await insertSupplier(s, A, { gross: 10000 }); const s2 = await insertSupplier(s, A, { gross: 10000 }); const s3 = await insertSupplier(s, A, { gross: 12100 }); await s.end();
  const { clients, closeAll } = await openMany(d.name, 8); let dead = 0; let failed = 0;
  try {
    for (let r = 0; r < 10; r++) {
      const res = await race(clients.slice(0, 2), (c, i) => record(c, A, `sd-${r}-${i}`, { direction: 'OUT', amount: 1000, allocations: i ? [salloc(s2.id, 500), salloc(s1.id, 500)] : [salloc(s1.id, 500), salloc(s2.id, 500)] }));
      for (const x of res) if (x.status === 'rejected') { failed++; if (/deadlock/i.test(x.reason.message)) dead++; }
    }
    const res = await race(clients, (c, i) => record(c, A, `sp-${i}`, { direction: 'OUT', amount: 3000, allocations: [salloc(s3.id, 3000)] })); const ok = res.filter((r) => r.status === 'fulfilled').length;
    const n1 = await netPaidOfSupplier(clients[0], s1.id); const n3 = await netPaidOfSupplier(clients[0], s3.id); const row = (await clients[0].query('select status, payment_status from fin_supplier_invoices where id=$1', [s1.id])).rows[0];
    return { holds: dead === 0 && failed === 0 && n1 === 10000 && row.status === 'PAID' && ok === 4 && n3 === 12000, evidence: `opposite orders: deadlocks=${dead}, failures=${failed}, supplier 1 net=${n1} -> ${row.status}/${row.payment_status}; 8 simultaneous partial payments of 3000 on 12100: accepted=${ok}, net=${n3}` };
  } finally { await closeAll(); }
}));

control('SUPPLIER truth both ways: a fully allocated invoice cannot be written away from PAID; only a reversal moves it', withDb(async (d) => {
  const c = await d.open(); const sup = await insertSupplier(c, A, { gross: 5000 }); const p = await record(c, A, 'sb-1', { direction: 'OUT', amount: 5000, allocations: [salloc(sup.id, 5000)] });
  try {
    const away = await attempt(c, "update fin_supplier_invoices set status='TO_PAY' where id=$1", [sup.id]); const row1 = (await c.query('select status, payment_status from fin_supplier_invoices where id=$1', [sup.id])).rows[0];
    await reverseAllocations(c, A, 'sb-undo', [{ allocationId: p.allocations[0].id, amountCents: 1000 }]); const row2 = (await c.query('select status, payment_status from fin_supplier_invoices where id=$1', [sup.id])).rows[0];
    return { holds: !away.ok && away.code === 'FIN_INVOICE_HAS_PAYMENTS' && row1.status === 'PAID' && row2.status === 'TO_PAY' && row2.payment_status === 'partially_paid', evidence: `write away from PAID -> ${away.code} (still ${row1.status}); after reversing 1000: ${row2.status}/${row2.payment_status}` };
  } finally { await c.end(); }
}));

// ===================================================== PROPERTY TEST: SQL amounts == JS amounts, invariants hold =====================================================
const rng = (seed) => { let x = seed; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
const camelDoc = (r) => ({ id: r.id, merchantId: r.merchant_id, type: r.doc_type, relatedDocumentId: r.related_document_id, lockedAt: r.locked_at, totals: { grossCents: Number(r.gross_cents), roundingCents: Number(r.body?.totals?.roundingCents ?? 0) } });
const camelAlloc = (r) => ({ id: r.id, customerDocumentId: r.customer_document_id, supplierInvoiceId: r.supplier_invoice_id, amountCents: Number(r.amount_cents) });

for (const seed of [11, 4242, 987654]) {
  control(`PROPERTY (seed ${seed}): after 70 random payments, credits, refunds, reversals and late allocations, fin_invoice_amounts (SQL) == amounts.js (JS) and the invariants hold`, withDb(async (d) => {
    const c = await d.open(); const rnd = rng(seed); const pick = (a) => a[Math.floor(rnd() * a.length)]; const inv = await issuedInvoice(c, A, 10000); const cns = []; const pays = []; let ok = 0; let refused = 0; let mismatches = 0; const bad = [];
    try {
      for (let step = 0; step < 70; step++) {
        const roll = rnd(); const key = `pp-${seed}-${step}`; let r;
        if (roll < 0.28) { const cents = 1 + Math.floor(rnd() * 4000); r = await attempt(c, recordSqlText, [A, key, 'IN', cents + (rnd() < 0.3 ? 500 : 0), 'EUR', '2026-10-01', 'bank_transfer', null, '{}', JSON.stringify([alloc(inv.id, cents)]), null]); if (r.ok) pays.push(key); }
        else if (roll < 0.40) { const g = 100 + Math.floor(rnd() * 2500); r = await attempt(c, 'select 1', []); try { cns.push(await issueCn(c, inv, g)); r = { ok: true }; } catch (e) { r = { ok: false }; } }
        else if (roll < 0.58 && cns.length) { const cn = pick(cns); r = await attempt(c, refundSql, refundArgs(A, key, cn, 1 + Math.floor(rnd() * 1500))); }
        else if (roll < 0.74) { const rows = (await c.query('select id, amount_cents from fin_payment_allocations where customer_document_id=$1 and amount_cents>0', [inv.id])).rows; if (rows.length) { const o = pick(rows); r = await attempt(c, 'select fin_reverse_allocations($1,$2,$3,$4,$5)', [A, key, JSON.stringify([{ allocationId: o.id, amountCents: rnd() < 0.5 ? null : 1 + Math.floor(rnd() * 2000) }]), 'fuzz', '{}']); } else r = { ok: false }; }
        else if (roll < 0.86 && cns.length) { const rows = (await c.query('select a.id from fin_payment_allocations a where a.customer_document_id = any($1) and a.amount_cents>0', [cns.map((x) => x.id)])).rows; if (rows.length) r = await attempt(c, 'select fin_reverse_allocations($1,$2,$3,$4,$5)', [A, key, JSON.stringify([{ allocationId: pick(rows).id, amountCents: null }]), 'fuzz refund', '{}']); else r = { ok: false }; }
        else { const free = (await c.query("select p.id, p.amount_cents - coalesce((select sum(amount_cents) from fin_payment_registry x where x.reversal_of_id=p.id),0) - coalesce((select sum(amount_cents) from fin_payment_allocations a where a.payment_id=p.id),0) as free from fin_payment_registry p where p.direction='IN' and p.reversal_of_id is null")).rows.filter((x) => Number(x.free) > 0); if (free.length) { const p = pick(free); r = await attempt(c, 'select fin_allocate_payment($1,$2,$3,$4,$5)', [A, key, p.id, JSON.stringify([alloc(inv.id, 1 + Math.floor(rnd() * Number(p.free)))]), '{}']); } else r = { ok: false }; }
        if (r.ok) ok++; else refused++;
        const sql = await amountsOf(c, A, inv.id);
        const docs = (await c.query('select * from fin_documents where merchant_id=$1', [A])).rows.map(camelDoc); const allocs = (await c.query('select * from fin_payment_allocations where merchant_id=$1', [A])).rows.map(camelAlloc);
        const js = amountsOfInvoice(docs, allocs, docs.find((x) => x.id === inv.id));
        const same = sql.document_total === js.documentTotal && sql.credited === js.credited && sql.effective_due === js.effectiveDue && sql.allocated === js.allocated && sql.refunded === js.refunded && sql.retained === js.retained && sql.remaining_due === js.remainingDue && sql.refundable === js.refundable;
        if (!same) { mismatches++; bad.push(`step ${step}: sql=${am(sql)} js=${JSON.stringify(js)}`); }
        const v = amountViolations(js); if (js.retained > js.documentTotal) v.push('RETAINED_ABOVE_TOTAL'); if (v.length) bad.push(`step ${step}: ${v.join(',')} ${am(sql)}`);
      }
      const end = await amountsOf(c, A, inv.id);
      return { holds: mismatches === 0 && bad.length === 0, evidence: `70 operations (${ok} accepted, ${refused} refused by the database ceilings), SQL==JS at every step: ${mismatches === 0}; invariant violations: ${bad.length}${bad.length ? ' ' + bad[0] : ''}; final ${am(end)}` };
    } finally { await c.end(); }
  }));
}
