// P11-LITE: side-by-side comparison of 2-5 existing sourcing cases (one case = one product from one supplier).
// PURE and DETERMINISTIC: same cases + same `now` + same externals => the same ComparisonSet, byte for byte. It reads the cases and their assessments; it never writes to a case.
// What it will NOT do: rank on price alone, turn an UNKNOWN into a number, name a winner on insufficient evidence, or take a company decision.
//   SOURCING_EVALUATION (what the evidence supports for each offer)  !=  BUSINESS_DECISION (the merchant / the Core: never taken here, never imported).
// Cell statuses: VERIFIED | SUPPLIER_CLAIM | ESTIMATED | UNKNOWN | CONFLICT. Nothing the supplier says is above SUPPLIER_CLAIM; nothing computed from claims is VERIFIED.
import { assess } from './case.js';
import { resolveUnitPrice, normalizeTiers } from './offers.js';

export const COMPARISON_SCHEMA = 1;
export const MIN_CANDIDATES = 2;
export const MAX_CANDIDATES = 5;
export const CELL = Object.freeze({ VERIFIED: 'VERIFIED', SUPPLIER_CLAIM: 'SUPPLIER_CLAIM', ESTIMATED: 'ESTIMATED', UNKNOWN: 'UNKNOWN', CONFLICT: 'CONFLICT' });
export const ROLE = Object.freeze({ PREFERRED: 'PREFERRED', VIABLE: 'VIABLE', INVESTIGATE: 'INVESTIGATE', BLOCKED: 'BLOCKED' });
export const RECOMMENDATION = Object.freeze({ BUY_CANDIDATE: 'BUY_CANDIDATE', INVESTIGATE: 'INVESTIGATE', PASS: 'PASS' });

export class ComparisonError extends Error { constructor(code, msg) { super(msg ?? code); this.code = code; } }

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const cell = (caseId, status, value, display, evidence = [], extra = {}) => ({ caseId, status, value, display, evidence, ...extra });
const ev = (kind, ref, status, note = null) => ({ kind, ref, status, note });

const latestLedger = (state, key) => (state.ledger ?? []).filter((e) => e.key === key).at(-1) ?? null;
const openConflicts = (state) => (state.conflicts ?? []).filter((c) => c.state === 'OPEN');
const conflictOn = (state, keyPrefix) => openConflicts(state).some((c) => String(c.key).startsWith(keyPrefix));

/** A supplier-quoted field: SUPPLIER_CLAIM (the provenance the ledger recorded is kept in the evidence), CONFLICT while the owner has not resolved a contradiction, UNKNOWN when absent. */
function quoteField(c, key, value, display, conflictKey) {
  const { state } = c; const id = state.id;
  if (conflictKey && conflictOn(state, conflictKey)) return cell(id, CELL.CONFLICT, null, 'conflicting statements: not resolved', [ev('conflict', conflictKey, CELL.CONFLICT, 'two different supplier statements are both on record')]);
  if (value === null || value === undefined || value === '') return cell(id, CELL.UNKNOWN, null, 'not known', []);
  const led = latestLedger(state, key);
  return cell(id, CELL.SUPPLIER_CLAIM, value, display, [ev('quote', key, CELL.SUPPLIER_CLAIM, led ? `ledger: ${led.status}${led.corrected ? ' (corrected by the owner)' : ''}` : 'typed into the quote')]);
}

