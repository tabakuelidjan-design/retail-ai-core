// READ-ONLY Finance facts for Nordla Core and Parle à Nordla. Finance stays the authority: every figure below is computed by Finance's
// own code (payables settlement + due-date views, the treasury engine, the purchase analytics), on Finance's own store, for ONE
// merchant. Nothing is recomputed differently here, nothing is written, nothing is paid. Each answer carries its period, its source
// and its freshness ("as of"). Finance's own definition of an open payable is used: status VALIDATED or TO_PAY with an amount left.
import { dueViewOf, settlementOf } from '../finance/payables/index.js';
import { createTreasuryService } from '../finance/treasury-service.js';
import { createMerchantClock } from '../finance/civil-date.js';
import { buildPurchaseAnalytics } from '../finance/analytics.js';
import { loadDocsForReports } from '../finance/reports.js';
import { money } from '../finance/pdf.js';

const OPEN = ['VALIDATED', 'TO_PAY'];
const NOT_YET_VALIDATED = ['RECEIVED', 'TO_REVIEW'];
const CALENDAR_ORDER = { OVERDUE: 0, DUE_TODAY: 1, NOT_DUE: 2, NO_DUE_DATE: 3, NOT_APPLICABLE: 4 };

/**
 * @param {{ store: object, merchantId: string, timeZone: string, now?: () => string, source: string, dueSoonDays?: number }} o
 *   store  = Finance's store (createSupabaseFinanceStore on the server, the memory store in tests) - only list/get methods are called
 *   source = where the data lives, said in every answer (e.g. 'Finance · Supabase staging')
 */
export function createFinanceReader({ store, merchantId, timeZone, now = () => new Date().toISOString(), source, dueSoonDays = 7 }) {
  if (!merchantId) throw new TypeError('createFinanceReader: merchantId is required');
  const clock = createMerchantClock({ now, timeZone }); // throws without a time zone: "today" is never a silent UTC default
  const meta = () => ({ source, merchantId, asOf: clock.today(), readAt: now(), timeZone });

  /** Supplier invoices still to pay, with Finance's due-date view, most urgent first. */
  async function payables() {
    const rows = await store.listSupplierInvoices(merchantId);
    const today = clock.today(); const items = []; let pending = 0;
    for (const r of rows) {
      if (NOT_YET_VALIDATED.includes(r.status)) { pending += 1; continue; }
      if (!OPEN.includes(r.status)) continue;
      const s = settlementOf(r); if (s.remainingCents === null || s.remainingCents <= 0) continue;
      const v = dueViewOf(r, { today, dueSoonDays });
      items.push({ id: r.id, supplier: r.supplierName ?? null, invoiceNumber: r.invoiceNumber ?? null, currency: r.currency ?? null, grossCents: r.grossCents ?? null, remainingCents: s.remainingCents, settlement: s.state, dueDate: v.dueDate, dueOrigin: v.origin, calendar: v.calendar, daysRemaining: v.daysRemaining, dueSoon: v.dueSoon, message: v.message });
    }
    items.sort((a, b) => (CALENDAR_ORDER[a.calendar] ?? 9) - (CALENDAR_ORDER[b.calendar] ?? 9) || String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')));
    const totals = {}; for (const i of items) totals[i.currency ?? '?'] = (totals[i.currency ?? '?'] ?? 0) + i.remainingCents; // sum of Finance's own remaining amounts, per currency (never converted)
    return { ...meta(), items, totals, overdue: items.filter((i) => i.calendar === 'OVERDUE').length, dueSoon: items.filter((i) => i.dueSoon && i.calendar !== 'OVERDUE').length, notYetValidated: pending };
  }

  // the inbox's own filter semantics (inbox.js list({ statuses })): the treasury asks for VALIDATED / TO_PAY only
  const inboxList = async ({ statuses } = {}) => (await store.listSupplierInvoices(merchantId)).filter((r) => !statuses || statuses.includes(r.status));

  /** Treasury position and the 30-day forecast from Finance's treasury engine (observed vs projected, with freshness). */
  async function treasury({ horizonDays = 30 } = {}) {
    const svc = createTreasuryService({ store, merchantId, clock, finance: { listInvoices: () => loadDocsForReports(store, merchantId) }, inbox: { list: inboxList } });
    const f = await svc.forecast({ horizonDays });
    return { ...meta(), horizonDays, position: f.position, forecast: f.forecast, warnings: f.warnings ?? [], undated: (f.undated ?? []).length };
  }

  /** Purchases (supplier documents) of a period, from Finance's purchase analytics. */
  async function purchases({ from, to, currency = 'EUR' }) {
    const rows = await store.listSupplierInvoices(merchantId);
    return { ...meta(), period: { from, to }, report: buildPurchaseAnalytics(rows, { from, to, currency, m: (c) => money(c, 'fr') }) };
  }

  return Object.freeze({ kind: 'finance', source, payables, treasury, purchases, today: () => clock.today() });
}
