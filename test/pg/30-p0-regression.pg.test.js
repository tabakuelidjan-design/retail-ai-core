// Phase 1 - P0 FINANCIAL INTEGRITY, as non-regression tests on a real PostgreSQL 17 with real concurrent connections.
// Every test here is the transformation of a Phase 0 reproducer (see 35-legacy-gaps for the ones aimed at the frozen legacy table) or a new proof of a guarantee that
// the database itself now provides. A failure means money integrity regressed. Classification of each guarantee (SERVICE / POSTGRES / BOTH): src/finance/payment-ledger.js GUARANTEES.
import { openMany, race, seedMerchants, insertDraft, issueDocument, issueSql, issueArgs, issuedInvoice, insertSupplier, record, reverseAllocations, voidPayment, num, netPaidOfInvoice, netPaidOfSupplier, attempt, codeOf,
  freshDatabase, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { control } from './lib/classify.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const A = MERCHANT_A; const B = MERCHANT_B;
const credit = (c, inv, gross, merchant = A) => insertDraft(c, merchant, { docType: 'credit_note', related: inv.id, gross });
const issueCredit = (c, cn, merchant = A) => c.query(issueSql, issueArgs(merchant, cn, { prefix: 'NC' }));
const creditedOf = (c, inv) => num(c, "select coalesce(sum(gross_cents),0) s from fin_documents where doc_type='credit_note' and related_document_id=$1 and locked_at is not null", [inv.id]);
const has = (settled, code) => settled.status === 'rejected' && new RegExp(code).test(settled.reason.message);
const alloc = (id, cents) => ({ customerDocumentId: id, amountCents: cents });
const salloc = (id, cents) => ({ supplierInvoiceId: id, amountCents: cents });

// ===================================================== P0-1 CREDIT INTEGRITY (trigger fin_credit_ceiling_guard) =====================================================
control('P0-1 over-credit rejected: one credit note larger than its invoice', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c);
  try { const cn = await credit(c, inv, 12101); const r = await attempt(c, issueSql, issueArgs(A, cn, { prefix: 'NC' })); return { holds: !r.ok && r.code === 'FIN_CREDIT_EXCEEDS_INVOICE', evidence: `${r.ok ? 'ACCEPTED' : r.code}; credited=${await creditedOf(c, inv)}` }; } finally { await c.end(); }
}));

control('P0-1 sequential credits bounded: three full credit notes, only the first can be issued', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const out = [];
  try { for (let i = 0; i < 3; i++) { const cn = await credit(c, inv, 12100); out.push((await attempt(c, issueSql, issueArgs(A, cn, { prefix: 'NC' }))).code ?? 'OK'); }
    const total = await creditedOf(c, inv); return { holds: total === 12100 && out.join() === 'OK,FIN_CREDIT_EXCEEDS_INVOICE,FIN_CREDIT_EXCEEDS_INVOICE', evidence: `${out.join(' / ')}; credited=${total}` }; } finally { await c.end(); }
}));

control('P0-1 exact full credit accepted', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c);
  try { const r = await attempt(c, issueSql, issueArgs(A, await credit(c, inv, 12100), { prefix: 'NC' })); return { holds: r.ok && await creditedOf(c, inv) === 12100, evidence: `full credit of 12100 on 12100: ${r.ok ? 'accepted' : r.code}` }; } finally { await c.end(); }
}));

control('P0-1 partial credits accepted up to the exact remainder, one cent more refused', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const out = [];
  try { for (const g of [5000, 7100, 1]) out.push((await attempt(c, issueSql, issueArgs(A, await credit(c, inv, g), { prefix: 'NC' }))).code ?? 'OK');
    return { holds: out.join() === 'OK,OK,FIN_CREDIT_EXCEEDS_INVOICE' && await creditedOf(c, inv) === 12100, evidence: `5000 / 7100 / 1 -> ${out.join(' / ')}` }; } finally { await c.end(); }
}));

control('P0-1 concurrent credits bounded: two full credit notes at the same instant, exactly one wins', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s); const cns = [await credit(s, inv, 12100), await credit(s, inv, 12100)]; await s.end();
  const { clients, closeAll } = await openMany(d.name, 2);
  try { const res = await race(clients, (c, i) => c.query(issueSql, issueArgs(A, cns[i], { prefix: 'NC' }))); const total = await creditedOf(clients[0], inv); const ok = res.filter((r) => r.status === 'fulfilled').length;
    return { holds: ok === 1 && total === 12100 && res.some((r) => has(r, 'FIN_CREDIT_EXCEEDS_INVOICE')), evidence: `winners=${ok}; credited=${total} of 12100; loser: ${res.map(codeOf).join(' / ')}` }; } finally { await closeAll(); }
}));

control('P0-1 concurrent credits bounded: eight partial credits of 5000 at once, exactly two fit in 12100', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s); const cns = []; for (let i = 0; i < 8; i++) cns.push(await credit(s, inv, 5000)); await s.end();
  const { clients, closeAll } = await openMany(d.name, 8);
  try { const res = await race(clients, (c, i) => c.query(issueSql, issueArgs(A, cns[i], { prefix: 'NC' }))); const total = await creditedOf(clients[0], inv); const ok = res.filter((r) => r.status === 'fulfilled').length;
    return { holds: ok === 2 && total === 10000, evidence: `winners=${ok}; credited=${total} of 12100` }; } finally { await closeAll(); }
}));