function priceCell(c) {
  const { state } = c; const q = state.quotes?.at(-1) ?? null; const id = state.id;
  if (conflictOn(state, 'quote.unitPrice') || conflictOn(state, 'quote.tiers')) return quoteField(c, 'quote.unitPrice', null, '', 'quote.unitPrice');
  if (!q) return cell(id, CELL.UNKNOWN, null, 'no quote', []);
  const qty = q.qty ?? q.moq ?? null; const r = resolveUnitPrice(q, qty); const tiers = normalizeTiers(q.tiers);
  if (r.unitPrice === null) return cell(id, CELL.UNKNOWN, null, tiers.length ? 'price tiers do not cover this quantity (or are ambiguous)' : 'no unit price', [ev('quote', 'quote.tiers', CELL.UNKNOWN, r.reason ?? null)]);
  const cur = q.currency ?? null; const priceText = `${r.unitPrice}${cur ? ` ${cur}` : ' — currency to confirm'}`;
  return cell(id, CELL.SUPPLIER_CLAIM, { unitPrice: String(r.unitPrice), currency: cur, atQty: qty === null ? null : String(qty), tiers: tiers.map((t) => ({ minQty: t.minQty, unitPrice: t.unitPrice })) }, `${priceText}${qty ? ` for ${qty} pcs` : ''}${tiers.length ? ` (${tiers.length} price tiers)` : ''}`,
    [ev('quote', 'quote.unitPrice', CELL.SUPPLIER_CLAIM, latestLedger(state, 'quote.unitPrice') ? `ledger: ${latestLedger(state, 'quote.unitPrice').status}` : 'typed into the quote'), ...(r.flags ? [ev('quote', 'quote.tiers', CELL.SUPPLIER_CLAIM, r.flags.join(', '))] : [])]);
}

function landedCell(a, id) {
  const l = a.landed;
  if (!l || l.status === 'INFORMATION_INSUFFICIENT') return cell(id, CELL.UNKNOWN, null, `cannot be calculated: missing ${(l?.criticalUnknown ?? []).map((u) => String(u).replace(/^(costs|supplier)\./, '')).join(', ') || 'inputs'}`, [ev('assessment', 'landed', CELL.UNKNOWN, 'a landed cost with a critical unknown is never turned into a number')]);
  const minor = l.totals?.landedPerUnitEurMinor ?? null;
  if (minor === null || minor === undefined) return cell(id, CELL.UNKNOWN, null, 'no landed cost per unit', []);
  return cell(id, CELL.ESTIMATED, { perUnitEurMinor: minor, isLowerBound: l.isLowerBound === true }, `${(minor / 100).toFixed(2)} EUR per unit${l.isLowerBound ? ' (LOWER BOUND: some import costs not entered)' : ''}`, [ev('assessment', 'landed', CELL.ESTIMATED, `calculated from claims and typed estimates (${l.status})`)]);
}

function maxPriceCell(a, id) {
  const m = a.maxPurchasePrice;
  if (!m || m.maxUnitPriceMinor === null || m.maxUnitPriceMinor === undefined) return cell(id, CELL.UNKNOWN, null, 'not computable yet', []);
  return cell(id, CELL.ESTIMATED, { maxUnitPriceMinor: m.maxUnitPriceMinor, currency: m.currency ?? null, upperBound: m.upperBound === true }, `${(m.maxUnitPriceMinor / 100).toFixed(2)} ${m.currency ?? ''}${m.upperBound ? ' (UPPER BOUND)' : ''}`.trim(), [ev('assessment', 'maxPurchasePrice', CELL.ESTIMATED, 'depends on the selling price the owner entered')]);
}

function marginCell(a, id) {
  const e = a.economics;
  if (!e || e.contributionPct === null || e.contributionPct === undefined) return cell(id, CELL.UNKNOWN, null, e?.reason ? `not computable: ${e.reason}` : 'not computable', []);
  return cell(id, CELL.ESTIMATED, { contributionPct: e.contributionPct, classification: e.classification, isUpperBound: e.contributionIsUpperBound === true }, `${(e.contributionPct * 100).toFixed(1)}% (${String(e.classification).toLowerCase()})${e.contributionIsUpperBound ? ', UPPER BOUND' : ''}`, [ev('assessment', 'economics', CELL.ESTIMATED, `selling price basis: ${e.priceBasis ?? 'unknown'}`)]);
}

