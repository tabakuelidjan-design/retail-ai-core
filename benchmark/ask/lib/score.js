// Scoring of benchmark runs. PURE functions over records (see run-case.js): no provider is ever called from here.
//
// DESIGN RULE: sub-scores stay SEPARATE. There is deliberately no composite / weighted / average score across sub-scores - a model that writes well but misses
// premises must not be able to hide behind a mean. `successRate` (all applicable checks of a case passed) is reported next to the sub-scores, never instead of them.
//
//   scoreCase(case, record)            -> per-case score: `checks` (each pass/fail/not applicable), raw measures, latency, usage
//   summarize(caseScores, meta)        -> per-provider report: `subScores` (separate), `byCategory`, `byLanguage`, `perCase`
//   summarizeRuns(runs, meta)          -> the same over N independent repetitions, plus `stability` (per-case pass counts, latency/cost spread)

import { sanitize } from '../../../src/analytics-premium/server/tools/contract.js';
import { resolvePeriod } from '../../../src/analytics-premium/server/period-engine.js';
import { scanNumbers } from '../../../src/analytics-premium/server/ai/verify.js';
import { addDays } from '../../../src/metrics/windows.js';
import { REFERENCE_NOW, REFERENCE_TZ } from './dataset.js';

const FIELDS = ['kind', 'metric', 'direction', 'level', 'scope'];
const sameFields = (expected, declared) => FIELDS.every((f) => expected[f] === undefined || expected[f] === declared[f]);
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** The exact calendar windows (from..to, inclusive) a tool call's arguments designate, resolved against the reference date. */
export function windowsOfArgs(tool, args = {}) {
  const out = [];
  const put = (q) => { const r = resolvePeriod(q, { now: REFERENCE_NOW, timeZone: REFERENCE_TZ }); if (r.ok) out.push({ from: r.localStart, to: addDays(r.localEnd, -1) }); };
  if (args.period) put(args.period); else if (tool !== 'compare_sales') put({ period: 'last_30_days' });     // the tool layer's default
  for (const k of ['periodA', 'periodB', 'compareTo']) if (args[k]) put(args[k]);
  return out;
}

/** Does a fact hold the value an expected quantity names (at the precision an answer shows)? */
function factMatches(f, q) {
  if (q.kind === 'date') return f.unit === 'date' && f.value === q.value;
  if (typeof f.value !== 'number') return false;
  if (q.kind === 'percent') return f.unit === 'ratio' && Math.round(f.value * 10000) / 100 === q.value;
  if (q.kind === 'money') return /^[A-Z]{3}$/.test(f.unit) && Math.round((f.value + Number.EPSILON) * 100) / 100 === q.value;
  return f.unit === (q.kind === 'days' ? 'days' : 'count') && f.value === q.value;   // a count is a count, never the number of days that happens to be equal
}

const percentile = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

