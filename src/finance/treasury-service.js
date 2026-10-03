// Treasury service: READ-ONLY. It gathers the source facts the other engines already own and hands them to the pure engine (treasury-engine.js).
//   Payments  -> remaining_due of every open customer invoice (settlement(), the single amounts definition) and the net allocations of supplier invoices
//   Bank      -> observed balances, accounts, transactions after the observation, derived reconciliation state (never matched_*)
//   Cash      -> the last confirmed count and the movements after it
// It owns no table and calls no write method of any store: scenarios are computed from the same facts with hypotheses applied in memory and discarded.
// All reads are a constant number of queries (one per source), never one per invoice.

import { addDays, settlement } from './document.js';
import { settlementOf } from './payables/status.js';
import { dueForProjection } from './payables/index.js';
import { requireClock } from './civil-date.js';
import { HORIZONS, buildTreasuryModel, explainItemIn, explainPositionIn, runScenarioOn, TreasuryError } from './treasury-engine.js';

const OPEN_STATUSES = ['ISSUED', 'SENT', 'PARTIALLY_PAID'];

/**
 * @param {{store: object, merchantId: string, finance: {listInvoices: Function}, inbox: {list: Function}, clock: {now: Function, today: Function, timeZone: string}, currency?: string}} d
 */
export function createTreasuryService({ store, merchantId, finance, inbox, clock, currency = 'EUR' }) {
  requireClock(clock, 'createTreasuryService');
  if (!clock.timeZone) throw new TypeError('createTreasuryService: the clock must expose the merchant timeZone');

  async function facts() {
    const asOf = clock.today(); const nowInstant = clock.now();
    // five independent reads, in parallel; every list is read ONCE
    const [balances, accounts, transactions, cashCount, cashMovements, invoices, supplierRows] = await Promise.all([
      store.listBankBalances(merchantId), store.listBankAccounts(merchantId), store.listBankTransactions({ merchantId }), store.latestCashCount(merchantId), store.listCashMovements(merchantId),
      finance.listInvoices(), inbox.list({ statuses: ['VALIDATED', 'TO_PAY'] })]);
    const receivables = [];
    for (const { doc, payments, creditNotes, refunds } of invoices) {
      if (doc.type !== 'invoice' || !OPEN_STATUSES.includes(doc.status)) continue;
      const s = settlement(doc, payments, creditNotes, refunds); if (s.remainingCents <= 0) continue;
      receivables.push({ id: doc.id, number: doc.number, customer: doc.customer?.name ?? null, currency: doc.currency ?? currency, dueDate: doc.dueDate, remainingCents: s.remainingCents, grossCents: s.grossCents, creditedCents: s.creditedCents, paidCents: s.retainedCents ?? s.paidCents, effectiveDueCents: s.effectiveDueCents, schedule: doc.dueSchedule ?? null });
    }
    const payables = [];
    for (const r of supplierRows) {
      const s = settlementOf(r); if (s.remainingCents === null || s.remainingCents <= 0) continue; const due = dueForProjection(r);
      payables.push({ id: r.id, invoiceNumber: r.invoiceNumber, supplierName: r.supplierName, currency: r.currency ?? currency, dueDate: due.dueDate, dueOrigin: due.origin, remainingCents: s.remainingCents, grossCents: r.grossCents, paidCents: s.paidCents });
    }
    return { asOf, nowInstant, timeZone: clock.timeZone, currency, balances, accounts, transactions, cashCount, cashMovements, receivables, payables };
  }

  const api = {
    HORIZONS,
    /** The whole derived model (position per currency, items with provenance, forecasts 7/30/90, risk). */
    async model() { return buildTreasuryModel(await facts()); },
    async position() { const m = await api.model(); return { asOf: m.asOf, currencies: m.currencies, consolidation: m.consolidation, position: m.position, warnings: m.warnings, legend: m.legend }; },
    async forecast({ horizonDays } = {}) {
      const m = await api.model(); if (horizonDays != null && !HORIZONS.includes(horizonDays)) throw new TreasuryError('TREASURY_HORIZON_INVALID', String(horizonDays));
      const forecast = {}; for (const c of m.currencies) forecast[c] = { currency: c, startingCents: m.forecast[c].startingCents, horizons: horizonDays ? { [horizonDays]: m.forecast[c].horizons[horizonDays] } : m.forecast[c].horizons, series: m.forecast[c].series, risk: m.forecast[c].risk };
      return { asOf: m.asOf, currencies: m.currencies, consolidation: m.consolidation, forecast, items: m.items, undated: m.undated, position: m.position, warnings: m.warnings, legend: m.legend };
    },
    /** What-if. Pure computation on the same facts: it cannot persist anything (this service holds no write path). */
    async scenario(hypotheses) { return runScenarioOn(await facts(), hypotheses); },
    async explainItem(id) { return explainItemIn(await api.model(), String(id)); },
    async explainPosition(cur = currency) { return explainPositionIn(await api.model(), cur); },
    /** The summary shape the dashboard already consumes, DERIVED from the same model (no second calculation). */
    async legacyView({ horizonDays = 7, currency: cur = currency } = {}) {
      const m = await api.model(); const f = m.forecast[cur]; const pos = m.position[cur];
      const end = addDays(m.asOf, horizonDays);
      const inRange = (x) => x.currency === cur && x.included && x.date >= m.asOf && x.date <= end; const ins = m.items.filter((x) => x.direction === 'IN' && inRange(x)); const outs = m.items.filter((x) => x.direction === 'OUT' && inRange(x));
      const overdueIn = m.items.filter((x) => x.currency === cur && x.direction === 'IN' && !x.included && x.overdue); const sum = (xs) => xs.reduce((a, x) => a + x.amountCents, 0);
      const bank = (pos?.components ?? []).filter((c) => c.kind === 'BANK_BALANCE' && c.amountCents !== null); const bankCents = bank.length ? bank.reduce((a, c) => a + c.amountCents, 0) : null;
      const cashC = (pos?.components ?? []).find((c) => c.kind === 'CASH_COUNT'); const cashMv = (pos?.components ?? []).find((c) => c.kind === 'CASH_LATER_MOVEMENTS'); const cashCents = cashC ? cashC.amountCents + (cashMv?.amountCents ?? 0) : null;
      const liquidCents = pos?.calculated.totalCents ?? null; const fromTerms = outs.filter((x) => x.dueOrigin === 'COMPUTED_FROM_TERMS');
      const series = (f?.series ?? []).slice(0, horizonDays + 1).map((p, d) => ({ date: p.date, incomingCents: p.inCents, outgoingCents: p.outCents, balanceCents: p.balanceCents, basis: d === 0 ? 'OBSERVED_PLUS_EXPECTED' : 'PROJECTED' })).filter((p) => p.balanceCents !== null);
      const warnings = []; if (!bank.length) warnings.push('NO_BANK_BALANCE_AVAILABLE'); if (!cashC) warnings.push('NO_CASH_COUNT_CONFIRMED');
      const projectedCents = liquidCents === null ? null : liquidCents + sum(ins) - sum(outs);
      return { asOf: m.asOf, horizonDays, currency: cur,
        observed: { bankCents, bankAsOf: bank.map((c) => c.observedAt).filter(Boolean).sort().at(-1) ?? null, cashCents, cashAsOf: cashC?.countedOn ?? null, liquidCents, freshness: pos?.freshness ?? 'UNKNOWN', basis: 'OBSERVED_PLUS_LATER_TRANSACTIONS' },
        expected: { incomingCents: sum(ins), incomingCount: ins.length, outgoingCents: sum(outs), outgoingCount: outs.length, outgoingFromTermsCents: sum(fromTerms), outgoingFromTermsCount: fromTerms.length },
        assumed: { overdueReceivablesCents: sum(overdueIn), overdueCount: overdueIn.length, note: 'NOT_INCLUDED_IN_THE_PROJECTION' },
        projection: { cents: projectedCents, basis: 'PROJECTED', horizonEnd: end, formula: 'CALCULATED_POSITION + EXPECTED_IN - EXPECTED_OUT' },
        items: [{ key: 'bank', cents: bankCents, basis: 'OBSERVED' }, { key: 'cash', cents: cashCents, basis: 'OBSERVED' }, { key: 'liquid', cents: liquidCents, basis: 'CALCULATED' }, { key: 'receivables_due', cents: sum(ins), basis: 'EXPECTED' }, { key: 'payables_due', cents: sum(outs), basis: 'EXPECTED' }, { key: 'overdue_receivables', cents: sum(overdueIn), basis: 'ASSUMED' }, { key: 'projection', cents: projectedCents, basis: 'PROJECTED' }],
        series, warnings, notices: m.warnings.filter((w) => !w.currency || w.currency === cur), risk: f?.horizons[HORIZONS.find((x) => x >= horizonDays) ?? 90]?.risk ?? null,
        disclaimer: 'SHORT_TERM_LIQUIDITY_VIEW_NOT_ACCOUNTING_CASH_FLOW',
        excluded: { foreignReceivables: m.items.filter((x) => x.direction === 'IN' && x.currency !== cur).length, foreignPayables: m.items.filter((x) => x.direction === 'OUT' && x.currency !== cur).length + m.undated.filter((x) => x.direction === 'OUT' && x.currency !== cur).length, foreignBankAccounts: Object.values(m.position).filter((p) => p.currency !== cur).reduce((a, p) => a + p.components.filter((c) => c.kind === 'BANK_BALANCE').length, 0) } };
    },
  };
  return api;
}