/** Compliance is an assessment, never a legal finding: ESTIMATED at best. It is VERIFIED only when a LIVE Safety Gate EXACT match blocks the product (an official, current source). */
function complianceCell(a, id) {
  const d = a.decision; const hard = d.hardBlockers.map((b) => b.code);
  const verifiedStop = hard.includes('SAFETY_ALERT_EXACT_MATCH') && a.safety.source?.mode === 'LIVE_VERIFIED';
  const status = d.contradictions?.length || hard.includes('DOCUMENT_CONTRADICTS_CASE') ? CELL.CONFLICT : verifiedStop ? CELL.VERIFIED : d.verdict === 'INSUFFICIENT_INFORMATION' ? CELL.UNKNOWN : CELL.ESTIMATED;
  return cell(id, status, { verdict: d.verdict, hardBlockers: hard, conditions: d.conditions.length }, `${d.verdict}${hard.length ? ` - blocked by ${hard.join(', ')}` : ''}${d.conditions.length ? ` (${d.conditions.length} conditions)` : ''}`,
    [ev('assessment', 'decision', status, 'decision support only: not a legal conclusion')]);
}

const STRENGTH_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };
/** Evidence strength from what the engines already say (no new score): documents against the case, identification, contradictions. */
export function evidenceStrength(a) {
  const dim = a.decision.dimensions; const sup = dim.supplierEvidence; const ident = dim.identification;
  if (sup === 'CONTRADICTORY') return { level: 'LOW', why: 'documents or statements contradict the case' };
  if (ident === 'LOW' || sup === 'INSUFFICIENT') return { level: 'LOW', why: ident === 'LOW' ? 'the product is not identified' : 'required evidence is missing' };
  if (sup === 'COMPLETE' && ident !== 'MEDIUM') return { level: 'HIGH', why: 'required evidence present and the product identified' };
  return { level: 'MEDIUM', why: sup === 'PARTIAL' ? 'part of the required evidence is present' : 'identification partly assumed' };
}
function evidenceCell(a, id) { const s = evidenceStrength(a); return cell(id, s.level === 'LOW' ? CELL.UNKNOWN : CELL.ESTIMATED, { level: s.level }, `${s.level}: ${s.why}`, [ev('assessment', 'supplierEvidence', CELL.ESTIMATED, s.why)]); }

function leadCell(c) { const q = c.state.quotes?.at(-1) ?? null; const d = q?.leadTimeDays; return quoteField(c, 'quote.leadTime', num(d) === null ? null : num(d), `${d} days`, 'quote.leadTime'); }
function moqCell(c) { const q = c.state.quotes?.at(-1) ?? null; const m = num(q?.moq); return quoteField(c, 'quote.moq', m, `${q?.moq} pcs`, 'quote.moq'); }
function termsCell(c) {
  const q = c.state.quotes?.at(-1) ?? null; const id = c.state.id;
  if (!q?.incoterm) return cell(id, CELL.UNKNOWN, null, 'no Incoterm', []);
  if (conflictOn(c.state, 'quote.incoterm') || conflictOn(c.state, 'quote.port')) return quoteField(c, 'quote.incoterm', null, '', 'quote.incoterm');
  const pay = q.payment?.depositPct != null ? `, ${q.payment.depositPct}% deposit` : '';
  return cell(id, CELL.SUPPLIER_CLAIM, { incoterm: q.incoterm, port: q.port ?? null, depositPct: q.payment?.depositPct ?? null }, `${q.incoterm}${q.port ? ` ${q.port}` : ''}${pay}`, [ev('quote', 'quote.incoterm', CELL.SUPPLIER_CLAIM, 'supplier statement')]);
}
function contradictionCell(c, a) {
  const open = openConflicts(c.state); const docs = a.decision.contradictions ?? []; const id = c.state.id;
  const n = open.length + docs.length;
  if (!n) return cell(id, CELL.ESTIMATED, { open: 0 }, 'none on record', [ev('case', 'conflicts', CELL.ESTIMATED, 'absence of a recorded contradiction is not proof that none exists')]);
  return cell(id, CELL.CONFLICT, { open: open.length, documents: docs.length, keys: open.map((x) => x.key) }, `${n} open: ${[...open.map((x) => x.key), ...docs.map(() => 'document vs case')].join(', ')}`, [ev('conflict', 'open', CELL.CONFLICT, 'resolve before relying on either value')]);
}
function missingEvidenceCell(a, id) {
  const miss = (a.decision.gaps?.missingDocs ?? []); const labels = miss.map((m) => String(m.docType ?? m.label ?? m.id ?? m));
  return cell(id, miss.length ? CELL.UNKNOWN : CELL.ESTIMATED, { missing: labels }, miss.length ? `${miss.length} missing: ${labels.slice(0, 4).join(', ')}` : 'no required document missing for the regimes that apply', [ev('assessment', 'gaps', miss.length ? CELL.UNKNOWN : CELL.ESTIMATED, 'what is required depends on the rules that apply today')]);
}