control('P0-1 retry: issuing the same credit note twice cannot credit twice', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const cn = await credit(c, inv, 5000);
  try { await issueCredit(c, cn); const again = await attempt(c, issueSql, issueArgs(A, cn, { prefix: 'NC' })); return { holds: !again.ok && again.code === 'FIN_CONCURRENT_MODIFICATION' && await creditedOf(c, inv) === 5000, evidence: `${again.ok ? 'ACCEPTED' : again.code}; credited=${await creditedOf(c, inv)}` }; } finally { await c.end(); }
}));

control('P0-1 credit preconditions: invoice must be issued, same merchant, same currency, linked', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const draftInv = await insertDraft(c, A); const out = [];
  try {
    out.push((await attempt(c, issueSql, issueArgs(A, await credit(c, draftInv, 100), { prefix: 'NC' }))).code);
    const eur = await credit(c, inv, 100); await c.query("update fin_documents set currency='USD' where id=$1", [eur.id]); out.push((await attempt(c, issueSql, issueArgs(A, eur, { prefix: 'NC' }))).code);
    const orphan = await insertDraft(c, A, { docType: 'credit_note', gross: 100 }); out.push((await attempt(c, issueSql, issueArgs(A, orphan, { prefix: 'NC' }))).code);
    return { holds: out.join() === 'FIN_CREDIT_INVOICE_NOT_ISSUED,FIN_CREDIT_CURRENCY_MISMATCH,FIN_CREDIT_WITHOUT_INVOICE', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('P0-1/P0-4 cross-merchant credit rejected: a credit note of B can neither point at nor be issued against the invoice of A', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const out = [];
  try {
    out.push((await attempt(c, "insert into fin_documents (merchant_id, doc_type, status, body, related_document_id) values ($1,'credit_note','DRAFT','{}',$2)", [B, inv.id])).code);
    const cnA = await credit(c, inv, 100); out.push((await attempt(c, issueSql, issueArgs(B, cnA, { prefix: 'NC' }))).code);
    return { holds: out[0] === 'fin_documents_related_same_merchant_fk' && out[1] === 'FIN_NOT_FOUND', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

// ===================================================== P0-2 PAYMENT INTEGRITY (fin_record_payment + allocation trigger) =====================================================
control('P0-2 duplicate payment idempotent: the same key twice is ONE payment, one allocation, one audit event', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 20000);
  try {
    const first = await record(c, A, 'key-0001', { amount: 15000, allocations: [alloc(inv.id, 15000)] }); const second = await record(c, A, 'key-0001', { amount: 15000, allocations: [alloc(inv.id, 15000)] });
    const rows = await num(c, 'select count(*) s from fin_payment_registry'); const al = await num(c, 'select count(*) s from fin_payment_allocations'); const ev = await num(c, "select count(*) s from fin_events where action='RECORD_PAYMENT'");
    return { holds: !first.duplicate && second.duplicate && first.payment.id === second.payment.id && rows === 1 && al === 1 && ev === 1 && await netPaidOfInvoice(c, inv.id) === 15000, evidence: `second.duplicate=${second.duplicate}, same id=${first.payment.id === second.payment.id}, registry=${rows}, allocations=${al}, events=${ev}` };
  } finally { await c.end(); }
}));

control('P0-2 double click: eight connections submit the same payment with the same key at once -> one payment, all eight answers are the same payment', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s, A, 20000); await s.end(); const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c) => record(c, A, 'key-click', { amount: 15000, allocations: [alloc(inv.id, 15000)] }));
    const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value); const ids = new Set(ok.map((r) => r.payment.id)); const rows = await num(clients[0], 'select count(*) s from fin_payment_registry');
    return { holds: ok.length === 8 && ids.size === 1 && rows === 1 && ok.filter((r) => !r.duplicate).length === 1 && await netPaidOfInvoice(clients[0], inv.id) === 15000, evidence: `answers=${ok.length}, distinct payments=${ids.size}, registry rows=${rows}, fresh=${ok.filter((r) => !r.duplicate).length}, net=${await netPaidOfInvoice(clients[0], inv.id)}` };
  } finally { await closeAll(); }
}));

control('P0-2 network retry: the connection dies after COMMIT, the retry on a new connection returns the SAME committed payment', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s, A, 20000); await s.end(); const { clients, closeAll } = await openMany(d.name, 3); const [first, retry, admin] = clients;
  try {
    const pid = (await first.query('select pg_backend_pid() p')).rows[0].p; const a = await record(first, A, 'key-net', { amount: 15000, allocations: [alloc(inv.id, 15000)] });
    await admin.query('select pg_terminate_backend($1)', [pid]).catch(() => {}); // the answer is "lost": the client only knows the connection broke
    const b = await record(retry, A, 'key-net', { amount: 15000, allocations: [alloc(inv.id, 15000)] }); const rows = await num(admin, 'select count(*) s from fin_payment_registry');
    return { holds: b.duplicate === true && b.payment.id === a.payment.id && rows === 1, evidence: `retry duplicate=${b.duplicate}, same payment=${b.payment.id === a.payment.id}, registry rows=${rows}` };
  } finally { await closeAll(); }
}));

