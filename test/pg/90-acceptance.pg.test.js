// Nordla Finance V1 final acceptance on a real PostgreSQL 17.
//  1. Every acceptance scenario (test/finance-acceptance-scenarios*.js) runs on the PRODUCTION store code (supabase-store.js, unchanged) over PostgreSQL and must give the SAME evidence as the memory store.
//  2. Concurrency with meaningful load: 16 real, simultaneous server connections, each with its own service instance, race on numbering, payments, allocations, credit notes, refunds,
//     reconciliation, Peppol enqueue / send and inbound deduplication. Money invariants are re-derived from the raw rows afterwards.
//  3. Restart / recovery at critical boundaries (a brand-new service instance over the same database).
import assert from 'node:assert/strict';
import { createSupabaseFinanceStore } from '../../src/finance/supabase-store.js';
import { createMemoryAttachmentStore } from '../../src/finance/inbox.js';
import { createFakePeppolProvider } from '../../src/finance/peppol-provider.js';
import { vcsValid } from '../../src/finance/belgium-compliance.js';
import { SCENARIOS } from '../finance-acceptance-scenarios.js';
import { SCENARIOS_2 } from '../finance-acceptance-scenarios-2.js';
import { SCENARIOS_3 } from '../finance-acceptance-scenarios-3.js';
import { accWorld, independent, code, MERCHANT_ACTOR, GROSS_1000, TWO_LINES, LINE_B } from '../finance-acceptance-world.js';
import { supplierInvoiceXml } from '../finance-legal-helpers.js';
import { measure } from '../finance-acceptance-perf.mjs';
import { createPgRestClient } from './lib/pgrest.js';
import { freshDatabase, seedMerchants, MERCHANT_A as A, MERCHANT_B as B } from './lib/db.js';
import { control } from './lib/classify.js';

const ALL = { ...SCENARIOS, ...SCENARIOS_2, ...SCENARIOS_3 };
const N = 16;

/** a world on its own fresh PostgreSQL database (spawned worlds get their own database too) */
async function pgWorld(extra = {}, closers = []) {
  const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end();
  const rest = await createPgRestClient(db.name); const stores = new Map();
  const storeFor = (m) => { if (!stores.has(m)) stores.set(m, createSupabaseFinanceStore(rest, { merchantId: m })); return stores.get(m); };
  closers.push(async () => { await rest.close(); await db.drop(); });
  const w = accWorld({ store: storeFor(A), merchantId: A, otherMerchantId: B, storeFor, spawn: (o) => pgWorld(o, closers), ...extra }); w.db = db; w.closers = closers; return w;
}
const closeAll = async (closers) => { for (const c of closers.splice(0).reverse()) await c().catch(() => {}); };

for (const [name, scenario] of Object.entries(ALL)) {
  control(`ACCEPTANCE ${name}`, async () => {
    const mem = JSON.parse(JSON.stringify((await scenario(accWorld({ otherMerchantId: 'merchant-test-2' }))) ?? null)); const closers = [];
    try {
      const w = await pgWorld({}, closers); const got = JSON.parse(JSON.stringify((await scenario(w)) ?? null)); const same = JSON.stringify(got) === JSON.stringify(mem);
      return { holds: same, evidence: same ? `PostgreSQL == memory: ${JSON.stringify(got).slice(0, 200)}` : `DIFFERENT postgres=${JSON.stringify(got)} memory=${JSON.stringify(mem)}` };
    } finally { await closeAll(closers); }
  });
}

// ===================================================== CONCURRENCY
/** N worlds, each on its own connection and service instance, over ONE database, sharing artifact storage and the fake provider */
async function crowd(n = N) {
  const closers = []; const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); const storage = createMemoryAttachmentStore(); const provider = createFakePeppolProvider();
  const worlds = []; for (let i = 0; i < n; i++) { const rest = await createPgRestClient(db.name); closers.push(() => rest.close()); worlds.push(accWorld({ store: createSupabaseFinanceStore(rest, { merchantId: A }), merchantId: A, storage, provider })); }
  closers.push(() => db.drop());
  const go = async (fn) => { let release; const gate = new Promise((r) => { release = r; }); const runs = worlds.map(async (w, i) => { await gate; return fn(w, i); }); await new Promise((r) => setTimeout(r, 50)); release(); return Promise.allSettled(runs); };
  return { worlds, w0: worlds[0], go, close: () => closeAll(closers) };
}
const ok = (rs) => rs.filter((r) => r.status === 'fulfilled');
const why = (rs) => [...new Set(rs.filter((r) => r.status === 'rejected').map((r) => r.reason?.code ?? String(r.reason?.message).slice(0, 60)))].join('|') || 'none';

