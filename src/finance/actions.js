// Finance Action Center: turns the facts the workspace already holds into a short, prioritised list of things to do.
// Pure function over facts (no I/O, no arithmetic on money beyond adding integer cents): the same facts always give the same list.
// Every action names its target screen; the merchant decides what to do, nothing is executed from here.

const TONE_ORDER = { bad: 0, warn: 1, info: 2, ok: 3 };
const DAY = 86_400_000;
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** End date of the calendar quarter containing `today` and the days left (0 = it ends today). */
export function quarterInfo(today) {
  const y = Number(today.slice(0, 4)); const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const end = new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10);
  return { year: y, quarter: q + 1, end, daysLeft: days(today, end) };
}

/**
 * @param {{today: string, currency: string, dueSoonDays: number,
 *   receivables: {overdue: {count: number, outstandingCents: number}, due_soon: {count: number, outstandingCents: number}},
 *   inbox: {toReview: number, TO_PAY: number, toPayCents: number}, stock: {counts: object}|null,
 *   draftsMissingVat: number, awaitingApproval: number, quotesToConvert: number,
 *   pack: {status: string, period: {start: string, end: string}, completeness: string, orders: number, reconciliation: string, anomalies: number}|null,
 *   settingsMissing: number, closingWarnDays?: number}} facts
 * @returns {Array<{id: string, tone: 'bad'|'warn'|'info'|'ok', kind: string, count: number, cents?: number, params: object, href: string, cta: string}>}
 */
export function buildActions(f) {
  const out = []; const add = (a) => out.push(a);
  const q = quarterInfo(f.today);
  if (f.settingsMissing > 0) add({ id: 'setup', tone: 'warn', kind: 'setup_incomplete', count: f.settingsMissing, params: {}, href: '#/settings', cta: 'settings' });
  if (f.receivables.overdue.count > 0) add({ id: 'overdue', tone: 'bad', kind: 'overdue_invoices', count: f.receivables.overdue.count, cents: f.receivables.overdue.outstandingCents, params: {}, href: '#/receivables', cta: 'review' });
  if (f.receivables.due_soon.outstandingCents > 0) add({ id: 'collect', tone: 'info', kind: 'to_collect_soon', count: f.receivables.due_soon.count, cents: f.receivables.due_soon.outstandingCents, params: { days: f.dueSoonDays }, href: '#/receivables', cta: 'review' });
  if (f.awaitingApproval > 0) add({ id: 'approve', tone: 'warn', kind: 'invoices_to_approve', count: f.awaitingApproval, params: {}, href: '#/invoices?status=READY_FOR_APPROVAL', cta: 'review' });
  if (f.draftsMissingVat > 0) add({ id: 'vat', tone: 'warn', kind: 'documents_missing_vat', count: f.draftsMissingVat, params: {}, href: '#/invoices?status=DRAFT', cta: 'review' });
  if (f.quotesToConvert > 0) add({ id: 'quotes', tone: 'info', kind: 'quotes_to_convert', count: f.quotesToConvert, params: {}, href: '#/quotes?status=ACCEPTED', cta: 'review' });
  if (f.inbox.toReview > 0) add({ id: 'inbox', tone: 'warn', kind: 'supplier_invoices_to_review', count: f.inbox.toReview, params: {}, href: '#/inbox', cta: 'validate' });
  if (f.inbox.TO_PAY > 0) add({ id: 'pay', tone: 'info', kind: 'supplier_invoices_to_pay', count: f.inbox.TO_PAY, cents: f.inbox.toPayCents, params: {}, href: '#/purchases', cta: 'review' });
  const sc = f.stock?.counts;
  if (sc && (sc.FAILED || sc.UNCERTAIN)) add({ id: 'stock', tone: 'bad', kind: 'stock_movements_need_attention', count: sc.FAILED + sc.UNCERTAIN, params: {}, href: '#/settings', cta: 'review' });
  if (q.daysLeft <= (f.closingWarnDays ?? 14)) add({ id: 'closing', tone: 'info', kind: 'quarter_closes_soon', count: q.daysLeft, params: { quarter: q.quarter, year: q.year, days: q.daysLeft }, href: '#/pack', cta: 'prepare_pack' });
  const p = f.pack;
  if (p && p.status === 'OK') {
    if (p.completeness === 'COMPLETE' && p.reconciliation === 'CLEAN') add({ id: 'pack', tone: 'ok', kind: 'accountant_pack_ready', count: 1, params: { period: `${p.period.start} - ${p.period.end}` }, href: '#/pack', cta: 'prepare_pack' });
    else add({ id: 'pack', tone: 'warn', kind: 'accountant_pack_needs_review', count: p.anomalies, params: { period: `${p.period.start} - ${p.period.end}` }, href: '#/pack', cta: 'review' });
    if (p.orders > 0 && p.reconciliation === 'CLEAN') add({ id: 'recon', tone: 'ok', kind: 'orders_reconciled', count: p.orders, params: {}, href: '#/pack', cta: 'review' });
  }
  return out.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}
