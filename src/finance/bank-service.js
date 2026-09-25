// Bank & Treasury service: read-only sync, suggestions, merchant-confirmed reconciliation, physical cash, treasury facts.
// It never moves money and never records a payment on its own: a suggestion becomes a payment only when the merchant confirms it.

import { FinanceError, settlement } from './document.js';
import { formatCents } from './money.js';
import { NoBankAdapter, assertReadOnlyAdapter, parseBankCsv } from './bank.js';
import { suggest } from './reconcile.js';
import { buildTreasury } from './treasury.js';
import { eurOfSupplier } from './currency.js';

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * @param {{store: object, merchantId: string, adapter?: object, vault?: object, finance: {listInvoices: Function, recordPayment: Function}, inbox: {list: Function, pay: Function},
 *          clock?: {now: Function, today: Function}, audit?: Function}} d
 */
export function createBankService({ store, merchantId, adapter = NoBankAdapter, vault, finance, inbox, clock = { now: () => new Date().toISOString(), today: () => new Date().toISOString().slice(0, 10) }, audit = async () => {} }) {
  if (adapter !== NoBankAdapter) assertReadOnlyAdapter(adapter);
  const merchantOnly = (actor) => { if (actor?.type !== 'merchant') throw new FinanceError('THIS_STEP_REQUIRES_A_MERCHANT_ACTOR'); };
  const openInvoices = async () => {
    const out = [];
    for (const { doc, payments, creditNotes } of await finance.listInvoices()) {
      if (doc.type !== 'invoice' || !['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(doc.status)) continue;
      const s = settlement(doc, payments, creditNotes); if (s.remainingCents > 0) out.push({ documentId: doc.id, number: doc.number, customer: doc.customer.name, remainingCents: s.remainingCents, dueDate: doc.dueDate, currency: doc.currency });
    }
    return out;
  };
  const payablesAll = async () => inbox.list({ statuses: ['VALIDATED', 'TO_PAY'] });
  const toPayable = (r, cur) => ({ itemId: r.id, invoiceNumber: r.invoiceNumber, supplierName: r.supplierName, grossCents: eurOfSupplier(r, cur), paymentReference: r.paymentReference, dueDate: r.dueDate, status: r.status });
  // EUR-only: a foreign-currency payable never enters matching or the projection (unless the merchant typed its EUR amount)
  const payables = async (cur = 'EUR') => (await payablesAll()).map((r) => toPayable(r, cur)).filter((p) => p.grossCents !== null);
  const store1 = async (accountId, list, source) => { let created = 0; for (const t of list) { const r = await store.insertBankTransaction({ merchantId, accountId, providerTxId: String(t.id), date: t.date, amountCents: t.amountCents, currency: t.currency ?? 'EUR', counterpartyName: t.counterpartyName ?? null, reference: t.reference ?? null, structuredReference: t.structuredReference ?? null, source, status: 'NEW', importedAt: clock.now() }); if (r.created) created += 1; } return created; };

  return {
    async status() {
      const c = vault ? await vault.view() : { connected: false, state: 'NOT_CONNECTED' };
      const tx = await store.listBankTransactions({ merchantId });
      return { ...c, adapter: { name: adapter.name, label: adapter.label, configured: adapter.configured, scopes: adapter.scopes }, readOnly: true, paymentInitiation: false,
        counts: { NEW: tx.filter((t) => t.status === 'NEW').length, MATCHED: tx.filter((t) => t.status === 'MATCHED').length, IGNORED: tx.filter((t) => t.status === 'IGNORED').length }, csvImportAvailable: true };
    },
    async beginConsent(redirectUri, actor) { merchantOnly(actor); if (!adapter.configured || !adapter.beginConsent) throw new FinanceError('BANK_NOT_CONFIGURED'); return adapter.beginConsent({ redirectUri }); },
    async completeConsent(payload, actor) {
      merchantOnly(actor); const r = await adapter.completeConsent(payload);
      await vault.save({ provider: adapter.name, token: r.token, expiresAt: r.expiresAt, accountIds: r.accountIds, scopes: adapter.scopes });
      await audit({ at: clock.now(), action: 'BANK_CONSENT_GRANTED', provider: adapter.name, scopes: adapter.scopes });
      return vault.view();
    },
    /** Read balances and transactions. Idempotent: a transaction already stored (same provider id) is never duplicated. */
    async sync({ from, to } = {}) {
      const end = to ?? clock.today(); const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
      const r = await vault.use(async (token) => {
        let created = 0; const balances = [];
        for (const a of await adapter.accounts(token)) {
          const b = await adapter.balances(token, a.id); balances.push({ accountId: a.id, balanceCents: b.balanceCents, asOf: b.asOf });
          await store.upsertBankBalance({ merchantId, accountId: a.id, iban: a.iban ?? null, balanceCents: b.balanceCents, currency: b.currency ?? 'EUR', asOf: b.asOf });
          created += await store1(a.id, await adapter.transactions(token, a.id, { from: start, to: end }), 'bank');
        }
        return { created, accounts: balances.length };
      });
      await audit({ at: clock.now(), action: 'BANK_SYNC', created: r.created });
      return r;
    },
    async importCsv(text) {
      const { rows, errors } = parseBankCsv(text);
      const created = await store1('csv-import', rows, 'csv');
      await audit({ at: clock.now(), action: 'BANK_CSV_IMPORTED', created, rejected: errors.length });
      return { created, duplicates: rows.length - created, rejected: errors };
    },
    async transactions(f = {}) { return (await store.listBankTransactions({ merchantId, ...f })).sort((a, b) => String(b.date).localeCompare(String(a.date))); },
    async suggestions() {
      const news = await store.listBankTransactions({ merchantId, status: 'NEW' });
      const sug = suggest(news, { openInvoices: await openInvoices(), payables: await payables() });
      const byId = new Map(news.map((t) => [t.id, t]));
      return sug.map((s) => ({ ...s, transaction: byId.get(s.transactionId) }));
    },
    /** The merchant confirms one suggestion (or picks another invoice): only now is a payment recorded. */
    async confirm(txId, { documentId, itemId, amountCents }, actor) {
      merchantOnly(actor);
      const tx = await store.getBankTransaction(txId); if (!tx || tx.merchantId !== merchantId) throw new FinanceError('BANK_TRANSACTION_NOT_FOUND', txId);
      if (tx.status !== 'NEW') throw new FinanceError('BANK_TRANSACTION_ALREADY_HANDLED', tx.status);
      if (tx.amountCents >= 0) {
        const inv = (await openInvoices()).find((i) => i.documentId === documentId); if (!inv) throw new FinanceError('INVOICE_NOT_OPEN_FOR_PAYMENT');
        const cents = amountCents ?? Math.min(tx.amountCents, inv.remainingCents);
        if (!Number.isInteger(cents) || cents <= 0 || cents > tx.amountCents) throw new FinanceError('PAYMENT_AMOUNT_INVALID');
        if (cents > inv.remainingCents) throw new FinanceError('PAYMENT_EXCEEDS_REMAINING', `${cents} > ${inv.remainingCents}`);
        // claim first (compare-and-set): a second confirmation of the same transaction can never record a second payment
        if (!(await store.updateBankTransaction(txId, { status: 'MATCHED', matchedKind: 'INVOICE', matchedDocumentId: documentId, matchedAt: clock.now(), matchedAmountCents: cents }, 'NEW'))) throw new FinanceError('BANK_TRANSACTION_ALREADY_HANDLED');
        const pay = await finance.recordPayment(documentId, { amount: formatCents(cents), paidOn: tx.date, method: 'bank_transfer', reference: `bank:${tx.providerTxId}`.slice(0, 100) }, actor);
        await store.updateBankTransaction(txId, { matchedPaymentId: pay?.id ?? null }, 'MATCHED');
        await audit({ at: clock.now(), action: 'BANK_PAYMENT_RECONCILED', transactionId: txId, documentId, amountCents: cents });
        return { status: 'MATCHED', documentId, amountCents: cents, surplusCents: tx.amountCents - cents };
      }
      const abs = Math.abs(tx.amountCents); const item = (await payables()).find((p) => p.itemId === itemId); if (!item) throw new FinanceError('SUPPLIER_INVOICE_NOT_PAYABLE');
      if (abs !== item.grossCents) throw new FinanceError('PARTIAL_SUPPLIER_PAYMENTS_NOT_SUPPORTED_YET');
      if (!(await store.updateBankTransaction(txId, { status: 'MATCHED', matchedKind: 'SUPPLIER_INVOICE', matchedDocumentId: itemId, matchedAt: clock.now(), matchedAmountCents: abs }, 'NEW'))) throw new FinanceError('BANK_TRANSACTION_ALREADY_HANDLED');
      if (item.status === 'VALIDATED') await inbox.markToPay(item.itemId, actor);
      await inbox.pay(item.itemId, { paidOn: tx.date, amountCents: abs, reference: `bank:${tx.providerTxId}` }, actor);
      await audit({ at: clock.now(), action: 'BANK_SUPPLIER_PAYMENT_RECONCILED', transactionId: txId, itemId });
      return { status: 'MATCHED', itemId, amountCents: abs };
    },
    async ignore(txId, actor) { merchantOnly(actor); const r = await store.updateBankTransaction(txId, { status: 'IGNORED', matchedAt: clock.now() }, 'NEW'); if (!r) throw new FinanceError('BANK_TRANSACTION_ALREADY_HANDLED'); return r; },
    async disconnect(actor) { merchantOnly(actor); const r = await vault.revoke(adapter); await audit({ at: clock.now(), action: 'BANK_DISCONNECTED', remote: r.remote ?? null }); return r; },

    // ---- physical cash: only what a person confirmed ----
    async confirmCashCount({ amountCents, countedOn, note }, actor) {
      merchantOnly(actor); if (!Number.isInteger(amountCents) || amountCents < 0) throw new FinanceError('CASH_AMOUNT_INVALID'); if (!isDate(countedOn)) throw new FinanceError('CASH_DATE_INVALID');
      const row = await store.insertCashCount({ merchantId, amountCents, countedOn, note: note ? String(note).slice(0, 200) : null, createdAt: clock.now() }); await audit({ at: clock.now(), action: 'CASH_COUNT_CONFIRMED', countedOn }); return row;
    },
    async addCashMovement({ kind, amountCents, date, note }, actor) {
      merchantOnly(actor); if (!['CASH_IN', 'CASH_OUT', 'DEPOSIT_TO_BANK'].includes(kind)) throw new FinanceError('CASH_KIND_INVALID'); if (!Number.isInteger(amountCents) || amountCents <= 0) throw new FinanceError('CASH_AMOUNT_INVALID'); if (!isDate(date)) throw new FinanceError('CASH_DATE_INVALID');
      return store.insertCashMovement({ merchantId, kind, amountCents, date, note: note ? String(note).slice(0, 200) : null, createdAt: clock.now() });
    },
    async treasury({ horizonDays = 7, currency = 'EUR' } = {}) {
      const today = clock.today(); const balancesAll = await store.listBankBalances(merchantId);
      const balances = balancesAll.filter((b) => (b.currency ?? currency) === currency); // an account in another currency is never added to the EUR position
      const recvAll = await openInvoices(); const recvNative = recvAll.filter((i) => (i.currency ?? currency) === currency);
      const recv = recvNative.map((i) => ({ number: i.number, dueDate: i.dueDate, remainingCents: i.remainingCents }));
      const allP = await payablesAll(); const payNative = allP.map((r) => toPayable(r, currency)).filter((p) => p.grossCents !== null);
      const pay = payNative.map((p) => ({ invoiceNumber: p.invoiceNumber, supplierName: p.supplierName, dueDate: p.dueDate, grossCents: p.grossCents }));
      const t = buildTreasury({ asOf: today, horizonDays, currency, bank: balances.length ? balances : null, cashCount: await store.latestCashCount(merchantId), cashMovements: await store.listCashMovements(merchantId), receivables: recv, payables: pay });
      return { ...t, excluded: { foreignReceivables: recvAll.length - recvNative.length, foreignPayables: allP.length - payNative.length, foreignBankAccounts: balancesAll.length - balances.length } };
    },
  };
}
