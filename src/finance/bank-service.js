// Bank & Treasury service: read-only sync, accounts, suggestions (no authority), merchant-confirmed reconciliation, physical cash, treasury facts.
// It never moves money. TARGET MODEL:  Bank account -> Bank transaction -> Reconciliation -> Payment / Allocation.
//   - A bank transaction is an OBSERVED movement, not a payment. A reconciliation links it to the payment truth (fin_payment_registry + allocations): Payments stay the only authority.
//   - A suggestion has NO authority: reconcile.js only scores; a reconciliation exists only through an explicit command, and the suggestion is kept as evidence.
//   - Reconciling and creating the payment are ONE database transaction (fin_bank_reconcile_and_pay): a transaction is never left claimed by a failed payment.

import { randomUUID } from 'node:crypto';
import { FinanceError, settlement } from './document.js';
import { toCents } from './money.js';
import { NoBankAdapter, assertReadOnlyAdapter, maskIban, observedBalance, parseBankCsv } from './bank.js';
import { suggest } from './reconcile.js';
import { buildTreasury } from './treasury.js';
import { eurOfSupplier } from './currency.js';
import { dueForProjection } from './payables/index.js';
import { requireClock } from './civil-date.js';
import { isPaymentMethod } from './payment-methods.js';

const CSV_ACCOUNT = 'csv-import'; // every CSV statement lands in this pseudo-account (idempotence key: account + transaction id)
const KEY = /^[A-Za-z0-9_.:-]{8,200}$/;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const centsOf = (o, field = 'amount') => {
  if (o.amountCents !== undefined) { if (!Number.isInteger(o.amountCents) || o.amountCents <= 0) throw new FinanceError('PAYMENT_AMOUNT_INVALID', field); return o.amountCents; }
  const c = toCents(o.amount); if (c === null || !Number.isInteger(c) || c <= 0) throw new FinanceError('PAYMENT_AMOUNT_INVALID', field); return c;
};

/**
 * @param {{store: object, merchantId: string, adapter?: object, vault?: object, finance: {listInvoices: Function, settleInvoices?: Function}, inbox: {list: Function, markToPay: Function},
 *          clock: {now: Function, today: Function}, audit?: Function}} d
 */
