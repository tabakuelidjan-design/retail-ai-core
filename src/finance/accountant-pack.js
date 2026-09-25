// Accountant pack: a deterministic period export.
// SOURCE OF TRUTH for shop/POS sales is Retail Core's own Phase 2A functions (windowFacts + aggregate, the same code
// computeSalesMetrics uses), so there is exactly one definition of sales and it cannot drift. Finance documents add ONLY
// standalone B2B sales; invoices linked to an existing shop/POS order are listed as documentation and never added.

import { aggregate, aggregateShipping, windowFacts } from '../metrics/sales.js';
import { addDays as addLocalDays, localDateString, localMidnight } from '../metrics/windows.js';
import { historyCoversPeriod } from '../sync/history.js';
import { findNumberingGaps } from './numbering.js';
import { verifyIntegrity, settlement } from './document.js';
import { checkLinkage, orderTotalsFromLedger } from './linking.js';
import { formatCents } from './money.js';
import { buildReceivables } from './receivables.js';

const toCents = (x) => Math.round(x * 100 + Number.EPSILON);
const ISSUED = ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CREDITED'];
const inPeriod = (d, p) => !!d && d >= p.start && d <= p.end;
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

/**
 * @param {{ledger: object, rawOrders: object[], docs: Array<{doc: object, payments: object[], creditNotes: object[]}>, period: {start: string, end: string},
 *   timeZone: string, now: Date, config: object, today: string, sources?: object}} p
 */