control('P0-2 idempotency key reused with a DIFFERENT request is refused (never silently replayed)', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c, A, 20000);
  try { await record(c, A, 'key-reuse', { amount: 5000, allocations: [alloc(inv.id, 5000)] });
    const r = await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'key-reuse', 'IN', 6000, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 6000)])]);
    return { holds: !r.ok && r.code === 'FIN_IDEMPOTENCY_KEY_REUSED' && await netPaidOfInvoice(c, inv.id) === 5000, evidence: `${r.ok ? 'ACCEPTED' : r.code}; net=${await netPaidOfInvoice(c, inv.id)}` }; } finally { await c.end(); }
}));

control('P0-2 idempotency keys are per merchant (the same key for A and B are two independent operations)', withDb(async (d) => {
  const c = await d.open(); const a = await issuedInvoice(c, A); const b = await issuedInvoice(c, B);
  try { const x = await record(c, A, 'shared-key', { amount: 100, allocations: [alloc(a.id, 100)] }); const y = await record(c, B, 'shared-key', { amount: 100, allocations: [alloc(b.id, 100)] }); return { holds: !x.duplicate && !y.duplicate && x.payment.id !== y.payment.id, evidence: 'both fresh' }; } finally { await c.end(); }
}));

control('P0-2 concurrent payment bounded: two different payments of the full amount, exactly one wins', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s); await s.end(); const { clients, closeAll } = await openMany(d.name, 2);
  try {
    const res = await race(clients, (c, i) => record(c, A, `key-conc-${i}`, { amount: 12100, allocations: [alloc(inv.id, 12100)] })); const net = await netPaidOfInvoice(clients[0], inv.id); const regs = await num(clients[0], 'select count(*) s from fin_payment_registry');
    return { holds: res.filter((r) => r.status === 'fulfilled').length === 1 && net === 12100 && regs === 1 && res.some((r) => has(r, 'FIN_ALLOCATION_EXCEEDS_REMAINING')), evidence: `${res.map(codeOf).join(' / ')}; net=${net}; the refused payment left no registry row (registry=${regs})` };
  } finally { await closeAll(); }
}));

control('P0-2 concurrent payment bounded: eight payments of 3000 on 12100, exactly four fit, never more than the invoice', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s); await s.end(); const { clients, closeAll } = await openMany(d.name, 8);
  try { const res = await race(clients, (c, i) => record(c, A, `key-eight-${i}`, { amount: 3000, allocations: [alloc(inv.id, 3000)] })); const net = await netPaidOfInvoice(clients[0], inv.id); const ok = res.filter((r) => r.status === 'fulfilled').length;
    return { holds: ok === 4 && net === 12000 && net <= 12100, evidence: `accepted=${ok}, net=${net} of 12100` }; } finally { await closeAll(); }
}));

