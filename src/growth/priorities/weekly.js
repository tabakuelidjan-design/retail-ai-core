// Développement des ventes > Opportunités: the (up to) three commercial actions to treat FIRST this week.
// Pure and deterministic: the commercial items of the priorities payload (each already validated by an engine with its own thresholds, each carrying the
// action prepared by actions.js) in, an ordered short list with its reasons out. It reads nothing, writes nothing, knows no commerce platform: it only sees Growth's normalised facts.
//
// There is NO explicit merchant goal in Growth today, so the COMMON RULE below applies. No score, no revenue estimate, no new business threshold.
//
// ELIGIBLE = a commercial item (engine-validated) that has a prepared action and is not BLOCKED. A missing datum blocks an action only when that datum is needed to justify or to run it:
//   MEASUREMENT_MISSING    the period of the figures is unknown (the justification and the later comparison need it);
//   COST_NOT_VERIFIED      a product visibility action (push / variant) whose purchase cost is not verified (the push engine requires a reliable margin; restock does not need the margin);
//   TARGET_MISSING         the product or the day to act on is unknown;
//   AUDIENCE_VOLUME_MISSING  the size of the segment is unknown (the email draft states it).
// Data corrections ("À corriger") and weak signals ("À surveiller") are never used to fill free places. A blocked candidate is reported with its reason, never silently dropped.
//
// RANKING = three comparisons, in this order. Items that compare equal share a LEVEL (same priority); nothing invents a commercial reason to separate them.
//   1. PROOF: no gap before one gap. A gap is a missing proof the engines themselves flag: an unverified purchase cost on a restock, or a variant proof that is incomplete
//      (sales window missing / different, unusable stock, cover not computable). Other reasons not to pick a variant (a tie, a low cover) are not gaps: they are decisions, with their own text.
//   2. FEASIBILITY: an action whose target and steps are known and that has no external prerequisite is "immediate"; an action that itself tells the merchant to check something outside
//      Nordla first is "prerequisite" (restock: the supplier lead time, which Growth does not have; email segment: authorised recipients and the real button link). Manual actions with a target count as feasible.
//      Same kind and equal figures (or an unknown one) = tied: stable order by id, said as such.
//   3. ONLY WITHIN THE SAME KIND (same unit, same period, same scope): the larger figure first - products: net sales; segments: customers; weekdays: share of store sales.
//      Different kinds are never compared (a segment's customers are not a variant's net units). Their order inside a level is a fixed display order (KIND_ORDER), then the id.
// The first three of the ordered list are the weekly priorities. The others stay in the list.

export const WEEKLY_MAX = 3;
/** Fixed display order of the kinds inside a level. It is NOT a priority between kinds. */
export const KIND_ORDER = ['product', 'storeWeekday', 'segment'];
/** The external checks a prepared action asks the merchant to make before acting (empty = none). The same list drives the confirmation in the opportunity sheet. */
export function prerequisitesOf(action) { const p = action ? PREREQUISITE[action.code] : null; return p ? [p] : []; }
/** Prepared actions that ask the merchant to check something outside Nordla before acting (from their own texts: "vérifier le délai fournisseur", "vérifiez les destinataires autorisés et ajoutez le lien"). */
const PREREQUISITE = { restock: 'supplierLeadTime', segment: 'recipientsAndLink' };
const VARIANT_PROOF_GAPS = ['WINDOW_MISSING', 'WINDOW_MISMATCH', 'STOCK_UNVERIFIED', 'COVER_UNKNOWN'];
const COST_CODES = ['costMissing', 'costUnverified'];
const CANDIDATE_SOURCES = ['products', 'audience', 'store'];

const finite = (v) => Number.isFinite(v);
const magnitudeOf = (i) => (i.kind === 'product' ? i.evidence?.netSales : i.kind === 'segment' ? i.evidence?.customers : i.kind === 'storeWeekday' ? i.evidence?.share : null);
const MAGNITUDE_NAME = { product: 'netSales', segment: 'customers', storeWeekday: 'share' };

/** The reason why a validated, prepared candidate cannot be proposed (null = eligible). */
export function blockerOf(item) {
  const a = item.preparedAction;
  if (!item.measurement || !item.measurement.start || !item.measurement.end) return 'MEASUREMENT_MISSING';
  if (item.kind === 'product') {
    if (!a.target?.id || !a.target?.title) return 'TARGET_MISSING';
    if (['variant', 'product'].includes(a.code) && item.dataBlocker === 'costNotVerified') return 'COST_NOT_VERIFIED';
  }
  if (item.kind === 'storeWeekday' && a.day == null) return 'TARGET_MISSING';
  if (item.kind === 'segment' && !finite(a.campaign?.customers)) return 'AUDIENCE_VOLUME_MISSING';
  return null;
}