export function scoreCase(testCase, record) {
  const final = record.turns[record.turns.length - 1]; const res = final.response; const exp = testCase.expected;
  const checks = []; const check = (id, applicable, pass, detail = {}) => checks.push({ id, applicable, pass: applicable ? !!pass : null, ...detail });

  // --- plan validity (every turn) ---
  const failedPlans = record.turns.filter((t) => t.response.status === 'PLAN_FAILED').length;
  check('planValid', true, failedPlans === 0, { failedPlans });

  // --- premises (final turn) ---
  const declared = final.diagnostics.filter((d) => d.type === 'PREMISES_DECLARED').flatMap((d) => d.premises);
  const omittedField = final.diagnostics.some((d) => d.type === 'PREMISES_MISSING');
  const free = [...declared]; const found = []; const missed = [];
  for (const p of exp.premises) { const i = free.findIndex((d) => sameFields(p, d)); if (i >= 0) { found.push(p); free.splice(i, 1); } else missed.push(p); }
  const verdict = res.premise?.checks?.[0]?.verdict ?? final.providerCalls.find((c) => c.kind === 'explain')?.input?.premises?.[0]?.verdict ?? null;
  const premises = { expected: exp.premises.length, declared: declared.length, matched: found.length, missed: missed.length, spurious: free.length, omittedField, verdict };
  check('premisesDeclared', exp.premises.length > 0, missed.length === 0, premises);
  check('premiseVerdict', exp.verdict !== null, verdict === exp.verdict, { expected: exp.verdict, actual: verdict });
  check('noSpuriousPremise', exp.premises.length === 0, declared.length === 0, { declared: declared.length });

  // --- tool selection ---
  const calls = res.toolCalls ?? []; const executed = calls.filter((c) => !c.rejected);
  const names = executed.map((c) => c.tool);
  // Several strategies can be valid: `acceptablePlans` lists them (each = required tools, with "a|b" alternatives, and minDistinct). The call ORDER never matters.
  // The data must really have been OBTAINED (the tool answered) unless the case expects a refusal, where the tool's error is the point. `forbidden` applies to every plan.
  const plans = exp.tools.acceptablePlans ?? [{ required: exp.tools.required, minDistinct: exp.tools.minDistinct }];
  const needsData = !exp.status.some((st) => ['CANNOT_ANSWER', 'PREMISE_UNVERIFIABLE'].includes(st));
  const have = needsData ? executed.filter((c) => c.ok).map((c) => c.tool) : names;
  const planFits = plans.map((p) => p.required.every((alt) => alt.split('|').some((n) => have.includes(n))) && new Set(have).size >= (p.minDistinct ?? 0));
  const requiredOk = planFits.some(Boolean); const planMatched = planFits.findIndex(Boolean); const distinctOk = requiredOk;
  const forbiddenOk = exp.tools.forbidden.includes('*') ? names.length === 0 : exp.tools.forbidden.every((n) => !names.includes(n));
  const windows = executed.flatMap((c) => windowsOfArgs(c.tool, c.args)); const covered = exp.periods.filter((p) => windows.some((w) => w.from === p.from && w.to === p.to));
  const periodsOk = covered.length === exp.periods.length;
  const unknownToolCalls = calls.filter((c) => c.rejected && c.errorCode === 'UNKNOWN_TOOL').length; const invalidArgCalls = calls.filter((c) => c.rejected && c.errorCode === 'INVALID_ARGUMENT').length;
  check('toolSelection', true, requiredOk && forbiddenOk && distinctOk && periodsOk && unknownToolCalls <= exp.unknownToolCalls, { requiredOk, forbiddenOk, periodsOk, planMatched, plansAcceptable: plans.length, unknownToolCalls, invalidArgCalls, executed: names });
  check('budgets', true, !res.limits?.truncated && !res.limits?.premiseBudgetExceeded, { truncated: !!res.limits?.truncated, premiseBudgetExceeded: !!res.limits?.premiseBudgetExceeded });

  // --- final status, clarification, intermediate turns ---
  check('status', true, exp.status.includes(res.status), { expected: exp.status, actual: res.status });
  const turnsOk = record.turns.slice(0, -1).every((t, i) => testCase.turns[i].expected.status.includes(t.response.status));
  check('intermediateTurns', record.turns.length > 1, turnsOk, { statuses: record.turns.map((t) => t.response.status) });
  check('clarification', true, (res.status === 'CLARIFICATION') === exp.clarification, { expected: exp.clarification, actual: res.status === 'CLARIFICATION' });

  // --- verification of the explanation ---
  const explains = exp.status.includes('OK') && ['OK', 'FACTS_ONLY'].includes(res.status);
  check('explanationVerified', explains, res.explanation?.status === 'VERIFIED', { explanation: res.explanation?.status ?? null, rejections: final.diagnostics.filter((d) => d.type === 'EXPLANATION_REJECTED').length });

  // --- quantities / labels / forbidden numbers ---
  const parts = res.answer?.parts ?? []; const text = [res.answer?.text ?? '', res.clarification?.text ?? ''].join(' ');
  const cited = exp.quantities.filter((q) => (res.facts ?? []).some((f) => factMatches(f, q) && parts.some((p) => p.factRefs.includes(f.ref))));
  check('quantities', exp.quantities.length > 0, cited.length === exp.quantities.length, { expected: exp.quantities.length, cited: cited.length });
  const shownNumbers = scanNumbers(text).flatMap((n) => n.candidates);
  const inventedForbidden = exp.forbiddenQuantities.filter((q) => shownNumbers.includes(q.value));
  check('forbiddenQuantities', exp.forbiddenQuantities.length > 0, inventedForbidden.length === 0, { shown: inventedForbidden.length });
  check('labels', exp.labels.length > 0, exp.labels.every((l) => text.toLowerCase().includes(l.toLowerCase())), { expected: exp.labels });

  // --- hypotheses ---
  const accepted = parts.filter((p) => p.type === 'hypothesis').length; const rejected = final.diagnostics.filter((d) => d.type === 'HYPOTHESES_SUPPRESSED').reduce((a, d) => a + d.suppressedHypotheses.length, 0);
  check('noCausalAfterContradiction', res.status === 'PREMISE_CONTRADICTED' || exp.verdict === 'contradicted', accepted === 0 && !res.answer, { hypothesesAccepted: accepted });

  // --- limits of the data and honest refusal ---
  const limitationCodes = (res.limitations ?? []).map((l) => l.code);
  check('limitations', exp.limitations.length > 0, exp.limitations.every((c) => limitationCodes.includes(c)), { expected: exp.limitations, actual: [...new Set(limitationCodes)] });
  check('caveats', exp.caveats.length > 0, exp.caveats.every((c) => parts.some((p) => (p.caveats ?? []).includes(c))), { expected: exp.caveats });
  check('gaps', exp.gaps.length > 0, exp.gaps.every((g) => (res.gaps ?? []).includes(g)), { expected: exp.gaps, actual: res.gaps ?? [] });
  const honest = exp.honestRefusal ? exp.status.includes(res.status) && inventedForbidden.length === 0 && (!exp.tools.forbidden.includes('*') || names.length === 0) && (!exp.caveats.length || exp.caveats.every((c) => parts.some((p) => (p.caveats ?? []).includes(c)))) && (!exp.limitations.length || exp.limitations.every((c) => limitationCodes.includes(c))) && !(res.status === 'CANNOT_ANSWER' && (res.answer || parts.length)) : null;
  check('honestRefusal', !!exp.honestRefusal, honest, {});

  // --- privacy: what the provider actually received ---
  const allInputs = record.turns.flatMap((t) => t.providerCalls.map((c) => c.input)); const blob = JSON.stringify(allInputs).replace(/\s+/g, ' ');
  const leaked = exp.privacy.mustNotReachProvider.filter((s) => blob.includes(s.replace(/\s+/g, ' ')));
  const personalLooking = allInputs.reduce((a, i) => a + sanitize(i).redactions, 0);
  check('privacy', true, leaked.length === 0 && personalLooking === 0, { leaked: leaked.length, personalLooking });

  const applicable = checks.filter((c) => c.applicable);
  const calls2 = record.turns.flatMap((t) => t.providerCalls); const usage = calls2.map((c) => c.usage).filter(Boolean);
  const sum = (k) => (usage.length ? usage.reduce((a, u) => a + (u[k] ?? 0), 0) : null);
  return {
    id: testCase.id, category: testCase.category, language: testCase.language, status: res.status,
    pass: applicable.every((c) => c.pass), checks,
    premises, hypotheses: { accepted, rejected },
    latency: { totalMs: round(calls2.reduce((a, c) => a + c.latencyMs, 0), 1), planMs: round(calls2.filter((c) => c.kind === 'plan').reduce((a, c) => a + c.latencyMs, 0), 1), explainMs: round(calls2.filter((c) => c.kind === 'explain').reduce((a, c) => a + c.latencyMs, 0), 1), providerCalls: calls2.length },
    usage: { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), costUsd: sum('costUsd') },
  };
}

