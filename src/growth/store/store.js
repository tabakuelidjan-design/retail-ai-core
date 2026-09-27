// Growth > Croissance magasin - the store engine. Pure and deterministic: per-order facts in, aggregate in-store signals out.
// It answers "what happens in my physical point of sale, which growth signals can I really observe, which local actions are
// worth considering?" - from SALES only. Nordla has no footfall source: store orders are never visitors, a sales increase is
// never a traffic increase, and conversion / visitors / sales per visitor are NOT computed (reported as not connected).
//
// Rules (existing engine values unless stated):
//   - window: the last 8 complete weeks, compared with the 8 weeks before (same buckets as Produits Potentiels); a comparison is
//     only made when the business history covers the whole previous window;
//   - sample gate: customers.minOrdersPerGroup (30 orders per compared group) before any signal or recommendation;
//   - store channel: metrics/channels.js (pos = point_of_sale);
//   - several store locations: always aggregated as "all stores", with a per-location breakdown; never a silent pick of one;
//   - product guards: Produits Potentiels' own statuses (no second engine) - only push / topSeller / stable may be highlighted,
//     restock -> "restock before any in-store animation", every other status blocks the highlight;
//   - GROWTH V1 RULES (owner-validated 2026-09-28, to become configurable later - not universal truths):
//       * strong weekday: its share of the store's sales >= 2/7 (twice an even split) over the 8-week window, on 30+ store orders;
//       * product over-represented in store: share of store sales >= 2 x share of online sales, with 30+ orders on each side AND
//         the product sold in at least customers.basket.minPairSupport (3) separate store orders - the customers engine's own
//         minimum before a product pattern is reported. One sale, or several units in a single basket, never makes a signal.

export const STORE_VERSION = 'growth-store.1';
export const WEEKDAY_STRONG_SHARE = 2 / 7;
export const STORE_OVER_ONLINE_RATIO = 2;
export const HIGHLIGHT_ALLOWED = ['push', 'topSeller', 'stable'];
/** Future sources shown in "Pour aller plus loin" - none is connected, none is simulated. */
export const FUTURE_SOURCES = [
  { code: 'footfall', unlocks: ['conversion', 'visitors', 'salesPerVisitor'] },
  { code: 'googleBusiness', unlocks: ['directions', 'calls', 'localVisibility'] },
  { code: 'posEnriched', unlocks: ['staff', 'paymentMethods', 'hours'] },
];

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const share = (a, b) => (b > 0 ? round4(a / b) : null);
const change = (cur, prev) => (prev != null && prev > 0 && cur != null ? round4((cur - prev) / prev) : null);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const inW = (o, s, e) => o.at >= s && o.at < e;

function channelFacts(orders) {
  const net = round2(sum(orders, (o) => o.net));
  const units = sum(orders, (o) => o.units);
  return { orders: orders.length, net, aov: orders.length ? round2(net / orders.length) : null, units, refundRate: share(sum(orders, (o) => o.unitsRefunded), units) };
}
function productNet(orders) {
  const m = new Map();
  for (const o of orders) {
    const seen = new Set();
    for (const l of o.lines) if (l.productId) {
      const x = m.get(l.productId) ?? { net: 0, units: 0, orders: 0 }; x.net += l.net; x.units += l.units;
      if (!seen.has(l.productId)) { x.orders += 1; seen.add(l.productId); }
      m.set(l.productId, x);
    }
  }
  return m;
}

/**
 * @param {{ orders: object[], products: Map, locations: object[], windows: object, historyStart: Date|null,
 *   potential: Map<string, {status: string, action: string}>, config: object, currency: string }} p
 */
