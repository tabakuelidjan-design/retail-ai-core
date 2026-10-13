// FIELD ENGINE: the one object the field screens talk to. It owns nothing that matters (the cases and the workspace are passed in; the derived cache can be thrown away and rebuilt) and it never writes
// to a case. Everything here is synchronous, deterministic and offline: the same code runs in the browser and on the server, so the phone keeps working with no connection.
import { compareCases } from '../comparison.js';
import { createDerivedCache, refreshDerived, cachedAssessFn } from './derived.js';
import { fieldComparison } from './field-comparison.js';
import { recordFromDerived, saveComparison, askStateOf, setView } from './workspace.js';
import { supplierHistory } from './memory.js';

const NEED = ['deal', 'merchantFit', 'recommendation', 'evidenceStatus', 'askNow', 'truthCard', 'negotiation'];

/** @param {{ profile?: object|null, externals?: () => object, now?: () => Date, cache?: object }} cfg */
export function createFieldEngine({ profile = null, externals = () => ({}), now = () => new Date(), cache = createDerivedCache() } = {}) {
  const ctx = (extra = {}) => ({ now: now(), externals: externals(), profile, ...extra });
  const refresh = (state, ws = null, extra = {}) => refreshDerived(state, cache, ctx({ askState: askStateOf(ws, state.id), ...extra }));
  /** every derived result of one case, brought up to date (only what changed is recomputed) */
  const caseView = (state, ws = null, nodes = null) => { const r = refresh(state, ws, nodes ? { nodes } : {}); return { ...r.results, recomputed: r.recomputed, reused: r.reused, fingerprints: r.fingerprints }; };
  /** one line per supplier case for the home screen: cheap (it needs the assessment, the recommendation and the evidence status) */
  const overview = (cases, ws = null) => cases.map((s) => {
    const v = refresh(s, ws, { nodes: ['recommendation', 'evidenceStatus', 'deal'] }).results; const a = v.assessment;
    return { caseId: s.id, title: s.identity?.workingName || s.id, supplier: s.supplier?.name ?? null, updatedAt: s.updatedAt, offers: (s.offers ?? []).length, recommendation: v.recommendation.value, role: v.recommendation.role, evidence: v.evidenceStatus.evidenceCompleteness, verdict: a.decision.verdict,
      price: v.deal.quoted.status === 'SUPPLIER_CLAIM' ? `${v.deal.quoted.unitPrice} ${v.deal.quoted.currency}` : null, landed: v.deal.landed.display, pending: s.candidates.filter((c) => c.state === 'PROPOSED').length, conflicts: s.conflicts.filter((c) => c.state === 'OPEN').length, blocked: v.recommendation.role === 'BLOCKED' };
  });
  /** the comparison of 2-5 cases, with the field view built over it. The saved definition is NOT needed to rebuild it: the cases are. */
  const compare = (cases, { id = null, ws = null, asOf = null } = {}) => {
    const t = asOf ? new Date(asOf) : now(); const set = compareCases(cases, { now: t, externals: externals(), assessFn: cachedAssessFn(cache), ...(id ? { id } : {}) });
    const derived = {}; for (const s of cases) { const r = refreshDerived(s, cache, ctx({ now: t, askState: askStateOf(ws, s.id), nodes: NEED })); derived[s.id] = r.results; }
    return { set, view: fieldComparison(set, derived), derived };
  };
  /** records what changed into the workspace (history of recommendations, fit, deal...) - nothing is recorded when the inputs are the same as the last record */
  const record = (ws, state, results = null) => { const r = results ?? { results: caseView(state, ws), fingerprints: refresh(state, ws).fingerprints }; return recordFromDerived(ws, state, { results: r.results ?? r, fingerprints: r.fingerprints }, now()); };
  const saveCmp = (ws, set, view, opts = {}) => saveComparison(ws, set, { now: now(), fieldView: view, ...opts });
  const suppliers = (cases, ws = null) => supplierHistory(cases, { recommendations: Object.values(ws?.snapshots ?? {}).flatMap((k) => k.recommendation ?? []).map((s) => ({ id: s.id, caseId: s.caseId, value: s.value, at: s.at, fingerprint: s.fingerprint })) });
  return { cache, refresh, caseView, overview, compare, record, saveComparison: saveCmp, suppliers, setView: (ws, view) => setView(ws, view, now()) };
}