export function createBankService({ store, merchantId, adapter = NoBankAdapter, vault, finance, inbox, clock, audit = async () => {} }) {
  requireClock(clock, 'createBankService');
  if (adapter !== NoBankAdapter) assertReadOnlyAdapter(adapter);
  const merchantOnly = (actor) => { if (actor?.type !== 'merchant') throw new FinanceError('THIS_STEP_REQUIRES_A_MERCHANT_ACTOR'); };
  const keyOf = (k, fallback) => { if (k != null && !KEY.test(k)) throw new FinanceError('IDEMPOTENCY_KEY_INVALID'); return k ?? fallback; };
  const openInvoices = async () => {
    const out = [];
    for (const { doc, payments, creditNotes, refunds } of await finance.listInvoices()) {
      if (doc.type !== 'invoice' || !['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(doc.status)) continue;
      const s = settlement(doc, payments, creditNotes, refunds); if (s.remainingCents > 0) out.push({ documentId: doc.id, number: doc.number, customer: doc.customer.name, remainingCents: s.remainingCents, dueDate: doc.dueDate, currency: doc.currency });
    }
    return out;
  };
  const payablesAll = async () => inbox.list({ statuses: ['VALIDATED', 'TO_PAY'] });
  const toPayable = (r, cur) => ({ itemId: r.id, invoiceNumber: r.invoiceNumber, supplierName: r.supplierName, grossCents: eurOfSupplier(r, cur), remainingCents: (r.grossCents ?? 0) - (r.allocatedCents ?? 0), paymentReference: r.paymentReference, dueDate: dueForProjection(r).dueDate, dueOrigin: dueForProjection(r).origin, status: r.status });
  // EUR-only: a foreign-currency payable never enters matching or the projection (unless the merchant typed its EUR amount)
  const payables = async (cur = 'EUR') => (await payablesAll()).map((r) => toPayable(r, cur)).filter((p) => p.grossCents !== null && p.remainingCents > 0);
  // All rows of a list are stored in ONE atomic batch: completely or not at all (never a partial import). The identity of a row (provider id / fingerprint+occurrence) makes a retry idempotent.
  const store1 = async (accountId, list, source) => {
    const rows = list.map((t) => ({ merchantId, accountId, providerTxId: String(t.id), date: t.date, valueDate: t.valueDate ?? null, amountCents: t.amountCents, currency: t.currency ?? 'EUR', counterpartyName: t.counterpartyName ?? null, counterpartyAccountMasked: t.counterpartyAccountMasked ?? null,
      reference: t.reference ?? null, structuredReference: t.structuredReference ?? null, bankReference: t.bankReference ?? null, fingerprint: t.fingerprint ?? null, source, status: 'NEW', importedAt: clock.now() }));
    return store.insertBankTransactionsBatch(rows);
  };
  const txView = (t) => ({ ...t, direction: t.amountCents >= 0 ? 'IN' : 'OUT' });
  /** The evidence kept with a reconciliation that confirmed a suggestion: rebuilt by the SERVER from the scoring (a client never supplies it). */
  const evidenceFor = async (txId) => { const s = (await api.suggestions()).find((x) => x.transactionId === txId); return s ? { status: s.status, confidence: s.confidence, reasons: s.explanation, candidates: (s.candidates ?? []).slice(0, 3), at: clock.now() } : null; };
  const settle = async (ids, actor) => { if (ids.length && finance.settleInvoices) await finance.settleInvoices(ids, actor); };

  const api = {
    async status() {
      // Independent reads: fetched in parallel (each is a database round trip).
      const [c, tx] = await Promise.all([vault ? vault.view() : { connected: false, state: 'NOT_CONNECTED' }, store.listBankTransactions({ merchantId })]);
      const by = (st) => tx.filter((t) => t.reconciliationStatus === st).length;
      return { ...c, adapter: { name: adapter.name, label: adapter.label, configured: adapter.configured, scopes: adapter.scopes }, readOnly: true, paymentInitiation: false,
        // legacy counts (NEW / MATCHED / IGNORED) are derived from the reconciliations; the detailed ones say what is partial
        counts: { NEW: tx.filter((t) => t.status === 'NEW').length, MATCHED: tx.filter((t) => t.status === 'MATCHED').length, IGNORED: tx.filter((t) => t.status === 'IGNORED').length },
        reconciliation: { UNRECONCILED: by('UNRECONCILED'), PARTIALLY_RECONCILED: by('PARTIALLY_RECONCILED'), RECONCILED: by('RECONCILED'), IGNORED: by('IGNORED') }, csvImportAvailable: true };
    },
    async beginConsent(redirectUri, actor) { merchantOnly(actor); if (!adapter.configured || !adapter.beginConsent) throw new FinanceError('BANK_NOT_CONFIGURED'); return adapter.beginConsent({ redirectUri }); },
    async completeConsent(payload, actor) {
      merchantOnly(actor); if (!adapter.configured || !adapter.completeConsent) throw new FinanceError('BANK_NOT_CONFIGURED');
      const r = await adapter.completeConsent(payload);
      await vault.save({ provider: adapter.name, token: r.token, expiresAt: r.expiresAt, accountIds: r.accountIds, scopes: adapter.scopes });
      await audit({ at: clock.now(), action: 'BANK_CONSENT_GRANTED', provider: adapter.name, scopes: adapter.scopes });
      return vault.view();
    },
    /** Read accounts, balances and transactions. Idempotent: a transaction already stored (same provider id) is never duplicated; a balance is stored WITH the time the bank observed it. */
    async sync({ from, to } = {}) {
      const end = to ?? clock.today(); const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
      const r = await vault.use(async (token) => {
        let created = 0; const balances = [];
        for (const a of await adapter.accounts(token)) {
          const b = await adapter.balances(token, a.id); const currency = b.currency ?? a.currency ?? 'EUR';
          await store.ensureBankAccount({ externalId: a.id, origin: 'PROVIDER', provider: adapter.name, displayName: a.name ?? null, ibanMasked: maskIban(a.iban), currency, at: clock.now() }); // the full IBAN is never stored
          balances.push({ accountId: a.id, balanceCents: b.balanceCents, asOf: b.asOf });
          await store.upsertBankBalance({ merchantId, accountId: a.id, iban: maskIban(a.iban), balanceCents: b.balanceCents, currency, asOf: b.asOf, source: 'provider' });
          created += (await store1(a.id, await adapter.transactions(token, a.id, { from: start, to: end }), 'bank')).created;
        }
        return { created, accounts: balances.length };
      });
      await audit({ at: clock.now(), action: 'BANK_SYNC', created: r.created });
      return r;
    },
    /**
     * CSV preview: parses and compares with what is already stored - WRITES NOTHING. The merchant sees the lines, the period, the recognised columns, the invalid lines and the
     * duplicates before deciding to import. Two lines that look the same inside one file are two transactions (identicalInFile): they are never merged.
     */
    async previewCsv(text) {
      const p = parseBankCsv(text);
      const existing = new Set((await store.listBankTransactions({ merchantId })).filter((t) => t.accountId === CSV_ACCOUNT).map((t) => String(t.providerTxId)));
      let already = 0; let importable = 0; let identical = 0;
      for (const r of p.rows) { if (/#\d+$/.test(r.id)) identical += 1; if (existing.has(String(r.id))) already += 1; else importable += 1; }
      return { dataLines: p.dataLines, validRows: p.rows.length, invalid: p.errors, period: p.period, columns: p.columns, delimiter: p.delimiter,
        duplicates: { alreadyImported: already, inFile: 0 }, identicalInFile: identical, importable, canImportValidRows: p.errors.length > 0 && p.rows.length > 0,
        sample: p.rows.slice(0, 5).map((r) => ({ line: r.line, date: r.date, amountCents: r.amountCents, currency: r.currency, counterpartyName: r.counterpartyName, reference: r.reference })) };
    },
    /**
     * Default: all-or-nothing (a file with ANY invalid line imports nothing). With { allowPartial: true } the VALID lines are imported and every invalid line is returned with its
     * number and reason (nothing is dropped silently). Idempotent either way: known transactions are skipped.
     */
    async importCsv(text, { allowPartial = false } = {}) {
      const { rows, errors } = parseBankCsv(text);
      if (errors.length && !(allowPartial && rows.length)) throw new FinanceError('BANK_CSV_ROWS_INVALID', errors.map((e) => `${e.line}:${e.reason}`).join(',').slice(0, 500));
      let r;
      try { r = await store1(CSV_ACCOUNT, rows, 'csv'); } catch (e) {
        // The batch is atomic: nothing of this statement was stored. Say so, keep the technical detail out of the answer, and let the merchant retry.
        try { await audit({ at: clock.now(), action: 'BANK_CSV_IMPORT_FAILED', rows: rows.length }); } catch { /* auditing must not hide the failure */ }
        throw new FinanceError('BANK_IMPORT_FAILED_NOTHING_SAVED');
      }
      await audit({ at: clock.now(), action: 'BANK_CSV_IMPORTED', created: r.created, duplicates: r.duplicates, rejected: errors.length });
      return { created: r.created, duplicates: r.duplicates, rejected: errors };
    },
    async transactions(f = {}) { return (await store.listBankTransactions({ merchantId, ...f })).map(txView).sort((a, b) => String(b.date).localeCompare(String(a.date))); },
    /** Accounts with their OBSERVED balance and how old it is (never "the current balance"). */
    async accounts() {
      const [accounts, balances] = await Promise.all([store.listBankAccounts(merchantId), store.listBankBalances(merchantId)]); const now = clock.now();
      const tx = await store.listBankTransactions({ merchantId });
      return accounts.map((a) => { const b = balances.find((x) => x.accountId === a.externalId && x.currency === a.currency);
        const mine = tx.filter((t) => t.bankAccountId === a.id); return { id: a.id, externalId: a.externalId, origin: a.origin, provider: a.provider, displayName: a.displayName, ibanMasked: a.ibanMasked, currency: a.currency, status: a.status,
          balance: b ? observedBalance(b, now) : null, transactions: mine.length, toReconcile: mine.filter((t) => t.remainingCents > 0).length }; });
    },
    /** Suggestions: explainable, scored on what is STILL unreconciled of each transaction. They carry NO authority (authority: 'NONE'): nothing changes until a person confirms. */
    async suggestions() {
      const open = (await store.listBankTransactions({ merchantId })).filter((t) => t.remainingCents > 0 && t.status === 'NEW');
      const scored = open.map((t) => ({ ...t, amountCents: Math.sign(t.amountCents) * t.remainingCents })); // the part not yet reconciled is what a match must explain
      const sug = suggest(scored, { openInvoices: await openInvoices(), payables: await payables() });
      const byId = new Map(open.map((t) => [t.id, t]));
      return sug.map((s) => ({ ...s, authority: 'NONE', explanation: s.candidates?.[0]?.reasons ?? [], transaction: byId.get(s.transactionId) }));
    },
    /**
     * Reconcile a bank transaction with the payment truth, explicitly. Two shapes:
     *  - { payments: [{ paymentId, amount|amountCents }] }          link payments that already exist (recorded by hand earlier);
     *  - { create: { amount|amountCents, method?, reference?, allocations: [{ documentId | supplierInvoiceId, amount|amountCents }] } }   create the payment AND link it, atomically.
     * A transaction can be reconciled in several steps (partial), with several payments (1->N) and a payment can be funded by several transactions (N->1). idempotencyKey: one per action.
     */
    async reconcile(txId, input, actor) {
      merchantOnly(actor);
      const tx = await store.getBankTransaction(txId); if (!tx || tx.merchantId !== merchantId) throw new FinanceError('BANK_TX_NOT_FOUND', String(txId));
      const suggestion = input.fromSuggestion ? await evidenceFor(txId) : (input.suggestion ?? null); const inbound = tx.amountCents > 0;
      if (input.create?.method != null && !isPaymentMethod(input.create.method)) throw new FinanceError('PAYMENT_METHOD_INVALID', String(input.create.method));
      if (input.payments?.length) {
        const items = input.payments.map((p) => ({ paymentId: p.paymentId, amountCents: centsOf(p) })); const total = items.reduce((s, i) => s + i.amountCents, 0);
        // no pre-check against the remaining amount here: an identical retry (same key) must come back as the same effect, and the store/database enforce the bound atomically
        const r = await store.reconcileBank({ merchantId, key: keyOf(input.idempotencyKey, randomUUID()), transactionId: txId, items, suggestion, actor, at: clock.now() });
        await audit({ at: clock.now(), action: 'BANK_RECONCILED', transactionId: txId, payments: items.length, amountCents: total });
        return { duplicate: r.duplicate, transaction: await this.transaction(txId), reconciliations: r.reconciliations };
      }
      if (!input.create) throw new FinanceError('BANK_RECONCILE_NOTHING_TO_DO');
      const cents = centsOf(input.create); const allocations = []; let allocated = 0;
      for (const a of input.create.allocations ?? []) {
        const c = centsOf(a, 'allocation'); allocated += c;
        if (inbound) { if (!a.documentId) throw new FinanceError('BANK_DIRECTION_MISMATCH', 'an incoming transaction settles customer invoices'); allocations.push({ customerDocumentId: a.documentId, amountCents: c }); }
        else { if (!a.supplierInvoiceId) throw new FinanceError('BANK_DIRECTION_MISMATCH', 'an outgoing transaction settles supplier invoices'); allocations.push({ supplierInvoiceId: a.supplierInvoiceId, amountCents: c }); }
      }
      if (allocated > cents) throw new FinanceError('PAYMENT_OVER_ALLOCATED', `allocations ${allocated} > payment ${cents} (cents)`);
      const key = keyOf(input.idempotencyKey, randomUUID());
      const r = await store.reconcileAndPay({ merchantId, key, transactionId: txId, suggestion, actor, at: clock.now(),
        payment: { amountCents: cents, method: input.create.method ?? 'bank_transfer', reference: input.create.reference ?? `bank:${tx.providerTxId}`.slice(0, 100), allocations, meta: { externalReference: input.create.externalReference ?? null } } });
      await settle([...new Set(allocations.map((a) => a.customerDocumentId).filter(Boolean))], actor);
      await audit({ at: clock.now(), action: 'BANK_RECONCILED', transactionId: txId, paymentId: r.payment.id, amountCents: cents, createdPayment: true });
      return { duplicate: r.duplicate, transaction: await this.transaction(txId), reconciliations: [r.reconciliation], payment: r.payment, allocations: r.allocations };
    },
    /** The merchant confirms one suggestion (or picks another document). Same behaviour as before for the callers, now atomic: payment + reconciliation in one transaction. */
    async confirm(txId, { documentId, itemId, amountCents, idempotencyKey, suggestion }, actor) {
      merchantOnly(actor);
      const tx = await store.getBankTransaction(txId); if (!tx || tx.merchantId !== merchantId) throw new FinanceError('BANK_TRANSACTION_NOT_FOUND', txId);
      if (tx.status !== 'NEW' || tx.remainingCents <= 0) throw new FinanceError('BANK_TRANSACTION_ALREADY_HANDLED', tx.status);
      if (tx.amountCents > 0) {
        const inv = (await openInvoices()).find((i) => i.documentId === documentId); if (!inv) throw new FinanceError('INVOICE_NOT_OPEN_FOR_PAYMENT');
        const cents = amountCents ?? Math.min(tx.remainingCents, inv.remainingCents);
        if (!Number.isInteger(cents) || cents <= 0 || cents > tx.remainingCents) throw new FinanceError('PAYMENT_AMOUNT_INVALID');
        if (cents > inv.remainingCents) throw new FinanceError('PAYMENT_EXCEEDS_REMAINING', `${cents} > ${inv.remainingCents}`);
        const r = await this.reconcile(txId, { create: { amountCents: cents, method: 'bank_transfer', reference: `bank:${tx.providerTxId}`.slice(0, 100), allocations: [{ documentId, amountCents: cents }] }, ...(suggestion === true ? { fromSuggestion: true } : { suggestion }), idempotencyKey: idempotencyKey ?? `bank:${txId}:${documentId}:${cents}` }, actor);
        return { status: 'MATCHED', documentId, amountCents: cents, surplusCents: tx.remainingCents - cents, paymentId: r.payment?.id ?? null, transaction: r.transaction };
      }
      const item = (await payables()).find((p) => p.itemId === itemId); if (!item) throw new FinanceError('SUPPLIER_INVOICE_NOT_PAYABLE');
      const cents = amountCents ?? Math.min(tx.remainingCents, item.remainingCents);
      if (!Number.isInteger(cents) || cents <= 0 || cents > tx.remainingCents) throw new FinanceError('PAYMENT_AMOUNT_INVALID');
      if (cents > item.remainingCents) throw new FinanceError('PAYMENT_EXCEEDS_REMAINING', `${cents} > ${item.remainingCents}`);
      if (item.status === 'VALIDATED') await inbox.markToPay(item.itemId, actor);
      const r = await this.reconcile(txId, { create: { amountCents: cents, method: 'bank_transfer', reference: `bank:${tx.providerTxId}`.slice(0, 100), allocations: [{ supplierInvoiceId: itemId, amountCents: cents }] }, ...(suggestion === true ? { fromSuggestion: true } : { suggestion }), idempotencyKey: idempotencyKey ?? `bank:${txId}:${itemId}:${cents}` }, actor);
      return { status: 'MATCHED', itemId, amountCents: cents, paymentId: r.payment?.id ?? null, transaction: r.transaction };
    },
    /** Take reconciliations back (all of a transaction, or the given rows). Nothing is deleted: negative rows are appended. The PAYMENT stays (void it separately if it was wrong). */
    async unreconcile(txId, { reconciliationIds, amountCents = null, reason, idempotencyKey } = {}, actor) {
      merchantOnly(actor); if (!String(reason ?? '').trim()) throw new FinanceError('REASON_REQUIRED');
      const tx = await store.getBankTransaction(txId); if (!tx || tx.merchantId !== merchantId) throw new FinanceError('BANK_TX_NOT_FOUND', String(txId));
      const rows = await store.listReconciliations({ bankTransactionId: txId });
      const standing = rows.filter((r) => r.amountCents > 0 && r.amountCents + rows.filter((x) => x.reversesId === r.id).reduce((s, x) => s + x.amountCents, 0) > 0);
      const picked = reconciliationIds?.length ? standing.filter((r) => reconciliationIds.includes(r.id)) : standing;
      if (!picked.length) throw new FinanceError('BANK_NOTHING_TO_UNRECONCILE');
      const r = await store.unreconcileBank({ merchantId, key: keyOf(idempotencyKey, randomUUID()), items: picked.map((p) => ({ reconciliationId: p.id, amountCents: reconciliationIds?.length === 1 ? amountCents : null })), reason: String(reason).slice(0, 300), actor, at: clock.now() });
      await audit({ at: clock.now(), action: 'BANK_UNRECONCILED', transactionId: txId, rows: picked.length });
      return { duplicate: r.duplicate, transaction: await this.transaction(txId) };
    },
    /** Set a transaction (or part of it) aside on purpose. Reversible (unreconcile the IGNORE row). */
    async ignore(txId, { amountCents = null, reason = null, idempotencyKey } = {}, actor) {
      merchantOnly(actor);
      const tx = await store.getBankTransaction(txId); if (!tx || tx.merchantId !== merchantId) throw new FinanceError('BANK_TRANSACTION_NOT_FOUND', String(txId));
      const r = await store.ignoreBank({ merchantId, key: keyOf(idempotencyKey, randomUUID()), transactionId: txId, amountCents, reason: reason ? String(reason).slice(0, 300) : null, actor, at: clock.now() });
      await audit({ at: clock.now(), action: 'BANK_IGNORED', transactionId: txId });
      return { duplicate: r.duplicate, ...(await this.transaction(txId)) };
    },
    /** One transaction with its derived reconciliation truth and every row that explains it (who/what reconciled, which payment, reversals). */
    async transaction(txId) {
      const tx = await store.getBankTransaction(txId); if (!tx || tx.merchantId !== merchantId) throw new FinanceError('BANK_TX_NOT_FOUND', String(txId));
      const rows = await store.listReconciliations({ bankTransactionId: txId });
      return { ...txView(tx), reconciliations: rows.map((r) => ({ id: r.id, kind: r.kind, amountCents: r.amountCents, paymentId: r.paymentId, reversesId: r.reversesId, method: r.method, suggestion: r.suggestion, reason: r.reason, actor: r.actor ? { type: r.actor.type, id: r.actor.id ?? null } : null, createdAt: r.createdAt })) };
    },
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
      const today = clock.today();
      // The five sources are independent reads: fetched in parallel (each is a database round trip), then combined as before.
      const [balancesAll, recvAll, allP, cashCount, cashMovements] = await Promise.all([store.listBankBalances(merchantId), openInvoices(), payablesAll(), store.latestCashCount(merchantId), store.listCashMovements(merchantId)]);
      const balances = balancesAll.filter((b) => (b.currency ?? currency) === currency); // an account in another currency is never added to the EUR position
      const recvNative = recvAll.filter((i) => (i.currency ?? currency) === currency);
      const recv = recvNative.map((i) => ({ number: i.number, dueDate: i.dueDate, remainingCents: i.remainingCents }));
      const payNative = allP.map((r) => toPayable(r, currency)).filter((p) => p.grossCents !== null);
      const pay = payNative.map((p) => ({ invoiceNumber: p.invoiceNumber, supplierName: p.supplierName, dueDate: p.dueDate, dueOrigin: p.dueOrigin, grossCents: p.grossCents }));
      const t = buildTreasury({ asOf: today, horizonDays, currency, bank: balances.length ? balances : null, cashCount, cashMovements, receivables: recv, payables: pay });
      return { ...t, excluded: { foreignReceivables: recvAll.length - recvNative.length, foreignPayables: allP.length - payNative.length, foreignBankAccounts: balancesAll.length - balances.length } };
    },
  };
  return api;
}