control('P0-2 over-allocation rejected: more than the remaining of the invoice, more than the payment, and a credited invoice leaves less to pay', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const out = [];
  try {
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'k1', 'IN', 20000, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 12101)])])).code);
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'k2', 'IN', 5000, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 6000)])])).code);
    await issueCredit(c, await credit(c, inv, 5000)); // payable is now 7100
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'k3', 'IN', 7101, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 7101)])])).code);
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'k4', 'IN', 7100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 7100)])])).code ?? 'OK');
    return { holds: out.join() === 'FIN_ALLOCATION_EXCEEDS_REMAINING,FIN_PAYMENT_OVER_ALLOCATED,FIN_ALLOCATION_EXCEEDS_REMAINING,OK', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('P0-2 unallocated amounts are represented: advance, partial allocation, later allocation, never beyond the payment', withDb(async (d) => {
  const c = await d.open(); const i1 = await issuedInvoice(c); const i2 = await issuedInvoice(c, A, 8000);
  const free = async (id) => num(c, "select p.amount_cents - coalesce((select sum(amount_cents) from fin_payment_registry r where r.reversal_of_id=p.id),0) - coalesce((select sum(amount_cents) from fin_payment_allocations a where a.payment_id=p.id),0) s from fin_payment_registry p where p.id=$1", [id]);
  try {
    const adv = await record(c, A, 'adv', { amount: 3000 }); const p = await record(c, A, 'part', { amount: 10000, allocations: [alloc(i1.id, 4000)] });
    const step = [await free(adv.payment.id), await free(p.payment.id)];
    const ins = (cid, pid, cents) => attempt(c, "insert into fin_payment_allocations (merchant_id, payment_id, customer_document_id, amount_cents, currency, idempotency_key) values ($1,$2,$3,$4,'EUR',$5)", [A, pid, cid, cents, `late-${pid}-${cents}-${cid}`]);
    const later = await ins(i2.id, p.payment.id, 6000); const tooMuch = await ins(i2.id, p.payment.id, 1);
    return { holds: step.join() === '3000,6000' && later.ok && !tooMuch.ok && tooMuch.code === 'FIN_PAYMENT_OVER_ALLOCATED' && await free(p.payment.id) === 0, evidence: `unallocated after record: advance=${step[0]}, partial=${step[1]}; late allocation of 6000 ${later.ok ? 'ok' : later.code}; one cent more -> ${tooMuch.code}` };
  } finally { await c.end(); }
}));

control('P0-2 direction, currency and target rules: IN cannot pay a supplier, currency must match, a draft cannot be paid, an IN payment cannot settle a credit note (credit notes are refunded by OUT)', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const sup = await insertSupplier(c); const draft = await insertDraft(c, A); const out = [];
  try {
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'd1', 'IN', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([salloc(sup.id, 100)])])).code);
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'd2', 'OUT', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 100)])])).code);
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'd3', 'IN', 100, 'USD', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 100)])])).code);
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'd4', 'IN', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(draft.id, 100)])])).code);
    const cn = await credit(c, inv, 100); await issueCredit(c, cn);
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'd5', 'IN', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(cn.id, 100)])])).code);
    return { holds: out.join() === 'FIN_DIRECTION_MISMATCH,FIN_DIRECTION_MISMATCH,FIN_CURRENCY_MISMATCH,FIN_TARGET_NOT_OPEN,FIN_DIRECTION_MISMATCH', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('P0-2 locking order: opposite allocation orders across two invoices never deadlock (20 rounds of two simultaneous payments)', withDb(async (d) => {
  const s = await d.open(); const i1 = await issuedInvoice(s, A, 10000); const i2 = await issuedInvoice(s, A, 10000); await s.end(); const { clients, closeAll } = await openMany(d.name, 2); let dead = 0; let failed = 0;
  try {
    for (let r = 0; r < 10; r++) {
      const res = await race(clients, (c, i) => record(c, A, `lock-${r}-${i}`, { amount: 1000, allocations: i ? [alloc(i2.id, 500), alloc(i1.id, 500)] : [alloc(i1.id, 500), alloc(i2.id, 500)] }));
      for (const x of res) { if (x.status === 'rejected') { failed++; if (/deadlock/i.test(x.reason.message)) dead++; } }
    }
    const n1 = await netPaidOfInvoice(clients[0], i1.id); const n2 = await netPaidOfInvoice(clients[0], i2.id);
    return { holds: dead === 0 && failed === 0 && n1 === 10000 && n2 === 10000, evidence: `rounds=10, deadlocks=${dead}, failures=${failed}, nets=${n1}/${n2}` };
  } finally { await closeAll(); }
}));

// ===================================================== P0-5 REVERSAL INTEGRITY =====================================================
control('P0-5 reversal links to its original, is negative, restores the unallocated amount, and the invoice can be paid again', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c);
  try {
    const p = await record(c, A, 'rev-1', { amount: 12100, allocations: [alloc(inv.id, 12100)] }); const orig = p.allocations[0];
    const r = await reverseAllocations(c, A, 'rev-1-undo', [{ allocationId: orig.id, amountCents: 3000 }]); const rv = r.reversals[0];
    const again = await record(c, A, 'rev-1-again', { amount: 3000, allocations: [alloc(inv.id, 3000)] });
    const ev = await num(c, "select count(*) s from fin_events where action='REVERSE_PAYMENT_ALLOCATION'");
    return { holds: rv.amount_cents === -3000 && rv.reverses_allocation_id === orig.id && rv.payment_id === orig.payment_id && !again.duplicate && await netPaidOfInvoice(c, inv.id) === 12100 && ev === 1, evidence: `reversal ${rv.amount_cents} linked to original=${rv.reverses_allocation_id === orig.id}; re-paid 3000 -> net ${await netPaidOfInvoice(c, inv.id)}; audit events=${ev}` };
  } finally { await c.end(); }
}));

control('P0-5 duplicate reversal: the same key is idempotent, another key cannot reverse more than what is left', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c);
  try {
    const p = await record(c, A, 'rev-2', { amount: 12100, allocations: [alloc(inv.id, 12100)] }); const id = p.allocations[0].id;
    const a = await reverseAllocations(c, A, 'undo-a', [{ allocationId: id, amountCents: 5000 }]); const b = await reverseAllocations(c, A, 'undo-a', [{ allocationId: id, amountCents: 5000 }]);
    const over = await attempt(c, 'select fin_reverse_allocations($1,$2,$3,$4,$5)', [A, 'undo-b', JSON.stringify([{ allocationId: id, amountCents: 7101 }]), 'x', '{}']);
    const exact = await attempt(c, 'select fin_reverse_allocations($1,$2,$3,$4,$5)', [A, 'undo-c', JSON.stringify([{ allocationId: id, amountCents: 7100 }]), 'x', '{}']);
    const diff = await attempt(c, 'select fin_reverse_allocations($1,$2,$3,$4,$5)', [A, 'undo-a', JSON.stringify([{ allocationId: id, amountCents: 1 }]), 'x', '{}']);
    return { holds: !a.duplicate && b.duplicate && a.reversals[0].id === b.reversals[0].id && !over.ok && over.code === 'FIN_REVERSAL_EXCEEDS_ALLOCATION' && exact.ok && !diff.ok && diff.code === 'FIN_IDEMPOTENCY_KEY_REUSED' && await netPaidOfInvoice(c, inv.id) === 0,
      evidence: `retry duplicate=${b.duplicate}; over-reversal -> ${over.code}; exact remainder ${exact.ok ? 'ok' : exact.code}; same key other amount -> ${diff.code}; net=${await netPaidOfInvoice(c, inv.id)}` };
  } finally { await c.end(); }
}));

control('P0-5 concurrent reversal bounded: eight full reversals of the same allocation at once, exactly one wins', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s); const p = await record(s, A, 'rev-3', { amount: 12100, allocations: [alloc(inv.id, 12100)] }); await s.end(); const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c, i) => reverseAllocations(c, A, `undo-conc-${i}`, [{ allocationId: p.allocations[0].id, amountCents: null }])); const net = await netPaidOfInvoice(clients[0], inv.id); const ok = res.filter((r) => r.status === 'fulfilled').length;
    return { holds: ok === 1 && net === 0 && res.filter((r) => r.status === 'rejected').every((r) => has(r, 'FIN_REVERSAL_EXCEEDS_ALLOCATION')), evidence: `winners=${ok}, net=${net} (never negative), losers: ${[...new Set(res.map(codeOf))].join(' / ')}` };
  } finally { await closeAll(); }
}));

