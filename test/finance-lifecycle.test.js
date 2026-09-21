import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/metrics/ledger.js';
import { mergeConfig } from '../src/metrics/config.js';
import { orderTotalsFromLedger } from '../src/finance/linking.js';
import { buildReceivables, bucketOf } from '../src/finance/receivables.js';
import { effectiveStatus, settlement } from '../src/finance/document.js';
import { loadDocsForReports } from '../src/finance/reports.js';
import { AGENT_ACTOR, CUSTOMER, LINES, MERCHANT, MERCHANT_ACTOR, VAT_OK, draftInvoice, issueInvoice, makeService } from './finance-fixtures.js';
import { makeMarketingData } from './fixtures/marketing-sample.js';

const quoteInput = (over = {}) => ({ type: 'quote', customer: CUSTOMER, lines: LINES, vat: VAT_OK, issueDate: '2026-09-21', validUntil: '2026-10-21', ...over });

// ---------- quotes ----------
test('quote lifecycle: DRAFT -> SENT (numbered, locked) -> ACCEPTED -> CONVERTED; quote is never revenue', async () => {
  const { svc } = makeService();
  const q = await svc.create(quoteInput(), AGENT_ACTOR);
  await assert.rejects(svc.sendQuote(q.id, AGENT_ACTOR), (e) => e.code === 'SENDING_REQUIRES_A_MERCHANT_ACTOR');
  const sent = await svc.sendQuote(q.id, MERCHANT_ACTOR);
  assert.equal(sent.status, 'SENT');
  assert.equal(sent.number, 'QT-2026-0001');
  assert.ok(sent.lockedAt);
  await assert.rejects(svc.update(q.id, { notes: 'x' }, AGENT_ACTOR), (e) => e.code === 'DOCUMENT_LOCKED');
  const accepted = await svc.acceptQuote(q.id, MERCHANT_ACTOR);
  assert.equal(accepted.status, 'ACCEPTED');
  const inv = await svc.convertQuote(q.id, MERCHANT_ACTOR);
  assert.equal(inv.type, 'invoice');
  assert.equal(inv.status, 'DRAFT');
  assert.equal(inv.relatedDocumentId, q.id); // quote_id -> invoice link
  const quote = await svc.get(q.id);
  assert.equal(quote.status, 'CONVERTED');
  assert.equal(quote.convertedInvoiceId, inv.id); // and back
  await assert.rejects(svc.convertQuote(q.id, MERCHANT_ACTOR), (e) => e.code === 'INVALID_TRANSITION');
});

test('conversion reuses every commercial value without retyping and produces identical totals', async () => {
  const { svc } = makeService();
  const q = await svc.create(quoteInput({ notes: 'Delivery in 2 weeks', paymentTerms: '30 days net' }), AGENT_ACTOR);
  await svc.sendQuote(q.id, MERCHANT_ACTOR);
  await svc.acceptQuote(q.id, MERCHANT_ACTOR);
  const inv = await svc.convertQuote(q.id, MERCHANT_ACTOR);
  const quote = await svc.get(q.id);
  assert.deepEqual(inv.lines.map(({ description, qtyMilli, priceMicro, discountBp, vatRateBp }) => ({ description, qtyMilli, priceMicro, discountBp, vatRateBp })),
    quote.lines.map(({ description, qtyMilli, priceMicro, discountBp, vatRateBp }) => ({ description, qtyMilli, priceMicro, discountBp, vatRateBp })));
  assert.deepEqual(inv.customer, quote.customer);
  assert.equal(inv.totals.grossCents, quote.totals.grossCents);
  assert.deepEqual(inv.totals.vatBreakdown, quote.totals.vatBreakdown);
  assert.equal(inv.notes, 'Delivery in 2 weeks');
  assert.equal(inv.paymentTerms, '30 days net');
  await svc.submit(inv.id, AGENT_ACTOR);
  const issued = await svc.decide(inv.id, 'APPROVE', MERCHANT_ACTOR);
  assert.equal(issued.number, 'INV-2026-0001'); // separate numbering from the quote
});

test('a quote cannot be converted before acceptance, and a rejected quote cannot be accepted', async () => {
  const { svc } = makeService();
  const q = await svc.create(quoteInput(), AGENT_ACTOR);
  await svc.sendQuote(q.id, MERCHANT_ACTOR);
  await assert.rejects(svc.convertQuote(q.id, MERCHANT_ACTOR), (e) => e.code === 'INVALID_TRANSITION');
  await svc.rejectQuote(q.id, MERCHANT_ACTOR);
  await assert.rejects(svc.acceptQuote(q.id, MERCHANT_ACTOR), (e) => e.code === 'INVALID_TRANSITION');
});

