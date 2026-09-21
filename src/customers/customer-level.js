// Customer-level behaviour from the PSEUDONYMOUS key (orders.customer_key). Output is aggregate only: no key,
// no per-customer row and no ranking of individuals ever leaves this module. Gated numbers are null.

import { aggregate } from '../metrics/sales.js';
import { customerProvenance } from './provenance.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const share = (a, b) => (b > 0 ? round4(a / b) : null);
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const DAY = 86400000;
const bucket = (n) => (n >= 3 ? '3_plus' : String(n));

/**
 * @param {Array<{id: string, orderedAt: Date, raw: object}>} orders in-scope orders (raw carries customer_key / customer_order_index)
 * @param {object} ledger @param {object} config @param {object} ctx { window, historyLimitations, spanDays }
 * @returns {null | object} null when no order carries a customer key
 */
export function buildCustomerLevel(orders, ledger, config, { window, historyLimitations, spanDays }) {
  const c = config.customers;
  const identified = orders.filter((o) => o.raw.customer_key);
  if (identified.length === 0) return null;

  const linesByOrder = new Map();
  for (const l of ledger.lineFacts) (linesByOrder.get(l.orderId) ?? linesByOrder.set(l.orderId, []).get(l.orderId)).push(l);
  const orderOfLine = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l.orderId]));
  const refundsByOrder = new Map();
  for (const r of ledger.refundFacts) { const o = orderOfLine.get(r.orderLineId); if (o) (refundsByOrder.get(o) ?? refundsByOrder.set(o, []).get(o)).push(r); }
  const orderFact = (o) => {
    const a = aggregate(linesByOrder.get(o.id) ?? [], refundsByOrder.get(o.id) ?? [], config);
    return { at: o.orderedAt, idx: o.raw.customer_order_index, net: a.net_sales_ex_tax, gross: a.net_sales, units: a.units_sold };
  };

  const byKey = new Map();
  for (const o of identified) (byKey.get(o.raw.customer_key) ?? byKey.set(o.raw.customer_key, []).get(o.raw.customer_key)).push(orderFact(o));
  const customers = [...byKey.values()].map((os) => {
    os.sort((a, b) => a.at - b.at);
    const maxIdx = Math.max(0, ...os.map((x) => x.idx ?? 0));
    return { orders: os, windowOrders: os.length, lifetimeLowerBound: Math.max(os.length, maxIdx), net: sum(os, (x) => x.net), gross: sum(os, (x) => x.gross), units: sum(os, (x) => x.units), returning: os.length > 1 || maxIdx > 1 };
  });
  const n = customers.length;
  const totalIdentifiedNet = sum(customers, (x) => x.net);
  const allNet = sum(orders, (o) => orderFact(o).net);
  const sampleGate = n >= c.minCustomers;
  const sampleReasons = sampleGate ? [] : [`ONLY_${n}_IDENTIFIED_CUSTOMERS_BELOW_${c.minCustomers}`];
  const shortHistory = spanDays < c.shortHistoryDays;
  const coverage = { identified_orders: identified.length, orders_in_scope: orders.length, identified_order_share: share(identified.length, orders.length), identified_revenue_share: share(totalIdentifiedNet, allNet), anonymous_orders: orders.length - identified.length };
  const covLimit = ['ANONYMOUS_ORDERS_HAVE_NO_CUSTOMER_KEY'];
  const prov = (extra) => customerProvenance({ window, historyLimitations, evidence_kind: 'derived', completeness: 'PARTIAL', ...extra, limitations: [...covLimit, ...(extra.limitations ?? [])] });

  // ---- new vs returning customers ----
  const typeOf = (x) => (x.returning ? 'returning' : 'new');
  const groups = {};
  for (const g of ['new', 'returning']) {
    const cs = customers.filter((x) => typeOf(x) === g);
    const ords = sum(cs, (x) => x.windowOrders);
    groups[g] = { customers: cs.length, customer_share: share(cs.length, n), orders: ords, order_share: share(ords, identified.length), net_sales_ex_tax: round2(sum(cs, (x) => x.net)), revenue_share: share(sum(cs, (x) => x.net), totalIdentifiedNet), aov: ords ? round2(sum(cs, (x) => x.gross) / ords) : null, units: sum(cs, (x) => x.units) };
  }
  const smallGroups = ['new', 'returning'].filter((g) => groups[g].customers < c.minOrdersPerGroup);
  const newVsReturning = {
    groups, coverage,
    definitions: { returning: 'customer with 2+ orders in the window, or any order whose recorded index is above 1', new: 'identified customer whose only order(s) have index 1' },
    provenance: prov({ sample: { customers: n, identified_orders: identified.length }, safe: smallGroups.length === 0, unsafeReasons: smallGroups.map((g) => `GROUP_${g.toUpperCase()}_BELOW_${c.minOrdersPerGroup}_CUSTOMERS`) }),
  };

  // ---- orders per customer, repeat rate, time between purchases ----
  const dist = (f) => { const d = { 1: 0, 2: 0, '3_plus': 0 }; for (const x of customers) d[bucket(f(x))] += 1; return d; };
  const gaps = customers.flatMap((x) => x.orders.slice(1).map((o, i) => (o.at - x.orders[i].at) / DAY));
  const repeatReasons = [...sampleReasons, ...(shortHistory ? ['SHORT_HISTORY'] : [])];
  const repeatCustomers = customers.filter((x) => x.lifetimeLowerBound >= 2).length;
  const intervalReasons = [...(gaps.length >= c.minIntervals ? [] : [`ONLY_${gaps.length}_INTERVALS_BELOW_${c.minIntervals}`]), ...(shortHistory ? ['SHORT_HISTORY'] : [])];
  const repeat = {
    identified_customers: n,
    customers_by_window_orders: dist((x) => x.windowOrders),
    customers_by_lifetime_orders_lower_bound: dist((x) => x.lifetimeLowerBound),
    repeat_customers_lower_bound: repeatCustomers,
    repeat_customer_rate_lower_bound: share(repeatCustomers, n),
    observed_intervals: gaps.length,
    days_between_purchases: gaps.length >= c.minIntervals ? { median: round2(median(gaps)), mean: round2(sum(gaps) / gaps.length) } : { median: null, mean: null, status: 'GATED', reasons: [`ONLY_${gaps.length}_INTERVALS_BELOW_${c.minIntervals}`] },
    time_between_purchases_safe: intervalReasons.length === 0,
    coverage,
    provenance: prov({ sample: { customers: n, intervals: gaps.length }, safe: repeatReasons.length === 0, unsafeReasons: repeatReasons, limitations: ['REPEAT_RATE_IS_A_LOWER_BOUND_ON_SHORT_HISTORY', 'INTERVALS_ONLY_WITHIN_THE_OBSERVED_DATASET', 'NOT_A_RETENTION_OR_LIFETIME_VALUE_ESTIMATE'] }),
  };

  // ---- observed value per customer (no prediction) ----
  const per = (f) => ({ mean: round2(sum(customers, f) / n), median: round2(median(customers.map(f))) });
  const value = {
    identified_customers: n,
    observed_revenue_ex_tax_per_customer: per((x) => x.net), observed_orders_per_customer: per((x) => x.windowOrders), observed_units_per_customer: per((x) => x.units),
    total_observed_revenue_ex_tax: round2(totalIdentifiedNet), coverage,
    provenance: prov({ sample: { customers: n }, safe: sampleReasons.length === 0 && !shortHistory, unsafeReasons: [...sampleReasons, ...(shortHistory ? ['SHORT_HISTORY'] : [])], limitations: ['OBSERVED_IN_WINDOW_NOT_LIFETIME_VALUE', 'NO_PREDICTIVE_CLV'] }),
  };

  // ---- concentration (numbers withheld below the sample gate: a top share over a few people is near-identifying) ----
  const sorted = customers.map((x) => x.net).sort((a, b) => b - a);
  const cc = c.concentration;
  let concentration;
  if (sampleGate && totalIdentifiedNet > 0) {
    const shares = sorted.map((v) => v / totalIdentifiedNet);
    const top1 = round4(shares[0]);
    const topN = round4(sum(shares.slice(0, cc.topN)));
    concentration = { status: 'OK', customers: n, top1_share: top1, [`top${cc.topN}_share`]: topN, hhi: Math.round(sum(shares, (s) => s * s) * 10000), risk: { top1: top1 >= cc.riskTop1Share, topN: topN >= cc.riskTopNShare, thresholds: cc } };
  } else concentration = { status: 'GATED', reasons: sampleGate ? ['NO_REVENUE'] : sampleReasons, customers: n, top1_share: null, hhi: null, risk: null };
  concentration.coverage = coverage;
  concentration.provenance = prov({ sample: { customers: n }, safe: sampleGate && !shortHistory && concentration.status === 'OK', unsafeReasons: [...sampleReasons, ...(shortHistory ? ['SHORT_HISTORY'] : [])], limitations: ['SHARES_ARE_OVER_IDENTIFIED_REVENUE_ONLY', 'NO_INDIVIDUAL_IS_NAMED_OR_RANKED_IN_OUTPUT'] });

  return { newVsReturning, repeat, value, concentration };
}
