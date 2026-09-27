// Growth > Audience - the decision engine. Pure and deterministic: per-order facts in, aggregate Growth segments out.
// It answers "which groups of customers are a growth opportunity now, why, and which action deserves to be considered?"
// (Analytics > Clients answers "who are my customers and how do they behave").
//
// Privacy by design: the only customer-level input is the PSEUDONYMOUS key (orders.customer_key, a keyed hash). It is used
// to group orders and NEVER leaves this module: the payload holds counts, sums, shares and medians per segment only - no
// key, no label, no per-customer row, no name / e-mail / phone / address (those are not even synced).
//
// Two modes, decided by the data, never by the request:
//   customer   at least one order of the loaded history carries a customer key -> segments of identified customers
//   aggregate  no customer key -> order-level facts only (orders, revenue, basket, the order's recorded new / returning
//              index when the source provides it); no segment of people is fabricated.
//
// Every threshold is an EXISTING rule of the customers engine / Explorer (src/metrics/config.js, src/report):
//   - window: the last 90 complete days (customers.shortHistoryDays = 90; also the last recency cut-off of Explorer > Clients)
//   - repeat buyer: 2+ orders, or a recorded order index above 1 (customer-level.js "returning", lifetime lower bound)
//   - frequent buyer: 3+ orders (the "3_plus" bucket of customers_by_lifetime_orders_lower_bound)
//   - proven new customer: first known order with a recorded index of 1 (orderGroup / classifyCustomerOrders)
//   - sample gate: customers.minCustomers (30 identified customers) and customers.minOrdersPerGroup (30 per compared group)
// No score, no prediction, no uplift, no future revenue.

import { WINDOW_DAYS } from './facts.js';

export const AUDIENCE_VERSION = 'growth-audience.1';
/** Customer segments, mutually exclusive, assigned in this order (first match wins). */
export const SEGMENTS = ['reactivate', 'loyal', 'newReturned', 'new', 'returning', 'occasional', 'unknown'];
export const STATUSES = ['priority', 'activate', 'develop', 'watch', 'insufficient'];
const STATUS_RANK = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
/** Segments that bought in the window (the others are defined by NOT having bought in it). */
const ACTIVE = ['loyal', 'newReturned', 'new', 'returning', 'unknown'];
/** Segments that need an order history older than the window to exist at all. */
const NEEDS_HISTORY = ['reactivate', 'occasional'];
/** Main suggested action per segment (a verb for a human, never an automated action). */
export const SEGMENT_ACTION = { reactivate: 'reactivation', loyal: 'loyalty', newReturned: 'loyalty', new: 'secondPurchase', returning: 'loyalty', occasional: 'targetedOffer', unknown: 'none' };

const DAY = 86400000;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const share = (a, b) => (b > 0 ? round4(a / b) : null);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const inRange = (o, start, end) => o.at >= start && o.at < end;

/**
 * Order-level facts of one window (available in both modes).
 * @param {Array<object>} orders see facts.js (at, net, multiProduct, group)
 */
function orderFacts(orders, start, end) {
  const w = orders.filter((o) => inRange(o, start, end));
  const net = round2(sum(w, (o) => o.net));
  const groups = { new: 0, returning: 0, first_recorded_pos: 0, unknown: 0 };
  for (const o of w) groups[o.group] += 1;
  const known = groups.new + groups.returning + groups.first_recorded_pos;
  return {
    orders: w.length, netSales: net, aov: w.length ? round2(net / w.length) : null,
    multiProductShare: share(w.filter((o) => o.multiProduct).length, w.length),
    groups, returningOrderShare: share(groups.returning, known), knownIndexOrders: known,
    identifiedOrders: w.filter((o) => o.key).length,
  };
}

/** One identified customer's facts as of `end` (only orders strictly before `end`). */
function customerAsOf(orders, start, end) {
  const known = orders.filter((o) => o.at < end).sort((a, b) => a.at - b.at);
  if (!known.length) return null;
  const inWin = known.filter((o) => o.at >= start);
  const maxIdx = Math.max(0, ...known.map((o) => o.idx ?? 0));
  const first = known[0]; const last = known[known.length - 1];
  return {
    knownOrders: known.length, lifetimeLowerBound: Math.max(known.length, maxIdx),
    windowOrders: inWin.length, windowNet: sum(inWin, (o) => o.net), historyNet: sum(known, (o) => o.net),
    provenNewInWindow: first.at >= start && first.idx === 1,
    recencyDays: Math.floor((end - last.at) / DAY),
  };
}

