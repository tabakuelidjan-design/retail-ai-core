// Final acceptance world: ONE builder that runs on the memory store or on the production store code over PostgreSQL 17.
// Everything is synthetic. The helpers here never compute money for the code under test; `independent()` re-derives every figure from the raw rows.
import { createHash } from 'node:crypto';
import { createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { createFakePeppolProvider } from '../src/finance/peppol-provider.js';
import { createTreasuryService } from '../src/finance/treasury-service.js';
import { createAccountantExportService } from '../src/finance/accountant-export-service.js';
import { createMerchantClock } from '../src/finance/civil-date.js';
import { loadDocsForReports } from '../src/finance/reports.js';
import { renderDocumentPdf } from '../src/finance/pdf.js';
import { legalWorld, MERCHANT_ACTOR, CUSTOMER, LINES, VAT_OK } from './finance-legal-helpers.js';

export { MERCHANT_ACTOR, CUSTOMER, LINES, VAT_OK };
export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code ?? String(e.message).slice(0, 80); } };
export const eur = (c) => (c / 100).toFixed(2);
/** 1 000.00 EUR gross exactly: 826.45 + 21 % VAT (173.55) */
export const GROSS_1000 = [{ description: 'Prestation', quantity: '1', unitPrice: '826.45', vatRate: '21' }];
/** two lines of exactly 400.00 net (484.00 gross each, 968.00 total, no rounding) */
export const TWO_LINES = [{ description: 'Ligne A', quantity: '1', unitPrice: '400.00', vatRate: '21' }, { description: 'Ligne B', quantity: '1', unitPrice: '400.00', vatRate: '21' }];
export const LINE_B = [{ description: 'Ligne B', quantity: '1', unitPrice: '400.00', vatRate: '21' }];

export function accWorld({ store, merchantId, storage = createMemoryAttachmentStore(), provider = createFakePeppolProvider(), nowIso = '2026-10-03T10:00:00.000Z', timeZone = 'Europe/Brussels', config = {}, validate = undefined, startIso = null, otherMerchantId = 'merchant-test-2', storeFor = null, spawn = null } = {}) {
  const lw = legalWorld({ ...(store ? { store } : {}), ...(merchantId ? { merchantId } : {}), storage, provider, config, ...(validate ? { validate } : {}), ...(startIso ? { startIso } : {}) });
  const st = lw.store; const mid = lw.merchantId; let n = 0; const at = nowIso;
  const P = lw.svc.payments; const key = (p) => `acc-${p}-${(n += 1)}`;
  const w = { ...lw, st, mid, P, at, key, storage, provider };
  w.spawn = (o = {}) => (spawn ? spawn(o) : Promise.resolve(accWorld(o)));
  w.otherWorld = () => accWorld({ store: storeFor ? storeFor(otherMerchantId) : st, merchantId: otherMerchantId, otherMerchantId: mid, storeFor });
  w.invoice = (euros = 1000, over = {}) => lw.issue({ lines: [{ description: 'Prestation', quantity: '1', unitPrice: (euros / 1.21).toFixed(2), vatRate: '21' }], ...over });
  w.invoice1000 = (over = {}) => lw.issue({ lines: GROSS_1000, ...over });
  w.receive = (amountCents, allocations, o = {}) => P.receive({ amountCents, paidOn: o.paidOn ?? '2026-09-20', method: o.method ?? 'bank_transfer', reference: o.reference, idempotencyKey: o.key ?? key('rcv'), allocations: allocations.map(([documentId, a]) => ({ documentId, amountCents: a })) }, MERCHANT_ACTOR);
  w.paySupplier = (amountCents, allocations, o = {}) => P.pay({ amountCents, paidOn: o.paidOn ?? '2026-09-25', method: o.method ?? 'bank_transfer', idempotencyKey: o.key ?? key('pay'), allocations: allocations.map(([supplierInvoiceId, a]) => ({ supplierInvoiceId, amountCents: a })) }, MERCHANT_ACTOR);
  w.supplier = (grossCents, over = {}) => st.saveSupplierInvoice({ merchantId: mid, supplierName: 'Fournisseur Exemple', invoiceNumber: `S-${key('s')}`, issueDate: '2026-09-01', dueDate: '2026-09-30', netCents: Math.round(grossCents / 1.21), vatCents: grossCents - Math.round(grossCents / 1.21), grossCents, currency: 'EUR', status: 'TO_PAY', source: 'manual', ...over });
  w.bankTx = async (tag, amountCents, date = '2026-09-20', over = {}) => { await st.insertBankTransactionsBatch([{ merchantId: mid, accountId: 'acc-1', providerTxId: tag, date, amountCents, currency: 'EUR', source: 'bank', status: 'NEW', reference: tag, ...over }]); return w.tx(tag); };
  w.tx = async (tag) => (await st.listBankTransactions({ merchantId: mid })).find((t) => t.providerTxId === tag);
  w.reconcile = (tx, paymentId, amountCents, k = key('rec')) => st.reconcileBank({ merchantId: mid, key: k, transactionId: tx.id, items: [{ paymentId, amountCents }], actor: MERCHANT_ACTOR, at });
  w.treasury = (o = {}) => createTreasuryService({ store: st, merchantId: mid, clock: createMerchantClock({ now: () => o.now ?? at, timeZone }), currency: 'EUR', finance: { listInvoices: () => loadDocsForReports(st, mid) }, inbox: { list: () => st.listSupplierInvoices(mid) } });
  w.exporter = (o = {}) => createAccountantExportService({ store: st, merchantId: mid, clock: createMerchantClock({ now: () => o.now ?? at, timeZone }), merchant: { name: 'Exemple Atelier SRL' }, finance: { listInvoices: () => loadDocsForReports(st, mid) }, inbox: { list: () => st.listSupplierInvoices(mid) }, storage, renderPdf: renderDocumentPdf });
  w.pkg = (spec = { kind: 'custom', from: '2026-01-01', to: '2026-12-31' }, o = {}) => w.exporter(o).generate(spec, { includeDocuments: o.includeDocuments ?? false });
  w.view = async (id) => { const v = await lw.svc.view(id); const s = v.settlement; return { status: v.doc.status, gross: s.grossCents, credited: s.creditedCents, due: s.effectiveDueCents, paid: s.paidCents, remaining: s.remainingCents, refunded: s.refundedCents, retained: s.retainedCents }; };
  return w;
}