control('P0-5 concurrent reversal bounded: eight reversals of 2000 on a 12100 allocation, exactly six fit', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s); const p = await record(s, A, 'rev-4', { amount: 12100, allocations: [alloc(inv.id, 12100)] }); await s.end(); const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c, i) => reverseAllocations(c, A, `undo-part-${i}`, [{ allocationId: p.allocations[0].id, amountCents: 2000 }])); const net = await netPaidOfInvoice(clients[0], inv.id); const ok = res.filter((r) => r.status === 'fulfilled').length;
    return { holds: ok === 6 && net === 100, evidence: `winners=${ok}, net left=${net}` };
  } finally { await closeAll(); }
}));

control('P0-5 void a payment: standing allocations reversed, payment reversed once, idempotent, never twice, concurrent voids bounded', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s); const sup = await insertSupplier(s);
  const p = await record(s, A, 'void-1', { amount: 12100, allocations: [alloc(inv.id, 12100)] }); const q = await record(s, A, 'void-sup', { direction: 'OUT', amount: 12100, allocations: [salloc(sup.id, 12100)] });
  const v1 = await voidPayment(s, A, 'void-key', p.payment.id); const v1b = await voidPayment(s, A, 'void-key', p.payment.id);
  const second = await attempt(s, 'select fin_void_payment($1,$2,$3,$4,$5,$6)', [A, 'void-other', p.payment.id, '2026-10-01', 'again', '{}']);
  const afterSup = (await s.query('select status, payment_status from fin_supplier_invoices where id=$1', [sup.id])).rows[0]; await s.end();
  const { clients, closeAll } = await openMany(d.name, 4);
  try {
    const res = await race(clients, (c, i) => voidPayment(c, A, `void-conc-${i}`, q.payment.id)); const ok = res.filter((r) => r.status === 'fulfilled').length;
    const reversed = await num(clients[0], 'select coalesce(sum(amount_cents),0) s from fin_payment_registry where reversal_of_id=$1', [q.payment.id]); const net = await netPaidOfSupplier(clients[0], sup.id); const row = (await clients[0].query('select status, payment_status from fin_supplier_invoices where id=$1', [sup.id])).rows[0];
    return { holds: !v1.duplicate && v1b.duplicate && v1.reversal.id === v1b.reversal.id && !second.ok && second.code === 'FIN_PAYMENT_ALREADY_REVERSED' && afterSup.status === 'PAID' && ok === 1 && reversed === 12100 && net === 0 && row.status === 'TO_PAY' && row.payment_status === 'unpaid',
      evidence: `void retry duplicate=${v1b.duplicate}; second void -> ${second.code}; 4 concurrent voids: winners=${ok}, reversed=${reversed}, supplier invoice back to ${row.status}/${row.payment_status}` };
  } finally { await closeAll(); }
}));

control('P0-5 the history is append-only: no update or delete of payments, allocations or reversals, and a reversal cannot be reversed', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const p = await record(c, A, 'ao-1', { amount: 1000, allocations: [alloc(inv.id, 1000)] }); const rv = await reverseAllocations(c, A, 'ao-undo', [{ allocationId: p.allocations[0].id, amountCents: 400 }]); const out = [];
  try {
    for (const sql of ['update fin_payment_registry set amount_cents=1 where id=$1', 'delete from fin_payment_registry where id=$1']) out.push((await attempt(c, sql, [p.payment.id])).ok ? 'ACCEPTED' : 'refused');
    for (const sql of ['update fin_payment_allocations set amount_cents=1 where id=$1', 'delete from fin_payment_allocations where id=$1']) out.push((await attempt(c, sql, [rv.reversals[0].id])).ok ? 'ACCEPTED' : 'refused');
    const rr = await attempt(c, 'select fin_reverse_allocations($1,$2,$3,$4,$5)', [A, 'ao-rr', JSON.stringify([{ allocationId: rv.reversals[0].id, amountCents: null }]), 'x', '{}']);
    const direct = await attempt(c, "insert into fin_payment_registry (merchant_id, direction, amount_cents, currency, paid_on, reversal_of_id, request_hash, idempotency_key) values ($1,'IN',1000,'EUR','2026-10-01',$2,'h','direct-rev')", [A, p.payment.id]);
    return { holds: out.every((x) => x === 'refused') && !rr.ok && rr.code === 'FIN_ALLOCATION_NOT_FOUND' && !direct.ok && direct.code === 'FIN_REVERSAL_PAYMENT_ALLOCATED', evidence: `${out.join(',')}; reverse a reversal -> ${rr.code}; reversing a still-allocated payment directly -> ${direct.code}` };
  } finally { await c.end(); }
}));