function gapsOf(item) {
  const a = item.preparedAction; const gaps = [];
  if (a.code === 'restock' && (item.dataBlocker === 'costNotVerified' || (item.findings ?? []).some((f) => COST_CODES.includes(f.code)))) gaps.push('COST_UNVERIFIED');
  if (a.variantReason && VARIANT_PROOF_GAPS.includes(a.variantReason.code)) gaps.push(`VARIANT_${a.variantReason.code}`);
  return gaps;
}

/**
 * @param {object[]} commercial   result.sections.commercial (items with `preparedAction` and `measurement`)
 * @param {{ sources?: Record<string,string>, max?: number, confirmed?: Set<string> }} opts   sources = the payload's per-engine state ('ok' | 'unavailable');
 *   confirmed = ids of the items whose external prerequisites the merchant confirmed: they then count as immediate. The HTTP endpoint passes none: the confirmations live in the merchant's browser (follow-up history), the server ranking does not see them.
 * @returns {{ state: 'ok'|'empty'|'emptyPartial'|'unavailable', max: number, items: object[], blocked: {id: string, reason: string}[], unavailableSources: string[], rule: string }}
 */
export function rankWeeklyActions(commercial, { sources = {}, max = WEEKLY_MAX, confirmed = new Set() } = {}) {
  // Only the engines that can produce a commercial candidate count (Contenu produces data corrections, never a commercial action).
  const states = Object.entries(sources).filter(([k]) => CANDIDATE_SOURCES.includes(k));
  const unavailableSources = states.filter(([, v]) => v !== 'ok').map(([k]) => k).sort();
  const base = { max, blocked: [], unavailableSources, rule: 'growth-weekly.1' };
  if (states.length > 0 && unavailableSources.length === states.length) return { ...base, state: 'unavailable', items: [] };

  const blocked = []; const eligible = [];
  for (const item of Array.isArray(commercial) ? commercial : []) {
    if (!item || item.category !== 'commercial' || !item.preparedAction) continue; // not a prepared action: stays in the list, is not a weekly candidate
    const reason = blockerOf(item);
    if (reason) { blocked.push({ id: item.id, reason }); continue; }
    const gaps = gapsOf(item); const isConfirmed = confirmed.has(item.id); const prerequisite = isConfirmed ? null : (PREREQUISITE[item.preparedAction.code] ?? null);
    eligible.push({ item, gaps, prerequisite, isConfirmed, key: [gaps.length > 0 ? 1 : 0, prerequisite ? 1 : 0] });
  }
  const kindRank = (k) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };
  const mag = (e) => { const v = magnitudeOf(e.item); return finite(v) ? v : -Infinity; }; // unknown figure: displayed last within its kind, never a reason shown
  eligible.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || kindRank(a.item.kind) - kindRank(b.item.kind) || mag(b) - mag(a) || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));

  const levels = []; // dense level numbers over (proof, feasibility)
  for (const e of eligible) { const k = e.key.join('|'); if (!levels.includes(k)) levels.push(k); e.level = levels.indexOf(k) + 1; }
  const items = eligible.slice(0, max).map((e, index) => {
    const peers = eligible.filter((o) => o !== e && o.level === e.level);
    const sameKindAll = peers.filter((o) => o.item.kind === e.item.kind);
    const sameKind = sameKindAll.filter((o) => finite(magnitudeOf(o.item)) && finite(magnitudeOf(e.item)) && magnitudeOf(o.item) !== magnitudeOf(e.item));
    return {
      id: e.item.id, rank: index + 1, level: e.level, kind: e.item.kind,
      reasons: {
        validatedBy: e.item.sourcePage, // the engine that validated it, with its own thresholds
        gaps: e.gaps, // [] = nothing missing to justify it
        feasibility: e.prerequisite ? { code: 'prerequisite', prerequisite: e.prerequisite } : e.isConfirmed ? { code: 'immediate', confirmed: true } : { code: 'immediate' },
        // how it compares with the other eligible actions of the SAME level
        tie: peers.length === 0 ? 'alone' : sameKind.length ? { code: 'magnitude', metric: MAGNITUDE_NAME[e.item.kind], position: sameKind.every((o) => magnitudeOf(e.item) > magnitudeOf(o.item)) ? 'ahead' : sameKind.every((o) => magnitudeOf(e.item) < magnitudeOf(o.item)) ? 'behind' : 'between' } : sameKindAll.length ? 'equalFigures' : 'displayOrder',
      },
    };
  });
  return { ...base, state: items.length ? 'ok' : unavailableSources.length ? 'emptyPartial' : 'empty', items, blocked, eligibleCount: eligible.length };
}
