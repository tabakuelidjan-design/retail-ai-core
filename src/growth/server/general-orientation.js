// Growth reads the commerce context from Paramètres > Général (priority, expected result, deadline, featured offers, constraints) and ORIENTS the recommendations with it.
// READ ONLY and additive: the sales, margin and stock figures still come from the business sources; no ranking rule of the weekly actions is changed.
//   result.general          what Général says (or why nothing is said)
//   item.orientation        on a product opportunity whose title matches a featured offer: { featuredOffer }
//   result.general.focus    the ids of those opportunities, so the screen can put them forward
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const note = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** @param {object|null} ctx contextFor({ module: 'growth' }) @returns {object} the block `general` */
export function describeGeneral(ctx) {
  if (!ctx) return { state: 'NOT_AVAILABLE', reason: 'GENERAL_OFF' };
  const o = ctx.objectives ?? {}; const c = o.constraints ?? {};
  const priority = o.priority ? (o.priority.label ?? o.priority.value) : null; const offers = (o.featured_offers ?? []).map((x) => x.label).filter(Boolean);
  const constraints = { time: note(c.time?.note), stock: note(c.stock?.note), production: note(c.production?.note), budget: c.budget?.amount != null ? { amount: c.budget.amount, period: c.budget.period ?? null } : null };
  const empty = !priority && !o.expected_result && !o.deadline && !offers.length && !constraints.time && !constraints.stock && !constraints.production && !constraints.budget;
  return { state: empty ? 'EMPTY' : 'PRESENT', priority, expectedResult: o.expected_result ?? null, deadline: o.deadline ?? null, featuredOffers: offers, constraints, focus: [] };
}

/** Annotates `result` in place (never throws: a problem leaves the result as it was) and returns it. */
export function orientWithGeneral(result, ctx) {
  try {
    const general = describeGeneral(ctx); result.general = general;
    if (general.state !== 'PRESENT' || !general.featuredOffers.length) return result;
    const offers = general.featuredOffers.map((label) => ({ label, key: norm(label) })).filter((x) => x.key);
    for (const item of result.sections?.commercial ?? []) {
      if (item?.entity?.type !== 'product') continue; const title = norm(item.entity.title); if (!title) continue;
      const hit = offers.find((x) => title.includes(x.key) || x.key.includes(title));
      if (hit) { item.orientation = { featuredOffer: hit.label }; general.focus.push(item.id); }
    }
  } catch { /* the orientation is optional context */ }
  return result;
}