// ---------- credit notes ----------
test('credit note: full credit marks the invoice CREDITED; the issued invoice itself is never rewritten', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  const cn = await svc.createCreditNote(inv.id, { reason: 'Order cancelled' }, AGENT_ACTOR);
  assert.equal(cn.type, 'credit_note');
  assert.equal(cn.relatedDocumentId, inv.id);
  assert.equal(cn.totals.grossCents, inv.totals.grossCents);
  await svc.submit(cn.id, AGENT_ACTOR);
  const issued = await svc.decide(cn.id, 'APPROVE', MERCHANT_ACTOR);
  assert.equal(issued.number, 'CN-2026-0001');
  const v = await svc.view(inv.id);
  assert.equal(v.doc.status, 'CREDITED');
  assert.equal(v.doc.snapshotHash, inv.snapshotHash); // commercial content untouched
  assert.equal(v.settlement.remainingCents, 0);
  assert.equal(v.integrity.ok, true);
});

test('partial credit note reduces what is owed but leaves the invoice open; credits can never exceed the invoice', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc); // gross 71.90
  const cn = await svc.createCreditNote(inv.id, { reason: 'Returned Item A', lines: [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }] }, AGENT_ACTOR);
  assert.equal(cn.totals.grossCents, 1210);
  await svc.submit(cn.id, AGENT_ACTOR);
  await svc.decide(cn.id, 'APPROVE', MERCHANT_ACTOR);
  const v = await svc.view(inv.id);
  assert.equal(v.settlement.creditedCents, 1210);
  assert.equal(v.settlement.remainingCents, 7190 - 1210);
  assert.notEqual(v.doc.status, 'CREDITED');
  await assert.rejects(svc.createCreditNote(inv.id, { reason: 'too much', lines: [{ description: 'x', quantity: '1', unitPrice: '100.00', vatRate: '21' }] }, AGENT_ACTOR), (e) => e.code === 'CREDIT_EXCEEDS_INVOICE');
  await assert.rejects(svc.createCreditNote((await svc.create(draftInvoice(), AGENT_ACTOR)).id, { reason: 'r' }, AGENT_ACTOR), (e) => e.code === 'ONLY_ISSUED_INVOICES_CAN_BE_CREDITED');
});

test('credit note needs a reason and references its original', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  const cn = await svc.createCreditNote(inv.id, {}, AGENT_ACTOR);
  const r = await svc.readiness(cn);
  assert.ok(r.errors.includes('CREDIT_REASON_MISSING'));
});

// ---------- payments and overdue ----------
test('partial then full payment: PARTIALLY_PAID -> PAID, remaining tracked, overpayment refused', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc); // 71.90
  await svc.recordPayment(inv.id, { amount: '30.00', paidOn: '2026-09-25', method: 'bank_transfer' }, MERCHANT_ACTOR);
  let v = await svc.view(inv.id);
  assert.equal(v.doc.status, 'PARTIALLY_PAID');
  assert.deepEqual([v.settlement.paidCents, v.settlement.remainingCents], [3000, 4190]);
  await assert.rejects(svc.recordPayment(inv.id, { amount: '50.00', paidOn: '2026-09-26' }, MERCHANT_ACTOR), (e) => e.code === 'PAYMENT_EXCEEDS_REMAINING');
  await svc.recordPayment(inv.id, { amount: '41.90', paidOn: '2026-09-30', method: 'cash' }, MERCHANT_ACTOR);
  v = await svc.view(inv.id);
  assert.equal(v.doc.status, 'PAID');
  assert.equal(v.settlement.remainingCents, 0);
  await assert.rejects(svc.recordPayment(inv.id, { amount: '1.00', paidOn: '2026-10-01' }, MERCHANT_ACTOR), (e) => e.code === 'INVOICE_NOT_OPEN_FOR_PAYMENT');
  assert.equal((await svc.events(inv.id)).filter((e) => e.action === 'RECORD_PAYMENT').length, 2);
});