export function buildAccountantPack({ ledger, rawOrders, docs, period, timeZone, now, config, today, dueSoonDays = 7, retailHistory = null }) {
  const anomalies = [];
  const flag = (code, severity, detail) => anomalies.push({ code, severity, detail });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.start) || !/^\d{4}-\d{2}-\d{2}$/.test(period.end) || period.end < period.start) throw new Error('period must be { start, end } as YYYY-MM-DD with end >= start');

  // ---- retail (Phase 2A definitions, verbatim) ----
  const window = { key: 'custom', start: localMidnight(period.start, timeZone), end: localMidnight(addLocalDays(period.end, 1), timeZone), timeZone };
  const facts = windowFacts(ledger, window);
  const channelOf = new Map(rawOrders.map((o) => [o.id, o.channel_handle]));
  const cls = (id) => (config.marketing.posChannelHandles.includes(channelOf.get(id)) ? 'pos' : config.marketing.onlineChannelHandles.includes(channelOf.get(id)) ? 'online' : 'other');
  const orderOfLine = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l.orderId]));
  const part = (c) => aggregate(facts.lines.filter((l) => cls(l.orderId) === c), facts.refunds.filter((r) => cls(orderOfLine.get(r.orderLineId)) === c), ledger.config);
  const total = aggregate(facts.lines, facts.refunds, ledger.config);
  // Shipping is a separate revenue stream (with its own VAT) and is reported apart from product sales, then added to the totals.
  const shipOf = (c) => aggregateShipping(facts.shipping.filter((x) => cls(x.orderId) === c), facts.shippingRefunds.filter((x) => cls(x.orderId) === c));
  const ship = aggregateShipping(facts.shipping, facts.shippingRefunds);
  const shippingUncaptured = ledger.shippingCoverage?.uncaptured ? facts.orders.length - facts.shipping.length : 0;
  const byChannel = Object.fromEntries(['pos', 'online', 'other'].map((c) => {
    const a = part(c); const sc = shipOf(c);
    return [c, { orders: facts.orders.filter((o) => cls(o.id) === c).length, gross_sales: a.gross_sales, discounts: a.discounts, refunds: a.refunds, net_sales: a.net_sales, vat: a.tax, net_sales_ex_vat: a.net_sales_ex_tax,
      shipping_incl_vat_after_refunds: sc.net_incl_tax_after_refunds, shipping_vat_after_refunds: sc.tax_after_refunds, shipping_ex_vat_after_refunds: sc.net_ex_tax_after_refunds }];
  }));
  // ---- retail VAT by rate: only from rates the source REPORTED per line (taxRateBp); anything else is explicitly unavailable ----
  const lineById = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l]));
  const rateRows = new Map();
  const bucket = (bp) => { const k = bp === null || bp === undefined ? 'unknown' : bp; if (!rateRows.has(k)) rateRows.set(k, { rateBp: k === 'unknown' ? null : k, taxable: 0, vat: 0, lines: 0 }); return rateRows.get(k); };
  for (const l of facts.lines) { const b = bucket(l.taxRateBp); b.taxable += l.exTaxBeforeRefund; b.vat += l.tax; b.lines += 1; }
  for (const r of facts.refunds) { const b = bucket(lineById.get(r.orderLineId)?.taxRateBp); b.taxable -= r.exTax; b.vat -= r.tax; }
  // Shipping: the rate is the one Shopify reported on the shipping tax line (never assumed). Several rates or none reported -> unknown, which
  // makes the VAT breakdown PARTIAL exactly like a product line without a captured rate.
  // A shipping line with no VAT reported at all is a 0% line (the source says no tax applies); several different rates stay unknown.
  const shipRate = (x) => (x.taxRateBp ?? (x.tax === 0 ? 0 : null));
  const shipRateOf = new Map((ledger.shippingFacts ?? []).map((x) => [x.orderId, shipRate(x)]));
  for (const x of facts.shipping) { if (x.charged === 0 && x.tax === 0) continue; const b = bucket(shipRate(x)); b.taxable += x.exTax; b.vat += x.tax; b.lines += 1; }
  for (const r of facts.shippingRefunds) { const b = bucket(shipRateOf.get(r.orderId)); b.taxable -= r.exTax; b.vat -= r.tax; }
  const knownRates = [...rateRows.values()].filter((b) => b.rateBp !== null).sort((a, b) => a.rateBp - b.rateBp).map((b) => ({ vatRateBp: b.rateBp, taxableCents: toCents(b.taxable), vatCents: toCents(b.vat), lines: b.lines }));
  const unknownRate = rateRows.get('unknown');
  const retailVatByRate = {
    status: unknownRate && (unknownRate.lines > 0 || Math.abs(unknownRate.taxable) > 0.004 || Math.abs(unknownRate.vat) > 0.004) ? 'PARTIAL' : knownRates.length || !facts.lines.length ? 'COMPLETE' : 'PARTIAL',
    by_rate: knownRates,
    unavailable: unknownRate ? { lines: unknownRate.lines, taxableCents: toCents(unknownRate.taxable), vatCents: toCents(unknownRate.vat), reason: 'THE_SOURCE_RATE_WAS_NOT_CAPTURED_FOR_THESE_LINES (synced before rate capture, or compound taxes); re-sync to populate' } : null,
    reconciles_with_total_vat: Math.abs(sum([...rateRows.values()], (b) => b.vat) - (total.tax + ship.tax_after_refunds)) < 0.005,
    basis: 'VAT rate as reported by the source per order line and per shipping line; base = amount excl. tax minus refunded excl. tax',
  };
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const otherRefunds = round2(sum(facts.refundTotals, (r) => r.otherAmount));
  const retail = {
    orders: facts.orders.length, currency: ledger.currency,
    // PRODUCT figures (unchanged definitions): product lines only
    gross_sales: total.gross_sales, discounts: total.discounts, refunds: total.refunds, net_sales: total.net_sales, vat: total.tax, net_sales_ex_vat: total.net_sales_ex_tax,
    // SHIPPING, apart, as reported by the source (NULL columns = not captured, counted in orders_without_shipping_data, never zero)
    shipping: { ...ship, orders_without_shipping_data: shippingUncaptured, coverage: shippingUncaptured > 0 ? 'PARTIAL' : 'COMPLETE' },
    // Refunds with explicit semantics: `refunds` above is the PRODUCT refund; this is the full picture.
    refunds_breakdown: { product: total.refunds, shipping: ship.refunds_incl_tax, other: otherRefunds, total: round2(total.refunds + ship.refunds_incl_tax + otherRefunds) },
    // TOTALS = product + shipping, after refunds: the figures that go into the accounting totals
    total_net_sales: round2(total.net_sales + ship.net_incl_tax_after_refunds), total_vat: round2(total.tax + ship.tax_after_refunds), total_net_sales_ex_vat: round2(total.net_sales_ex_tax + ship.net_ex_tax_after_refunds),
    by_channel: byChannel, vat_by_rate: retailVatByRate,
  };

  // ---- finance documents in the period ----
  const issued = docs.filter(({ doc }) => doc.type !== 'quote' && ISSUED.includes(doc.status) && inPeriod(doc.issueDate, period));
  const sameCurrency = issued.filter(({ doc }) => doc.currency === ledger.currency);
  for (const { doc } of issued.filter(({ doc }) => doc.currency !== ledger.currency)) flag('DOCUMENT_IN_OTHER_CURRENCY_NOT_INCLUDED_IN_TOTALS', 'warning', `${doc.number} (${doc.currency})`);
  const standalone = sameCurrency.filter(({ doc }) => doc.revenueBasis === 'standalone_b2b');
  const linked = sameCurrency.filter(({ doc }) => doc.revenueBasis === 'linked_source_order');
  const sign = (doc) => (doc.type === 'credit_note' ? -1 : 1);
  const b2b = {
    standalone_invoices: standalone.filter(({ doc }) => doc.type === 'invoice').length,
    standalone_credit_notes: standalone.filter(({ doc }) => doc.type === 'credit_note').length,
    net_ex_vat_cents: sum(standalone, ({ doc }) => sign(doc) * doc.totals.netCents),
    vat_cents: sum(standalone, ({ doc }) => sign(doc) * doc.totals.vatCents),
    gross_incl_vat_cents: sum(standalone, ({ doc }) => sign(doc) * doc.totals.grossCents),
  };
  const rates = new Map();
  for (const { doc } of standalone) for (const g of doc.totals.vatBreakdown) { const r = rates.get(g.vatRateBp) ?? { vatRateBp: g.vatRateBp, taxableCents: 0, vatCents: 0 }; r.taxableCents += sign(doc) * g.taxableCents; r.vatCents += sign(doc) * g.vatCents; rates.set(g.vatRateBp, r); }
  const treatment = new Map();
  for (const { doc } of standalone) {
    const t = treatment.get(doc.vat.regime) ?? { regime: doc.vat.regime, taxableCents: 0, vatCents: 0, documents: 0, legalMentions: new Set() };
    t.taxableCents += sign(doc) * doc.totals.netCents; t.vatCents += sign(doc) * doc.totals.vatCents; t.documents += 1;
    if (doc.vat.mention) t.legalMentions.add(doc.vat.mention);
    treatment.set(doc.vat.regime, t);
  }
  const b2bByTreatment = [...treatment.values()].map((t) => ({ regime: t.regime, taxableCents: t.taxableCents, vatCents: t.vatCents, documents: t.documents, legalMentions: [...t.legalMentions], exemptOrReverseCharge: t.regime !== 'domestic' }));
  const linkedBlock = {
    documents: linked.length, additive_to_revenue: false,
    gross_documented_cents: sum(linked, ({ doc }) => sign(doc) * doc.totals.grossCents),
    note: 'Documents an existing shop/POS sale already counted in the retail figures; excluded from totals to prevent double counting.',
  };
  const creditNoteDocs = sameCurrency.filter(({ doc }) => doc.type === 'credit_note');
  const creditNotesBlock = {
    issued: creditNoteDocs.length,
    gross_cents: sum(creditNoteDocs, ({ doc }) => doc.totals.grossCents),
    standalone_gross_cents: sum(creditNoteDocs.filter(({ doc }) => doc.revenueBasis === 'standalone_b2b'), ({ doc }) => doc.totals.grossCents),
    linked_gross_cents: sum(creditNoteDocs.filter(({ doc }) => doc.revenueBasis === 'linked_source_order'), ({ doc }) => doc.totals.grossCents),
    note: 'Standalone credit notes reduce B2B sales; credit notes on invoices linked to a shop/POS sale are documentation (the shop refund carries the effect).',
  };
  const totals = {
    sales_ex_vat_cents: toCents(retail.total_net_sales_ex_vat) + b2b.net_ex_vat_cents,
    vat_collected_cents: toCents(retail.total_vat) + b2b.vat_cents,
    sales_incl_vat_cents: toCents(retail.total_net_sales) + b2b.gross_incl_vat_cents,
  };

  // combined VAT by rate: retail known rates + standalone B2B rates. Retail lines without a reported rate stay separate and make it PARTIAL.
  const combined = new Map();
  const add = (bp, taxable, vat) => { const c = combined.get(bp) ?? { vatRateBp: bp, taxableCents: 0, vatCents: 0 }; c.taxableCents += taxable; c.vatCents += vat; combined.set(bp, c); };
  for (const g of knownRates) add(g.vatRateBp, g.taxableCents, g.vatCents);
  for (const g of rates.values()) add(g.vatRateBp, g.taxableCents, g.vatCents);
  const vatSummary = {
    status: retailVatByRate.status,
    retail: retailVatByRate,
    b2b: { by_rate: [...rates.values()].sort((a, b) => a.vatRateBp - b.vatRateBp), by_treatment: b2bByTreatment, exempt_or_reverse_charge_base_cents: sum(b2bByTreatment.filter((t) => t.exemptOrReverseCharge), (t) => t.taxableCents) },
    combined_by_rate: [...combined.values()].sort((a, b) => a.vatRateBp - b.vatRateBp),
    retail_unclassified: retailVatByRate.unavailable,
    total_vat_cents: totals.vat_collected_cents,
    note: 'Combined rows contain only amounts with a known rate. Retail lines whose rate was not captured are listed separately and are NOT distributed across rates.',
  };

  // ---- payment status of B2B invoices issued in the period ----
  const invoicesInPeriod = sameCurrency.filter(({ doc }) => doc.type === 'invoice');
  const pay = { paid: { count: 0, cents: 0 }, partially_paid: { count: 0, cents: 0 }, unpaid: { count: 0, cents: 0 }, credited: { count: 0, cents: 0 } };
  for (const { doc, payments, creditNotes } of invoicesInPeriod) {
    const s = settlement(doc, payments, creditNotes);
    const k = s.creditedCents >= s.grossCents ? 'credited' : s.payableCents > 0 && s.remainingCents === 0 ? 'paid' : s.paidCents > 0 ? 'partially_paid' : 'unpaid';
    pay[k].count += 1; pay[k].cents += k === 'paid' || k === 'credited' ? s.payableCents || s.grossCents : s.remainingCents;
  }
  const receivables = buildReceivables(docs, { today, dueSoonDays });

  // ---- reconciliation and integrity ----
  const orderTotals = orderTotalsFromLedger(ledger);
  const allDocs = docs.map((d) => d.doc);
  let suspected = 0;
  for (const { doc } of issued.filter(({ doc }) => doc.type === 'invoice')) {
    const r = checkLinkage(doc, { orderTotals, invoices: allDocs.filter((d) => d.id !== doc.id), dupWindowDays: config.finance?.linking?.dupWindowDays ?? 3, toleranceCents: config.finance?.linking?.toleranceCents ?? 1 });
    for (const e of r.errors) { if (e.startsWith('POSSIBLE_DUPLICATE')) suspected += 1; flag(e.split(' ')[0], 'critical', `${doc.number}: ${e}`); }
    for (const w of r.warnings) flag(w.split(' ')[0], 'warning', `${doc.number}: ${w}`);
  }
  for (const { doc } of issued) if (!verifyIntegrity(doc).ok) flag('DOCUMENT_INTEGRITY_HASH_MISMATCH', 'critical', doc.number);
  const seqByKey = new Map();
  for (const { doc } of docs.filter(({ doc }) => doc.number && doc.type !== 'quote')) {
    const m = /(\d+)$/.exec(doc.number);
    if (!m) continue;
    const k = `${doc.type}|${doc.issueDate.slice(0, 4)}`;
    (seqByKey.get(k) ?? seqByKey.set(k, []).get(k)).push(Number(m[1]));
  }
  for (const [k, seqs] of seqByKey) { const g = findNumberingGaps(seqs); if (g.gaps.length || g.duplicates.length) flag('NUMBERING_GAP_OR_DUPLICATE', 'critical', `${k}: gaps [${g.gaps}] duplicates [${g.duplicates}]`); }
  const unissued = docs.filter(({ doc }) => doc.type !== 'quote' && ['DRAFT', 'READY_FOR_APPROVAL'].includes(doc.status) && inPeriod(doc.issueDate, period));
  if (unissued.length) flag('UNISSUED_DOCUMENTS_IN_PERIOD', 'warning', `${unissued.length} draft/ready document(s) dated in the period are not counted`);
  const quotesInPeriod = docs.filter(({ doc }) => doc.type === 'quote' && inPeriod(doc.issueDate, period)).length;

  // ---- completeness ----
  const reasons = [];
  const firstOrder = ledger.orders.length ? new Date(Math.min(...ledger.orders.map((o) => o.orderedAt))) : null;
  if (!firstOrder && !historyCoversPeriod(retailHistory, period.start)) reasons.push('NO_RETAIL_ORDERS_LOADED');
  else {
    // Compare LOCAL DATES: history that starts mid-day on the period's first day fully covers that day's start of the period.
    const firstDate = localDateString(firstOrder, timeZone);
    if (firstDate > period.start && !historyCoversPeriod(retailHistory, period.start)) reasons.push(`RETAIL_HISTORY_STARTS_${firstDate}_AFTER_PERIOD_START`);
  }
  if (period.end >= today) reasons.push('PERIOD_NOT_CLOSED');
  if (retailHistory?.lastSyncedAt && retailHistory.lastSyncedAt < window.end.toISOString()) reasons.push('RETAIL_LAST_SYNC_BEFORE_PERIOD_END');
  if (ledger.excluded.test) reasons.push(`${ledger.excluded.test}_TEST_ORDERS_EXCLUDED`);
  if (ledger.excluded.otherCurrency) reasons.push(`${ledger.excluded.otherCurrency}_ORDERS_IN_OTHER_CURRENCY_EXCLUDED`);
  if (shippingUncaptured > 0) reasons.push(`SHIPPING_NOT_CAPTURED_FOR_${shippingUncaptured}_ORDERS`);
  if (retailVatByRate.status === 'PARTIAL') reasons.push(`RETAIL_VAT_RATE_UNAVAILABLE_FOR_${retailVatByRate.unavailable?.lines ?? 0}_LINES`);
  const critical = anomalies.filter((a) => a.severity === 'critical').length;
  const blockingGaps = reasons.filter((r) => r.startsWith('RETAIL_HISTORY') || r === 'RETAIL_LAST_SYNC_BEFORE_PERIOD_END' || r.startsWith('RETAIL_VAT_RATE') || r === 'PERIOD_NOT_CLOSED' || r === 'NO_RETAIL_ORDERS_LOADED');

  return {
    kind: 'accountant_pack', version: 'FIN-1',
    period: { ...period, timeZone }, generated_at: now.toISOString(), currency: ledger.currency,
    source_systems: [
      { system: 'retail_core', description: 'Orders and refunds synced read-only from the merchant commerce platform, through the validated Phase 2A ledger', role: 'sole source of shop and POS sales' },
      { system: 'finance_documents', description: 'Issued invoices and credit notes recorded in this system', role: 'standalone B2B sales only' },
    ],
    definitions: 'Retail figures use the Phase 2A definitions unchanged (gross, discounts, refunds, net, tax); finance documents use integer cents with per-rate VAT rounding.',
    completeness: { status: blockingGaps.length || critical ? 'PARTIAL' : 'COMPLETE', reasons, unresolved_anomalies: anomalies.length, critical_anomalies: critical },
    retail, b2b, b2b_linked: linkedBlock, credit_notes: creditNotesBlock, vat_summary: vatSummary, vat_by_rate_b2b: [...rates.values()].sort((a, b) => a.vatRateBp - b.vatRateBp), totals,
    payment_status_of_period_invoices: pay, receivables,
    reconciliation: {
      status: suspected || critical ? 'REVIEW_REQUIRED' : 'CLEAN',
      linked_documents_excluded: linked.length, standalone_documents_added: standalone.length, suspected_duplicates: suspected,
      rule: 'A shop/POS sale is counted once, from Retail Core. Only invoices declared standalone_b2b add to revenue.',
    },
    quotes_in_period: { count: quotesInPeriod, counted_as_revenue: false },
    anomalies,
    documents: sameCurrency.map(({ doc, payments, creditNotes }) => {
      const s = doc.type === 'invoice' ? settlement(doc, payments, creditNotes) : null;
      return { number: doc.number, type: doc.type, issueDate: doc.issueDate, dueDate: doc.dueDate, customer: doc.customer.name, customerVat: doc.customer.vatNumber ?? '', revenueBasis: doc.revenueBasis, status: doc.status, net: formatCents(doc.totals.netCents), vat: formatCents(doc.totals.vatCents), gross: formatCents(doc.totals.grossCents), paid: s ? formatCents(s.paidCents) : '', remaining: s ? formatCents(s.remainingCents) : '', additive: doc.revenueBasis === 'standalone_b2b' ? 'yes' : 'no (documents an existing shop/POS sale)' };
    }),
  };
}

