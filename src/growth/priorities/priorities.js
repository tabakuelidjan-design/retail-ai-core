// Développement des ventes > Opportunités - the priorities aggregator. Pure and deterministic: the four engines' payloads in
// (Produits Potentiels, Audience, Croissance magasin, Contenu), one list of priorities out, in three sections:
//   fix         "À corriger maintenant"     reliable data-quality problems, GROUPED BY PROBLEM (never one card per product);
//   commercial  "Opportunités commerciales" only what an engine already validated with its existing thresholds;
//   watch       "À surveiller"              interesting but too weak (or blocked by a guard) to become a recommendation.
//
// Rules (owner decisions 2026-09-28):
//   - nothing is recomputed and no threshold is read, lowered or invented here: every status comes from an engine;
//   - one product = at most ONE card: what several engines say about the same product is merged into that card's findings;
//   - guards win: a product that Produits Potentiels does not classify "À pousser" (push) or "Réassort avant promotion" (restock)
//     is never a commercial opportunity, whatever another engine suggests (e.g. a store highlight on a product with 4 sales);
//   - purchase costs that are not verified block "À pousser" and "Marge faible": shown as a data blocker, never "fixed" here
//     (cost verification belongs to a future shared capability, see docs/growth/README.md);
//   - aggregates only: no customer identifier, no per-customer row (Audience already returns segment aggregates only);
//   - every item has a STABLE id (same entity -> same id on every run) so a later status (to do / done / dismissed) can attach
//     to it without breaking existing items. No status is stored today.

export const PRIORITIES_VERSION = 'growth-priorities.1';
export const SECTIONS = ['fix', 'commercial', 'watch'];
export const SOURCES = ['products', 'audience', 'store', 'content'];
export const SOURCE_PAGE = { products: 'potential', audience: 'audience', store: 'storeGrowth', content: 'content' };

/** Produits Potentiels statuses that are a validated commercial opportunity (the engine's own opportunity contract). */
const COMMERCIAL_PRODUCT = ['push', 'restock'];
/** Produits Potentiels statuses that are a risk or a contradiction to look at (the engine's WATCH_GROUP). */
const WATCH_PRODUCT = ['watch', 'declining', 'lowMargin', 'returns'];
/** Audience segment statuses: opportunity (engine contract) vs signal to watch. */
const COMMERCIAL_SEGMENT = ['priority', 'activate'];
const WATCH_SEGMENT = ['watch'];
/** Content problems that make a recommendation weaker, in the order they are shown when equally frequent. */
const CONTENT_ORDER = ['noImage', 'noAltText', 'noType', 'noCollection', 'missingSku', 'duplicateTitle'];
const EXAMPLES = 3;

const byDesc = (f) => (a, b) => f(b) - f(a);
const bySold = (a, b) => (b.units || 0) - (a.units || 0) || (b.netSales || 0) - (a.netSales || 0) || String(a.title).localeCompare(String(b.title));

function usable(payload) { return payload != null && typeof payload === 'object' && !payload.error; }

/**
 * @param {{ products?: object|null, audience?: object|null, store?: object|null, content?: object|null, now?: Date }} p
 *   each value = the engine's payload (as its page receives it), or null when the source is not configured / failed.
 */
export function buildPriorities({ products = null, audience = null, store = null, content = null, now = new Date() } = {}) {
  const sources = Object.fromEntries(SOURCES.map((k) => [k, usable({ products, audience, store, content }[k]) ? 'ok' : 'unavailable']));
  const P = sources.products === 'ok' ? products : null;
  const A = sources.audience === 'ok' ? audience : null;
  const S = sources.store === 'ok' ? store : null;
  const C = sources.content === 'ok' ? content : null;

  const fix = [...costGroup(P), ...contentGroups(C)];
  const cards = productCards(P, S, C);
  const commercial = [...cards.filter((c) => c.category === 'commercial'), ...weekdayItems(S), ...segmentItems(A, 'commercial')];
  const watch = [...cards.filter((c) => c.category === 'watch'), ...segmentItems(A, 'watch')];

  const items = [...fix, ...commercial, ...watch];
  const ids = items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) throw new Error('priorities: duplicate id'); // one entity = one item, always

  return {
    version: PRIORITIES_VERSION,
    generatedAt: now.toISOString(),
    currency: (P && P.currency) || (S && S.currency) || (C && C.currency) || (A && A.currency) || 'EUR',
    window: { weeks: (P && P.window && P.window.weeks) || (S && S.window && S.window.weeks) || 8, audienceDays: (A && A.window && A.window.days) || null },
    sources,
    counts: { fix: fix.length, commercial: commercial.length, watch: watch.length, fixElements: fix.reduce((a, g) => a + g.evidence.count, 0) },
    sections: { fix, commercial, watch },
    waiting: waiting(P, A, S),
  };
}