export const DIMENSIONS = Object.freeze([
  { key: 'unitPrice', label: 'Quoted unit price', labelFr: 'Prix unitaire proposé', numeric: true },
  { key: 'moq', label: 'Minimum order', labelFr: 'Minimum de commande', numeric: true },
  { key: 'landedCost', label: 'Landed cost per unit', labelFr: 'Coût rendu par pièce', numeric: true },
  { key: 'maxPurchasePrice', label: 'Maximum purchase price', labelFr: "Prix d'achat maximum", numeric: true },
  { key: 'margin', label: 'Margin', labelFr: 'Marge', numeric: true },
  { key: 'compliance', label: 'Compliance assessment', labelFr: 'Évaluation de conformité', numeric: false },
  { key: 'evidenceStrength', label: 'Evidence strength', labelFr: 'Solidité des preuves', numeric: false },
  { key: 'contradictions', label: 'Contradictions', labelFr: 'Contradictions', numeric: false },
  { key: 'missingEvidence', label: 'Missing evidence', labelFr: 'Preuves manquantes', numeric: false },
  { key: 'leadTime', label: 'Lead time', labelFr: 'Délai', numeric: true },
  { key: 'terms', label: 'Shipping and payment terms', labelFr: "Conditions d'expédition et de paiement", numeric: false },
]);

export function cellsOf(c, a) {
  const id = c.state.id;
  return { unitPrice: priceCell(c), moq: moqCell(c), landedCost: landedCell(a, id), maxPurchasePrice: maxPriceCell(a, id), margin: marginCell(a, id), compliance: complianceCell(a, id), evidenceStrength: evidenceCell(a, id), contradictions: contradictionCell(c, a), missingEvidence: missingEvidenceCell(a, id), leadTime: leadCell(c), terms: termsCell(c) };
}

/** SOURCING role of one offer from what the engines already concluded. UNKNOWN never counts against a case: it makes it INVESTIGATE, not BLOCKED. */
export function roleOf(a, cells) {
  const d = a.decision;
  if (d.verdict === 'NO_GO' || d.hardBlockers.some((b) => ['SAFETY_ALERT_EXACT_MATCH', 'DOCUMENT_CONTRADICTS_CASE', 'NEGATIVE_UNIT_ECONOMICS', 'AMAZON_CATEGORY_RESTRICTION'].includes(b.code))) return { role: ROLE.BLOCKED, why: `blocked: ${d.hardBlockers.map((b) => b.code).join(', ') || d.verdict}` };
  const reasons = [];
  if (d.verdict === 'INSUFFICIENT_INFORMATION') reasons.push('assessment cannot conclude yet (missing information)');
  if (cells.landedCost.status === CELL.UNKNOWN) reasons.push('landed cost unknown');
  else if (cells.landedCost.value?.isLowerBound) reasons.push('landed cost is only a lower bound');
  if (cells.contradictions.status === CELL.CONFLICT) reasons.push('open contradiction');
  if (cells.unitPrice.status !== CELL.SUPPLIER_CLAIM) reasons.push('no usable unit price');
  if (cells.evidenceStrength.value?.level === 'LOW') reasons.push('evidence too weak');
  if (cells.margin.status === CELL.UNKNOWN) reasons.push('margin unknown');
  if (reasons.length) return { role: ROLE.INVESTIGATE, why: reasons.join('; ') };
  return { role: ROLE.VIABLE, why: `${d.verdict}${d.conditions.length ? ` with ${d.conditions.length} condition(s) to clear before any deposit` : ''}` };
}

