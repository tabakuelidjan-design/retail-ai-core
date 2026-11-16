/**
 * Prepare an editable action only after an existing engine validates the signal.
 * The caller supplies facts in Growth's format, independently of the commerce provider.
 */
export function prepareOpportunityAction(item, product, variantWindow, productWindow) {
  if (item.category !== 'commercial') return null;
  if (item.kind === 'storeWeekday') {
    return { code: 'storeWeekday', day: item.title.params.day };
  }
  if (item.kind === 'segment') {
    const purpose = item.explanation?.params?.action;
    if (!['reactivation', 'loyalty'].includes(purpose)) return null;
    return { code: 'segment', segment: item.entity.id, campaign: {
      purpose,
      customers: item.evidence.customers ?? null,
      days: item.evidence.days ?? null,
      baselineOrders: item.evidence.orders ?? null,
      // WHY this segment (the Audience engine's own rule and the figures it quotes) and the analysed period; the SIZE of the analysed segment is not a number of recipients.
      reason: { rule: item.evidence.rule ?? null, revenueShare: item.evidence.revenueShare ?? null, activeShare: item.evidence.activeShare ?? null, previousCustomers: item.evidence.previousCustomers ?? null },
      // The list of recipients that may actually be mailed (consent, unsubscribes, duplicates) lives in the merchant's e-mail tool: Growth does not have it. null = unknown;
      // a connection that knows it would supply { count, source }.
      eligible: null,
    } };
  }
  if (item.kind !== 'product') return null;

  const target = { id: item.entity.id, title: item.entity.title };
  const margin = product?.margin;
  const marginPct = margin?.tier === 'RELIABLE' && Number.isFinite(margin.pct) ? margin.pct : null;
  if (item.title.code === 'product.restock.title') return { code: 'restock', target, marginPct };

  const choice = chooseVariant(product?.variants ?? [], variantWindow, productWindow);
  return {
    code: choice.variant ? 'variant' : 'product',
    target,
    marginPct,
    variant: choice.variant,
    // Why Growth stays at the product level (null when a variant is chosen, or when the product has no variant to look at).
    variantReason: choice.reason,
  };
}

const ms = (v) => { const n = v == null ? NaN : new Date(v).getTime(); return Number.isFinite(n) ? n : null; };

/**
 * The sales windows must be the SAME on the same time base: the product engine's window (start, end) and the variant calculation's (since, until), both end-EXCLUDED.
 * A missing or different bound means the variant figures do not describe the period of the opportunity: no variant is chosen. The stock snapshot date is not a sales bound and is never compared.
 */
export function sameSalesWindow(productWindow, variantWindow) {
  const a = [ms(productWindow?.start), ms(productWindow?.end)];
  const b = [ms(variantWindow?.since), ms(variantWindow?.until)];
  if (a.includes(null) || b.includes(null)) return 'WINDOW_MISSING';
  return a[0] === b[0] && a[1] === b[1] ? null : 'WINDOW_MISMATCH';
}

/**
 * One variant, only when: the windows agree; every variant has a usable, dated stock; exactly one sold variant leads among those in stock; and that variant's COVER passes
 * the product engine's own push rule (src/demand/classify.js#computeCover, cover.lowWeeks): cover CALCULATED and weeks >= lowWeeks. The cover comes with the variant (variant.cover),
 * computed from its sellable stock and its net units over the same window; an unknown or stale stock has no cover (never 0). The length of the promotion is not known: the rule is the engine's.
 */
function chooseVariant(variants, variantWindow, productWindow) {
  if (!variants.length) return { variant: null, reason: null };
  const w = sameSalesWindow(productWindow, variantWindow);
  if (w) return { variant: null, reason: { code: w } };
  const allVerified = variants.every((v) => Number.isFinite(v.unitsNet) && v.stock?.usable === true && Number.isFinite(v.stock.units) && v.stock.snapshotAt);
  if (!allVerified) return { variant: null, reason: { code: 'STOCK_UNVERIFIED' } };
  const eligible = variants.filter((v) => v.stock.units > 0 && v.unitsNet > 0).sort((a, b) => b.unitsNet - a.unitsNet);
  const [leader, runnerUp] = eligible;
  if (!leader) return { variant: null, reason: { code: 'NO_VARIANT_IN_STOCK_WITH_SALES' } };
  if (leader.unitsNet <= (runnerUp?.unitsNet ?? 0)) return { variant: null, reason: { code: 'TIE' } };
  const c = leader.cover;
  if (!c || c.status !== 'CALCULATED' || !Number.isFinite(c.weeks) || !Number.isFinite(c.minWeeks)) return { variant: null, reason: { code: 'COVER_UNKNOWN', title: leader.title, status: c?.status ?? 'NOT_COMPUTED' } };
  if (c.weeks < c.minWeeks) return { variant: null, reason: { code: 'COVER_LOW', title: leader.title, weeks: c.weeks, minWeeks: c.minWeeks } };
  return { reason: null, variant: { id: leader.id, title: leader.title, unitsNet: leader.unitsNet, stockUnits: leader.stock.units, stockSnapshotAt: leader.stock.snapshotAt,
    coverWeeks: c.weeks, minCoverWeeks: c.minWeeks, since: variantWindow.since, until: variantWindow.until } };
}
