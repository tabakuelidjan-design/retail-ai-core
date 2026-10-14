import {
  APPROVAL_STATUS, AXES, CONFIDENCE, DECISION_OUTCOME, LEVER_TYPE, RECOMMENDATION_KIND, REVERSIBILITY, RULE_RESULT, SUBJECT_STATUS,
} from './constants.js';
import { axisUtility, axisVector, dominates, rankLexicographic, resolveProfile, tradeoffsVs } from './compare.js';
import { checkEligibility, combineLevers, createDoNothingLever, createTestSmallLever } from './lever.js';
import { evaluateRules } from './rules.js';
import { SocleError, deepFreeze, hashId, toIso } from './util.js';

// The ONE place where options are compared. Domains only supply facts, rules
// and levers. Nothing here calls an LLM, the network or a clock (now is injected).

const isAction = (l) => l.type === LEVER_TYPE.ACTION;
const byId = (a, b) => (a.lever.id < b.lever.id ? -1 : a.lever.id > b.lever.id ? 1 : 0);

function describeStage(t) {
  if (t.note) return `${t.axis}: ${t.note}`;
  return `${t.axis}: kept [${t.kept.join(', ')}]` +
    (t.dropped_worse.length ? `; less favorable: [${t.dropped_worse.join(', ')}]` : '') +
    (t.dropped_unknown.length ? `; unknown (never guessed): [${t.dropped_unknown.join(', ')}]` : '');
}

const resolvesAll = (results, unresolved) => unresolved.every((u) => results.find((r) => r.rule_id === u.rule_id)?.evidence.resolves_breach === true);

function tryCombine(winnerEntry, others, rules, subject, profile, unresolved) {
  let current = winnerEntry.lever;
  let currentResults = winnerEntry.rule_results;
  const members = [winnerEntry.lever];
  const notes = [];
  for (const o of [...others].sort(byId)) {
    if (unresolved.length && resolvesAll(currentResults, unresolved)) break; // minimal intervention once the breach is resolved
    const c = o.lever;
    if (o.needs_human.length) continue;
    const mutual = members.every((m) => m.combinable_with.includes(c.id) && c.combinable_with.includes(m.id));
    if (!mutual) continue;
    if (members.some((m) => m.exclusive_group && m.exclusive_group === c.exclusive_group)) continue;
    const candidate = combineLevers([...members, c]);
    const candResults = evaluateRules(rules, candidate, subject);
    if (candResults.some((r) => r.result !== RULE_RESULT.PASS)) {
      notes.push(`combination with ${c.id} rejected: a rule does not PASS for the combined lever`);
      continue;
    }
    const keep = ['risk', 'reversibility'].every((a) => axisUtility(candidate, a, profile) >= axisUtility(current, a, profile));
    const cash = [axisUtility(candidate, 'cash_impact', profile), axisUtility(current, 'cash_impact', profile)];
    const margin = [axisUtility(candidate, 'margin_impact', profile), axisUtility(current, 'margin_impact', profile)];
    const known = [...cash, ...margin].every((v) => v !== null);
    const noWorse = known && cash[0] >= cash[1] && margin[0] >= margin[1];
    const better = known && (cash[0] > cash[1] || margin[0] > margin[1]);
    const resolvesMore = unresolved.length > 0 && !resolvesAll(currentResults, unresolved) && resolvesAll(candResults, unresolved);
    if (resolvesMore || (keep && noWorse && better)) {
      members.push(c);
      current = candidate;
      currentResults = candResults;
      notes.push(resolvesMore
        ? `combined with ${c.id}: the combination resolves the breached hard constraint that no single option resolves (effects declared additive)`
        : `combined with ${c.id}: cash/margin improve with no extra risk or irreversibility (effects declared additive)`);
    } else notes.push(`combination with ${c.id} rejected: no clear gain or higher risk/irreversibility`);
  }
  return { lever: current, member_ids: members.map((m) => m.id), notes };
}