test('payment validation: amounts and dates are strict; a negative correction needs a reference', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  await assert.rejects(svc.recordPayment(inv.id, { amount: '0', paidOn: '2026-09-25' }, MERCHANT_ACTOR), (e) => e.code === 'PAYMENT_AMOUNT_INVALID');
  await assert.rejects(svc.recordPayment(inv.id, { amount: '1.005', paidOn: '2026-09-25' }, MERCHANT_ACTOR), (e) => e.code === 'PAYMENT_AMOUNT_INVALID');
  await assert.rejects(svc.recordPayment(inv.id, { amount: '1.00', paidOn: '25/09/2026' }, MERCHANT_ACTOR), (e) => e.code === 'PAYMENT_DATE_INVALID');
  await assert.rejects(svc.recordPayment(inv.id, { amount: '-5.00', paidOn: '2026-09-25' }, MERCHANT_ACTOR), (e) => e.code === 'CORRECTION_REQUIRES_A_REFERENCE');
});

test('overdue is derived from the due date and what remains, never stored', async () => {
  const { svc, store, setToday } = makeService();
  const inv = await issueInvoice(svc); // due 2026-10-21
  const s0 = settlement(inv, [], []);
  assert.equal(effectiveStatus(inv, s0, '2026-10-21'), 'ISSUED'); // due today is not overdue
  assert.equal(effectiveStatus(inv, s0, '2026-10-22'), 'OVERDUE');
  setToday('2026-11-15');
  assert.equal((await svc.view(inv.id)).effectiveStatus, 'OVERDUE');
  assert.equal((await store.getDocument(inv.id)).status, 'ISSUED'); // stored lifecycle status unchanged
  await svc.recordPayment(inv.id, { amount: '71.90', paidOn: '2026-11-15' }, MERCHANT_ACTOR);
  assert.equal((await svc.view(inv.id)).effectiveStatus, 'PAID');
});

test('due date defaults from payment terms and cannot precede the issue date', async () => {
  const { svc } = makeService();
  const d = await svc.create(draftInvoice({ issueDate: '2026-01-31', paymentTermsDays: 30 }), AGENT_ACTOR);
  assert.equal(d.dueDate, '2026-03-02'); // calendar arithmetic, not "add a month"
  const bad = await svc.create(draftInvoice({ issueDate: '2026-09-21', dueDate: '2026-09-01' }), AGENT_ACTOR);
  assert.ok((await svc.readiness(bad)).errors.includes('DUE_DATE_BEFORE_ISSUE_DATE'));
});

// ---------- receivables ----------
test('aging buckets, due soon, overdue and outstanding amounts', async () => {
  assert.deepEqual([-1, 0, 7, 8, 30, 31, 60, 61].map(bucketOf), ['not_due', '0_7', '0_7', '8_30', '8_30', '31_60', '31_60', '60_plus']);
  const { svc, store } = makeService();
  const mk = (issueDate, dueDate) => issueInvoice(svc, { issueDate, dueDate });
  await mk('2026-05-01', '2026-06-01'); // 112 days overdue on 2026-09-21
  await mk('2026-08-15', '2026-09-05'); // 16
  await mk('2026-09-10', '2026-09-20'); // 1
  await mk('2026-09-15', '2026-09-24'); // due in 3 days
  await mk('2026-09-15', '2026-11-30'); // not due
  const paid = await mk('2026-08-01', '2026-08-15');
  await svc.recordPayment(paid.id, { amount: '71.90', paidOn: '2026-08-20' }, MERCHANT_ACTOR);
  const r = buildReceivables(await loadDocsForReports(store, MERCHANT), { today: '2026-09-21', dueSoonDays: 7 });
  assert.equal(r.unpaid.count, 5);
  assert.equal(r.unpaid.outstandingCents, 5 * 7190);
  assert.equal(r.overdue.count, 3);
  assert.equal(r.due_soon.count, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(r.aging).map(([k, v]) => [k, v.count])), { not_due: 2, '0_7': 1, '8_30': 1, '31_60': 0, '60_plus': 1 });
  assert.equal(r.provenance.reminders_sent, false);
  assert.equal(r.invoices[0].daysOverdue, 112);
});

// ---------- Shopify linkage and double counting ----------
const retail = () => { const data = makeMarketingData(); return buildLedger(data, { config: mergeConfig({}) }); };
const linkedLines = [{ description: 'Order o4', quantity: '1', unitPrice: '16.53', vatRate: '21' }]; // gross 20.00 = source order o4

test('source-order totals come from the validated ledger, not a second definition', () => {
  const t = orderTotalsFromLedger(retail());
  assert.equal(t.get('o4').grossCents, 2000);
  assert.equal(t.get('o2').refundedCents, 2000);
  assert.equal(t.get('o1').grossCents, 4500); // 2 x 25 - 5 discount
});