control(`CONCURRENCY ${N} connections: numbering (distinct, consecutive), VCS (valid, unique), one issued document each`, async () => {
  const c = await crowd();
  try {
    const rs = await c.go((w) => w.invoice1000()); const done = ok(rs).map((r) => r.value); const numbers = done.map((d) => d.number).sort(); const refs = [];
    for (const d of done) refs.push((await c.w0.legal.compliance(d.id)).paymentReference);
    const seqs = numbers.map((x) => Number(x.split('-').pop())).sort((a, b) => a - b); const consecutive = seqs.every((x, i) => i === 0 || x === seqs[i - 1] + 1);
    const holds = done.length === N && new Set(numbers).size === N && consecutive && new Set(refs).size === N && refs.every((x) => vcsValid(x));
    return { holds, evidence: `${done.length}/${N} issued, ${new Set(numbers).size} distinct numbers (${numbers[0]}..${numbers[N - 1]}), consecutive=${consecutive}, ${new Set(refs).size} distinct valid VCS` };
  } finally { await c.close(); }
});

control(`CONCURRENCY ${N} connections: the same payment request (one idempotency key) is ONE payment, allocated once`, async () => {
  const c = await crowd();
  try {
    const inv = await c.w0.invoice1000(); const rs = await c.go((w) => w.receive(40000, [[inv.id, 40000]], { key: 'acc-conc-same-key' })); const ids = new Set(ok(rs).map((r) => r.value.payment.id));
    const ind = (await independent(c.w0)).customers[inv.id]; const reg = (await c.w0.st.listRegistry(A)).length;
    return { holds: ids.size === 1 && ind.paid === 40000 && reg === 1 && ok(rs).filter((r) => !r.value.duplicate).length === 1, evidence: `${ok(rs).length} calls answered, ${ids.size} payment id, paid=${ind.paid}, registry rows=${reg}, first-writers=${ok(rs).filter((r) => !r.value.duplicate).length}, refused: ${why(rs)}` };
  } finally { await c.close(); }
});

control(`CONCURRENCY ${N} connections: competing payments cannot over-allocate an invoice (remaining_due never negative)`, async () => {
  const c = await crowd();
  try {
    const inv = await c.w0.invoice1000(); const rs = await c.go((w, i) => w.receive(60000, [[inv.id, 60000]], { key: `acc-conc-alloc-${i}` })); const ind = (await independent(c.w0)).customers[inv.id];
    return { holds: ok(rs).length === 1 && ind.paid === 60000 && ind.remaining === 40000, evidence: `${ok(rs).length} accepted of ${N} (600 each against 1 000), paid=${ind.paid}, remaining=${ind.remaining}, refused=${rs.length - ok(rs).length}` };
  } finally { await c.close(); }
});


// A payment is committed atomically in PostgreSQL; the stored lifecycle status is only a mirror re-derived afterwards. A race on that mirror must neither tell the caller that a committed payment failed
// nor leave the mirror stale: every call that returns success matches a committed payment, every committed payment returns success, and the stored status equals the derived one.
control(`CONCURRENCY ${N} connections: payments that together settle an invoice all succeed and the stored status ends equal to the derived one`, async () => {
  const c = await crowd();
  try {
    const inv = await c.w0.invoice1000(); const rs = await c.go((w, i) => w.receive(6250, [[inv.id, 6250]], { key: `acc-conc-settle-${i}` })); const committed = (await c.w0.st.listRegistry(A)).length;
    const stored = (await c.w0.st.getDocument(inv.id)).status; const v = await c.w0.view(inv.id); const derivedPaid = v.remaining === 0;
    return { holds: ok(rs).length === committed && committed === N && derivedPaid && stored === 'PAID', evidence: `${ok(rs).length} calls succeeded, ${committed} payments committed, remaining=${v.remaining}, stored status=${stored}, refused: ${why(rs)}` };
  } finally { await c.close(); }
});