export function decide({ subject, levers = [], ruleSet, config = {}, now }) {
  const evaluated_at = toIso(now, 'now');
  if (!ruleSet || ruleSet.merchant_id !== subject.merchant_id) {
    throw new SocleError('MERCHANT_MISMATCH', 'rule set does not belong to the subject merchant');
  }
  const profile = resolveProfile(subject.type, config);
  const header = {
    decision_id: hashId('dec', subject.merchant_id, subject.id, evaluated_at),
    merchant_id: subject.merchant_id,
    subject: { id: subject.id, type: subject.type, kind: subject.kind, title: subject.title, status: subject.status, materiality: subject.materiality, currency: subject.currency, confidence: subject.confidence },
    evaluated_at,
    facts_used: subject.facts.map((f) => ({ ...f })),
    rules_applied: ruleSet.rules.map((r) => ({ id: r.id, type: r.type, label: r.label, params: { ...r.params } })),
    comparison_method: {
      type: 'PARETO_THEN_LEXICOGRAPHIC',
      axis_priority: [...profile.axis_priority],
      tolerances: { ...profile.tolerances },
      multiplicative_score: false,
      uses_llm: false,
    },
  };

  if (subject.status === SUBJECT_STATUS.TO_VERIFY) {
    return deepFreeze({
      ...header,
      outcome: DECISION_OUTCOME.TO_VERIFY,
      levers_examined: [], eliminated: [], remaining: [], recommended: null, alternatives: [], tradeoffs: [],
      verification_needed: subject.triage?.reasons ?? [],
      missing_data: subject.missing_data.map((m) => ({ ...m })),
      unresolved_constraints: [], needs_human: [],
      approval_status: APPROVAL_STATUS.VERIFICATION_REQUIRED,
    });
  }
  if (subject.status !== SUBJECT_STATUS.TO_DECIDE) {
    throw new SocleError('INVALID_STATE', `cannot decide a subject in status ${subject.status}`);
  }

  // Pool: domain levers + the two levers that must always be able to exist.
  const pool = [...levers];
  if (new Set(pool.map((l) => l.id)).size !== pool.length) throw new SocleError('DUPLICATE_LEVER', 'lever ids must be unique');
  if (!pool.some((l) => l.type === LEVER_TYPE.DO_NOTHING)) pool.unshift(createDoNothingLever(subject));
  if (config.testSmall && !pool.some((l) => l.type === LEVER_TYPE.TEST_SMALL)) pool.push(createTestSmallLever(subject, config.testSmall));

  const examined = [];
  const eliminated = [];
  let remaining = [];
  for (const lever of pool) {
    const base = { lever_id: lever.id, label: lever.label, domain: lever.domain, type: lever.type };
    const elig = checkEligibility(lever, subject);
    if (!elig.eligible) {
      eliminated.push({ ...base, stage: 'ELIGIBILITY', reasons: elig.reasons, rule_results: [] });
      continue;
    }
    const rule_results = evaluateRules(ruleSet.rules, lever, subject);
    const fails = rule_results.filter((r) => r.result === RULE_RESULT.FAIL);
    const needs_human = rule_results.filter((r) => r.result === RULE_RESULT.NEEDS_HUMAN);
    if (fails.length && lever.type !== LEVER_TYPE.DO_NOTHING) {
      eliminated.push({ ...base, stage: 'RULES', reasons: fails.map((f) => `${f.rule_id}: ${f.reason}`), rule_results });
      continue;
    }
    remaining.push({ lever, rule_results, needs_human, violations: lever.type === LEVER_TYPE.DO_NOTHING ? fails : [] });
  }

  // TEST_SMALL is offered when there is something to learn.
  const real0 = remaining.filter((e) => isAction(e.lever));
  const testSmallRelevant = subject.confidence !== CONFIDENCE.HIGH || subject.missing_data.length > 0 ||
    real0.some((e) => e.lever.reversibility !== REVERSIBILITY.REVERSIBLE || e.lever.confidence === CONFIDENCE.LOW);
  const ts = remaining.find((e) => e.lever.type === LEVER_TYPE.TEST_SMALL);
  if (ts && !testSmallRelevant) {
    remaining = remaining.filter((e) => e !== ts);
    eliminated.push({ lever_id: 'TEST_SMALL', label: ts.lever.label, domain: 'common', type: LEVER_TYPE.TEST_SMALL, stage: 'RELEVANCE', reasons: ['NOT_RELEVANT: high confidence, no missing data, every candidate action is reversible'], rule_results: ts.rule_results });
  }

  const doNothing = remaining.find((e) => e.lever.type === LEVER_TYPE.DO_NOTHING);
  const testSmall = remaining.find((e) => e.lever.type === LEVER_TYPE.TEST_SMALL);
  const real = remaining.filter((e) => isAction(e.lever));

  // Pareto dominance among actions (DO_NOTHING can dominate too; it is never removed itself).
  const dominatedBy = new Map();
  for (const e of real) {
    const doms = [...real, doNothing].filter((o) => o !== e && dominates(o.lever, e.lever, profile)).map((o) => o.lever.id);
    if (doms.length) dominatedBy.set(e.lever.id, doms);
  }
  const frontier = real.filter((e) => !dominatedBy.has(e.lever.id));

  // Stage 0: a breached hard constraint must be resolved first.
  const unresolved = doNothing.rule_results.filter((r) => r.evidence.breach_before === true && r.evidence.resolves_breach !== true);
  const resolvers = frontier.filter((e) => unresolved.every((u) => e.rule_results.find((r) => r.rule_id === u.rule_id)?.evidence.resolves_breach === true));
  const stage0 = unresolved.length > 0 && resolvers.length > 0;
  const candidates = stage0 ? resolvers : frontier;
  const pickPool = candidates.map((e) => e.lever);
  if (!stage0) pickPool.push(doNothing.lever);

  const rationale = [];
  if (stage0) rationale.push(`Stage 0 - hard constraint(s) breached at baseline (${unresolved.map((u) => u.rule_id).join(', ')}): only options that resolve them are compared.`);
  let recommendedLever;
  let kind;
  let memberIds;
  let rank = null;
  let testTarget = null;

  if (candidates.length === 0) {
    const fallback = testSmall ?? doNothing;
    recommendedLever = fallback.lever;
    kind = fallback === testSmall ? RECOMMENDATION_KIND.TEST_SMALL : RECOMMENDATION_KIND.DO_NOTHING;
    memberIds = [recommendedLever.id];
    rationale.push(kind === RECOMMENDATION_KIND.TEST_SMALL
      ? 'No eligible action survived eligibility and rules: a small test is the only informative step.'
      : 'No eligible action survived eligibility and rules: doing nothing is the remaining option.');
  } else {
    rank = rankLexicographic(pickPool, profile);
    rationale.push(...rank.trace.map(describeStage));
    if (rank.tied_with.length) rationale.push(`Tie on every declared axis between ${[rank.winner.id, ...rank.tied_with].join(', ')}; ${rank.winner.id} listed first by id only - the human should choose.`);
    const winnerEntry = remaining.find((e) => e.lever.id === rank.winner.id);
    if (rank.winner.type === LEVER_TYPE.DO_NOTHING) {
      recommendedLever = doNothing.lever;
      kind = RECOMMENDATION_KIND.DO_NOTHING;
      memberIds = ['DO_NOTHING'];
      rationale.push('No eligible action beats doing nothing on the declared axis priority.');
    } else if (testSmall && (rank.winner.confidence === CONFIDENCE.LOW || subject.confidence === CONFIDENCE.LOW)) {
      recommendedLever = testSmall.lever;
      kind = RECOMMENDATION_KIND.TEST_SMALL;
      memberIds = ['TEST_SMALL'];
      testTarget = rank.winner.id;
      rationale.push(`Best-ranked option ${rank.winner.id} has LOW confidence: test small before committing.`);
    } else {
      const combo = tryCombine(winnerEntry, real.filter((e) => e !== winnerEntry), ruleSet.rules, subject, profile, unresolved);
      recommendedLever = combo.lever;
      memberIds = combo.member_ids;
      kind = memberIds.length > 1 ? RECOMMENDATION_KIND.COMBINED : RECOMMENDATION_KIND.ACTION;
      rationale.push(...combo.notes);
    }
  }

  const memberSet = new Set(memberIds);
  if (testTarget) memberSet.add(testTarget);
  const alternatives = remaining
    .filter((e) => !memberIds.includes(e.lever.id))
    .map((e) => {
      const why = [];
      if (dominatedBy.has(e.lever.id)) why.push(`dominated by ${dominatedBy.get(e.lever.id).join(', ')} (no better on any shared known axis)`);
      if (stage0 && isAction(e.lever) && !resolvers.includes(e) && !dominatedBy.has(e.lever.id)) why.push('does not resolve the breached hard constraint');
      if (rank) for (const t of rank.trace) {
        if (t.dropped_worse?.includes(e.lever.id)) { why.push(`less favorable on ${t.axis}`); break; }
        if (t.dropped_unknown?.includes(e.lever.id)) { why.push(`${t.axis} unknown - cannot win this axis`); break; }
      }
      if (testTarget === e.lever.id) why.push('LOW confidence: to be tested small first');
      if (!why.length) why.push('ranked behind the recommendation');
      return { lever_id: e.lever.id, label: e.lever.label, why_not: why };
    });
  // When the recommendation is a test, the trade-offs that matter are those of the option being tested.
  const reference = testTarget ? remaining.find((e) => e.lever.id === testTarget).lever : recommendedLever;
  const tradeoffs = remaining
    .filter((e) => !memberIds.includes(e.lever.id) && e.lever.id !== reference.id)
    .map((e) => tradeoffsVs(reference, e.lever, profile));

  const finalResults = memberIds.length === 1 && memberIds[0] === recommendedLever.id && remaining.find((e) => e.lever.id === recommendedLever.id)
    ? remaining.find((e) => e.lever.id === recommendedLever.id).rule_results
    : evaluateRules(ruleSet.rules, recommendedLever, subject);
  const unresolved_constraints = unresolved.map((u) => {
    const r = finalResults.find((x) => x.rule_id === u.rule_id);
    return { rule_id: u.rule_id, baseline_reason: u.reason, resolved_by_recommendation: r?.evidence.resolves_breach === true };
  });
  const needs_human = remaining.flatMap((e) => e.needs_human.map((r) => ({ lever_id: e.lever.id, rule_id: r.rule_id, reason: r.reason })));
  const recNeedsHuman = needs_human.some((n) => memberSet.has(n.lever_id));
  const unknownAxes = AXES.filter((a) => axisUtility(recommendedLever, a, profile) === null);

  for (const lever of pool) {
    const el = eliminated.find((x) => x.lever_id === lever.id);
    examined.push({ lever_id: lever.id, label: lever.label, domain: lever.domain, type: lever.type, status: el ? 'ELIMINATED' : 'ELIGIBLE', stage: el?.stage ?? null });
  }

  return deepFreeze({
    ...header,
    outcome: DECISION_OUTCOME.RECOMMENDED,
    levers_examined: examined,
    eliminated,
    remaining: remaining.map((e) => ({
      lever_id: e.lever.id, label: e.lever.label, domain: e.lever.domain, type: e.lever.type,
      axes: axisVector(e.lever), required_approval: e.lever.required_approval,
      rule_results: e.rule_results, needs_human: e.needs_human, violations: e.violations,
      dominated_by: dominatedBy.get(e.lever.id) ?? [],
    })),
    recommended: {
      kind, lever_ids: memberIds, label: recommendedLever.label, tests_lever_id: testTarget,
      axes: axisVector(recommendedLever), rule_results: finalResults, rationale,
    },
    alternatives,
    tradeoffs_reference: reference.id,
    tradeoffs,
    missing_data: [
      ...subject.missing_data.map((m) => ({ ...m })),
      ...unknownAxes.map((a) => ({ field: a, reason: 'unknown for the recommended option', blocking: false })),
    ],
    unresolved_constraints,
    needs_human,
    approval_status: recNeedsHuman ? APPROVAL_STATUS.NEEDS_HUMAN_INPUT : APPROVAL_STATUS.AWAITING_HUMAN_DECISION,
  });
}