export function parseCsv(buf) {
  const text = Buffer.from(buf).toString('utf8').replace(/^﻿/, ''); const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c; }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows; return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
export const csv = (pkg, name) => parseCsv(pkg.files.get(name));

/**
 * INDEPENDENT recomputation (raw rows only; none of the settlement / treasury / export code is used):
 * customer: gross - credit notes - net allocations + refunds paid out on those credit notes = remaining ; supplier: gross - net allocations = remaining.
 */
export async function independent(w) {
  const docs = await w.st.listDocuments({ merchantId: w.mid }); const issued = docs.filter((d) => d.lockedAt && ['invoice', 'credit_note'].includes(d.type));
  const inv = new Map(); const out = { customers: {}, suppliers: {} };
  for (const d of issued.filter((x) => x.type === 'invoice')) inv.set(d.id, { number: d.number, currency: d.currency, gross: d.totals.grossCents + (d.totals.roundingCents ?? 0), credited: 0, paid: 0, refunded: 0 });
  for (const d of issued.filter((x) => x.type === 'credit_note')) { const i = inv.get(d.relatedDocumentId); if (i) i.credited += d.totals.grossCents + (d.totals.roundingCents ?? 0); i.refunded += (await w.st.listAllocations({ customerDocumentId: d.id })).reduce((x, a) => x + a.amountCents, 0); }
  for (const [id, i] of inv) { const al = await w.st.listAllocations({ customerDocumentId: id }); i.paid = al.reduce((s, a) => s + a.amountCents, 0); out.customers[id] = { ...i, remaining: i.gross - i.credited - i.paid + i.refunded }; }
  for (const s of await w.st.listSupplierInvoices(w.mid)) { const al = await w.st.listAllocations({ supplierInvoiceId: s.id }); const paid = al.reduce((x, a) => x + a.amountCents, 0); out.suppliers[s.id] = { number: s.invoiceNumber, currency: s.currency, gross: s.grossCents, paid, remaining: s.grossCents - paid }; }
  return out;
}