const NUMERIC = {
  landed: (cs) => cs.landedCost.value?.perUnitEurMinor ?? null,
  margin: (cs) => cs.margin.value?.contributionPct ?? null,
  evidence: (cs) => STRENGTH_RANK[cs.evidenceStrength.value?.level] ?? null,
  missing: (cs) => cs.missingEvidence.value?.missing?.length ?? null,
  moq: (cs) => num(cs.moq.value),
};
/** A dominates B only if EVERY dimension is known for both and A is no worse on all and strictly better on at least one. Any unknown means no dominance: nothing is guessed. */
export function dominates(A, B) {
  const spec = [['landed', -1], ['margin', 1], ['evidence', 1], ['missing', -1], ['moq', -1]];
  let strict = false;
  for (const [k, dir] of spec) { const a = NUMERIC[k](A); const b = NUMERIC[k](B); if (a === null || b === null) return false; const diff = (a - b) * dir; if (diff < 0) return false; if (diff > 0) strict = true; }
  return strict;
}

// ---------- ASK NEXT -------------------------------------------------------------------------------------------------------------------------------------------------
const W = { CONFLICT: 100, DOC_CONTRADICTION: 95, IDENTITY: 90, PRICE: 88, LANDED_INPUT: 82, MISSING_DOC: 80, MOQ: 75, TERMS: 70, CARTON: 45, LEAD: 40 };
/** Deterministic: the highest-weighted open unknown/conflict of the case. A bonus applies when the other offers have that very dimension known (the unknown then blocks the comparison). */
export function askNext(c, a, cells, others) {
  const out = [];
  const known = (k) => others.some((o) => o.cells[k].status !== CELL.UNKNOWN && o.cells[k].status !== CELL.CONFLICT);
  const qs = new Map((a.questions ?? []).map((q) => [q.id, q]));
  const push = (score, dimension, source, reason, q, key) => out.push({ score: score + (known(key ?? dimension) ? 5 : 0), dimension, source, reason, questionId: q?.id ?? null, en: q?.en ?? null, zh: q?.zh ?? null });
  for (const x of openConflicts(c.state)) push(W.CONFLICT, 'contradictions', 'CONFLICT', `two statements differ for ${x.key}`, { id: `conflict:${x.id}`, en: x.question?.en ?? null, zh: x.question?.zh ?? null }, 'contradictions');
  if (a.decision.contradictions?.length || a.decision.hardBlockers.some((b) => b.code === 'DOCUMENT_CONTRADICTS_CASE')) { const q = (a.questions ?? []).find((x) => /^doc_fix|^docfix/i.test(x.id)) ?? null; push(W.DOC_CONTRADICTION, 'compliance', 'QUESTION', 'a document names another model than the case', q, 'compliance'); }
  if (qs.has('model') || a.identity?.confidence?.level === 'LOW') push(W.IDENTITY, 'compliance', 'QUESTION', 'the exact product is not identified: nothing else can be tied to it', qs.get('model') ?? null, 'compliance');
  if (cells.unitPrice.status === CELL.UNKNOWN) push(W.PRICE, 'unitPrice', 'QUESTION', 'no usable unit price', qs.get('price') ?? null);
  if (cells.landedCost.status === CELL.UNKNOWN && cells.unitPrice.status !== CELL.UNKNOWN) { const q = qs.get('incoterm') ?? qs.get('carton') ?? null; push(W.LANDED_INPUT, 'landedCost', 'QUESTION', `landed cost cannot be calculated: ${cells.landedCost.display}`, q); }
  const md = a.decision.gaps?.missingDocs ?? []; if (md.length) { const q = (a.questions ?? []).find((x) => x.docType || /doc/i.test(x.topic ?? '')) ?? null; push(W.MISSING_DOC, 'missingEvidence', 'QUESTION', `required document missing: ${String(md[0].docType ?? md[0].label ?? md[0].id ?? md[0])}`, q); }
  if (cells.moq.status === CELL.UNKNOWN && cells.unitPrice.status !== CELL.UNKNOWN) push(W.MOQ, 'moq', 'DERIVED', 'minimum order quantity not stated', qs.get('price') ?? null);
  if (cells.terms.status === CELL.UNKNOWN) push(W.TERMS, 'terms', 'QUESTION', 'Incoterm / shipping terms unknown', qs.get('incoterm') ?? null);
  if (qs.has('carton')) push(W.CARTON, 'landedCost', 'QUESTION', 'carton data needed to estimate freight', qs.get('carton'), 'landedCost');
  if (cells.leadTime.status === CELL.UNKNOWN) push(W.LEAD, 'leadTime', 'QUESTION', 'lead time unknown', qs.get('lead_time') ?? null);
  out.sort((x, y) => y.score - x.score || x.dimension.localeCompare(y.dimension) || String(x.questionId).localeCompare(String(y.questionId)));
  const [top, ...rest] = out;
  return top ? { ...top, alternatives: rest.slice(0, 2).map((r) => ({ dimension: r.dimension, reason: r.reason, questionId: r.questionId })) } : null;
}