// ---------------------------------------------------------------- À corriger maintenant ----------------------------------------------------------------

/** Purchase costs: products sold in the window whose margin rests on a missing or non-verified cost (Produits Potentiels tiers). */
function costGroup(P) {
  if (!P || !Array.isArray(P.rows)) return [];
  const rows = P.rows.filter((r) => r.margin && (r.margin.tier === 'UNVERIFIED' || r.margin.tier === 'MISSING' || r.margin.tier === 'PARTIAL'));
  if (!rows.length) return [];
  const missing = rows.filter((r) => r.margin.tier === 'MISSING').length;
  const blocked = rows.filter((r) => r.rule === 'RISING_DEMAND_BLOCKED');
  const examples = [...blocked.slice().sort(bySold), ...rows.filter((r) => r.rule !== 'RISING_DEMAND_BLOCKED').sort(bySold)].slice(0, EXAMPLES);
  return [{
    id: 'fix:purchase-cost',
    category: 'fix',
    kind: 'purchaseCost',
    title: { code: 'fix.purchaseCost.title', params: { count: rows.length } },
    explanation: { code: 'fix.purchaseCost.why', params: { blocked: blocked.length } },
    evidence: { count: rows.length, unverified: rows.length - missing, missing, blockedRecommendations: blocked.length, analysedProducts: P.rows.length },
    reliability: 'reliable',
    entity: { type: 'catalog', id: 'purchase-cost' },
    examples: examples.map((r) => ({ id: r.id, title: r.title })),
    sourcePage: SOURCE_PAGE.products,
    rankReason: 'blocksRecommendations',
    dataBlocker: 'costVerificationNotAvailable',
  }];
}

/** Content problems (Contenu), one group per problem code with its count, never one card per product. */
function contentGroups(C) {
  if (!C || !Array.isArray(C.problems)) return [];
  const rows = Array.isArray(C.rows) ? C.rows : [];
  return C.problems.filter((p) => p && p.count > 0).map((p) => {
    const affected = rows.filter((r) => Array.isArray(r.problems) && r.problems.includes(p.code));
    const sold = affected.filter((r) => (r.units || 0) > 0);
    return {
      id: `fix:content:${p.code}`,
      category: 'fix',
      kind: 'content',
      problem: p.code,
      title: { code: `fix.content.${p.code}.title`, params: { count: p.count } },
      explanation: { code: `fix.content.${p.code}.why`, params: {} },
      evidence: { count: p.count, soldAffected: sold.length, analysedProducts: C.scope ? C.scope.analysed : rows.length },
      reliability: 'reliable',
      entity: { type: 'catalog', id: `content:${p.code}` },
      examples: affected.slice().sort(bySold).slice(0, EXAMPLES).map((r) => ({ id: r.id, title: r.title })),
      sourcePage: SOURCE_PAGE.content,
      rankReason: sold.length ? 'affectsSoldProducts' : 'catalogOnly',
      dataBlocker: null,
    };
  }).sort((a, b) => b.evidence.soldAffected - a.evidence.soldAffected || b.evidence.count - a.evidence.count || CONTENT_ORDER.indexOf(a.problem) - CONTENT_ORDER.indexOf(b.problem));
}

// ---------------------------------------------------------------- products (merged across engines) ----------------------------------------------------------------

/**
 * One card per product that at least one engine flags as an opportunity or as something to watch. Everything the engines say about
 * that product is merged into `findings`; the card's category follows Produits Potentiels (the guard engine).
 */