test('linked invoice: verified against the source order; unknown order and missing basis are refused', async () => {
  const { svc } = makeService({ ledger: retail() });
  const ok = await svc.create(draftInvoice({ lines: linkedLines, revenueBasis: 'linked_source_order', sourceOrderId: 'o4' }), AGENT_ACTOR);
  const r = await svc.readiness(ok);
  assert.equal(r.ready, true);
  assert.equal(r.checks.source_order_verified, 'ok');
  const ghost = await svc.create(draftInvoice({ lines: linkedLines, revenueBasis: 'linked_source_order', sourceOrderId: 'nope' }), AGENT_ACTOR);
  assert.ok((await svc.readiness(ghost)).errors.includes('SOURCE_ORDER_NOT_FOUND_IN_RETAIL_CORE'));
  const none = await svc.create(draftInvoice({ revenueBasis: null }), AGENT_ACTOR);
  assert.ok((await svc.readiness(none)).errors.includes('REVENUE_BASIS_NOT_DECLARED'));
  const mismatch = await svc.create(draftInvoice({ revenueBasis: 'linked_source_order', sourceOrderId: 'o5' }), AGENT_ACTOR); // 71.90 vs order o5 (10.00)
  assert.ok((await svc.readiness(mismatch)).warnings.some((w) => w.startsWith('LINKED_AMOUNT_DIFFERS_FROM_SOURCE_ORDER')));
  const noRetail = makeService({ ledger: null });
  const unv = await noRetail.svc.create(draftInvoice({ lines: linkedLines, revenueBasis: 'linked_source_order', sourceOrderId: 'o4' }), AGENT_ACTOR);
  assert.ok((await noRetail.svc.readiness(unv)).errors.includes('SOURCE_ORDER_UNVERIFIABLE_NO_RETAIL_DATA'));
});

test('double-count guard: a shop order can only be invoiced once (refused at creation by the store rule)', async () => {
  const { svc, store } = makeService({ ledger: retail() });
  await issueInvoice(svc, { lines: linkedLines, revenueBasis: 'linked_source_order', sourceOrderId: 'o4' });
  await assert.rejects(svc.create(draftInvoice({ lines: linkedLines, revenueBasis: 'linked_source_order', sourceOrderId: 'o4' }), AGENT_ACTOR), (e) => e.code === 'SOURCE_ORDER_ALREADY_INVOICED');
  assert.equal([...store._debug.docs.values()].filter((d) => d.sourceOrderId === 'o4').length, 1);
});

test('duplicate suspicion: a standalone invoice that looks like an unlinked shop sale is blocked until acknowledged', async () => {
  const { svc } = makeService({ ledger: retail() });
  const lookalike = draftInvoice({ lines: linkedLines, revenueBasis: 'standalone_b2b', issueDate: '2026-09-14' }); // gross 20.00 on the day of o4
  const d = await svc.create(lookalike, AGENT_ACTOR);
  const r = await svc.readiness(d);
  assert.equal(r.ready, false);
  assert.ok(r.errors.some((e) => e.startsWith('POSSIBLE_DUPLICATE_OF_SHOP_SALE')));
  assert.equal(r.checks.duplicate_scan, 'suspected');
  const ack = await svc.create({ ...lookalike, acknowledgedNotDuplicate: true }, AGENT_ACTOR);
  const r2 = await svc.readiness(ack);
  assert.equal(r2.ready, true);
  assert.ok(r2.warnings.includes('POSSIBLE_DUPLICATE_ACKNOWLEDGED_BY_MERCHANT'));
  const far = await svc.create(draftInvoice({ lines: linkedLines, issueDate: '2026-09-30' }), AGENT_ACTOR); // same amount, no order that day
  assert.equal((await svc.readiness(far)).checks.duplicate_scan, 'ok');
});

test('a source order that is already covered by an invoice is not a duplicate suspect any more', async () => {
  const { svc } = makeService({ ledger: retail() });
  await issueInvoice(svc, { lines: linkedLines, revenueBasis: 'linked_source_order', sourceOrderId: 'o4', issueDate: '2026-09-14' });
  const other = await svc.create(draftInvoice({ lines: linkedLines, issueDate: '2026-09-15' }), AGENT_ACTOR); // o2, o4 and o8 all total 20.00 within 3 days; o4 is already linked
  const r = await svc.readiness(other);
  assert.ok(r.errors.some((e) => e.includes('2 unlinked order(s)'))); // o2 and o8 remain suspects; o4 is covered by an invoice
});
