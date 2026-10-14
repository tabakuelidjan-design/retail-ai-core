import { DECISION_OUTCOME, EVIDENCE_LEVEL, HUMAN_DECISION, OUTCOME_RESULT } from './constants.js';
import { SocleError, clone, deepFreeze, hashId, nonEmpty, oneOf, toIso } from './util.js';

// Decision log / follow-up. Pure functions over immutable entries.
// A result NEVER becomes a rule: there is no function here that touches rules.
const MACHINE_APPROVERS = ['system', 'engine', 'llm', 'ai', 'auto', 'bot', 'nordla'];

export function createLogEntry(decision, subject) {
  return deepFreeze({
    id: hashId('log', decision.decision_id),
    merchant_id: decision.merchant_id,
    subject_id: subject.id,
    subject: clone(decision.subject),
    facts_used: clone(decision.facts_used),
    rules_applied: clone(decision.rules_applied),
    rule_results: clone([...decision.remaining.flatMap((r) => r.rule_results), ...decision.eliminated.flatMap((e) => e.rule_results)]),
    options: clone({ examined: decision.levers_examined, eliminated: decision.eliminated, remaining: decision.remaining }),
    recommendation: clone(decision.recommended),
    decision_ref: decision.decision_id,
    approval_status: decision.approval_status,
    human_decision: null, // { decision, reason, approver, decided_at, chosen_lever_ids }
    planned_actions: [],
    result: null, // { result, evidence_level, measured_at, notes }
    next_review_at: null,
    learning: { rule_changes: [], note: 'Results never become rules automatically; changing a rule is a separate human act.' },
    created_at: decision.evaluated_at,
  });
}

export function applyHumanDecision(entry, decision, input) {
  if (entry.human_decision) throw new SocleError('ALREADY_DECIDED', 'a human decision is already recorded');
  if (decision.outcome !== DECISION_OUTCOME.RECOMMENDED) throw new SocleError('NOTHING_TO_DECIDE', 'this decision only asks for verification');
  const kind = oneOf(input.decision, HUMAN_DECISION, 'decision');
  const approver = nonEmpty(input.approver, 'approver');
  if (MACHINE_APPROVERS.includes(approver.toLowerCase())) throw new SocleError('APPROVER_NOT_HUMAN', `approver "${approver}" is not a human`);
  const reason = nonEmpty(input.reason, 'reason');
  const decided_at = toIso(input.decided_at, 'decided_at');
  let chosen = [];
  if (kind === HUMAN_DECISION.APPROVED) chosen = [...decision.recommended.lever_ids];
  if (kind === HUMAN_DECISION.APPROVED_ALTERNATIVE) {
    chosen = [...(input.chosen_lever_ids ?? [])];
    if (!chosen.length) throw new SocleError('INVALID_FIELD', 'chosen_lever_ids is required for APPROVED_ALTERNATIVE');
  }
  const allowed = new Set(decision.remaining.map((r) => r.lever_id));
  for (const id of chosen) {
    if (!allowed.has(id) && !decision.recommended.lever_ids.includes(id)) {
      throw new SocleError('LEVER_ELIMINATED', `lever ${id} was eliminated by eligibility/rules and cannot be approved`);
    }
  }
  return deepFreeze({
    ...clone(entry),
    human_decision: { decision: kind, reason, approver, decided_at, chosen_lever_ids: chosen },
    planned_actions: (input.planned_actions ?? []).map(String),
    next_review_at: input.next_review_at ? toIso(input.next_review_at, 'next_review_at') : null,
  });
}

export function applyResult(entry, input) {
  const hd = entry.human_decision;
  if (!hd) throw new SocleError('NO_HUMAN_DECISION', 'a result needs a recorded human decision first');
  if (![HUMAN_DECISION.APPROVED, HUMAN_DECISION.APPROVED_ALTERNATIVE].includes(hd.decision)) {
    throw new SocleError('NOTHING_TO_MEASURE', `human decision ${hd.decision} has no action to measure`);
  }
  const result = oneOf(input.result, OUTCOME_RESULT, 'result');
  const unmeasured = [OUTCOME_RESULT.NOT_MEASURABLE, OUTCOME_RESULT.UNKNOWN].includes(result);
  const evidence_level = unmeasured ? EVIDENCE_LEVEL.NONE : oneOf(input.evidence_level, EVIDENCE_LEVEL, 'evidence_level');
  return deepFreeze({
    ...clone(entry),
    result: { result, evidence_level, measured_at: toIso(input.measured_at, 'measured_at'), notes: input.notes ?? '' },
    next_review_at: input.next_review_at ? toIso(input.next_review_at, 'next_review_at') : entry.next_review_at,
    // learning stays empty by construction.
    learning: { rule_changes: [], note: entry.learning.note },
  });
}