function productCards(P, S, C) {
  const pp = new Map((P && Array.isArray(P.rows) ? P.rows : []).map((r) => [r.id, r]));
  const contentRows = new Map((C && Array.isArray(C.rows) ? C.rows : []).map((r) => [r.id, r]));
  const storeTop = S && Array.isArray(S.topProducts) ? S.topProducts : [];
  const storeRank = new Map(storeTop.map((p, i) => [p.id, { rank: i + 1, ...p }]));
  const storeActions = S && Array.isArray(S.actions) ? S.actions : [];
  const suggested = new Map(storeActions.filter((a) => a.productId && (a.code === 'highlightProduct' || a.code === 'restockFirst')).map((a) => [a.productId, a]));

  // Candidates: products with a commercial / watch status in Produits Potentiels, and products a store action points to.
  const ids = new Set([
    ...[...pp.values()].filter((r) => COMMERCIAL_PRODUCT.includes(r.status) || WATCH_PRODUCT.includes(r.status)).map((r) => r.id),
    ...suggested.keys(),
  ]);
  // The store's best seller, when a guard keeps it out of the highlight, is explained on its own card (never silently skipped).
  const firstStore = storeTop[0];
  if (firstStore && firstStore.highlightAllowed === false && pp.has(firstStore.id) && WATCH_PRODUCT.includes(pp.get(firstStore.id).status)) ids.add(firstStore.id);

  const cards = [];
  for (const id of ids) {
    const r = pp.get(id) || null;
    const st = storeRank.get(id) || null;
    const act = suggested.get(id) || null;
    const ct = contentRows.get(id) || null;
    const status = r ? r.status : null;
    const commercial = COMMERCIAL_PRODUCT.includes(status);
    const findings = [];
    if (r) findings.push(productFinding(r));
    if (st) findings.push({ id: `product:${id}:store`, source: 'store', code: act ? (commercial ? 'storeSuggested' : 'storeSuggestedNotRecommended') : (st.highlightAllowed === false ? 'storeTopBlocked' : 'storeTop'), params: { rank: st.rank, share: st.share } });
    if (r && r.margin && ['UNVERIFIED', 'MISSING', 'PARTIAL'].includes(r.margin.tier)) findings.push({ id: `product:${id}:cost`, source: 'products', code: r.margin.tier === 'MISSING' ? 'costMissing' : 'costUnverified', params: {} });
    if (ct && Array.isArray(ct.problems) && ct.problems.length) findings.push({ id: `product:${id}:content`, source: 'content', code: 'contentIncomplete', params: { problems: ct.problems.slice() } });
    const title = (r && r.title) || (st && st.title) || (ct && ct.title) || id;
    cards.push({
      id: `product:${id}`,
      category: commercial ? 'commercial' : 'watch',
      kind: 'product',
      title: { code: commercial ? `product.${status}.title` : 'product.watch.title', params: { product: title } },
      explanation: { code: commercial ? `product.${status}.why` : watchReason(r, act), params: {} },
      evidence: productEvidence(r, st, P),
      reliability: commercial ? 'reliable' : 'limited',
      entity: { type: 'product', id, title },
      findings,
      missing: commercial ? [] : missingFor(r, P),
      sourcePage: r ? SOURCE_PAGE.products : SOURCE_PAGE.store,
      relatedPages: [...new Set([r ? SOURCE_PAGE.products : null, st ? SOURCE_PAGE.store : null, ct && ct.problems && ct.problems.length ? SOURCE_PAGE.content : null].filter(Boolean))],
      rankReason: commercial ? 'engineValidated' : (act ? 'storeSuggestionBelowGuards' : `productStatus.${status}`),
      dataBlocker: r && r.margin && ['UNVERIFIED', 'MISSING', 'PARTIAL'].includes(r.margin.tier) ? 'costNotVerified' : null,
    });
  }
  // Commercial first by net sales; watch items: guard-blocked demand first, then by net sales.
  return cards.sort((a, b) => (b.evidence.netSales || 0) - (a.evidence.netSales || 0) || a.id.localeCompare(b.id));
}

function productFinding(r) {
  return { id: `product:${r.id}:potential`, source: 'products', code: `potential.${r.status}`, params: { rule: r.rule, trend: r.trend, top: !!r.top, topRank: r.topRank ?? null } };
}
function productEvidence(r, st, P) {
  return {
    units: r ? r.units : (st ? st.units : null),
    netSales: r ? r.netSales : (st ? st.net : null),
    weeks: P && P.window ? P.window.weeks : null,
    trend: r ? r.trend : null,
    storeRank: st ? st.rank : null,
    storeShare: st ? st.share : null,
    costTier: r && r.margin ? r.margin.tier : null,
  };
}
/** Why Nordla does not recommend acting yet, from the engine's own rule and reasons (never a new judgement). */
function watchReason(r, act) {
  if (!r) return 'product.watch.why.noProductEngine';
  if (r.rule === 'RISING_DEMAND_BLOCKED') return 'product.watch.why.risingBlocked';
  if (WATCH_PRODUCT.includes(r.status)) return `product.watch.why.${r.status}`;
  if (act) return 'product.watch.why.storeSuggestionThin';
  return 'product.watch.why.notValidated';
}
/** What is missing before Produits Potentiels could classify the product "À pousser" - read from the engine's reasons and thresholds. */
function missingFor(r, P) {
  if (!r) return [{ code: 'productHistory' }];
  const out = [];
  const reasons = Array.isArray(r.reasons) ? r.reasons : [];
  const th = (P && P.thresholds) || {};
  if (reasons.includes('COST_UNVERIFIED') || reasons.includes('COST_MISSING') || reasons.includes('MARGIN_PARTIAL')) out.push({ code: 'verifiedCost' });
  if (reasons.includes('TREND_INSUFFICIENT') || r.trend === 'INSUFFICIENT_DATA') out.push({ code: 'moreWeeks', params: { weeks: th.trend ? th.trend.minObservableWeeks : null, units: th.trend ? th.trend.minUnits : null } });
  else if (r.trend !== 'UP') out.push({ code: 'risingDemand' });
  if (reasons.includes('RETURNS_ELEVATED')) out.push({ code: 'fewerReturns' });
  return out;
}