// ===================================================== P0-3 SUPPLIER PAYMENT TRUTH =====================================================
control('P0-3 supplier payment state is DERIVED from allocations: unpaid -> partially paid -> paid, overpayment impossible', withDb(async (d) => {
  const c = await d.open(); const sup = await insertSupplier(c, A, { gross: 12100 }); const st = async () => (await c.query("select status, payment_status, to_char(paid_at,'YYYY-MM-DD') as paid_at, paid_amount_cents, paid_reference from fin_supplier_invoices where id=$1", [sup.id])).rows[0]; const out = [];
  try {
    const s0 = await st(); out.push(`${s0.status}/${s0.payment_status}`);
    await record(c, A, 'sp-1', { direction: 'OUT', amount: 5000, reference: 'part-1', allocations: [salloc(sup.id, 5000)] }); const s1 = await st(); out.push(`${s1.status}/${s1.payment_status}/paid_at=${s1.paid_at}`);
    const over = await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'sp-x', 'OUT', 7101, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([salloc(sup.id, 7101)])]); out.push(over.code);
    await record(c, A, 'sp-2', { direction: 'OUT', amount: 7100, reference: 'part-2', paidOn: '2026-10-02', allocations: [salloc(sup.id, 7100)] }); const s2 = await st(); out.push(`${s2.status}/${s2.payment_status}`);
    const iso = (v) => String(v);
    return { holds: out[0] === 'TO_PAY/unpaid' && out[1].startsWith('TO_PAY/partially_paid/paid_at=null') && out[2] === 'FIN_ALLOCATION_EXCEEDS_REMAINING' && out[3] === 'PAID/paid' && Number(s2.paid_amount_cents) === 12100 && s2.paid_reference === 'part-2' && iso(s2.paid_at) === '2026-10-02', evidence: out.join(' -> ') + '; mirror: paid_amount=' + s2.paid_amount_cents + ', ref=' + s2.paid_reference + ', paid_at=' + iso(s2.paid_at) };
  } finally { await c.end(); }
}));

control('P0-3 a supplier invoice can NEVER be PAID because a field was written (insert, update, mirror columns, payment_status)', withDb(async (d) => {
  const c = await d.open(); const sup = await insertSupplier(c, A); const out = [];
  try {
    out.push((await attempt(c, "insert into fin_supplier_invoices (merchant_id, supplier_name, invoice_number, issue_date, net_cents, vat_cents, gross_cents, currency, status) values ($1,'F','PAID-1','2026-09-01',1000,210,1210,'EUR','PAID')", [A])).code);
    out.push((await attempt(c, "update fin_supplier_invoices set status='PAID' where id=$1", [sup.id])).code);
    out.push((await attempt(c, "update fin_supplier_invoices set status='PAID', paid_at='2026-09-30', paid_amount_cents=12100, paid_reference='x' where id=$1", [sup.id])).code);
    await c.query("update fin_supplier_invoices set payment_status='paid' where id=$1", [sup.id]); const forced = (await c.query('select payment_status from fin_supplier_invoices where id=$1', [sup.id])).rows[0].payment_status;
    await record(c, A, 'tp-1', { direction: 'OUT', amount: 100, allocations: [salloc(sup.id, 100)] });
    out.push((await attempt(c, "update fin_supplier_invoices set status='PAID' where id=$1", [sup.id])).code);
    return { holds: out.every((x) => x === 'FIN_PAID_REQUIRES_ALLOCATIONS') && forced === 'unpaid', evidence: `${out.join(' / ')}; payment_status='paid' written by hand -> stays '${forced}'` };
  } finally { await c.end(); }
}));

control('P0-3 reversal takes a PAID invoice back to TO_PAY / partially paid, and nothing financial can change under payments', withDb(async (d) => {
  const c = await d.open(); const sup = await insertSupplier(c, A, { gross: 10000 }); const st = async () => (await c.query('select status, payment_status, paid_at from fin_supplier_invoices where id=$1', [sup.id])).rows[0];
  try {
    const p = await record(c, A, 'tr-1', { direction: 'OUT', amount: 10000, allocations: [salloc(sup.id, 10000)] }); const paid = await st();
    await reverseAllocations(c, A, 'tr-undo', [{ allocationId: p.allocations[0].id, amountCents: 4000 }]); const back = await st();
    const edits = [(await attempt(c, 'update fin_supplier_invoices set gross_cents=20000, net_cents=16529, vat_cents=3471 where id=$1', [sup.id])).code, (await attempt(c, "update fin_supplier_invoices set currency='USD' where id=$1", [sup.id])).code, (await attempt(c, "update fin_supplier_invoices set status='TO_REVIEW' where id=$1", [sup.id])).code];
    return { holds: paid.status === 'PAID' && back.status === 'TO_PAY' && back.payment_status === 'partially_paid' && back.paid_at === null && edits.every((x) => x === 'FIN_INVOICE_HAS_PAYMENTS'), evidence: `${paid.status}/${paid.payment_status} -> after reversing 4000: ${back.status}/${back.payment_status}; edits under payments: ${edits.join(' / ')}` };
  } finally { await c.end(); }
}));