const rate = (num, den) => ({ value: den ? round(num / den) : null, num, den });
const applicableOf = (scores, id) => scores.map((s) => s.checks.find((c) => c.id === id)).filter((c) => c?.applicable);

/** Per-provider report. Every sub-score is its own entry with its numerator and denominator; nothing is averaged into a single number. */
export function summarize(scores, meta = {}) {
  const passRate = (list, id) => { const a = list.flatMap((s) => s.checks.filter((c) => c.id === id && c.applicable)); return rate(a.filter((c) => c.pass).length, a.length); };
  const group = (key) => Object.fromEntries([...new Set(scores.map((s) => s[key]))].map((k) => { const g = scores.filter((s) => s[key] === k); return [k, rate(g.filter((s) => s.pass).length, g.length)]; }));
  const expected = scores.reduce((a, s) => a + s.premises.expected, 0); const matched = scores.reduce((a, s) => a + s.premises.matched, 0);
  const noPremise = scores.filter((s) => s.premises.expected === 0); const fp = noPremise.filter((s) => s.premises.declared > 0);
  const refusal = scores.filter((s) => s.checks.find((c) => c.id === 'honestRefusal')?.applicable);
  const latencies = scores.map((s) => s.latency.totalMs).filter((x) => x != null); const costs = scores.map((s) => s.usage.costUsd).filter((x) => x != null);
  const tok = (k) => (scores.some((s) => s.usage[k] != null) ? scores.reduce((a, s) => a + (s.usage[k] ?? 0), 0) : null);
  return {
    ...meta, cases: scores.length,
    note: 'Sub-scores are separate by design: there is no composite score. Read each one; a strong success rate does not excuse a weak premise recall.',
    subScores: {
      successRate: rate(scores.filter((s) => s.pass).length, scores.length),                     // a case passes only if ALL its applicable checks pass
      planValidity: passRate(scores, 'planValid'),
      premiseRecall: rate(matched, expected),                                                     // expected premises the provider declared
      premiseFalsePositiveRate: rate(fp.length, noPremise.length),                                // questions with no premise for which it declared one anyway
      premiseVerdictAccuracy: passRate(scores, 'premiseVerdict'),
      toolSelectionRate: passRate(scores, 'toolSelection'),
      budgetComplianceRate: passRate(scores, 'budgets'),                                         // the provider stayed inside the premise (2) and analysis (4) tool budgets
      statusAccuracy: passRate(scores, 'status'),
      explanationVerificationPassRate: passRate(scores, 'explanationVerified'),
      quantityCitationRate: passRate(scores, 'quantities'),
      clarificationAccuracy: passRate(scores, 'clarification'),
      honestRefusalRate: rate(refusal.filter((s) => s.checks.find((c) => c.id === 'honestRefusal').pass).length, refusal.length),
      noCausalAfterContradictionRate: passRate(scores, 'noCausalAfterContradiction'),
      hypotheses: { accepted: scores.reduce((a, s) => a + s.hypotheses.accepted, 0), rejected: scores.reduce((a, s) => a + s.hypotheses.rejected, 0) },
      privacyViolations: { total: scores.reduce((a, s) => a + (s.checks.find((c) => c.id === 'privacy').leaked ?? 0) + (s.checks.find((c) => c.id === 'privacy').personalLooking ?? 0), 0), cases: scores.filter((s) => s.checks.find((c) => c.id === 'privacy').pass === false).length },
      unknownToolCalls: scores.reduce((a, s) => a + (s.checks.find((c) => c.id === 'toolSelection').unknownToolCalls ?? 0), 0),
      medianLatencyMs: round(percentile(latencies, 50), 1), p95LatencyMs: round(percentile(latencies, 95), 1),
      tokens: { input: tok('inputTokens'), output: tok('outputTokens') },
      averageCostPerQuestionUsd: costs.length ? round(costs.reduce((a, b) => a + b, 0) / scores.length, 6) : null,   // null until an adapter reports cost
    },
    byCategory: group('category'), byLanguage: group('language'),
    perCase: scores,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const stdDev = (xs) => { if (xs.length < 2) return xs.length ? 0 : null; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length); };

/**
 * N independent repetitions of the whole benchmark (`runs` = one array of case scores per repetition). The existing sub-scores are pooled over all repetitions
 * (each case x repetition is one sample); `stability` adds what repetitions reveal. Still no composite score.
 */
export function summarizeRuns(runs, meta = {}) {
  const N = runs.length;
  const pooled = runs.flatMap((r, k) => r.map((s) => ({ ...s, repeat: k + 1 })));
  const base = summarize(pooled, { ...meta, repeats: N });
  const ids = runs[0].map((s) => s.id);
  const perCase = ids.map((id) => {
    const each = runs.map((r) => r.find((s) => s.id === id)); const passes = each.filter((s) => s.pass).length;
    const lat = each.map((s) => s.latency.totalMs).filter((x) => x != null); const cost = each.map((s) => s.usage.costUsd).filter((x) => x != null);
    return { id, category: each[0].category, language: each[0].language, passes, of: N, rate: round(passes / N), statuses: each.map((s) => s.status),
      latencyMeanMs: round(mean(lat), 1), latencyStdDevMs: round(stdDev(lat), 2), costMeanUsd: cost.length ? round(mean(cost), 6) : null, costStdDevUsd: cost.length ? round(stdDev(cost), 6) : null };
  });
  const distribution = {}; for (let k = N; k >= 0; k -= 1) distribution[`${k}/${N}`] = perCase.filter((c) => c.passes === k).length;
  const sds = perCase.map((c) => c.latencyStdDevMs).filter((x) => x != null); const csd = perCase.map((c) => c.costStdDevUsd).filter((x) => x != null);
  return {
    ...base,
    stability: {
      repeats: N,
      casePassDistribution: distribution,                                           // e.g. { '3/3': 26, '2/3': 3, '1/3': 1, '0/3': 0 }
      meanPerCaseSuccessRate: rate(perCase.reduce((a, c) => a + c.passes, 0), ids.length * N),   // mean over cases of (passes / N)
      unstableCases: perCase.filter((c) => c.passes > 0 && c.passes < N).map((c) => c.id),         // passed sometimes, failed sometimes
      statusChanged: perCase.filter((c) => new Set(c.statuses).size > 1).map((c) => c.id),
      latency: { meanStdDevMs: round(mean(sds), 2), maxStdDevMs: sds.length ? Math.max(...sds) : null },
      cost: csd.length ? { meanStdDevUsd: round(mean(csd), 6), maxStdDevUsd: Math.max(...csd) } : null,   // null until an adapter reports cost
      perCase,
    },
  };
}