// ---------- cross-case conflicts --------------------------------------------------------------------------------------------------------------------------------------
function crossCaseConflicts(cands) {
  const out = []; const key = (c) => `${norm(c.state.supplier?.name)}|${norm(c.state.identity?.identifiers?.model)}`;
  for (let i = 0; i < cands.length; i += 1) for (let j = i + 1; j < cands.length; j += 1) {
    const A = cands[i]; const B = cands[j]; const ka = key(A); if (ka.startsWith('|') || ka.endsWith('|') || ka !== key(B)) continue; // same supplier AND same model, both stated
    const pairs = [['unitPrice', A.cells.unitPrice, B.cells.unitPrice, (c) => `${c.value?.unitPrice} ${c.value?.currency}`], ['moq', A.cells.moq, B.cells.moq, (c) => String(c.value)], ['terms', A.cells.terms, B.cells.terms, (c) => c.value?.incoterm]];
    for (const [dim, ca, cb, f] of pairs) { if (ca.status !== CELL.SUPPLIER_CLAIM || cb.status !== CELL.SUPPLIER_CLAIM) continue; const same = dim === 'unitPrice' ? ca.value.unitPrice === cb.value.unitPrice && ca.value.currency === cb.value.currency && ca.value.atQty === cb.value.atQty : JSON.stringify(ca.value) === JSON.stringify(cb.value); if (!same) out.push({ kind: 'CROSS_CASE_CLAIM', dimension: dim, caseIds: [A.state.id, B.state.id], status: CELL.CONFLICT, description: `the same supplier and model are quoted differently in two cases (${dim}): ${f(ca)} vs ${f(cb)}`, resolution: 'NOT_RESOLVED: ask the supplier which one stands' }); }
  }
  return out;
}

const caseConflicts = (c) => openConflicts(c.state).map((x) => ({ kind: 'CASE_CONFLICT', dimension: String(x.key), caseIds: [c.state.id], status: CELL.CONFLICT, description: `two supplier statements differ for ${x.key}`, entries: clone(x.entries ?? []), resolution: 'NOT_RESOLVED: the owner chooses' }));

/**
 * @param {object[]} cases 2-5 DISTINCT case states (they are not modified)
 * @param {{ now?: Date, externals?: object, assessFn?: Function, rulebook?: object[], id?: string }} opts
 */
