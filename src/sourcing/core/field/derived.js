// DEPENDENCY-AWARE DERIVED STATE. The case is the only source of truth; everything else (assessment, deal, merchant fit, truth card, recommendation, negotiation, ask list, evidence status, memory) is DERIVED.
// Each derived node declares exactly what it reads: slices of the case and projections of the assessment. A node is recomputed only when the fingerprint of those inputs changed; otherwise its previous
// result is reused. An old result is never overwritten: it moves to a bounded history, so "what did Nordla say before this change?" always has an answer.
//   a new price        -> the deal, the merchant fit, the recommendation, the negotiation plan, the evidence status      (not the compliance summary, not the ask list when nothing there changed)
//   a new certificate  -> the compliance summary, the truth card, the recommendation, the ask list, the evidence status (not the deal)
// `assess()` is one pure pass (about a millisecond): it is recomputed for a changed case and only for that case; the saving is in everything built on top of it and in the other cases of a comparison.
// Safety net (tested): the incremental result is always identical to a recompute from scratch.
import { assess } from '../case.js';
import { contentHash } from './offer-import.js';
import { dealIntelligence } from './deal.js';
import { assessMerchantFit } from './merchant-fit.js';
import { supplierTruthCard } from './truth-card.js';
import { negotiationPlan } from './negotiation.js';
import { askNow } from './ask-now.js';
import { decisionEvidenceStatus } from './evidence-status.js';
import { recommendationOf, whatChanged } from './revisions.js';
import { behaviourMemory } from './memory.js';
import { documentStatusOf } from '../provenance.js';

export const HISTORY_MAX = 5;
const fp = (...parts) => contentHash(JSON.stringify(parts));
const day = (now) => now.toISOString().slice(0, 10);
const last = (list) => list[list.length - 1];

// ---- slices of the case (cheap, deterministic) ------------------------------------------------------------------------------------------------------------------------------------------------------------
export const SLICE = {
  identity: (s) => [s.identity.workingName, s.identity.evidence, s.identity.identifiers, s.identity.countryOfOrigin, s.identity.photos.length, s.productObservations?.length ?? 0],
  placing: (s) => [s.placing, s.context],
  supplier: (s) => s.supplier,
  quote: (s) => { const q = last(s.quotes) ?? null; return q ? { ...q, at: undefined } : null; },
  sale: (s) => [s.sale, s.saleAmazon],
  costs: (s) => [s.costs, s.customs],
  documents: (s) => [s.documents.map((d) => [d.id, d.docType, d.confirmed, d.textSource, d.extraction?.models, d.extraction?.standards, d.extraction?.dates, d.text?.length ?? 0])],
  docClaims: (s) => s.documentLedger, // every statement the supplier made about a document
  docStates: (s) => [...new Set(s.documentLedger.map((d) => d.claim))].sort().map((c) => [c, documentStatusOf(s, c).status]), // where each claim stands now (the question engine does not care how many times it was repeated)
  safety: (s) => s.safetySnapshot ? [s.safetySnapshot.status, s.safetySnapshot.identityKey, s.safetySnapshot.source?.mode, s.safetySnapshot.source?.fetchedAt] : null,
  market: (s) => [s.amazon, s.marketSearches?.length ?? 0, last(s.marketSearches ?? [])?.id ?? null],
  ledger: (s) => [s.ledger.length, last(s.ledger)?.id ?? null], // append-only
  // the newest reviewed value of a few keys: a node that reads only these is not disturbed by an unrelated fact (a certificate claim must not re-price a deal)
  ledgerSample: (s) => ['quote.samplePrice', 'offer.sampleRefund'].map((k) => s.ledger.filter((e) => e.key === k).at(-1)?.value ?? null),
  ledgerSpecs: (s) => ['spec.material', 'offer.packaging', 'offer.customization', 'offer.accessories', 'product.dimensions', 'carton.dimensions', 'carton.qty', 'carton.grossWeight', 'supplier.type'].map((k) => s.ledger.filter((e) => e.key === k).at(-1)?.value ?? null),
  ledgerTerms: (s) => ['quote.samplePrice', 'offer.sampleRefund', 'offer.packaging', 'offer.customization', 'offer.accessories', 'offer.productionDays'].map((k) => s.ledger.filter((e) => e.key === k).at(-1)?.value ?? null),
  // only the SHAPE of the quote (what is stated, not how much): the question engine asks about what is missing, whatever the price
  candidates: (s) => s.candidates.map((c) => c.state).join(''), conflicts: (s) => s.conflicts.map((c) => `${c.id}:${c.state}`),
  quoteShape: (s) => { const q = last(s.quotes) ?? null; return q ? [Boolean(q.unitPrice || q.tiers?.length), q.moq != null, q.incoterm ?? null, q.port ?? null, q.leadTimeDays != null, q.payment?.depositPct != null, q.qty ?? null, q.moq ?? null] : null; },
  // WHICH facts are pending / confirmed / in conflict (not their values): the question engine asks about what is missing, whatever its value turns out to be
  askKeys: (s) => [...new Set(s.candidates.map((c) => `${c.key}|${c.context}|${c.state}`))].sort(),
  offers: (s) => s.offers.map((o) => o.id), quotes: (s) => s.quotes.length,
  samples: (s) => s.samples ?? [], external: (s) => (s.externalEvidence ?? []).map((e) => e.id),
  questionLog: (s) => [s.questionLog.length, last(s.questionLog)?.id ?? null, s.userQuestions.map((q) => `${q.id}:${q.state}`)],
  notes: (s) => s.notes.length, decisions: (s) => s.decisions.length,
};
const S = (s, ...names) => names.map((n) => SLICE[n](s));