/** Flat summary lines used by the CSV and PDF exports, so both render exactly the same numbers. */
export function summaryLines(pack) {
  const e = (x) => formatCents(toCents(x));
  return [
    { line: 'Retail gross sales (shop + POS)', source: 'Retail Core', amount: e(pack.retail.gross_sales) },
    { line: 'Retail discounts', source: 'Retail Core', amount: e(pack.retail.discounts) },
    { line: 'Retail product refunds', source: 'Retail Core', amount: e(pack.retail.refunds) },
    { line: 'Retail product net sales incl. VAT', source: 'Retail Core', amount: e(pack.retail.net_sales) },
    { line: 'Retail product VAT collected', source: 'Retail Core', amount: e(pack.retail.vat) },
    { line: 'Retail product net sales excl. VAT', source: 'Retail Core', amount: e(pack.retail.net_sales_ex_vat) },
    { line: 'Retail shipping charged incl. VAT', source: 'Retail Core', amount: e(pack.retail.shipping.charged_incl_tax) },
    { line: 'Retail shipping refunds incl. VAT', source: 'Retail Core', amount: e(pack.retail.shipping.refunds_incl_tax) },
    { line: 'Retail shipping net excl. VAT (after refunds)', source: 'Retail Core', amount: e(pack.retail.shipping.net_ex_tax_after_refunds) },
    { line: 'Retail shipping VAT collected (after refunds)', source: 'Retail Core', amount: e(pack.retail.shipping.tax_after_refunds) },
    { line: 'Retail refunds total (products + shipping + other)', source: 'Retail Core', amount: e(pack.retail.refunds_breakdown.total) },
    { line: 'Retail net sales incl. VAT', source: 'Retail Core', amount: e(pack.retail.total_net_sales) },
    { line: 'Retail VAT collected', source: 'Retail Core', amount: e(pack.retail.total_vat) },
    { line: 'Retail net sales excl. VAT', source: 'Retail Core', amount: e(pack.retail.total_net_sales_ex_vat) },
    { line: '  of which POS excl. VAT (products + shipping)', source: 'Retail Core', amount: e(pack.retail.by_channel.pos.net_sales_ex_vat + pack.retail.by_channel.pos.shipping_ex_vat_after_refunds) },
    { line: '  of which online excl. VAT (products + shipping)', source: 'Retail Core', amount: e(pack.retail.by_channel.online.net_sales_ex_vat + pack.retail.by_channel.online.shipping_ex_vat_after_refunds) },
    { line: 'Standalone B2B net excl. VAT (invoices - credit notes)', source: 'Finance documents', amount: formatCents(pack.b2b.net_ex_vat_cents) },
    { line: 'Standalone B2B VAT', source: 'Finance documents', amount: formatCents(pack.b2b.vat_cents) },
    { line: 'Standalone B2B incl. VAT', source: 'Finance documents', amount: formatCents(pack.b2b.gross_incl_vat_cents) },
    { line: 'Linked invoices (documentation only, NOT added)', source: 'Finance documents', amount: formatCents(pack.b2b_linked.gross_documented_cents) },
    { line: 'TOTAL sales excl. VAT', source: 'Retail + standalone B2B', amount: formatCents(pack.totals.sales_ex_vat_cents) },
    { line: 'TOTAL VAT collected', source: 'Retail + standalone B2B', amount: formatCents(pack.totals.vat_collected_cents) },
    { line: 'TOTAL sales incl. VAT', source: 'Retail + standalone B2B', amount: formatCents(pack.totals.sales_incl_vat_cents) },
  ];
}