export function compareCases(cases, opts = {}) {
  if (!Array.isArray(cases) || cases.length < MIN_CANDIDATES || cases.length > MAX_CANDIDATES) throw new ComparisonError('COMPARISON_SIZE', `a comparison needs ${MIN_CANDIDATES} to ${MAX_CANDIDATES} cases (got ${Array.isArray(cases) ? cases.length : 'none'})`);
  const ids = cases.map((c) => c?.id); if (ids.some((i) => !i) || new Set(ids).size !== ids.length) throw new ComparisonError('COMPARISON_DUPLICATE', 'each case must appear once and have an id');
  const now = opts.now ?? new Date(); const assessFn = opts.assessFn ?? assess;
  const base = cases.map((s) => { const state = clone(s); const a = assessFn(state, { now, externals: opts.externals ?? {}, ...(opts.rulebook ? { rulebook: opts.rulebook } : {}) }); const c = { state }; return { c, a, cells: cellsOf(c, a) }; });
  const cands = base.map(({ c, a, cells }) => { const r = roleOf(a, cells); return { state: c.state, a, cells, role: r.role, why: r.why }; });

  // PREFERRED only among VIABLE offers, only by multi-dimension DOMINANCE, and never while a comparable offer is merely unknown or in conflict.
  const viable = cands.filter((x) => x.role === ROLE.VIABLE); const notEliminated = cands.filter((x) => x.role !== ROLE.BLOCKED);
  let preferred = null; let noWinnerReason = null;
  if (!viable.length) noWinnerReason = 'no offer is viable on the evidence available';
  else if (notEliminated.length > viable.length) noWinnerReason = `${notEliminated.length - viable.length} offer(s) are still unknown or in conflict: investigate them before concluding (an unknown is not a defect)`;
  else if (viable.length === 1) preferred = viable[0];
  else { const doms = viable.filter((x) => viable.every((y) => y === x || dominates(x.cells, y.cells))); if (doms.length === 1) preferred = doms[0]; else noWinnerReason = 'trade-offs between viable offers: none is at least as good on every compared dimension (price alone never decides)'; }
  if (preferred) preferred.role = ROLE.PREFERRED;

  const candidates = cands.map((x) => {
    const others = cands.filter((o) => o !== x);
    const rec = x.role === ROLE.BLOCKED ? RECOMMENDATION.PASS : x.role === ROLE.PREFERRED && x.a.decision.verdict !== 'INSUFFICIENT_INFORMATION' ? RECOMMENDATION.BUY_CANDIDATE : RECOMMENDATION.INVESTIGATE;
    const conds = x.a.decision.conditions;
    return {
      caseId: x.state.id, name: x.state.identity?.workingName ?? '', supplier: x.state.supplier?.name ?? null, role: x.role, roleWhy: x.why,
      sourcingEvaluation: { verdict: x.a.decision.verdict, evidence: evidenceStrength(x.a), blockers: x.a.decision.hardBlockers.map((b) => b.code), conditions: conds.slice(), missing: x.cells.missingEvidence.value?.missing ?? [] },
      recommendation: { value: rec, authority: 'SOURCING_EVALUATION', status: 'RECOMMENDATION_PENDING_APPROVAL', businessDecision: 'NOT_DECIDED', requiresMerchantApproval: true, canCommitMoney: false, note: 'A sourcing recommendation only. The company decision (and any payment) stays with the merchant / the Core.' },
      askNext: askNext(x, x.a, x.cells, others.map((o) => ({ cells: o.cells }))),
    };
  });
  const dimensions = DIMENSIONS.map((d) => ({ key: d.key, label: d.label, labelFr: d.labelFr, comparable: dimensionComparable(d, cands), cells: cands.map((x) => x.cells[d.key]) }));
  const conflicts = [...cands.flatMap((x) => caseConflicts(x)), ...crossCaseConflicts(cands)];
  const counts = Object.fromEntries(Object.values(ROLE).map((r) => [r, candidates.filter((x) => x.role === r).length]));
  const summary = { candidateCount: candidates.length, counts, preferredCaseId: preferred?.state.id ?? null, noWinnerReason: preferred ? null : noWinnerReason, priceOnlyWinner: false, openConflicts: conflicts.length, note: 'Evaluation of the offers on the evidence on record. UNKNOWN stays UNKNOWN; nothing here is a business decision.' };
  return { schema: COMPARISON_SCHEMA, id: opts.id ?? `cmp-${ids.slice().sort().join('+')}`, asOf: now.toISOString(), caseIds: ids.slice(), candidates, dimensions, conflicts, summary };
}