/** The segment of one customer (first matching rule wins; see SEGMENTS and the definitions in the payload). */
export function segmentOf(c) {
  const bought = c.windowOrders > 0;
  if (!bought && c.lifetimeLowerBound >= 2) return 'reactivate';
  if (bought && c.lifetimeLowerBound >= 3) return 'loyal';
  if (bought && c.provenNewInWindow && c.windowOrders >= 2) return 'newReturned';
  if (bought && c.provenNewInWindow) return 'new';
  if (bought && c.lifetimeLowerBound === 2) return 'returning';
  if (!bought) return 'occasional'; // one known order, before the window
  return 'unknown'; // bought once in the window, but nothing proves whether it was a first order (no index / anonymous POS)
}

/** Segment sizes and sums of identified customers as of a window [start, end). */
function segmentsAsOf(byKey, start, end) {
  const out = Object.fromEntries(SEGMENTS.map((s) => [s, []]));
  for (const orders of byKey.values()) {
    const c = customerAsOf(orders, start, end);
    if (c) out[segmentOf(c)].push(c);
  }
  return out;
}

/**
 * @param {{ orders: object[], window: { start: Date, end: Date, prevStart: Date, days: number }, historyStart: Date|null,
 *   config: object, currency: string }} p  orders = facts.js output of ONE merchant
 */