// ---- projections of the assessment (what downstream nodes actually read from it) ------------------------------------------------------------------------------------------------------
export const PROJ = {
  econ: (a) => [a.landed?.status, a.landed?.totals?.landedPerUnitEurMinor ?? null, a.landed?.totals?.landedTotalEurMinor ?? null, a.landed?.isLowerBound === true, a.landed?.unknownCostComponents ?? [], a.landed?.criticalUnknown ?? [], a.maxPurchasePrice?.maxUnitPriceMinor ?? null, a.maxPurchasePrice?.status ?? null, a.maxPurchasePrice?.reason ?? null, a.economics?.contributionPct ?? null, a.economics?.classification ?? null, a.economics?.contributionIsUpperBound === true, a.economics?.priceBasis ?? null, a.economics?.reason ?? null, a.landed?.goods?.totalEurMinor ?? null],
  comp: (a) => [a.decision.verdict, a.decision.hardBlockers.map((b) => b.code), a.decision.conditions, a.decision.gaps?.missingDocs ?? [], a.decision.contradictions ?? [], a.decision.dimensions, a.safety.status, a.safety.source?.mode ?? null, a.identity.confidence?.level ?? null, fp(a.questions), a.negotiation?.documentsBeforeDeposit ?? []],
  marketP: (a) => [a.market?.observationCount ?? 0, a.marketPresence?.status ?? null],
};

/** every derived node: what it reads and how it is computed. `deps` lists the nodes whose result it uses. */
export const NODES = Object.freeze({
  assessment: { slices: ['identity', 'placing', 'supplier', 'quote', 'sale', 'costs', 'documents', 'safety', 'market'], extra: (ctx) => [day(ctx.now), ctx.externalsKey], run: (s, ctx) => assess(s, { now: ctx.now, externals: ctx.externals, ...(ctx.rulebook ? { rulebook: ctx.rulebook } : {}) }) },
  deal: { slices: ['quote', 'sale', 'costs', 'ledgerSample'], proj: ['econ'], profile: true, run: (s, ctx, r) => dealIntelligence(s, r.assessment, { profile: ctx.profile }) },
  merchantFit: { slices: ['identity', 'ledgerSpecs', 'notes', 'sale'], proj: ['econ', 'comp', 'marketP'], profile: true, run: (s, ctx, r) => assessMerchantFit(s, r.assessment, ctx.profile) },
  recommendation: { slices: ['conflicts', 'quote'], proj: ['econ', 'comp'], run: (s, ctx, r) => recommendationOf(s, r.assessment) },
  truthCard: { slices: ['supplier', 'quote', 'ledger', 'conflicts', 'documents', 'docClaims', 'samples', 'external', 'offers', 'questionLog', 'identity', 'candidates'], proj: ['econ', 'comp'], run: (s, ctx, r) => supplierTruthCard(s, r.assessment) },
  evidenceStatus: { slices: ['candidates', 'conflicts', 'quote', 'samples', 'identity'], proj: ['econ', 'comp'], run: (s, ctx, r) => decisionEvidenceStatus(s, r.assessment, { recommendation: r.recommendation }) },
  negotiation: { slices: ['quote', 'sale', 'ledgerTerms', 'offers'], proj: ['econ', 'comp'], profile: true, run: (s, ctx, r) => negotiationPlan({ state: s, a: r.assessment, deal: r.deal, profile: ctx.profile }) },
  askNow: { slices: ['identity', 'askKeys', 'conflicts', 'documents', 'docStates', 'quoteShape', 'questionLog'], proj: ['comp'], extra: (ctx) => [ctx.askState], run: (s, ctx, r) => askNow(s, r.assessment, { askState: ctx.askState }) },
  memory: { slices: ['ledger', 'conflicts', 'offers', 'quote', 'questionLog', 'documents', 'docClaims', 'candidates', 'samples'], proj: ['comp'], run: (s, ctx, r) => behaviourMemory(s, r.assessment) },
  whatChanged: { slices: ['quotes', 'offers', 'ledger', 'costs', 'sale'], run: (s, ctx, r) => whatChanged(s, { now: ctx.now, externals: ctx.externals, recorded: ctx.recorded ?? null }) },
});
const ORDER = ['assessment', 'deal', 'recommendation', 'merchantFit', 'truthCard', 'evidenceStatus', 'negotiation', 'askNow', 'memory', 'whatChanged'];