control(`CONCURRENCY ${N} connections: one payment spread by competing allocations never exceeds the payment`, async () => {
  const c = await crowd();
  try {
    const invs = []; for (let i = 0; i < N; i++) invs.push(await c.w0.invoice1000()); const p = await c.w0.receive(100000, [[invs[0].id, 10000]]);
    const rs = await c.go((w, i) => (i === 0 ? { skipped: true } : w.P.allocate(p.payment.id, { allocations: [{ documentId: invs[i].id, amountCents: 10000 }], idempotencyKey: `acc-conc-al-${i}` }, MERCHANT_ACTOR))); const got = ok(rs).filter((r) => !r.value.skipped).length;
    const reg = (await c.w0.st.listRegistry(A)).find((x) => x.id === p.payment.id); const allocated = (await c.w0.st.listAllocations({ paymentId: p.payment.id })).reduce((s, a) => s + a.amountCents, 0);
    return { holds: allocated <= 100000 && allocated === 10000 * (1 + got) && got === 9, evidence: `payment 1 000.00: ${got} extra allocations of 100.00 accepted, allocated=${allocated}, registry unallocated=${reg.unallocatedCents ?? "n/a"}, refused: ${why(rs)}` };
  } finally { await c.close(); }
});

control(`CONCURRENCY ${N} connections: competing credit notes never exceed the invoice; competing refunds never exceed the credit note`, async () => {
  const c = await crowd();
  try {
    const inv = await c.w0.invoice1000({ lines: TWO_LINES }); const pay = await c.w0.receive(96800, [[inv.id, 96800]]);
    const rs = await c.go((w) => w.creditNote(inv, LINE_B).then((cn) => cn)); const cns = ok(rs).map((r) => r.value); const ind = (await independent(c.w0)).customers[inv.id];
    const credits = ok(rs).length; assert.ok(credits >= 1);
    const first = cns[0]; const refunds = await c.go((w, i) => w.P.refund(first.id, { amountCents: 48400, paidOn: '2026-09-28', method: 'bank_transfer', refundOfPaymentId: pay.payment.id, idempotencyKey: `acc-conc-rf-${i}` }, MERCHANT_ACTOR));
    const refunded = (await independent(c.w0)).customers[inv.id].refunded;
    return { holds: ind.credited <= 96800 && ind.credited === 48400 * credits && credits === 2 && ok(refunds).length === 1 && refunded === 48400, evidence: `credit notes accepted=${credits} [refused: ${why(rs)}] (credited ${ind.credited} <= 96800), refunds accepted=${ok(refunds).length} of ${N}, refunded=${refunded}` };
  } finally { await c.close(); }
});

control(`CONCURRENCY ${N} connections: competing reconciliations never exceed the bank transaction or a payment`, async () => {
  const c = await crowd();
  try {
    const tx = await c.w0.bankTx('conc-tx', 100000); const pays = []; for (let i = 0; i < N; i++) pays.push((await c.w0.receive(30000, [])).payment);
    const rs = await c.go((w, i) => w.st.reconcileBank({ merchantId: A, key: `acc-conc-rec-${i}`, transactionId: tx.id, items: [{ paymentId: pays[i].id, amountCents: 30000 }], actor: MERCHANT_ACTOR, at: w.at }));
    const t = await c.w0.tx('conc-tx'); const matched = t.reconciledCents;
    return { holds: ok(rs).length === 3 && matched === 90000 && t.remainingCents === 10000 && t.reconciliationStatus === 'PARTIALLY_RECONCILED', evidence: `${ok(rs).length} reconciliations of 300.00 accepted against 1 000.00, matched=${matched}, remaining=${t.remainingCents}, status=${t.reconciliationStatus}` };
  } finally { await c.close(); }
});

control(`CONCURRENCY ${N} connections: Peppol enqueue + send of one document is ONE message and ONE provider submission`, async () => {
  const c = await crowd();
  try {
    const inv = await c.w0.invoice1000(); const doc = await c.w0.st.getDocument(inv.id); const qs = await c.go((w) => w.peppol.queue(doc, { actor: MERCHANT_ACTOR })); const msg = ok(qs)[0].value.message;
    const ds = await c.go((w) => w.peppol.dispatch(msg.id)); const rows = await c.w0.st.listPeppolMessages({ merchantId: A, direction: 'OUT' });
    return { holds: ok(qs).filter((r) => !r.value.duplicate).length === 1 && rows.length === 1 && c.w0.provider.calls.submit === 1 && rows[0].state === 'SUBMITTED' && ok(ds).filter((r) => r.value.sent).length === 1, evidence: `${ok(qs).length} enqueues -> ${rows.length} message, provider submits=${c.w0.provider.calls.submit}, state=${rows[0].state}, senders=${ok(ds).filter((r) => r.value.sent).length}` };
  } finally { await c.close(); }
});

