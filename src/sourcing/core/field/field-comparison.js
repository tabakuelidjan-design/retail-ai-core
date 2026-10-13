// FIELD COMPARISON: the P11-lite comparison read for a person standing at a stand with a phone. It does not recompute or re-decide anything: it takes the ComparisonSet and the derived results of each
// case and ANSWERS THE QUESTIONS the owner asks in seconds - who looks strongest, who is cheapest, who has the best landed economics, who is blocked, who has weak evidence, who contradicts themselves,
// what to ask next, and why Nordla recommends what it recommends. "Cheapest" and "best" are different questions and are never merged: there is no price-only winner.
import { compareDeals } from './deal.js';
import { CELL, ROLE } from '../comparison.js';

const rankEv = { STRONG_EVIDENCE: 4, MEDIUM_EVIDENCE: 3, WEAK_EVIDENCE: 2, INSUFFICIENT_EVIDENCE: 1 };
const name = (c) => c.name ? (c.supplier ? `${c.supplier} · ${c.name}` : c.name) : (c.supplier ?? c.caseId);
const cellOf = (set, key, id) => set.dimensions.find((d) => d.key === key)?.cells.find((c) => c.caseId === id);
const short = (c) => c.supplier ?? c.name ?? c.caseId;

/**
 * @param {object} set the ComparisonSet  @param {Record<string, { deal, merchantFit, evidenceStatus, askNow, truthCard, negotiation }>} derived per case id
 * @returns the view model, in the order the phone shows it: summary, cards, decisive differences, risks and conflicts, economics, evidence, ask next, recommendation
 */