/** A numeric dimension is comparable only if every offer has a known value in the same unit/currency; otherwise the table shows the values and compares nothing. */
function dimensionComparable(d, cands) {
  const cs = cands.map((x) => x.cells[d.key]); if (!d.numeric) return false;
  if (cs.some((c) => c.status === CELL.UNKNOWN || c.status === CELL.CONFLICT)) return false;
  if (d.key === 'unitPrice') return new Set(cs.map((c) => c.value.currency)).size === 1 && new Set(cs.map((c) => c.value.atQty)).size === 1;
  return true;
}

/** What is saved to resume later: only the DEFINITION (which cases, as of when). The set is recomputed from the cases, so it can never drift from them. */
export const comparisonDefinition = (set) => ({ schema: set.schema, id: set.id, caseIds: set.caseIds.slice(), asOf: set.asOf });
export function recomputeComparison(def, casesById, opts = {}) {
  const cases = def.caseIds.map((id) => casesById[id]); if (cases.some((c) => !c)) throw new ComparisonError('COMPARISON_CASE_MISSING', 'a case of this comparison is no longer available');
  return compareCases(cases, { ...opts, now: new Date(def.asOf), id: def.id });
}

// ---------- mobile-readable contract ----------------------------------------------------------------------------------------------------------------------------------
const MOBILE_MAX = 78; const FR = { PREFERRED: 'Préféré', VIABLE: 'Viable', INVESTIGATE: 'À creuser', BLOCKED: 'Bloqué', BUY_CANDIDATE: "Candidat à l'achat", PASS: 'Passer', INVESTIGATE_R: 'À creuser' };
const MARK = { VERIFIED: '✓', SUPPLIER_CLAIM: '◐', ESTIMATED: '≈', UNKNOWN: '?', CONFLICT: '!' };
const cut = (s) => (s.length <= MOBILE_MAX ? s : `${s.slice(0, MOBILE_MAX - 1)}…`);
/** One card per offer, short lines, one marker per line, no table: readable at 390 px. Pure view over a ComparisonSet. */
export function toMobileView(set, { lang = 'fr' } = {}) {
  const fr = lang === 'fr'; const role = (r) => (fr ? FR[r] : r);
  const cards = set.candidates.map((cand, i) => ({
    caseId: cand.caseId, headline: cut(`${cand.name || cand.caseId}${cand.supplier ? ` · ${cand.supplier}` : ''}`), role: role(cand.role),
    recommendation: cut(`${fr ? (cand.recommendation.value === 'PASS' ? FR.PASS : cand.recommendation.value === 'BUY_CANDIDATE' ? FR.BUY_CANDIDATE : FR.INVESTIGATE_R) : cand.recommendation.value} (${fr ? 'à valider' : 'pending approval'})`),
    lines: set.dimensions.map((d) => { const c = d.cells[i]; return { label: cut(fr ? d.labelFr : d.label), text: cut(`${MARK[c.status]} ${c.display}`), status: c.status }; }),
    askNext: cand.askNext ? { text: cut(cand.askNext.en ?? cand.askNext.reason), dimension: cand.askNext.dimension, hasChinese: Boolean(cand.askNext.zh) } : null,
  }));
  return { lang, title: fr ? 'Comparaison des offres' : 'Offer comparison', legend: fr ? '✓ vérifié · ◐ dit par le fournisseur · ≈ estimé · ? inconnu · ! contradiction' : '✓ verified · ◐ supplier claim · ≈ estimated · ? unknown · ! conflict', cards,
    summary: cut(set.summary.preferredCaseId ? `${fr ? 'Préféré' : 'Preferred'}: ${set.summary.preferredCaseId}` : `${fr ? 'Pas de gagnant' : 'No winner'}: ${set.summary.noWinnerReason}`), maxLineLength: MOBILE_MAX };
}