control(`CONCURRENCY ${N} connections: the same inbound document (webhook, polling, retries, other transport ids) is ONE supplier invoice`, async () => {
  const c = await crowd();
  try {
    const { xml } = await supplierInvoiceXml({}); const sig = { 'x-fake-signature': 'fake-webhook-secret' };
    const rs = await c.go((w, i) => w.peppol.handleWebhook({ headers: sig, body: xml, providerMessageId: i % 2 ? 'pm-conc-1' : `pm-conc-${i}` }));
    const sup = await c.w0.st.listSupplierInvoices(A); const msgs = await c.w0.st.listPeppolMessages({ merchantId: A, direction: 'IN' }); const inboxCount = msgs.filter((m) => m.supplierInvoiceId).length;
    return { holds: sup.length === 1 && inboxCount === 1 && msgs.filter((m) => m.state === 'TO_REVIEW').length === 1, evidence: `${ok(rs).length}/${N} calls answered, supplier invoices=${sup.length}, messages=${msgs.length} (${[...new Set(msgs.map((m) => m.state))].join(',')}), with-candidate=${inboxCount}` };
  } finally { await c.close(); }
});

control(`CONCURRENCY ${N} connections: money invariants after the whole race (independent recomputation == settlement)`, async () => {
  const c = await crowd();
  try {
    const invs = []; for (let i = 0; i < 6; i++) invs.push(await c.w0.invoice(200 + i));
    await c.go(async (w, i) => { const inv = invs[i % 6]; return w.receive(5000 + i, [[inv.id, 5000 + i]], { key: `acc-conc-mix-${i}` }); });
    const ind = await independent(c.w0); let bad = 0; for (const [id, x] of Object.entries(ind.customers)) { const v = await c.w0.view(id); if (v.remaining !== x.remaining || v.paid !== x.paid) bad += 1; }
    return { holds: bad === 0 && Object.values(ind.customers).every((x) => x.remaining >= 0), evidence: `${Object.keys(ind.customers).length} invoices, ${bad} differences between settlement and the independent recomputation` };
  } finally { await c.close(); }
});

// ===================================================== RESTART / RECOVERY
control('RESTART: a new service instance over the same database sees the same truth; retried requests are idempotent; Peppol recovery by idempotency key', async () => {
  const closers = []; try {
    const w = await pgWorld({}, closers); const inv = await w.invoice1000(); const p = await w.receive(40000, [[inv.id, 40000]], { key: 'acc-restart-pay' }); const before = await w.view(inv.id);
    const w2 = accWorld({ store: createSupabaseFinanceStore(await (async () => { const rest = await createPgRestClient(w.db.name); closers.push(() => rest.close()); return rest; })(), { merchantId: A }), merchantId: A, storage: w.storage, provider: w.provider });
    const after = await w2.view(inv.id); const retry = await w2.receive(40000, [[inv.id, 40000]], { key: 'acc-restart-pay' }); const doc = await w2.st.getDocument(inv.id); const comp = await w2.legal.compliance(doc.id);
    const q = await w2.peppol.queue(doc, { actor: MERCHANT_ACTOR }); w2.provider.inject('submit', 'timeout_after_accept'); const d = await w2.peppol.dispatch(q.message.id);
    const w3 = accWorld({ store: createSupabaseFinanceStore(await (async () => { const rest = await createPgRestClient(w.db.name); closers.push(() => rest.close()); return rest; })(), { merchantId: A }), merchantId: A, storage: w.storage, provider: w.provider });
    const rec = await w3.peppol.recover(q.message.id); const msgs = await w3.st.listPeppolMessages({ merchantId: A, direction: 'OUT' });
    const holds = JSON.stringify(before) === JSON.stringify(after) && retry.duplicate === true && retry.payment.id === p.payment.id && comp.pdf && comp.structured && d.unknown === true && rec.state === 'SUBMITTED' && w.provider.calls.submit === 1 && msgs.length === 1;
    return { holds, evidence: `settlement identical after restart (${JSON.stringify(after)}), retry duplicate=${retry.duplicate}, originals intact, timeout-after-accept recovered -> ${rec.state}, provider submits=${w.provider.calls.submit}` };
  } finally { await closeAll(closers); }
});

void GROSS_1000; void code;

// ===================================================== PERFORMANCE (measurement with generous ceilings; the ~1-1.5 s synchronous issuance with official validation + archiving is accepted for V1, async is BACKLOG)
control('PERFORMANCE on PostgreSQL 17: issuance (official validation + archiving), payment, Treasury model, export for 20 invoices', async () => {
  const closers = []; try {
    const w = await pgWorld({}, closers); const m = await measure(w, 20);
    return { holds: m.issueMs.p95 < 6000 && m.treasuryModelMs < 5000 && m.exportWithDocumentsMs < 15000 && m.paymentMsAvg < 2000, evidence: JSON.stringify(m) };
  } finally { await closeAll(closers); }
});
