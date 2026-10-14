// DECISION EVIDENCE STATUS. How complete the evidence behind a recommendation is - NOT the probability that buying will succeed. The recommendation (BUY_CANDIDATE / INVESTIGATE / PASS) says
// what the evidence supports today; this says how much of the evidence is still missing, which items block, and what would raise it. Deterministic counting rules, printed with the result.
import { sampleState } from './external-evidence.js';
import { identificationStatus, MODEL_STATE } from './identity-gaps.js';
import { technicalGapText } from '../identity.js';

export const EVIDENCE_LEVEL = Object.freeze({ STRONG_EVIDENCE: 'STRONG_EVIDENCE', MEDIUM_EVIDENCE: 'MEDIUM_EVIDENCE', WEAK_EVIDENCE: 'WEAK_EVIDENCE', INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE' });
export const EVIDENCE_RULE = 'Critical gaps: product not identified, no usable price, landed cost unknown, an open contradiction, a document contradicting the case, a required document missing. Important gaps: landed cost only a lower bound, margin unknown, sample not evaluated, supplier facts still to review, Safety Gate not live, weak evidence strength. INSUFFICIENT: the product is not identified, there is no price, or 3 or more critical gaps. WEAK: 1-2 critical gaps, or 3 or more important gaps. MEDIUM: 1-2 important gaps. STRONG: none. It measures how complete the evidence is, not how likely a purchase is to succeed.';

/** @param {object} state the case @param {object} a its assessment @param {{ recommendation?: object }} opts */
export function decisionEvidenceStatus(state, a, { recommendation = null } = {}) {
  const d = a.decision; const critical = []; const important = []; const improve = [];
  const gap = (list, code, text, fix) => { list.push({ code, text }); if (fix) improve.push(fix); };
  // the model number and the technical identification are two different gaps with two remedies: each is counted once, under its own code, and a known model is never reported as missing
  const idn = identificationStatus(state, a); const m = idn.model; const t = idn.technical; const idLow = !idn.modelOk || !t.complete;
  if (m.state === MODEL_STATE.ABSENT) gap(critical, 'MODEL_NOT_ESTABLISHED', 'the exact model number is not known yet', 'get the exact model number');
  else if (m.state === MODEL_STATE.PROPOSED) gap(critical, 'MODEL_NOT_CONFIRMED', `a model number was proposed (${m.proposed.join(' / ')}) but not confirmed yet`, 'confirm, correct or reject the proposed model number');
  else if (m.state === MODEL_STATE.CONTRADICTORY) gap(critical, 'MODEL_CONTRADICTORY', `the model numbers contradict each other (${m.values.join(' / ') || 'conflicting statements'})`, 'find out which model number is the right one');
  if (!t.complete) gap(critical, 'PRODUCT_IDENTITY_UNRESOLVED', technicalGapText(a.identity?.confidence ?? { unresolvedTraits: t.unresolved, categoryConfirmed: t.categoryConfirmed }), t.categoryConfirmed ? 'establish the missing product traits' : 'confirm the product category');
  const q = state.quotes.at(-1); const price = q && (q.unitPrice || q.tiers?.length);
  if (!price) gap(critical, 'NO_PRICE', 'no usable unit price', 'get a clear unit price for your quantity');
  else if (a.landed?.status === 'INFORMATION_INSUFFICIENT') gap(critical, 'LANDED_UNKNOWN', `the landed cost cannot be calculated (missing ${(a.landed.criticalUnknown ?? []).map((u) => String(u).replace(/^(costs|supplier)\./, '')).join(', ') || 'inputs'})`, 'enter the missing import costs (freight, duty, exchange rate) or get the Incoterm');
  // a model contradiction / a proposed model is counted once, above (MODEL_CONTRADICTORY / MODEL_NOT_CONFIRMED), never again as a generic contradiction or a fact to review
  const open = state.conflicts.filter((c) => c.state === 'OPEN' && !m.conflictIds.includes(c.id)); if (open.length) gap(critical, 'OPEN_CONTRADICTION', `${open.length} contradictory statement(s): ${open.map((c) => c.key).join(', ')}`, 'resolve the contradiction with the supplier');
  if (d.contradictions?.length || d.hardBlockers.some((b) => b.code === 'DOCUMENT_CONTRADICTS_CASE')) gap(critical, 'DOCUMENT_CONTRADICTS_CASE', 'a supplied document names another model than the case', 'get the correct document for this exact model');
  const miss = d.gaps?.missingDocs ?? [];
  if (miss.length) { // one gap, however many documents: three missing papers are one thing to obtain, not three separate reasons to distrust the offer
    const names = miss.map((m) => String(m.label ?? m.docType ?? m)); critical.push({ code: 'REQUIRED_DOCUMENT_MISSING', text: `${names.length} required document${names.length > 1 ? 's' : ''} missing: ${names.slice(0, 3).join('; ')}${names.length > 3 ? '; ...' : ''}` });
    for (const n of names.slice(0, 4)) improve.push(`get ${n}`);
  }
  if (a.landed?.isLowerBound && a.landed.status !== 'INFORMATION_INSUFFICIENT') gap(important, 'LANDED_LOWER_BOUND', 'the landed cost is only a lower bound (some import costs are not entered)', 'enter the remaining import costs');
  if (a.economics?.contributionPct === null || a.economics?.contributionPct === undefined) gap(important, 'MARGIN_UNKNOWN', 'the margin cannot be calculated', 'enter the selling price and the target margin');
  const sample = sampleState(state); if (sample.status !== 'EVALUATED') gap(important, 'SAMPLE_NOT_EVALUATED', sample.status === 'NONE' ? 'no sample requested' : `sample ${sample.status.toLowerCase()}, not evaluated`, sample.status === 'NONE' ? 'request a sample' : 'evaluate the sample'); else if (sample.verdict === 'FAIL') gap(important, 'SAMPLE_FAILED', 'the sample was evaluated: FAIL', null);
  const pending = state.candidates.filter((c) => c.state === 'PROPOSED' && (c.key.startsWith('quote.') || c.key.startsWith('payment.') || (c.key.startsWith('identifier.') && c.key !== 'identifier.model') || c.key.startsWith('docClaim.'))).length; if (pending) gap(important, 'FACTS_TO_REVIEW', `${pending} supplier fact(s) imported and not yet reviewed`, 'confirm, correct or reject the imported facts');
  if (a.safety?.source?.mode !== 'LIVE_VERIFIED') gap(important, 'SAFETY_GATE_NOT_LIVE', 'the EU Safety Gate check is not live (cached or offline)', 'run the Safety Gate check while online');
  if (d.dimensions?.supplierEvidence === 'INSUFFICIENT' || d.dimensions?.supplierEvidence === 'PARTIAL') { if (!miss.length) gap(important, 'WEAK_SUPPLIER_EVIDENCE', 'the supplier evidence is only partly there', 'collect the supporting documents'); }
  const nc = critical.length; const ni = important.length;
  const level = idLow || !price || nc >= 3 ? EVIDENCE_LEVEL.INSUFFICIENT_EVIDENCE : nc >= 1 || ni >= 3 ? EVIDENCE_LEVEL.WEAK_EVIDENCE : ni >= 1 ? EVIDENCE_LEVEL.MEDIUM_EVIDENCE : EVIDENCE_LEVEL.STRONG_EVIDENCE;
  return { type: 'DecisionEvidenceStatus', caseId: state.id, recommendation: recommendation?.value ?? null, recommendationStatus: recommendation?.status ?? 'RECOMMENDATION_PENDING_APPROVAL', evidenceCompleteness: level, blocking: critical.map((x) => x.text), blockingCodes: critical.map((x) => x.code), identification: idn, important: important.map((x) => x.text), importantCodes: important.map((x) => x.code), whatWouldImprove: [...new Set(improve)],
    rule: EVIDENCE_RULE, measures: 'evidence completeness', notAProbability: true, businessDecision: 'NOT_DECIDED' };
}
