// Parle à Nordla - field facts (stages 2-4: SELECT the case, READ it, BUILD verified facts). Read-only and pure over a case state:
// every figure comes from the sourcing engine's own versioned code (assess) through the existing sourcingPurchaseFacts - there is no second calculator here.
// Nothing is written, journaled, fetched or ordered. A value the engine did not compute stays null, and null is said "inconnu", never replaced.
import { assess } from '../sourcing/core/case.js';
import { sourcingPurchaseFacts } from './sourcing-facts.js';
import { buildSourcingPurchaseSubject, sourcingPurchaseLevers } from '../buying/sourcing-purchase.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const minor = (v) => (isNum(v) ? v / 100 : null);

/** Free text that came from a case (product name, supplier wording, document labels) is DATA: one line, no control characters, bounded. It is quoted in answers, never obeyed. */
export const safeText = (s, max = 120) => Array.from(String(s ?? '')).map((ch) => { const c = ch.codePointAt(0); return c < 32 || c === 127 || c === 0x2028 || c === 0x2029 ? ' ' : ch; }).join('').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @returns the snapshot of ONE case: identity of the source (id + version), verdict, blockers, conditions, missing documents, supplier questions, economics, freshness, unknowns.
 * `assessment` (the engine output) is kept for the answer builders that need a sub-structure; they only read it.
 */
export function buildFieldSnapshot(state, { merchantId = 'local', now = new Date(), externals = {} } = {}) {
  const { input, scenarios, assessment: brief } = sourcingPurchaseFacts(state, { merchantId, now, externals });
  const a = assess(state, { now, externals });
  const d = a.decision; const quote = state.quotes?.at(-1) ?? null;
  const landed = a.landed ?? {}; const econ = a.economics ?? {};
  // order effects (cash out, margin if everything sells at the entered price) come from the Core's own lever builder: the same arithmetic the decision engine sees, not a copy of it
  let levers = []; try { levers = sourcingPurchaseLevers(buildSourcingPurchaseSubject(input), scenarios); } catch { levers = []; }
  const order = (id, qty) => { const l = levers.find((x) => x.id === id); return l ? { qty, landedTotal: l.estimated_cost?.amount ?? null, marginIfAllSold: l.estimated_effects?.margin_impact ?? null } : null; };
  const unitCurrency = quote?.currency ?? null;
  return {
    source: { kind: 'sourcing_case', ref: state.id, version: state.updatedAt ?? null, asOf: a.asOf, productName: safeText(input.product_name || state.id, 80) },
    verdict: d.verdict, canCommitMoney: d.canCommitMoney === true,
    hardBlockers: d.hardBlockers.map((b) => ({ code: b.code, detail: safeText(b.detail, 300) })),
    conditionBlockers: d.conditionBlockers.map((b) => ({ code: b.code, detail: safeText(b.detail, 300) })),
    conditions: d.conditions.map((c) => safeText(c, 400)),
    missingDocs: (d.gaps?.missingDocs ?? []).map((m) => ({ label: safeText(m.label, 160), docType: m.docType, ruleId: m.ruleId })),
    contradictions: (d.contradictions ?? []).map((c) => safeText(c.label ?? c, 200)),
    supplierQuestions: (a.questions ?? []).filter((q) => q.priority === 'P1').map((q) => ({ id: q.id, topic: q.topic, why: safeText(q.why, 200), en: safeText(q.en, 200), blocks: q.blocks ?? [] })),
    dimensions: d.dimensions, engineNextAction: safeText(d.nextAction, 500), unknowns: (a.evidence?.unknown ?? []).map((u) => ({ item: safeText(u.item, 60), note: safeText(u.note, 160) })),
    freshness: (a.freshness ?? []).map((f) => ({ name: f.name, status: f.status, checkedAt: f.checkedAt ?? null, mode: f.mode ?? null, version: f.version ?? null })),
    dataMode: a.dataMode,
    quote: quote ? { unitPrice: input.unit_price, currency: unitCurrency, qty: input.quote_qty, moq: input.moq, incoterm: safeText(quote.incoterm, 20) || null, leadTimeDays: input.lead_time_days } : null,
    economics: {
      landedStatus: landed.status ?? null, landedTotal: input.landed_total, landedPerUnit: input.landed_per_unit, landedLowerBound: input.landed_is_lower_bound,
      landedCriticalUnknown: (landed.criticalUnknown ?? []).map((u) => safeText(u, 60)), landedUnknownComponents: (landed.unknownCostComponents ?? []).map((u) => safeText(String(u).replace(/^costs\./, ''), 60)),
      economicsStatus: econ.status ?? null, economicsReason: safeText(econ.reason, 160) || null,
      contributionPerUnit: input.contribution_per_unit, contributionUpperBound: input.contribution_is_upper_bound, contributionPct: isNum(econ.contributionPct) ? econ.contributionPct : null,
      sellingPriceGross: minor(econ.sellingPriceGrossMinor), priceBasis: input.price_basis, targetContributionPct: isNum(econ.targetContributionPct) ? econ.targetContributionPct : null,
      maxUnitPrice: input.max_unit_price, maxUnitPriceCurrency: a.maxPurchasePrice?.currency ?? null, maxUnitPriceUpperBound: a.maxPurchasePrice?.upperBound === true,
      maxUnitPriceReason: a.maxPurchasePrice?.status !== 'COMPLETE' ? (safeText(a.maxPurchasePrice?.reason, 80) || null) : null,
    },
    orderQuoted: order('buying.ORDER_QUOTED_QTY', input.quote_qty), orderMoq: order('buying.ORDER_MOQ', input.moq),
    moqScenario: scenarios.moq, brief, assessment: a,
  };
}
