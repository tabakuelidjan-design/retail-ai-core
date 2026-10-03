// Final acceptance scenarios, second half: supplier side, inbound Peppol, overdue, cash, bank position, DST, currencies, routes, Peppol / artifact failure paths, security, export proof, mixed dataset.
import assert from 'node:assert/strict';
import { createPeppolService } from '../src/finance/peppol-service.js';
import { safeFileName } from '../src/finance/peppol.js';
import { verifyExportPackage } from '../src/finance/accountant-export.js';
import { unzip, zip } from '../src/finance/xlsx.js';
import { createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { supplierInvoiceXml, BUYER_OF_SELLER } from './finance-legal-helpers.js';
import { accWorld, MERCHANT_ACTOR, CUSTOMER, TWO_LINES, code, csv, independent, sha } from './finance-acceptance-world.js';

const eq = assert.deepStrictEqual;
const E = (c) => (c / 100).toFixed(2);
const sigOk = { 'x-fake-signature': 'fake-webhook-secret' };
const supplierOf = async (w, id) => (await w.st.listSupplierInvoices(w.mid)).find((s) => s.id === id);
const supplierItem = (model, id) => model.items.find((i) => i.id === `SUPPLIER_INVOICE:${id}`);
const salesRow = (pkg, number) => csv(pkg, 'sales.csv').find((r) => r.number === number);
const INDIVIDUAL = { kind: 'individual', name: 'Client Particulier (synthetic)', address: { street: 'Rue du Test 1', postalCode: '5000', city: 'Namur', countryCode: 'BE' } };
const FR_BUYER = { kind: 'business', name: 'Client France SARL (synthetic)', vatNumber: 'FR12345678901', address: { street: '1 rue Exemple', postalCode: '75001', city: 'Paris', countryCode: 'FR' }, peppolId: null };
const AUTHORITY = { kind: 'public_authority', name: 'Commune Exemple (synthetic)', address: { street: 'Place Communale 1', postalCode: '5000', city: 'Namur', countryCode: 'BE' }, enterpriseNumber: '0000.000.299' };

export const SCENARIOS_2 = {
  // ---------------------------------------------------------------- 9. supplier invoice: inbound structured -> archive -> validation -> review -> accept -> partial + remainder -> bank -> treasury -> export
  async 'S9 supplier invoice from an inbound Peppol document: human acceptance, partial then remaining payment, bank, treasury, export'(w) {
    const { xml } = await supplierInvoiceXml({}); const r = await w.peppol.receive({ providerMessageId: 'pm-s9', payload: xml });
    eq(r.message.state, 'TO_REVIEW'); eq(r.validation.ok, true); assert.ok(r.original.sha256 === sha(xml), 'exact bytes archived'); assert.ok(r.supplierInvoiceId);
    eq((await supplierOf(w, r.supplierInvoiceId)).status === 'VALIDATED', false, 'a candidate is never an accepted supplier invoice');
    eq(await code(() => w.paySupplier(1000, [[r.supplierInvoiceId, 1000]])) === 'OK', false, 'an unreviewed candidate cannot be paid');
    await w.peppol.accept(r.message.id, MERCHANT_ACTOR); const s = await supplierOf(w, r.supplierInvoiceId); eq(s.grossCents, 7190);
    const p1 = await w.paySupplier(2000, [[s.id, 2000]]); const t1 = await w.bankTx('s9-out-1', -2000, '2026-09-25'); await w.reconcile(t1, p1.payment.id, 2000);
    let ind = (await independent(w)).suppliers[s.id]; eq([ind.paid, ind.remaining], [2000, 5190]); eq(supplierItem(await w.treasury().model(), s.id).amountCents, 5190);
    const row1 = csv(await w.pkg(), 'purchases.csv')[0]; eq([row1.allocated, row1.remaining], ['20.00', '51.90']);
    const p2 = await w.paySupplier(5190, [[s.id, 5190]], { paidOn: '2026-09-26' }); const t2 = await w.bankTx('s9-out-2', -5190, '2026-09-26'); await w.reconcile(t2, p2.payment.id, 5190);
    ind = (await independent(w)).suppliers[s.id]; eq([ind.paid, ind.remaining], [7190, 0]); eq(supplierItem(await w.treasury().model(), s.id) ?? null, null);
    const pkg = await w.pkg(); const row2 = csv(pkg, 'purchases.csv')[0]; eq([row2.allocated, row2.remaining, row2.payment_state], ['71.90', '0.00', row2.payment_state]); assert.match(row2.payment_state, /PAID|Pay|pay/);
    eq((await w.tx('s9-out-1')).reconciliationStatus, 'RECONCILED'); eq(verifyExportPackage(pkg.zip).ok, true); eq(await code(() => w.paySupplier(1, [[s.id, 1]])) === 'OK', false, 'no over-payment of a settled supplier invoice');
    return { gross: s.grossCents, steps: [5190, 0], state: row2.payment_state };
  },

  // ---------------------------------------------------------------- 10. duplicate inbound documents
  async 'S10 duplicate inbound: webhook twice, poll + webhook, provider retry, same document with another transport id and other bytes -> ONE supplier invoice'(w) {
    const { xml } = await supplierInvoiceXml({}); const out = [];
    const a = await w.peppol.handleWebhook({ headers: sigOk, body: xml, providerMessageId: 'pm-d1' }); const b = await w.peppol.handleWebhook({ headers: sigOk, body: xml, providerMessageId: 'pm-d1' });
    out.push([a.duplicate, b.duplicate]);
    w.provider.pushInbound({ providerMessageId: 'pm-d1', payload: xml }); const polled = await w.peppol.poll(); out.push(polled.map((x) => x.duplicate));
    const retry = await w.peppol.handleWebhook({ headers: sigOk, body: xml, providerMessageId: 'pm-d2' }); out.push(retry.duplicate); eq(retry.message.state, 'DUPLICATE');
    const changed = Buffer.concat([xml, Buffer.from('<!-- resent -->')]); const conflicting = await w.peppol.handleWebhook({ headers: sigOk, body: changed, providerMessageId: 'pm-d3' }); out.push(conflicting.duplicate);
    const msgs = await w.st.listPeppolMessages({ merchantId: w.mid, direction: 'IN' }); const list = await w.st.listSupplierInvoices(w.mid);
    eq(list.length, 1, 'exactly one logical supplier invoice'); eq(msgs.filter((m) => m.supplierInvoiceId).length, 1); eq(msgs.map((m) => m.state).sort(), ['DUPLICATE', 'DUPLICATE', 'TO_REVIEW'], 'same transport id = the same message (no new row); another transport id = a DUPLICATE row');
    const kept = (await w.st.listArtifacts({ merchantId: w.mid, kind: 'INBOUND_ORIGINAL' })).map((x) => x.fileName).sort(); assert.ok(kept.includes('conflicting-duplicate.xml'), 'the conflicting bytes are kept as evidence');
    return { flags: out, states: msgs.map((m) => m.state).sort(), suppliers: list.length };
  },

  // ---------------------------------------------------------------- 12 + 13. overdue customer and supplier (civil dates, derived)
  async 'S12 S13 overdue customer and supplier: excluded from / assumed in the projection, visible in export, cleared by payment'(w) {
    const od = await w.invoice1000({ issueDate: '2026-08-01' }); const fine = await w.invoice1000({ issueDate: '2026-09-25' }); const sod = await w.supplier(12100, { dueDate: '2026-09-01' }); const sfine = await w.supplier(5000, { dueDate: '2026-10-20' });
    let m = await w.treasury().model(); const a = m.items.find((i) => i.sourceId === od.id); const b = m.items.find((i) => i.sourceId === sod.id);
    eq([a.overdue, a.overdueDays, a.included, a.treatment], [true, 33, false, 'OVERDUE_RECEIVABLE_NOT_IN_PROJECTION']); eq([b.overdue, b.overdueDays, b.included, b.certainty], [true, 32, true, 'COMMITTED']);
    eq(m.forecast.EUR.horizons[30].excluded.overdueReceivablesCents, 100000); eq(m.forecast.EUR.horizons[30].overduePayablesCents, 12100);
    const row = salesRow(await w.pkg(), od.number); eq([row.due_date, row.remaining], ['2026-08-31', '1000.00']);
    const p = await w.receive(100000, [[od.id, 100000]]); void p; await w.paySupplier(12100, [[sod.id, 12100]]); m = await w.treasury().model();
    eq(m.items.some((i) => i.sourceId === od.id || i.sourceId === sod.id), false, 'paid items leave the forecast'); eq(m.forecast.EUR.horizons[30].excluded.overdueReceivablesCents, 0);
    void fine; void sfine; return { overdue: [a.overdueDays, b.overdueDays] };
  },

  // ---------------------------------------------------------------- 14. cash
  async 'S14 cash: count + later movements, a same-day movement is not counted twice, a deposit moves cash to the bank without double counting'(w) {
    await w.st.insertCashCount({ merchantId: w.mid, amountCents: 50000, countedOn: '2026-10-01', note: null, createdAt: w.at });
    for (const [kind, amountCents, date] of [['CASH_IN', 99900, '2026-10-01'], ['CASH_IN', 10000, '2026-10-02'], ['CASH_OUT', 2500, '2026-10-02'], ['DEPOSIT_TO_BANK', 20000, '2026-10-03']]) await w.st.insertCashMovement({ merchantId: w.mid, kind, amountCents, date, note: null, createdAt: w.at });
    let p = (await w.treasury().model()).position.EUR; eq([p.observed.totalCents, p.calculated.totalCents], [50000, 37500], 'count + later movements only');
    await w.st.upsertBankBalance({ merchantId: w.mid, accountId: 'acc-1', iban: 'BE68539007547034', balanceCents: 100000, currency: 'EUR', asOf: '2026-10-02T08:00:00.000Z' });
    await w.st.insertBankTransactionsBatch([{ merchantId: w.mid, accountId: 'acc-1', providerTxId: 's14-dep', date: '2026-10-03', amountCents: 20000, currency: 'EUR', source: 'bank', status: 'NEW' }]);
    p = (await w.treasury().model()).position.EUR; eq(p.calculated.totalCents, 100000 + 20000 + 37500, 'bank (incl. the later deposit line) + cash after the deposit left it');
    eq(p.components.map((c) => c.kind).sort(), ['BANK_BALANCE', 'BANK_LATER_TRANSACTIONS', 'CASH_COUNT', 'CASH_LATER_MOVEMENTS'].sort());
    return { calculated: p.calculated.totalCents };
  },

  // ---------------------------------------------------------------- 15. bank position: observed != calculated, provenance, same-day boundary
  async 'S15 bank position: observed stays observed, calculated adds only LATER transactions, provenance and the same-day boundary hold'(w) {
    await w.st.upsertBankBalance({ merchantId: w.mid, accountId: 'acc-1', iban: 'BE68539007547034', balanceCents: 1000000, currency: 'EUR', asOf: '2026-10-02T08:00:00.000Z' });
    await w.st.insertBankTransactionsBatch([{ merchantId: w.mid, accountId: 'acc-1', providerTxId: 'b-same', date: '2026-10-02', amountCents: -50000, currency: 'EUR', source: 'bank', status: 'NEW' }, { merchantId: w.mid, accountId: 'acc-1', providerTxId: 'b-later', date: '2026-10-03', amountCents: 20000, currency: 'EUR', source: 'bank', status: 'NEW' }]);
    const p = (await w.treasury().model()).position.EUR; eq([p.observed.totalCents, p.calculated.totalCents, p.calculated.laterCents], [1000000, 1020000, 20000]); eq(p.calculated.basis, 'OBSERVED_PLUS_LATER_TRANSACTIONS');
    const c = p.components.find((x) => x.kind === 'BANK_BALANCE'); eq([c.basis, c.observedAt, c.sourceType], ['OBSERVED', '2026-10-02T08:00:00.000Z', 'BANK']); assert.ok(p.warnings.some((x) => /SAME_DAY|SAME/.test(x.code)), 'the same-day transaction is flagged, not added');
    return { observed: p.observed.totalCents, calculated: p.calculated.totalCents };
  },

  // ---------------------------------------------------------------- 17. multi currency
  async 'S17 multi-currency: never silently summed, Treasury warns, export separates, allocation cannot cross currencies'(w) {
    const eurInv = await w.invoice1000(); const usdInv = await w.invoice1000({ currency: 'USD' });
    const cross = await code(() => w.P.receive({ amountCents: 1000, currency: 'USD', paidOn: '2026-09-20', idempotencyKey: 'acc-cross-ccy', allocations: [{ documentId: eurInv.id, amountCents: 1000 }] }, MERCHANT_ACTOR)); assert.notEqual(cross, 'OK');
    const crossB = await code(() => w.P.receive({ amountCents: 1000, currency: 'EUR', paidOn: '2026-09-20', idempotencyKey: 'acc-cross-ccy2', allocations: [{ documentId: usdInv.id, amountCents: 1000 }] }, MERCHANT_ACTOR)); assert.notEqual(crossB, 'OK');
    await w.P.receive({ amountCents: 40000, currency: 'USD', paidOn: '2026-09-20', idempotencyKey: 'acc-usd-ok-1', allocations: [{ documentId: usdInv.id, amountCents: 40000 }] }, MERCHANT_ACTOR);
    const m = await w.treasury().model(); eq(m.currencies, ['EUR', 'USD']); eq(m.consolidation.available, false); assert.ok(m.warnings.some((x) => x.code === 'CURRENCIES_NOT_CONSOLIDATED'));
    eq([m.items.find((i) => i.sourceId === eurInv.id).amountCents, m.items.find((i) => i.sourceId === usdInv.id).amountCents], [100000, 60000]);
    const pkg = await w.pkg(); assert.ok(pkg.warnings.some((x) => x.code === 'MIXED_CURRENCIES')); const rows = csv(pkg, 'sales.csv'); eq(rows.map((r) => [r.currency, r.remaining]).sort(), [['EUR', '1000.00'], ['USD', '600.00']]);
    return { cross, crossB };
  },

  // ---------------------------------------------------------------- 18-20 routes
  async 'S18 S19 S20 routing: Belgian B2C, international (voluntary Peppol), B2G (own route, never silently structured-by-default)'(w) {
    const out = {};
    const c = await w.issue({ customer: INDIVIDUAL }); const cc = await w.legal.compliance(c.id); out.b2c = [cc.routing.route, !!cc.pdf, cc.structured === null]; eq(out.b2c, ['NON_STRUCTURED_ALLOWED', true, true]); assert.ok(cc.paymentReference);
    const fr = await w.issue({ customer: FR_BUYER }); const frc = await w.legal.compliance(fr.id); out.foreign = frc.routing.route; eq(out.foreign, 'NON_STRUCTURED_ALLOWED');
    const frP = await w.issue({ customer: { ...FR_BUYER, peppolId: { scheme: '0009', id: '12345678901234' } } }); const frPc = await w.legal.compliance(frP.id); out.foreignPeppol = frPc.routing.route; eq(out.foreignPeppol, 'PEPPOL_PREFERRED');
    const g = await w.issue({ customer: AUTHORITY }); const gc = await w.legal.compliance(g.id); out.b2g = gc.routing.route; eq(out.b2g, 'B2G_STRUCTURED'); assert.ok(gc.routing.notes.includes('B2G_THRESHOLDS_AND_EXCEPTIONS_NOT_EVALUATED'), 'what is not evaluated is said');
    out.b2gStructured = gc.structured ? gc.structured.provenance.validation.ok : (gc.validation?.ok ?? false); out.pdfs = [!!frc.pdf, !!gc.pdf];
    return out;
  },

  // ---------------------------------------------------------------- 26. crash at the inbound boundary: after the message row + archive + candidate, before the TO_REVIEW transition
  async 'S26 inbound crash boundary: a document registered but never finished is completed when the provider resends it (no loss, still ONE supplier invoice)'(w) {
    const { xml } = await supplierInvoiceXml({}); const real = w.st.transitionPeppol; let crashed = false;
    w.st.transitionPeppol = async (a) => { if (!crashed && a.to === 'TO_REVIEW') { crashed = true; throw Object.assign(new Error('process killed'), { code: 'SIMULATED_CRASH' }); } return real.call(w.st, a); };
    const first = await code(() => w.peppol.handleWebhook({ headers: sigOk, body: xml, providerMessageId: 'pm-crash' })); eq(first, 'SIMULATED_CRASH'); w.st.transitionPeppol = real;
    let m = (await w.st.listPeppolMessages({ merchantId: w.mid, direction: 'IN' }))[0]; eq(m.state, 'RECEIVED', 'the crash left the message unfinished');
    const resend = await w.peppol.handleWebhook({ headers: sigOk, body: xml, providerMessageId: 'pm-crash' }); m = (await w.st.listPeppolMessages({ merchantId: w.mid, direction: 'IN' }))[0];
    const list = await w.st.listSupplierInvoices(w.mid); eq(list.length, 1, 'exactly one supplier invoice'); eq(m.state, 'TO_REVIEW', 'the resend completed the unfinished message'); eq(m.supplierInvoiceId, list[0].id);
    await w.peppol.accept(m.id, MERCHANT_ACTOR); eq((await w.st.listPeppolMessages({ merchantId: w.mid, direction: 'IN' })).length, 1); void resend; return { first, state: m.state, suppliers: list.length };
  },

  // ---------------------------------------------------------------- 22. Peppol failure paths
  async 'S22 Peppol failure paths: unavailable, timeout before / after acceptance, retry, restart, no duplicate send, no false DELIVERED'(w) {
    const out = {}; const mk = async () => { const inv = await w.invoice1000(); const doc = await w.st.getDocument(inv.id); const q = await w.peppol.queue(doc, { actor: MERCHANT_ACTOR }); return { doc, id: q.message.id }; };
    // provider unavailable -> SUBMISSION_FAILED, explicit retry -> SUBMITTED, one acceptance at the provider
    let m = await mk(); w.provider.inject('submit', 'unavailable'); let d = await w.peppol.dispatch(m.id); out.unavailable = d.state; eq(d.state, 'SUBMISSION_FAILED'); eq(w.provider.accepted.size, 0);
    d = await w.peppol.retry(m.id); out.retry = d.state; eq(d.state, 'SUBMITTED'); eq(w.provider.accepted.size, 1);
    // timeout BEFORE the provider accepted: unknown outcome, a restarted worker re-queues after the lease and sends once
    m = await mk(); w.provider.inject('submit', 'timeout_before_accept'); d = await w.peppol.dispatch(m.id); eq([d.state, d.unknown], ['SUBMITTING', true]); eq(w.provider.accepted.size, 1);
    const restarted = createPeppolService({ store: w.st, merchantId: w.mid, provider: w.provider, legal: w.legal, storage: w.storage, inbox: w.inbox, clock: w.clock, ownEndpoints: [], leaseMs: 0 });
    const pass = await restarted.dispatchQueued(); out.restartPass = [pass.recovered, pass.dispatched]; eq((await w.st.getPeppolMessage(w.mid, m.id)).state, 'SUBMITTED'); eq(w.provider.accepted.size, 2);
    // timeout AFTER the provider accepted: never re-sent; recovery finds it by idempotency key
    m = await mk(); const before = w.provider.calls.submit; w.provider.inject('submit', 'timeout_after_accept'); d = await w.peppol.dispatch(m.id); eq(d.unknown, true); const rec = await restarted.recover(m.id); eq([rec.state, rec.recovered], ['SUBMITTED', true]); eq(w.provider.calls.submit, before + 1, 'exactly one submit for this document'); eq(w.provider.accepted.size, 3);
    out.afterAccept = rec.state;
    const msgs = await w.st.listPeppolMessages({ merchantId: w.mid, direction: 'OUT' }); assert.ok(msgs.every((x) => x.state !== 'DELIVERED' && x.deliveredAt === null), 'nothing is DELIVERED without a provider delivery status'); out.states = msgs.map((x) => x.state).sort();
    // validation failure: nothing queued, nothing sent
    const bad = await w.spawn({ validate: () => ({ ok: false, documentSha256: 'a'.repeat(64), ruleset: { bis: 'Peppol BIS Billing 3.0', version: '3.0.21', release: 'r', customizationId: 'c', profileId: 'p' }, layers: [], findings: [{ layer: 'EN16931', ruleId: 'BR-FAKE', severity: 'fatal', message: 'injected', location: null }], at: w.at }) });
    const bi = await bad.invoice1000(); const bdoc = await bad.st.getDocument(bi.id); out.validation = await code(() => bad.peppol.queue(bdoc, { actor: MERCHANT_ACTOR })); eq(out.validation, 'PEPPOL_NOT_READY');
    eq(bad.provider.calls.submit, 0); eq((await bad.st.listPeppolMessages({ merchantId: bad.mid, direction: 'OUT' })).map((x) => x.state), ['VALIDATION_FAILED']); eq((await bad.legal.compliance(bdoc.id)).structured, null);
    return out;
  },
};

export { BUYER_OF_SELLER, CUSTOMER, TWO_LINES, createMemoryAttachmentStore, safeFileName, zip, unzip };