export function fieldComparison(set, derived) {
  const cands = set.candidates; const byId = new Map(cands.map((c) => [c.caseId, c])); const D = (id) => derived[id] ?? {};
  const pref = set.summary.preferredCaseId ? byId.get(set.summary.preferredCaseId) : null;
  // ---- the seven questions ------------------------------------------------------------------------------------------------------------------------------------------------------------
  const evOf = (id) => D(id).evidenceStatus?.evidenceCompleteness ?? 'INSUFFICIENT_EVIDENCE';
  const live = cands.filter((c) => c.role !== ROLE.BLOCKED);
  const bestEv = live.length ? Math.max(...live.map((c) => rankEv[evOf(c.caseId)])) : null;
  const bestSupported = bestEv === null ? [] : live.filter((c) => rankEv[evOf(c.caseId)] === bestEv);
  const deals = compareDeals(cands.map((c) => ({ caseId: c.caseId, name: short(c), deal: D(c.caseId).deal ?? { quoted: { status: 'UNKNOWN', unitPrice: null, currency: null, incoterm: null }, landed: { perUnitEurMinor: null, isLowerBound: false, unknownCostComponents: [] } } })));
  const blocked = cands.filter((c) => c.role === ROLE.BLOCKED).map((c) => ({ caseId: c.caseId, name: short(c), why: c.roleWhy }));
  const weak = cands.filter((c) => ['WEAK_EVIDENCE', 'INSUFFICIENT_EVIDENCE'].includes(evOf(c.caseId))).map((c) => ({ caseId: c.caseId, name: short(c), level: evOf(c.caseId), blocking: D(c.caseId).evidenceStatus?.blocking ?? [] }));
  const contradicting = cands.filter((c) => cellOf(set, 'contradictions', c.caseId)?.status === CELL.CONFLICT).map((c) => ({ caseId: c.caseId, name: short(c), what: cellOf(set, 'contradictions', c.caseId).display }));
  const answers = {
    strongest: pref ? { caseId: pref.caseId, name: short(pref), basis: 'PREFERRED: at least as good as every other viable offer on every compared dimension and strictly better on one' } : { caseId: null, name: null, basis: set.summary.noWinnerReason ?? 'no offer is preferred', bestSupported: bestSupported.map((c) => ({ caseId: c.caseId, name: short(c), level: evOf(c.caseId) })), note: 'Best-supported is not a winner: it only says whose evidence is most complete.' },
    cheapest: deals.cheapestQuote ? { ...deals.cheapestQuote, note: 'the lowest quoted unit price - not the best offer' } : { caseId: null, note: 'quotes cannot be compared (missing prices or different currencies)' },
    bestLanded: deals.bestLanded ? { ...deals.bestLanded, provisional: deals.provisional } : { caseId: null, note: 'no landed cost can be compared yet' },
    blocked, weakEvidence: weak, contradictions: contradicting,
    askNext: cands.map((c) => ({ caseId: c.caseId, name: short(c), items: (D(c.caseId).askNow?.items ?? []).slice(0, 3).map((i) => ({ id: i.id, kind: i.kind, en: i.en, fr: i.fr, why: i.why, zh: i.zh, ...(i.verify ? { verify: i.verify } : {}) })) })),
  };
  // ---- decisive differences ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  const decisive = [];
  const num = (key, pick) => { const d = set.dimensions.find((x) => x.key === key); if (!d || !d.comparable) return null; const vals = d.cells.map((c) => [c.caseId, pick(c.value)]).filter(([, v]) => v !== null && v !== undefined); return vals.length > 1 ? vals : null; };
  const spread = (key, label, pick, fmt, lowerIsBetter) => { const v = num(key, pick); if (!v) return; const s = v.slice().sort((a, b) => (lowerIsBetter ? a[1] - b[1] : b[1] - a[1])); if (s[0][1] === s.at(-1)[1]) return; decisive.push({ dimension: key, label, best: { caseId: s[0][0], name: short(byId.get(s[0][0])), text: fmt(s[0][1]) }, worst: { caseId: s.at(-1)[0], name: short(byId.get(s.at(-1)[0])), text: fmt(s.at(-1)[1]) } }); };
  spread('landedCost', 'Landed cost per unit', (v) => v.perUnitEurMinor, (x) => `${(x / 100).toFixed(2)} EUR`, true);
  spread('margin', 'Margin', (v) => v.contributionPct, (x) => `${(x * 100).toFixed(1)}%`, false);
  spread('moq', 'Minimum order', (v) => Number(v), (x) => `${x} pcs`, true);
  spread('leadTime', 'Lead time', (v) => Number(v), (x) => `${x} days`, true);
  if (deals.inversion) decisive.push({ dimension: 'cheapestVsLanded', label: 'Cheapest quote is not the cheapest landed', text: deals.reasons.join(' ') });
  const compl = set.dimensions.find((d) => d.key === 'compliance'); if (compl && new Set(compl.cells.map((c) => c.status)).size > 1) decisive.push({ dimension: 'compliance', label: 'Compliance assessment differs', text: compl.cells.map((c) => `${short(byId.get(c.caseId))}: ${c.display}`).join(' | ') });
  if (new Set(cands.map((c) => evOf(c.caseId))).size > 1) decisive.push({ dimension: 'evidence', label: 'Evidence completeness differs', text: cands.map((c) => `${short(c)}: ${evOf(c.caseId).replace('_EVIDENCE', '')}`).join(' | ') });
  // ---- cards -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const cards = cands.map((c) => {
    const d = D(c.caseId); const price = cellOf(set, 'unitPrice', c.caseId); const landed = cellOf(set, 'landedCost', c.caseId); const margin = cellOf(set, 'margin', c.caseId); const flags = [];
    if (c.role === ROLE.BLOCKED) flags.push({ kind: 'BLOCKED', text: c.roleWhy }); if (cellOf(set, 'contradictions', c.caseId)?.status === CELL.CONFLICT) flags.push({ kind: 'CONTRADICTION', text: cellOf(set, 'contradictions', c.caseId).display });
    if (['WEAK_EVIDENCE', 'INSUFFICIENT_EVIDENCE'].includes(evOf(c.caseId))) flags.push({ kind: 'WEAK_EVIDENCE', text: (d.evidenceStatus?.blocking ?? [])[0] ?? 'evidence is incomplete' });
    if (deals.cheapestQuote?.caseId === c.caseId) flags.push({ kind: 'CHEAPEST_QUOTE', text: 'lowest quoted price' }); if (deals.bestLanded?.caseId === c.caseId) flags.push({ kind: 'BEST_LANDED', text: deals.provisional ? 'lowest landed cost (provisional)' : 'lowest landed cost' });
    return { caseId: c.caseId, name: c.name, supplier: c.supplier, title: name(c), role: c.role, roleWhy: c.roleWhy, recommendation: c.recommendation.value, recommendationStatus: c.recommendation.status, evidenceCompleteness: evOf(c.caseId), fit: d.merchantFit?.label ?? null,
      price: { status: price.status, text: price.display }, landed: { status: landed.status, text: landed.display }, margin: { status: margin.status, text: margin.display }, flags, askTop: (d.askNow?.items ?? [])[0]?.en ?? null, askTopKind: (d.askNow?.items ?? [])[0]?.kind ?? null, askTopId: (d.askNow?.items ?? [])[0]?.id ?? null };
  });
  const risks = { conflicts: set.conflicts.map((x) => ({ kind: x.kind, dimension: x.dimension, caseIds: x.caseIds, text: x.description, resolution: x.resolution })), high: cands.flatMap((c) => Object.entries(D(c.caseId).truthCard?.risk ?? {}).filter(([, v]) => v.level === 'HIGH').map(([area, v]) => ({ caseId: c.caseId, name: short(c), area, why: v.why }))) };
  const evidence = cands.map((c) => ({ caseId: c.caseId, name: short(c), completeness: evOf(c.caseId), health: D(c.caseId).truthCard?.evidenceHealth.counts ?? null, blocking: D(c.caseId).evidenceStatus?.blocking ?? [], improve: D(c.caseId).evidenceStatus?.whatWouldImprove ?? [] }));
  // ---- why this recommendation --------------------------------------------------------------------------------------------------------------------------------------------------------
  const why = [];
  if (pref) {
    why.push(`${short(pref)} is the only offer that is at least as good as every other viable offer on every compared dimension (landed cost, margin, evidence, missing evidence, MOQ) and strictly better on at least one.`);
    for (const c of cands.filter((x) => x.caseId !== pref.caseId)) why.push(`${short(c)}: ${c.role === ROLE.BLOCKED ? `blocked (${c.roleWhy})` : c.role === ROLE.INVESTIGATE ? `still to investigate (${c.roleWhy})` : 'viable but not better on every dimension'}.`);
    if (pref.sourcingEvaluation.conditions.length) why.push(`Before any deposit: ${pref.sourcingEvaluation.conditions.slice(0, 3).join('; ')}.`);
    if (['WEAK_EVIDENCE', 'INSUFFICIENT_EVIDENCE'].includes(evOf(pref.caseId))) why.push(`The evidence behind it is ${evOf(pref.caseId).replace('_EVIDENCE', '').toLowerCase()}: ${(D(pref.caseId).evidenceStatus?.blocking ?? []).slice(0, 2).join('; ')}.`);
  } else { why.push(`No offer is recommended as a buy candidate: ${set.summary.noWinnerReason ?? 'no offer is viable on the evidence available'}.`); for (const c of cands) why.push(`${short(c)}: ${c.role.toLowerCase()} (${c.roleWhy}).`); if (deals.inversion) why.push(deals.reasons.join(' ')); }
  const recommendation = { caseId: pref?.caseId ?? null, value: pref ? pref.recommendation.value : 'INVESTIGATE', authority: 'SOURCING_EVALUATION', status: 'RECOMMENDATION_PENDING_APPROVAL', businessDecision: 'NOT_DECIDED', requiresMerchantApproval: true, canCommitMoney: false, why,
    perCase: cands.map((c) => ({ caseId: c.caseId, value: c.recommendation.value, evidenceCompleteness: evOf(c.caseId) })), note: 'A sourcing recommendation only. The company decision (and any payment) stays with the merchant.' };
  const headline = pref ? `${short(pref)} looks strongest` : set.summary.counts.BLOCKED === cands.length ? 'All offers are blocked' : 'No clear winner yet';
  const sections = ['summary', 'cards', 'decisive', 'risks', 'economics', 'evidence', 'askNext', 'recommendation'];
  return { type: 'FieldComparison', id: set.id, asOf: set.asOf, caseIds: set.caseIds, sections, summary: { headline, counts: set.summary.counts, noWinnerReason: set.summary.noWinnerReason, priceOnlyWinner: false, answers }, cards, decisive, risks, economics: { deals, perCase: cands.map((c) => ({ caseId: c.caseId, name: short(c), deal: D(c.caseId).deal ?? null })) }, evidence, askNext: answers.askNext, recommendation };
}