control('P0-3 a supplier credit note and a non-validated invoice cannot be paid; concurrent supplier payments are bounded', withDb(async (d) => {
  const s = await d.open(); const cn = await insertSupplier(s, A, { documentType: 'CREDIT_NOTE' }); const un = await insertSupplier(s, A, { status: 'TO_REVIEW' }); const sup = await insertSupplier(s, A, { gross: 8000 });
  const out = [(await attempt(s, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'sc-1', 'OUT', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([salloc(cn.id, 100)])])).code,
    (await attempt(s, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'sc-2', 'OUT', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([salloc(un.id, 100)])])).code]; await s.end();
  const { clients, closeAll } = await openMany(d.name, 4);
  try {
    const res = await race(clients, (c, i) => record(c, A, `sc-conc-${i}`, { direction: 'OUT', amount: 8000, allocations: [salloc(sup.id, 8000)] })); const ok = res.filter((r) => r.status === 'fulfilled').length; const net = await netPaidOfSupplier(clients[0], sup.id);
    return { holds: out.join() === 'FIN_TARGET_NOT_OPEN,FIN_TARGET_NOT_OPEN' && ok === 1 && net === 8000, evidence: `${out.join(' / ')}; 4 simultaneous full payments: winners=${ok}, net=${net}` };
  } finally { await closeAll(); }
}));

// ===================================================== P0-4 MERCHANT ISOLATION =====================================================
control('P0-4 cross-merchant payment rejected: B cannot pay an invoice or a supplier invoice of A, and the refused payment leaves nothing behind', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const sup = await insertSupplier(c, A); const out = [];
  try {
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [B, 'x-1', 'IN', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 100)])])).code);
    out.push((await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [B, 'x-2', 'OUT', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([salloc(sup.id, 100)])])).code);
    const rows = await num(c, 'select count(*) s from fin_payment_registry'); return { holds: out.join() === 'FIN_TARGET_NOT_FOUND,FIN_TARGET_NOT_FOUND' && rows === 0, evidence: `${out.join(' / ')}; registry rows=${rows}` };
  } finally { await c.end(); }
}));

control('P0-4 cross-merchant allocation rejected at the table level: by the guard trigger AND, with the guard disabled, by the composite foreign keys alone (defence in depth)', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const pa = await record(c, A, 'iso-a', { amount: 500 }); const pb = await record(c, B, 'iso-b', { amount: 500 }); const guarded = []; const fkOnly = [];
  const ins = (m, pay, cid) => attempt(c, "insert into fin_payment_allocations (merchant_id, payment_id, customer_document_id, amount_cents, currency, idempotency_key) values ($1,$2,$3,100,'EUR',$4)", [m, pay, cid, `iso-${Math.random()}`]);
  try {
    guarded.push((await ins(B, pb.payment.id, inv.id)).code, (await ins(B, pa.payment.id, inv.id)).code, (await ins(A, pb.payment.id, inv.id)).code);
    await c.query('alter table fin_payment_allocations disable trigger fin_payment_allocation_guard_trg'); // test database only
    fkOnly.push((await ins(B, pb.payment.id, inv.id)).code, (await ins(B, pa.payment.id, inv.id)).code, (await ins(A, pb.payment.id, inv.id)).code);
    await c.query('alter table fin_payment_allocations enable trigger fin_payment_allocation_guard_trg');
    return { holds: guarded.join() === 'FIN_TARGET_NOT_FOUND,FIN_TARGET_NOT_FOUND,FIN_PAYMENT_NOT_FOUND' && fkOnly.join() === 'fin_payment_allocations_customer_fk,fin_payment_allocations_payment_fk,fin_payment_allocations_payment_fk', evidence: `guard: ${guarded.join(' / ')}; foreign keys alone: ${fkOnly.join(' / ')}` };
  } finally { await c.end(); }
}));