export function buildStore({ orders, products, locations, windows, historyStart, potential = new Map(), config, currency }) {
  const minN = config.customers.minOrdersPerGroup;
  const { start, end, prevStart } = windows;
  const comparable = historyStart != null && historyStart <= prevStart;
  const base = {
    version: STORE_VERSION, currency,
    window: { start: start.toISOString(), end: end.toISOString(), weeks: windows.current.length, previousComparable: comparable },
    thresholds: { minOrders: minN, weekdayStrongShare: round4(WEEKDAY_STRONG_SHARE), storeOverOnlineRatio: STORE_OVER_ONLINE_RATIO, productMinStoreOrders: config.customers.basket.minPairSupport, rulesVersion: 'v1' },
    footfall: { connected: false }, futureSources: FUTURE_SOURCES,
  };
  const storeEver = orders.some((o) => o.channel === 'store');
  // Channel absent: Nordla has never seen an in-store sale for this merchant - nothing is shown as 0.
  if (!storeEver) return { ...base, mode: 'noStore' };

  const cur = orders.filter((o) => inW(o, start, end));
  const prev = comparable ? orders.filter((o) => inW(o, prevStart, start)) : null;
  const storeCur = cur.filter((o) => o.channel === 'store');
  const storePrev = prev ? prev.filter((o) => o.channel === 'store') : null;
  const onlineCur = cur.filter((o) => o.channel === 'online');
  const onlinePrev = prev ? prev.filter((o) => o.channel === 'online') : null;
  const sc = channelFacts(storeCur); const sp = storePrev ? channelFacts(storePrev) : null;
  const oc = channelFacts(onlineCur); const op = onlinePrev ? channelFacts(onlinePrev) : null;
  const allNet = sum(cur, (o) => o.net); const allNetPrev = prev ? sum(prev, (o) => o.net) : null;

  // ---- locations: all stores aggregated, per-location breakdown (orders without a location stay a separate group) ----
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const byLoc = new Map();
  for (const o of storeCur) { const k = o.locationId ?? null; (byLoc.get(k) ?? byLoc.set(k, []).get(k)).push(o); }
  const locationRows = [...byLoc.entries()].map(([id, os]) => { const f = channelFacts(os); return { id, name: id ? (locName.get(id) ?? null) : null, known: id != null, orders: f.orders, net: f.net, aov: f.aov, share: share(f.net, sc.net) }; })
    .sort((a, b) => b.net - a.net || String(a.name).localeCompare(String(b.name)));

  const kpis = {
    storeNet: { value: sc.net, previous: sp ? sp.net : null, change: sp ? change(sc.net, sp.net) : null },
    storeOrders: { value: sc.orders, previous: sp ? sp.orders : null, change: sp ? change(sc.orders, sp.orders) : null },
    storeAov: { value: sc.aov, previous: sp ? sp.aov : null, change: sp ? change(sc.aov, sp.aov) : null },
    storeShare: { value: share(sc.net, allNet), previous: sp ? share(sp.net, allNetPrev) : null },
    locations: { value: locationRows.filter((l) => l.known).length, unknownLocationOrders: locationRows.filter((l) => !l.known).reduce((a, l) => a + l.orders, 0), total: locations.length },
  };

  // ---- weekly performance (store, previous window, online) ----
  const weekly = windows.current.map((w, i) => {
    const s = storeCur.filter((o) => inW(o, w.start, w.end)); const on = onlineCur.filter((o) => inW(o, w.start, w.end));
    const pw = windows.previous[i]; const ps = storePrev ? storePrev.filter((o) => inW(o, pw.start, pw.end)) : null;
    return { start: w.localStart, storeNet: round2(sum(s, (o) => o.net)), storeOrders: s.length, onlineNet: round2(sum(on, (o) => o.net)), prevStoreNet: ps ? round2(sum(ps, (o) => o.net)) : null, prevStoreOrders: ps ? ps.length : null };
  });

  // ---- sales activity by weekday (Monday first). Sales, not footfall; hours are not used. ----
  const weekdays = Array.from({ length: 7 }, (_, d) => { const os = storeCur.filter((o) => o.weekday === d); const f = channelFacts(os); return { day: d, orders: f.orders, net: f.net, aov: f.aov, share: share(f.net, sc.net) }; });

  // ---- products driving store sales (max 5), with Produits Potentiels' guard ----
  const pNow = productNet(storeCur); const pPrev = storePrev ? productNet(storePrev) : null;
  const topProducts = [...pNow.entries()].sort((a, b) => b[1].net - a[1].net || String(a[0]).localeCompare(String(b[0]))).slice(0, 5).map(([id, x]) => {
    const info = products.get(id) ?? {};
    const pot = potential.get(id) ?? null;
    return {
      id, title: info.title ?? null, imageUrl: info.imageUrl ?? null, category: info.category ?? null,
      net: round2(x.net), units: x.units, share: share(x.net, sc.net), change: pPrev ? change(x.net, pPrev.get(id)?.net ?? 0) : null,
      potentialStatus: pot?.status ?? null, highlightAllowed: pot != null && HIGHLIGHT_ALLOWED.includes(pot.status),
    };
  });

  // ---- store vs online (only with 30+ orders on both sides): facts, never reasons ----
  let differences = null;
  if (sc.orders >= minN && oc.orders >= minN) {
    const pOn = productNet(onlineCur);
    const minSupport = config.customers.basket.minPairSupport;
    const gaps = [...pNow.entries()].filter(([, x]) => x.orders >= minSupport).map(([id, x]) => ({ id, title: products.get(id)?.title ?? null, storeOrders: x.orders, storeShare: share(x.net, sc.net), onlineShare: share(pOn.get(id)?.net ?? 0, oc.net) }))
      .filter((g) => g.storeShare > 0 && g.storeShare >= STORE_OVER_ONLINE_RATIO * g.onlineShare).sort((a, b) => (b.storeShare - b.onlineShare) - (a.storeShare - a.onlineShare) || String(a.id).localeCompare(String(b.id))).slice(0, 3);
    differences = { storeAov: sc.aov, onlineAov: oc.aov, products: gaps };
  }

  // ---- signals: fact -> comparison -> why it matters (max 4, fixed order, sample-gated) ----
  const signals = [];
  const enough = (a, b) => a && b && a.orders >= minN && b.orders >= minN;
  if (enough(sc, sp) && enough(oc, op)) {
    const s = change(sc.net, sp.net); const o = change(oc.net, op.net);
    if (s != null && o != null && s !== o) signals.push({ code: 'storeVsOnline', store: s, online: o });
  }
  if (enough(sc, sp) && sc.orders > sp.orders && sc.aov < sp.aov) signals.push({ code: 'ordersUpAovDown', orders: change(sc.orders, sp.orders), aov: change(sc.aov, sp.aov) });
  else if (enough(sc, sp) && sc.orders < sp.orders && sc.aov > sp.aov) signals.push({ code: 'ordersDownAovUp', orders: change(sc.orders, sp.orders), aov: change(sc.aov, sp.aov) });
  const topDay = [...weekdays].sort((a, b) => b.net - a.net || a.day - b.day)[0];
  const strongDay = sc.orders >= minN && topDay.share != null && topDay.share >= WEEKDAY_STRONG_SHARE ? topDay : null;
  if (strongDay) signals.push({ code: 'strongWeekday', day: strongDay.day, share: strongDay.share, even: round4(1 / 7) });
  if (differences && differences.products.length) { const g = differences.products[0]; signals.push({ code: 'productGap', id: g.id, title: g.title, storeShare: g.storeShare, onlineShare: g.onlineShare }); }
  if (enough(sc, sp) && sc.refundRate != null && sp.refundRate != null && sc.refundRate > sp.refundRate) signals.push({ code: 'refundsUp', value: sc.refundRate, previous: sp.refundRate });

  // ---- local actions (max 4), each derived from a fact above; never from traffic ----
  const actions = [];
  if (sc.orders >= minN) {
    const restock = topProducts.find((p) => p.potentialStatus === 'restock');
    const highlight = topProducts.find((p) => p.highlightAllowed);
    if (restock) actions.push({ code: 'restockFirst', productId: restock.id, title: restock.title });
    if (highlight) actions.push({ code: 'highlightProduct', productId: highlight.id, title: highlight.title, share: highlight.share });
    if (strongDay) actions.push({ code: 'weekdayHighlight', day: strongDay.day, share: strongDay.share });
    if (signals.some((s) => s.code === 'ordersUpAovDown')) actions.push({ code: 'checkAov' });
  }

  const identifiedShare = share(storeCur.filter((o) => o.identified).length, storeCur.length);
  return {
    ...base, mode: 'store', kpis, store: sc, storePrevious: sp, online: oc, weekly, weekdays, topProducts, differences,
    locations: locationRows, signals: signals.slice(0, 4), actions: actions.slice(0, 4),
    audience: { identifiedShare, identifiable: identifiedShare != null && identifiedShare > 0 },
    // A strong store observation can later become a Growth opportunity (contract only: nothing is persisted).
    opportunities: actions.filter((a) => a.code === 'highlightProduct' || a.code === 'weekdayHighlight').map((a) => ({ kind: `store${a.code.charAt(0).toUpperCase()}${a.code.slice(1)}`, productId: a.productId ?? null, day: a.day ?? null })),
  };
}