/** A cache of derived results, one entry per case and node. Plain JSON (it can be persisted): { [caseId]: { [node]: { fp, at, result, history: [{ fp, at, result }] } } }. */
export function createDerivedCache(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  return {
    store,
    export: () => JSON.parse(JSON.stringify(store)),
    entry: (caseId, node) => store[caseId]?.[node] ?? null,
    history: (caseId, node) => store[caseId]?.[node]?.history ?? [],
    drop: (caseId) => { delete store[caseId]; },
  };
}
export const NODE_NAMES = Object.freeze([...ORDER]);

/**
 * Brings the derived state of ONE case up to date. Recomputes a node only when its input fingerprint changed (or `force`); reports what was recomputed and what was reused.
 * @param {object} state the case  @param {object} cache from createDerivedCache()  @param {{ now?: Date, externals?: object, profile?: object|null, askState?: object, nodes?: string[], force?: boolean, rulebook?: object[] }} opts
 */
export function refreshDerived(state, cache, opts = {}) {
  const now = opts.now ?? new Date(); const profile = opts.profile ?? null; const ctx = { now, externals: opts.externals ?? {}, externalsKey: fp(opts.externals?.safety?.source ?? null, (opts.externals?.safety?.alerts ?? []).length), profile, askState: opts.askState ?? {}, rulebook: opts.rulebook ?? null };
  const want = new Set(opts.nodes ?? ORDER); const recomputed = []; const reused = []; const results = {}; const fps = {}; const slot = (cache.store[state.id] ??= {});
  const need = new Set(); const addNeed = (n) => { if (need.has(n)) return; need.add(n); for (const d of DEPS[n]) addNeed(d); }; for (const n of want) addNeed(n);
  for (const name of ORDER) {
    if (!need.has(name)) continue; const def = NODES[name];
    const parts = [S(state, ...def.slices), def.extra ? def.extra(ctx) : null, def.profile ? fp(profile) : null];
    if (def.proj) parts.push(def.proj.map((p) => PROJ[p](results.assessment)));
    for (const d of DEPS[name]) if (d !== 'assessment') parts.push(fps[d]); // a node that uses another node's RESULT depends on that node's fingerprint
    const f = fp(parts); fps[name] = f; const prev = slot[name];
    if (prev && prev.fp === f && !opts.force) { results[name] = prev.result; reused.push(name); continue; }
    const result = def.run(state, ctx, results);
    if (prev) { const history = [{ fp: prev.fp, at: prev.at, result: prev.result }, ...(prev.history ?? [])].slice(0, HISTORY_MAX); slot[name] = { fp: f, at: now.toISOString(), result, history }; } else slot[name] = { fp: f, at: now.toISOString(), result, history: [] };
    results[name] = result; recomputed.push(name);
  }
  return { results, recomputed, reused, fingerprints: fps };
}
const DEPS = { assessment: [], deal: ['assessment'], recommendation: ['assessment'], merchantFit: ['assessment'], truthCard: ['assessment'], evidenceStatus: ['assessment', 'recommendation'], negotiation: ['assessment', 'deal'], askNow: ['assessment'], memory: ['assessment'], whatChanged: [] };

/** An `assessFn` for compareCases(): reuses the cached assessment of every case that did not change, so a comparison of five suppliers recomputes one. */
export function cachedAssessFn(cache, { counter = null } = {}) {
  return (state, o) => {
    const def = NODES.assessment; const ctx = { now: o.now, externals: o.externals ?? {}, externalsKey: fp(o.externals?.safety?.source ?? null, (o.externals?.safety?.alerts ?? []).length) };
    const f = fp([S(state, ...def.slices), def.extra(ctx), null]); const slot = (cache.store[state.id] ??= {}); const prev = slot.assessment;
    if (prev && prev.fp === f) return prev.result;
    if (counter) counter.n += 1; const result = assess(state, o);
    slot.assessment = { fp: f, at: o.now.toISOString(), result, history: prev ? [{ fp: prev.fp, at: prev.at, result: prev.result }, ...(prev.history ?? [])].slice(0, HISTORY_MAX) : [] }; return result;
  };
}