export function buildAudience({ orders, window, historyStart, config, currency }) {
  const c = config.customers;
  const { start, end, prevStart } = window;
  const prevCovered = historyStart != null && historyStart <= prevStart; // the previous 90 days are fully inside the history
  const historyBeforeWindow = historyStart != null && historyStart < start; // older orders are visible: inactivity can be observed
  const historyDays = historyStart ? Math.max(0, Math.round((end - historyStart) / DAY)) : 0;
  const cur = orderFacts(orders, start, end);
  const prev = prevCovered ? orderFacts(orders, prevStart, start) : null;
  const base = {
    version: AUDIENCE_VERSION, currency,
    window: { start: start.toISOString(), end: end.toISOString(), days: window.days, previousComparable: prevCovered, historyDays },
    thresholds: { windowDays: WINDOW_DAYS, minCustomers: c.minCustomers, minGroup: c.minOrdersPerGroup, repeatOrders: 2, frequentOrders: 3 },
  };
  if (!orders.length || !cur.orders && !orders.some((o) => o.at < start)) {
    return { ...base, mode: 'empty', kpis: null, orderFacts: { current: cur, previous: prev }, segments: [], signals: [], actions: [], coverage: null };
  }

  const identified = orders.filter((o) => o.key && o.at < end);
  const coverage = { identifiedOrders: cur.identifiedOrders, orders: cur.orders, identifiedOrderShare: share(cur.identifiedOrders, cur.orders), anonymousOrders: cur.orders - cur.identifiedOrders };
  if (!identified.length) return aggregateMode({ base, cur, prev, coverage, c });

  // ---------------- customer mode ----------------
  const byKey = new Map();
  for (const o of identified) (byKey.get(o.key) ?? byKey.set(o.key, []).get(o.key)).push(o);
  const segNow = segmentsAsOf(byKey, start, end);
  const segPrev = prevCovered ? segmentsAsOf(byKey, prevStart, start) : null;
  const all = SEGMENTS.flatMap((s) => segNow[s]);
  const classified = all.length;
  const active = ACTIVE.flatMap((s) => segNow[s]);
  const activeNet = sum(active, (x) => x.windowNet);
  const sampleOpen = classified >= c.minCustomers;

  const segments = SEGMENTS.map((key) => {
    const list = segNow[key];
    const n = list.length;
    const historyOrders = sum(list, (x) => x.knownOrders);
    const historyNet = sum(list, (x) => x.historyNet);
    const windowNet = sum(list, (x) => x.windowNet);
    const customerShare = share(n, classified);
    const revenueShare = ACTIVE.includes(key) ? share(windowNet, activeNet) : null;
    const activeShare = ACTIVE.includes(key) ? share(n, active.length) : null;
    const previous = segPrev ? segPrev[key].length : null;
    // ---- status: explicit rules, first match wins ----
    const reasons = [];
    if (!sampleOpen) reasons.push('SAMPLE_BELOW_MIN_CUSTOMERS');
    if (n < c.minOrdersPerGroup) reasons.push('SEGMENT_BELOW_MIN_GROUP');
    if (NEEDS_HISTORY.includes(key) && !historyBeforeWindow) reasons.push('SHORT_HISTORY');
    if (key === 'unknown') reasons.push('FIRST_ORDER_NOT_PROVEN');
    let status; let rule;
    if (reasons.length) { status = 'insufficient'; rule = 'INSUFFICIENT'; }
    else if (key === 'reactivate') { status = 'activate'; rule = 'REPEAT_BUYERS_WITHOUT_RECENT_ORDER'; }
    else if (ACTIVE.includes(key) && key !== 'new' && revenueShare != null && activeShare != null && revenueShare > activeShare) { status = 'priority'; rule = 'REVENUE_SHARE_ABOVE_CUSTOMER_SHARE'; }
    else if (previous != null && n < previous) { status = 'watch'; rule = 'SMALLER_THAN_PREVIOUS_WINDOW'; }
    else { status = 'develop'; rule = key === 'occasional' ? 'ONE_ORDER_NOT_REPEATED' : 'ACTIVE_SEGMENT'; }
    const action = status === 'insufficient' ? 'none' : SEGMENT_ACTION[key];
    return {
      key, status, rule, reasons, action,
      customers: n, customerShare, activeShare, previousCustomers: previous,
      windowOrders: sum(list, (x) => x.windowOrders), windowNet: round2(windowNet), revenueShare,
      historyOrders, historyNet: round2(historyNet),
      ordersPerCustomer: n ? round2(historyOrders / n) : null,
      aov: historyOrders ? round2(historyNet / historyOrders) : null,
      medianRecencyDays: n ? median(list.map((x) => x.recencyDays)) : null,
      // A strong observation can later become a Growth opportunity (contract only: nothing is persisted).
      opportunity: status === 'activate' || status === 'priority' ? { kind: `audience${key.charAt(0).toUpperCase()}${key.slice(1)}`, segment: key } : null,
    };
  });
  const seg = Object.fromEntries(segments.map((s) => [s.key, s]));

  // ---- KPIs (unknown stays null, never 0) ----
  const repeatActive = active.filter((x) => x.lifetimeLowerBound >= 2).length;
  const prevActive = segPrev ? ACTIVE.flatMap((s) => segPrev[s]) : null;
  const newNow = seg.new.customers + seg.newReturned.customers;
  const newPrev = segPrev ? segPrev.new.length + segPrev.newReturned.length : null;
  const repeatRate = active.length >= c.minCustomers ? share(repeatActive, active.length) : null;
  const repeatRatePrev = prevActive && prevActive.length >= c.minCustomers ? share(prevActive.filter((x) => x.lifetimeLowerBound >= 2).length, prevActive.length) : null;
  const kpis = {
    activeCustomers: { value: active.length, previous: prevActive ? prevActive.length : null },
    newCustomers: { value: newNow, previous: newPrev },
    repeatRate: { value: repeatRate, previous: repeatRatePrev, gated: repeatRate == null, repeatCustomers: repeatActive },
    aov: { value: cur.aov, previous: prev ? prev.aov : null },
    toReactivate: { value: historyBeforeWindow ? seg.reactivate.customers : null, previous: segPrev && prevStart > historyStart ? segPrev.reactivate.length : null },
  };

  // ---- signals: fact -> comparison -> why it matters (2 to 4, fixed order, only when the sample gate is open) ----
  const signals = [];
  if (sampleOpen) {
    const repeatSegs = ['loyal', 'returning', 'newReturned'].map((k) => seg[k]);
    const rShare = share(sum(repeatSegs, (s) => s.customers), active.length);
    const rRev = share(sum(repeatSegs, (s) => s.windowNet), activeNet);
    if (rShare != null && rRev != null && rRev > rShare) signals.push({ code: 'repeatRevenueShare', customerShare: rShare, revenueShare: rRev });
    if (seg.reactivate.status === 'activate') signals.push({ code: 'reactivation', customers: seg.reactivate.customers, historyNet: seg.reactivate.historyNet, days: WINDOW_DAYS });
    if (repeatRate != null && repeatRatePrev != null && repeatRate !== repeatRatePrev) signals.push({ code: 'repeatRateChange', value: repeatRate, previous: repeatRatePrev });
    const repeatAov = aovOf(repeatSegs); const newAov = aovOf([seg.new]);
    if (repeatAov && newAov && sum(repeatSegs, (s) => s.customers) >= c.minOrdersPerGroup && seg.new.customers >= c.minOrdersPerGroup && repeatAov.value !== newAov.value) {
      signals.push({ code: 'aovGap', repeat: repeatAov.value, new: newAov.value });
    }
  }
  if (coverage.identifiedOrderShare != null && coverage.identifiedOrderShare < 1 && signals.length < 4) signals.push({ code: 'coverage', identifiedShare: coverage.identifiedOrderShare, anonymousOrders: coverage.anonymousOrders });

  // ---- actions (3 to 5 max): only for segments whose status allows a recommendation ----
  const ACTION_ORDER = ['reactivate', 'loyal', 'returning', 'newReturned', 'new', 'occasional'];
  const seen = new Set(); const actions = [];
  for (const k of ACTION_ORDER) {
    const s = seg[k];
    if (s.status === 'insufficient' || seen.has(s.action)) continue;
    seen.add(s.action);
    actions.push({ code: s.action, segment: k, customers: s.customers, status: s.status });
  }
  if (!actions.length && !sampleOpen) actions.push({ code: 'growSample', segment: null, customers: classified, status: 'insufficient' });

  segments.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.customers - a.customers || SEGMENTS.indexOf(a.key) - SEGMENTS.indexOf(b.key));
  return {
    ...base, mode: 'customer', sampleOpen, identifiedCustomers: classified,
    kpis, orderFacts: { current: cur, previous: prev }, segments, signals: signals.slice(0, 4), actions: actions.slice(0, 5), coverage,
  };
}