// ---------------------------------------------------------------- store (non-product) and audience ----------------------------------------------------------------

/** A strong weekday is validated by Croissance magasin's own rule (30+ store orders, share >= 2/7): a commercial opportunity. */
function weekdayItems(S) {
  if (!S || !Array.isArray(S.actions)) return [];
  return S.actions.filter((a) => a.code === 'weekdayHighlight').map((a) => ({
    id: `store:weekday:${a.day}`,
    category: 'commercial',
    kind: 'storeWeekday',
    title: { code: 'store.weekday.title', params: { day: a.day } },
    explanation: { code: 'store.weekday.why', params: {} },
    evidence: { share: a.share, storeOrders: S.store ? S.store.orders : null, weeks: S.window ? S.window.weeks : null },
    reliability: 'reliable',
    entity: { type: 'store', id: `weekday:${a.day}` },
    sourcePage: SOURCE_PAGE.store,
    rankReason: 'engineValidated',
    dataBlocker: null,
  }));
}

/** Audience segments (aggregates only): an engine opportunity is commercial, a "watch" segment is a signal to watch. */
function segmentItems(A, category) {
  if (!A || !Array.isArray(A.segments)) return [];
  const statuses = category === 'commercial' ? COMMERCIAL_SEGMENT : WATCH_SEGMENT;
  return A.segments.filter((s) => statuses.includes(s.status) && (category !== 'commercial' || s.opportunity)).map((s) => ({
    id: `audience:segment:${s.key}`,
    category,
    kind: 'segment',
    title: { code: `segment.${s.key}.title`, params: { customers: s.customers } },
    explanation: { code: `segment.${category}.why`, params: { action: s.action } },
    evidence: { customers: s.customers, orders: s.windowOrders ?? null, revenueShare: s.revenueShare ?? null, days: A.window ? A.window.days : null },
    reliability: category === 'commercial' ? 'reliable' : 'limited',
    entity: { type: 'segment', id: s.key },
    sourcePage: SOURCE_PAGE.audience,
    rankReason: category === 'commercial' ? 'engineValidated' : 'segmentWatch',
    dataBlocker: null,
  }));
}

// ---------------------------------------------------------------- what Nordla is waiting for ----------------------------------------------------------------

/** Why the commercial section can be empty: read from the engines' own states, never estimated. */
function waiting(P, A, S) {
  const out = [];
  if (P && Array.isArray(P.rows)) {
    const insufficient = P.rows.filter((r) => r.status === 'insufficient').length;
    if (insufficient) out.push({ code: 'productSales', params: { insufficient, total: P.rows.length, weeks: P.window ? P.window.weeks : null, minUnits: P.thresholds ? P.thresholds.minUnits : null } });
    const unreliable = P.rows.filter((r) => r.margin && r.margin.tier !== 'RELIABLE').length;
    if (unreliable) out.push({ code: 'verifiedCosts', params: { count: unreliable, total: P.rows.length } });
  }
  if (A && A.thresholds) {
    const identified = A.identifiedCustomers ?? null;
    if (identified != null && identified < A.thresholds.minCustomers) out.push({ code: 'identifiedCustomers', params: { identified, min: A.thresholds.minCustomers } });
  }
  if (S && S.window) {
    if (S.window.previousComparable === false) out.push({ code: 'storeHistory', params: { weeks: S.window.weeks } });
    const minN = S.thresholds ? S.thresholds.minOrders : null;
    if (minN != null && S.online && S.online.orders < minN) out.push({ code: 'onlineOrders', params: { orders: S.online.orders, min: minN } });
    if (minN != null && S.store && S.store.orders < minN) out.push({ code: 'storeOrders', params: { orders: S.store.orders, min: minN } });
  }
  return out;
}