control('P0-4 merchant-consistent references everywhere: event, related document, customer company, supplier company', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); const co = (await c.query("insert into fin_companies (merchant_id, name) values ($1,'Client A') returning id", [A])).rows[0].id; const out = [];
  try {
    out.push((await attempt(c, "insert into fin_events (merchant_id, document_id, action) values ($1,$2,'X')", [B, inv.id])).code);
    out.push((await attempt(c, "insert into fin_documents (merchant_id, doc_type, status, body, customer_company_id) values ($1,'invoice','DRAFT','{}',$2)", [B, co])).code);
    out.push((await attempt(c, "insert into fin_supplier_invoices (merchant_id, supplier_company_id, status) values ($1,$2,'RECEIVED')", [B, co])).code);
    out.push((await attempt(c, "insert into fin_documents (merchant_id, doc_type, status, body, related_document_id) values ($1,'invoice','DRAFT','{}',$2)", [B, inv.id])).code);
    return { holds: out.join() === 'fin_events_document_same_merchant_fk,fin_documents_customer_same_merchant_fk,fin_supplier_invoices_company_same_merchant_fk,fin_documents_related_same_merchant_fk', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

// ===================================================== RECONCILIATION: no silent last-writer-wins =====================================================
const claim = "update fin_bank_transactions set status='MATCHED', matched_kind='INVOICE', matched_document_id=$2, matched_amount_cents=1210, matched_at='2026-09-30T10:00:00Z' where id=$1";
const bankTx = async (c, tag = 'tx-1', amount = -1210) => (await c.query("insert into fin_bank_transactions (merchant_id, account_id, provider_tx_id, date, amount_cents, currency, source) values ($1,'csv-import',$2,'2026-09-01',$3,'EUR','csv') returning id", [A, tag, amount])).rows[0].id;

control('RECONCILIATION corruption closed: two simultaneous claims of one bank transaction -> exactly one wins, the other is told, nothing is overwritten', withDb(async (d) => {
  const s = await d.open(); const i1 = await issuedInvoice(s); const i2 = await issuedInvoice(s); const tx = await bankTx(s); await s.end(); const { clients, closeAll } = await openMany(d.name, 2); const ids = [i1.id, i2.id];
  try {
    const res = await race(clients, (c, i) => c.query(claim, [tx, ids[i]])); const winner = res.findIndex((r) => r.status === 'fulfilled'); const owner = (await clients[0].query('select matched_document_id from fin_bank_transactions where id=$1', [tx])).rows[0].matched_document_id;
    return { holds: res.filter((r) => r.status === 'fulfilled').length === 1 && owner === ids[winner] && res.some((r) => has(r, 'FIN_BANK_TX_ALREADY_CLAIMED')), evidence: `accepted=${res.filter((r) => r.status === 'fulfilled').length} of 2; owner is the winner's invoice=${owner === ids[winner]}; loser: ${res.map(codeOf).join(' / ')}` };
  } finally { await closeAll(); }
}));

control('RECONCILIATION: a handled transaction is frozen (re-claim, amount, target of another merchant, payment attached once)', withDb(async (d) => {
  const c = await d.open(); const i1 = await issuedInvoice(c); const i2 = await issuedInvoice(c); const other = await issuedInvoice(c, B); const tx = await bankTx(c); const tx2 = await bankTx(c, 'tx-2'); const out = [];
  try {
    out.push((await attempt(c, claim, [tx2, other.id])).code); // merchant-consistent target
    out.push((await attempt(c, "update fin_bank_transactions set status='MATCHED', matched_kind='INVOICE', matched_document_id=$2, matched_amount_cents=9999 where id=$1", [tx2, i1.id])).code); // more than the transaction
    out.push((await attempt(c, claim, [tx, i1.id])).ok ? 'claimed' : 'x');
    out.push((await attempt(c, claim, [tx, i2.id])).code); // another invoice
    out.push((await attempt(c, "update fin_bank_transactions set matched_amount_cents=100 where id=$1", [tx])).code); // another amount
    out.push((await attempt(c, claim, [tx, i1.id])).ok ? 'same-claim-repeat-ok' : 'x'); // an identical repeat is harmless
    const p1 = await record(c, A, 'bank-p1', { amount: 1210, allocations: [alloc(i1.id, 1210)] }); const p2 = await record(c, A, 'bank-p2', { amount: 100 });
    out.push((await attempt(c, 'update fin_bank_transactions set matched_payment_id=$2 where id=$1', [tx, p1.payment.id])).ok ? 'payment-attached' : 'x');
    out.push((await attempt(c, 'update fin_bank_transactions set matched_payment_id=$2 where id=$1', [tx, p2.payment.id])).code);
    out.push((await attempt(c, "update fin_bank_transactions set status='NEW' where id=$1", [tx])).ok ? 'REOPENED' : 'cannot-reopen');
    return { holds: out.join() === 'FIN_BANK_MATCH_TARGET_NOT_FOUND,FIN_BANK_MATCH_EXCEEDS_TRANSACTION,claimed,FIN_BANK_TX_ALREADY_CLAIMED,FIN_BANK_TX_ALREADY_CLAIMED,same-claim-repeat-ok,payment-attached,FIN_BANK_TX_ALREADY_CLAIMED,cannot-reopen', evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('RECONCILIATION x PAYMENT: the bank transaction is the idempotency key, so it can settle only ONE thing even when two confirmations race', withDb(async (d) => {
  const s = await d.open(); const i1 = await issuedInvoice(s); const i2 = await issuedInvoice(s); await s.end(); const { clients, closeAll } = await openMany(d.name, 2); const ids = [i1.id, i2.id];
  try {
    const res = await race(clients, (c, i) => record(c, A, 'bank:tx-77', { amount: 1210, allocations: [alloc(ids[i], 1210)] })); const rows = await num(clients[0], 'select count(*) s from fin_payment_registry'); const ok = res.filter((r) => r.status === 'fulfilled').length;
    return { holds: ok === 1 && rows === 1 && res.some((r) => has(r, 'FIN_IDEMPOTENCY_KEY_REUSED')), evidence: `accepted=${ok}, registry rows=${rows}; the other confirmation: ${res.map(codeOf).join(' / ')}` };
  } finally { await closeAll(); }
}));

// ===================================================== PERMISSIONS =====================================================
control('PERMISSIONS: anon and authenticated can neither run the payment RPCs nor read the registry; service_role can', withDb(async (d) => {
  const c = await d.open(); const inv = await issuedInvoice(c); await record(c, A, 'perm-seed', { amount: 100 }); const out = [];
  try {
    for (const role of ['anon', 'authenticated']) {
      await c.query(`set role ${role}`);
      out.push(`${role}:rpc=${(await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, `perm-${role}`, 'IN', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 100)])])).ok ? 'ALLOWED' : 'refused'}`);
      out.push(`${role}:read=${(await attempt(c, 'select * from fin_payment_registry')).ok ? 'ALLOWED' : 'refused'}`);
      await c.query('reset role');
    }
    await c.query('set role service_role'); const ok = await attempt(c, 'select fin_record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [A, 'perm-svc', 'IN', 100, 'EUR', '2026-09-30', 'cash', null, '{}', JSON.stringify([alloc(inv.id, 100)])]); await c.query('reset role');
    return { holds: out.every((x) => x.endsWith('refused')) && ok.ok, evidence: `${out.join(', ')}, service_role:rpc=${ok.ok ? 'allowed' : ok.code}` };
  } finally { await c.end(); }
}));