function aovOf(segs) {
  const orders = sum(segs, (s) => s.historyOrders);
  return orders ? { value: round2(sum(segs, (s) => s.historyNet) / orders) } : null;
}

/** No customer key anywhere: order-level facts only, and a clear statement of what needs the pseudonymous key. */
function aggregateMode({ base, cur, prev, coverage, c }) {
  // Same sample gates as the customers engine: 30 orders per compared group, 30 orders before basket facts are read.
  const signals = [];
  if (cur.returningOrderShare != null && cur.knownIndexOrders >= c.minOrdersPerGroup) signals.push({ code: 'returningOrders', share: cur.returningOrderShare, knownIndexOrders: cur.knownIndexOrders });
  if (cur.aov != null && prev?.aov != null && cur.aov !== prev.aov && cur.orders >= c.minOrdersPerGroup && prev.orders >= c.minOrdersPerGroup) signals.push({ code: 'aovChange', value: cur.aov, previous: prev.aov });
  if (cur.multiProductShare != null && cur.orders >= c.basket.minOrders) signals.push({ code: 'multiProduct', share: cur.multiProductShare, orders: cur.orders });
  signals.push({ code: 'customerLevelMissing' });
  return {
    ...base, mode: 'aggregate', sampleOpen: false, identifiedCustomers: 0,
    kpis: {
      orders: { value: cur.orders, previous: prev ? prev.orders : null },
      netSales: { value: cur.netSales, previous: prev ? prev.netSales : null },
      aov: { value: cur.aov, previous: prev ? prev.aov : null },
      returningOrderShare: { value: cur.returningOrderShare, previous: prev ? prev.returningOrderShare : null },
      multiProductShare: { value: cur.multiProductShare, previous: prev ? prev.multiProductShare : null },
    },
    orderFacts: { current: cur, previous: prev }, segments: [], signals: signals.slice(0, 4),
    actions: [{ code: 'enableCustomerKey', segment: null, customers: null, status: 'insufficient' }], coverage,
  };
}
