import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SocleStore, createLever, createRuleSet, createSubject, decide, evaluateRule, createRule, selectPriorities, triageSubject,
  buildDormantInventorySubject, inventoryLevers, buildCashFloorRiskSubject, cashLevers, buildFootfallDeclineSubject, footfallLevers,
  resolveProfile,
} from '../src/socle-decision/index.js';
import * as fx from './fixtures/socle-decision-synthetic.js';

const { MERCHANT_A, MERCHANT_B, NOW, CONFIG, lever } = fx;
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'socle-decision');

const rulesA = () => createRuleSet(MERCHANT_A, fx.RULES_A);
const newStore = () => {
  const s = new SocleStore(CONFIG);
  s.setRuleSet(MERCHANT_A, rulesA());
  return s;
};
const accept = (s, subject, now = NOW) => s.ingestSubject(subject.merchant_id, subject, now).subject;
const days = (n) => new Date(new Date(NOW).getTime() + n * 86_400_000).toISOString();
const dormant = (over = {}) => buildDormantInventorySubject({ ...fx.DORMANT_INPUT, ...over });
const plainSubject = (over = {}) => createSubject({
  merchant_id: MERCHANT_A, type: 'GENERIC', kind: 'opportunity', title: 'synthetic', materiality: 2000, currency: 'EUR', detected_at: NOW, ...over,
});

function listSources(dir = SRC_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listSources(p) : [p];
  });
}

test('fixtures are explicitly synthetic', () => {
  assert.equal(fx.SYNTHETIC_FIXTURE, true);
  assert.match(fx.FIXTURE_NOTICE, /SYNTHETIC/);
  assert.ok(MERCHANT_A.startsWith('synthetic-') && MERCHANT_B.startsWith('synthetic-'));
});

// 1
test('1. a valid Subject is created, immutable, with all required fields', () => {
  const s = dormant();
  for (const k of ['id', 'merchant_id', 'type', 'title', 'summary', 'status', 'materiality', 'currency', 'confidence', 'detected_at', 'review_at', 'facts', 'missing_data', 'source_refs']) {
    assert.ok(k in s, `missing ${k}`);
  }
  assert.equal(s.kind, 'opportunity');
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.facts));
  assert.throws(() => createSubject({ ...fx.DORMANT_INPUT, merchant_id: '', type: 'X', kind: 'risk', title: 't', materiality: 1, currency: 'EUR', detected_at: NOW }), /merchant_id/);
  assert.throws(() => plainSubject({ materiality: -1 }), /materiality/);
  assert.throws(() => plainSubject({ currency: 'euro' }), /currency/);
  assert.throws(() => plainSubject({ kind: 'signal' }), /kind/);
});

// 2
test('2. a data anomaly becomes TO_VERIFY, not TO_DECIDE', () => {
  const suspect = triageSubject(plainSubject({ kind: 'anomaly', facts: [{ key: 'stock', value: -5, quality: 'SUSPECT' }] }));
  assert.equal(suspect.status, 'TO_VERIFY');
  assert.deepEqual(suspect.triage.reasons, ['SUSPECT_FACT:stock']);
  const blocking = triageSubject(plainSubject({ missing_data: [{ field: 'cost', blocking: true }] }));
  assert.equal(blocking.status, 'TO_VERIFY');
  assert.equal(triageSubject(plainSubject()).status, 'TO_DECIDE');
  const d = decide({ subject: suspect, levers: [], ruleSet: rulesA(), config: CONFIG, now: NOW });
  assert.equal(d.outcome, 'TO_VERIFY');
  assert.equal(d.recommended, null);
  assert.equal(d.approval_status, 'VERIFICATION_REQUIRED');
  assert.deepEqual(d.verification_needed, ['SUSPECT_FACT:stock']);
});

// 3
test('3. insufficient materiality: no priority; threshold must come from config', () => {
  const small = triageSubject(plainSubject({ id: 's-small', materiality: 100 }));
  const big = triageSubject(plainSubject({ id: 's-big', materiality: 900 }));
  const r = selectPriorities([small, big], CONFIG, MERCHANT_A);
  assert.deepEqual(r.priority.map((s) => s.id), ['s-big']);
  assert.equal(r.below_materiality[0].subject_id, 's-small');
  assert.match(r.below_materiality[0].reason, /BELOW_MATERIALITY/);
  const { materialityThreshold, ...noThreshold } = CONFIG;
  assert.throws(() => selectPriorities([big], noThreshold, MERCHANT_A), /materialityThreshold/);
  const eur = triageSubject(plainSubject({ id: 's-usd', materiality: 9999, currency: 'USD' }));
  assert.match(selectPriorities([eur], CONFIG, MERCHANT_A).below_materiality[0].reason, /CURRENCY_MISMATCH/);
});

// 4
test('4. attention budget: at most 3 priority subjects per cycle, the rest is deferred with a reason', () => {
  const subjects = [900, 5000, 1200, 700, 3000].map((m, i) => triageSubject(plainSubject({ id: `s${i}`, materiality: m })));
  const r = selectPriorities(subjects, CONFIG, MERCHANT_A);
  assert.equal(r.priority.length, 3);
  assert.deepEqual(r.priority.map((s) => s.materiality), [5000, 3000, 1200]);
  assert.equal(r.deferred.length, 2);
  assert.match(r.deferred[0].reason, /ATTENTION_BUDGET_EXCEEDED/);
  assert.equal(selectPriorities(subjects, { ...CONFIG, maxPrioritySubjects: 1 }, MERCHANT_A).priority.length, 1);
});

// 5
test('5. cooldown: a dismissed subject does not come back immediately, unless aggravated or after the delay', () => {
  const s = newStore();
  const first = accept(s, dormant());
  s.dismissSubject(MERCHANT_A, first.id, { reason: 'not now', approver: 'owner', now: NOW });
  const again = (over, now) => s.ingestSubject(MERCHANT_A, dormant({ detected_at: now, ...over }), now);
  const back = again({}, days(5));
  assert.equal(back.outcome, 'SUPPRESSED_COOLDOWN');
  assert.match(back.reason, /IN_COOLDOWN/);
  assert.equal(s.suppressedCount(MERCHANT_A, first.key), 1);
  assert.equal(s.selectPriorities(MERCHANT_A).priority.length, 0);
  const worse = again({ immobilized_value: 9500 }, days(6)); // 9500 >= 6000 * 1.5
  assert.equal(worse.outcome, 'ACCEPTED');
  assert.match(worse.reason, /reopened/);
  const later = again({}, days(31));
  assert.equal(later.outcome, 'ACCEPTED');
});

// 6
test('6. levers are filtered by eligibility (type, required facts, conditions)', () => {
  const s = newStore();
  const subj = accept(s, dormant());
  const levers = [
    createLever(lever({ id: 'x.NEEDS_FACT', eligibility: { requires_facts: ['no_such_fact'] } })),
    createLever(lever({ id: 'x.OTHER_TYPE', eligibility: { subject_types: ['CASH_FLOOR_RISK'] } })),
    createLever(lever({ id: 'x.CONDITION', eligibility: { conditions: [{ fact: 'units_on_hand', op: 'gt', value: 1000 }] } })),
    createLever(lever({ id: 'x.OK', eligibility: { subject_types: ['DORMANT_INVENTORY'], requires_facts: ['units_on_hand'], conditions: [{ fact: 'units_on_hand', op: 'gt', value: 100 }] } })),
  ];
  const { decision } = s.decide(MERCHANT_A, subj.id, levers, NOW);
  const el = Object.fromEntries(decision.eliminated.map((e) => [e.lever_id, e]));
  assert.equal(el['x.NEEDS_FACT'].stage, 'ELIGIBILITY');
  assert.deepEqual(el['x.NEEDS_FACT'].reasons, ['MISSING_FACT:no_such_fact']);
  assert.match(el['x.OTHER_TYPE'].reasons[0], /NOT_APPLICABLE_TO_TYPE/);
  assert.match(el['x.CONDITION'].reasons[0], /CONDITION_NOT_MET/);
  assert.ok(decision.remaining.some((r) => r.lever_id === 'x.OK'));
  assert.equal(el['x.OK'], undefined);
});

// 7
test('7. a hard constraint eliminates a lever that worsens it (cash floor)', () => {
  const s = newStore();
  const subj = accept(s, buildCashFloorRiskSubject(fx.CASH_INPUT));
  assert.equal(subj.status, 'TO_DECIDE');
  const levers = [...cashLevers(subj, fx.CASH_ASSUMPTIONS), createLever(fx.AGGRAVATING_LEVER)];
  const { decision } = s.decide(MERCHANT_A, subj.id, levers, NOW);
  const campaign = decision.eliminated.find((e) => e.lever_id === 'marketing.PAID_CAMPAIGN');
  assert.equal(campaign.stage, 'RULES');
  assert.match(campaign.reasons[0], /owner\.min_cash: worsens a hard constraint/);
  const sell = decision.eliminated.find((e) => e.lever_id === 'cash.SELL_DOWN_STOCK');
  assert.match(sell.reasons[0], /owner\.min_margin: resulting margin 12% < minimum 20%/);
  assert.ok(!decision.remaining.some((r) => r.lever_id === 'marketing.PAID_CAMPAIGN'));
  // no single lever resolves the breach; the declared-combinable pair does.
  assert.equal(decision.recommended.kind, 'COMBINED');
  assert.deepEqual(decision.recommended.lever_ids, ['cash.DEFER_PURCHASE', 'cash.ACCELERATE_COLLECTIONS']);
  assert.equal(decision.unresolved_constraints[0].resolved_by_recommendation, true);
  assert.match(decision.recommended.rationale.join(' '), /resolves the breached hard constraint/);
});

// 8
test('8. NEEDS_HUMAN stays visible and requires human input', () => {
  const s = newStore();
  const subj = accept(s, dormant());
  const unknownMargin = createLever(lever({
    id: 'x.PRICE_UNKNOWN_MARGIN', touches_price: true, parameters: { discount_pct: 10 },
    estimated_effects: { cash_impact: 9000, margin_impact: null, time_to_cash_days: 10, capacity_impact: 0, inventory_impact: -100 },
  }));
  const { decision } = s.decide(MERCHANT_A, subj.id, [unknownMargin], NOW);
  const entry = decision.remaining.find((r) => r.lever_id === 'x.PRICE_UNKNOWN_MARGIN');
  assert.equal(entry.needs_human[0].result, 'NEEDS_HUMAN');
  assert.equal(decision.needs_human[0].rule_id, 'owner.min_margin');
  assert.deepEqual(decision.recommended.lever_ids, ['x.PRICE_UNKNOWN_MARGIN']);
  assert.equal(decision.approval_status, 'NEEDS_HUMAN_INPUT');
  const rule = createRule({ id: 'r', type: 'MIN_CASH', params: { min_cash: 1, horizon_days: 1 } });
  const noFact = evaluateRule(rule, createLever(lever({})), plainSubject());
  assert.equal(noFact.result, 'NEEDS_HUMAN');
  assert.match(noFact.reason, /projected_cash/);
});

// 9
test('9. DO_NOTHING is always available, even when every other lever is eliminated', () => {
  const s = newStore();
  const subj = accept(s, buildCashFloorRiskSubject(fx.CASH_INPUT));
  const { decision } = s.decide(MERCHANT_A, subj.id, [createLever(fx.AGGRAVATING_LEVER)], NOW);
  assert.ok(decision.remaining.some((r) => r.lever_id === 'DO_NOTHING'));
  assert.ok(!decision.eliminated.some((e) => e.lever_id === 'DO_NOTHING'));
  assert.equal(decision.recommended.kind, 'DO_NOTHING');
  assert.equal(decision.unresolved_constraints[0].resolved_by_recommendation, false);
  const alone = decide({ subject: triageSubject(plainSubject()), levers: [], ruleSet: rulesA(), config: CONFIG, now: NOW });
  assert.ok(alone.levers_examined.some((l) => l.lever_id === 'DO_NOTHING' && l.status === 'ELIGIBLE'));
});

// 10
test('10. TEST_SMALL is available when relevant, and visibly dropped when there is nothing to learn', () => {
  const s = newStore();
  const subj = accept(s, dormant());
  const { decision } = s.decide(MERCHANT_A, subj.id, inventoryLevers(subj, fx.DORMANT_ASSUMPTIONS), NOW);
  assert.ok(decision.remaining.some((r) => r.lever_id === 'TEST_SMALL'));
  assert.equal(decision.recommended.kind, 'TEST_SMALL'); // best option has LOW confidence -> test first
  assert.equal(decision.recommended.tests_lever_id, 'inventory.WAIT_SEASON');
  const sure = triageSubject(dormant({ confidence: 'HIGH' }));
  const bundleOnly = createLever(lever({ id: 'inventory.BUNDLE2', eligibility: { subject_types: ['DORMANT_INVENTORY'] } }));
  const d2 = decide({ subject: sure, levers: [bundleOnly], ruleSet: rulesA(), config: CONFIG, now: NOW });
  const ts = d2.eliminated.find((e) => e.lever_id === 'TEST_SMALL');
  assert.equal(ts.stage, 'RELEVANCE');
  assert.match(ts.reasons[0], /NOT_RELEVANT/);
});

// 11
test('11. comparison has no multiplicative score: declared axis priority decides, units stay separate', () => {
  const P = createLever(lever({ id: 'x.P', estimated_effects: { cash_impact: 1000, margin_impact: 500, time_to_cash_days: 10, capacity_impact: 0, inventory_impact: 0 }, risk: 'LOW', confidence: 'HIGH' }));
  const Q = createLever(lever({ id: 'x.Q', estimated_effects: { cash_impact: 1500, margin_impact: 400, time_to_cash_days: 10, capacity_impact: 0, inventory_impact: 0 }, risk: 'HIGH', confidence: 'MEDIUM' }));
  const run = (config) => decide({ subject: triageSubject(plainSubject({ confidence: 'HIGH' })), levers: [P, Q], ruleSet: rulesA(), config, now: NOW });
  // impact*confidence/risk would pick P (3000 vs 1000). The engine follows the declared priority (cash first) instead.
  const byCash = run({ ...CONFIG, testSmall: undefined });
  assert.equal(byCash.recommended.lever_ids[0], 'x.Q');
  assert.equal(byCash.comparison_method.multiplicative_score, false);
  assert.equal(byCash.comparison_method.uses_llm, false);
  const tr = byCash.tradeoffs.find((t) => t.vs === 'x.P');
  assert.ok(tr.alternative_better_on.some((a) => a.axis === 'risk' && a.winner === 'HIGH' && a.alternative === 'LOW'));
  // Changing only the declared priority flips the outcome: no hidden score.
  const riskFirst = run({ ...CONFIG, testSmall: undefined, profiles: { GENERIC: { axis_priority: ['risk', 'cash_impact'] } } });
  assert.equal(riskFirst.recommended.lever_ids[0], 'x.P');
  assert.deepEqual(resolveProfile('GENERIC', { profiles: { GENERIC: { axis_priority: ['risk'] } } }).axis_priority, ['risk']);
  assert.ok(!JSON.stringify(byCash).match(/"(score|weighted|priority_score)"/));
  const compare = fs.readFileSync(path.join(SRC_DIR, 'compare.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/confidence\s*\*|\*\s*[a-z.]*confidence|\/\s*[a-z.]*risk/i.test(compare));
});

// 12
test('12. the recommendation shows explicit trade-offs, alternatives and eliminated levers', () => {
  const s = newStore();
  const subj = accept(s, dormant());
  const { decision: d } = s.decide(MERCHANT_A, subj.id, inventoryLevers(subj, fx.DORMANT_ASSUMPTIONS), NOW);
  assert.equal(d.outcome, 'RECOMMENDED');
  assert.equal(d.subject.id, subj.id);
  assert.ok(d.levers_examined.length >= 7);
  const b2b = d.eliminated.find((e) => e.lever_id === 'inventory.B2B_LIQUIDATION');
  assert.match(b2b.reasons.join(' '), /discount 50% > maximum 40%/);
  assert.ok(d.alternatives.length > 0 && d.alternatives.every((a) => a.why_not.length > 0));
  const mk = d.alternatives.find((a) => a.lever_id === 'inventory.MARKETING_PUSH');
  assert.match(mk.why_not[0], /dominated by inventory\.BUNDLE/);
  const vsDiscount = d.tradeoffs.find((t) => t.vs === 'inventory.DISCOUNT');
  assert.ok(vsDiscount.alternative_better_on.some((a) => a.axis === 'time_to_cash_days'));
  assert.ok(d.recommended.rationale.length > 0);
  assert.ok(Array.isArray(d.missing_data));
  assert.equal(d.approval_status, 'AWAITING_HUMAN_DECISION');
  assert.ok(d.facts_used.length > 0 && d.rules_applied.length === fx.RULES_A.length);
});

test('12b. a combination is only proposed for levers that mutually declare they are combinable', () => {
  const s = newStore();
  const subj = accept(s, dormant({ confidence: 'HIGH' }));
  const A = createLever(lever({ id: 'x.A', estimated_effects: { cash_impact: 3000, margin_impact: 1000, time_to_cash_days: 10, capacity_impact: 0, inventory_impact: -50 }, combinable_with: ['x.B'] }));
  const B = createLever(lever({ id: 'x.B', estimated_effects: { cash_impact: 1000, margin_impact: 800, time_to_cash_days: 20, capacity_impact: 0, inventory_impact: -20 }, combinable_with: ['x.A'] }));
  const C = createLever(lever({ id: 'x.C', estimated_effects: { cash_impact: 900, margin_impact: 700, time_to_cash_days: 20, capacity_impact: 0, inventory_impact: -20 } }));
  const d = s.decide(MERCHANT_A, subj.id, [A, B, C], NOW).decision;
  assert.equal(d.recommended.kind, 'COMBINED');
  assert.deepEqual(d.recommended.lever_ids, ['x.A', 'x.B']);
  assert.equal(d.recommended.axes.cash_impact, 4000);
  assert.ok(!d.recommended.lever_ids.includes('x.C'));
});

// 13
test('13. the human decision is recorded (who, why, when, what was planned)', () => {
  const s = newStore();
  const subj = accept(s, dormant());
  const { decision, log_entry } = s.decide(MERCHANT_A, subj.id, inventoryLevers(subj, fx.DORMANT_ASSUMPTIONS), NOW);
  assert.equal(log_entry.human_decision, null);
  assert.ok(log_entry.facts_used.length && log_entry.rules_applied.length && log_entry.options.examined.length);
  assert.deepEqual(log_entry.recommendation.lever_ids, decision.recommended.lever_ids);
  assert.throws(() => s.recordHumanDecision(MERCHANT_A, log_entry.id, { decision: 'APPROVED', reason: 'ok', approver: 'engine', decided_at: NOW }), /APPROVER_NOT_HUMAN/);
  assert.throws(() => s.recordHumanDecision(MERCHANT_A, log_entry.id, { decision: 'APPROVED', reason: '', approver: 'Owner', decided_at: NOW }), /reason/);
  assert.throws(() => s.recordHumanDecision(MERCHANT_A, log_entry.id, { decision: 'APPROVED_ALTERNATIVE', chosen_lever_ids: ['inventory.B2B_LIQUIDATION'], reason: 'cash', approver: 'Owner', decided_at: NOW }), /LEVER_ELIMINATED/);
  const done = s.recordHumanDecision(MERCHANT_A, log_entry.id, {
    decision: 'APPROVED', reason: 'learn before committing stock', approver: 'Owner (synthetic)', decided_at: days(1),
    planned_actions: ['run a 50-unit test'], next_review_at: days(15),
  });
  assert.deepEqual(done.human_decision, { decision: 'APPROVED', reason: 'learn before committing stock', approver: 'Owner (synthetic)', decided_at: days(1), chosen_lever_ids: ['TEST_SMALL'] });
  assert.deepEqual(done.planned_actions, ['run a 50-unit test']);
  assert.equal(done.next_review_at, days(15));
  assert.equal(s.getSubject(MERCHANT_A, subj.id).status, 'IN_PROGRESS');
  assert.throws(() => s.recordHumanDecision(MERCHANT_A, log_entry.id, { decision: 'REJECTED', reason: 'x', approver: 'Owner', decided_at: NOW }), /ALREADY_DECIDED/);
  const s2 = newStore();
  const subj2 = accept(s2, dormant());
  const e2 = s2.decide(MERCHANT_A, subj2.id, [], NOW).log_entry;
  s2.recordHumanDecision(MERCHANT_A, e2.id, { decision: 'REJECTED', reason: 'not a priority', approver: 'Owner', decided_at: NOW });
  assert.equal(s2.getSubject(MERCHANT_A, subj2.id).status, 'DISMISSED');
});

// 14
test('14. a result can be NOT_MEASURABLE; every V0 result value exists', () => {
  const s = newStore();
  const subj = accept(s, dormant());
  const { log_entry } = s.decide(MERCHANT_A, subj.id, inventoryLevers(subj, fx.DORMANT_ASSUMPTIONS), NOW);
  assert.throws(() => s.recordResult(MERCHANT_A, log_entry.id, { result: 'CONFIRMED', evidence_level: 'STRONG', measured_at: NOW }), /NO_HUMAN_DECISION/);
  s.recordHumanDecision(MERCHANT_A, log_entry.id, { decision: 'APPROVED', reason: 'test', approver: 'Owner', decided_at: NOW });
  const r = s.recordResult(MERCHANT_A, log_entry.id, { result: 'NOT_MEASURABLE', measured_at: days(20), notes: 'too few sales to tell' });
  assert.equal(r.result.result, 'NOT_MEASURABLE');
  assert.equal(r.result.evidence_level, 'NONE');
  assert.equal(s.getSubject(MERCHANT_A, subj.id).status, 'RESULT');
});

test('14b. result vocabulary is exactly CONFIRMED / SUGGESTIVE / REFUTED / NOT_MEASURABLE / UNKNOWN', async () => {
  const { OUTCOME_RESULT } = await import('../src/socle-decision/index.js');
  assert.deepEqual(Object.values(OUTCOME_RESULT).sort(), ['CONFIRMED', 'NOT_MEASURABLE', 'REFUTED', 'SUGGESTIVE', 'UNKNOWN']);
});

// 15
test('15. a weak (or strong) result never changes the rules: no automatic learning', async () => {
  for (const [result, evidence_level] of [['SUGGESTIVE', 'WEAK'], ['CONFIRMED', 'STRONG'], ['REFUTED', 'MODERATE']]) {
    const s = newStore();
    const subj = accept(s, dormant());
    const { log_entry } = s.decide(MERCHANT_A, subj.id, inventoryLevers(subj, fx.DORMANT_ASSUMPTIONS), NOW);
    s.recordHumanDecision(MERCHANT_A, log_entry.id, { decision: 'APPROVED', reason: 'test', approver: 'Owner', decided_at: NOW });
    const before = JSON.stringify(s.snapshotRules(MERCHANT_A));
    const done = s.recordResult(MERCHANT_A, log_entry.id, { result, evidence_level, measured_at: days(10) });
    assert.equal(JSON.stringify(s.snapshotRules(MERCHANT_A)), before);
    assert.equal(s.getRuleSet(MERCHANT_A).rules.length, fx.RULES_A.length);
    assert.deepEqual(done.learning.rule_changes, []);
  }
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(newStore()));
  assert.ok(!names.some((n) => /learn|addRule|updateRule|promote/i.test(n)), names.join(','));
  const ledger = await import('../src/socle-decision/ledger.js');
  assert.ok(!Object.keys(ledger).some((n) => /rule|learn/i.test(n)));
  assert.ok(!/from '\.\/rules\.js'|import .*rules/.test(fs.readFileSync(path.join(SRC_DIR, 'ledger.js'), 'utf8')));
});

// 16
test('16. strict merchant_id isolation', () => {
  const s = newStore();
  s.setRuleSet(MERCHANT_B, createRuleSet(MERCHANT_B, fx.RULES_A));
  const subjA = accept(s, dormant());
  const subjB = accept(s, dormant({ merchant_id: MERCHANT_B, immobilized_value: 7000 }));
  const entryA = s.decide(MERCHANT_A, subjA.id, [], NOW).log_entry;
  assert.equal(s.getSubject(MERCHANT_B, subjA.id), undefined);
  assert.equal(s.getLogEntry(MERCHANT_B, entryA.id), undefined);
  assert.deepEqual(s.listSubjects(MERCHANT_B).map((x) => x.id), [subjB.id]);
  assert.deepEqual(s.getLog(MERCHANT_B), []);
  assert.throws(() => s.decide(MERCHANT_B, subjA.id, [], NOW), /NOT_FOUND/);
  assert.throws(() => s.recordHumanDecision(MERCHANT_B, entryA.id, { decision: 'REJECTED', reason: 'x', approver: 'Owner', decided_at: NOW }), /NOT_FOUND/);
  assert.throws(() => s.recordResult(MERCHANT_B, entryA.id, { result: 'UNKNOWN', measured_at: NOW }), /NOT_FOUND/);
  assert.throws(() => s.ingestSubject(MERCHANT_B, subjA, NOW), /MERCHANT_MISMATCH/);
  assert.throws(() => s.setRuleSet(MERCHANT_B, rulesA()), /MERCHANT_MISMATCH/);
  assert.throws(() => decide({ subject: subjA, levers: [], ruleSet: createRuleSet(MERCHANT_B, fx.RULES_A), config: CONFIG, now: NOW }), /MERCHANT_MISMATCH/);
  assert.throws(() => selectPriorities([subjA, subjB], CONFIG, MERCHANT_A), /MERCHANT_MISMATCH/);
  // B's cooldown/priorities are not affected by A's dismissal
  s.dismissSubject(MERCHANT_A, subjA.id, { reason: 'x', approver: 'Owner', now: NOW });
  assert.equal(s.selectPriorities(MERCHANT_B).priority.length, 1);
  assert.equal(s.ingestSubject(MERCHANT_B, dormant({ merchant_id: MERCHANT_B, detected_at: days(2) }), days(2)).outcome, 'ACCEPTED');
});

// 17
test('17. no network call: fetch is trapped during a full cycle; sources contain no I/O primitives', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('network forbidden'); };
  try {
    const s = newStore();
    const subj = accept(s, dormant());
    const { log_entry } = s.decide(MERCHANT_A, subj.id, inventoryLevers(subj, fx.DORMANT_ASSUMPTIONS), NOW);
    s.recordHumanDecision(MERCHANT_A, log_entry.id, { decision: 'APPROVED', reason: 'test', approver: 'Owner', decided_at: NOW });
    s.recordResult(MERCHANT_A, log_entry.id, { result: 'UNKNOWN', measured_at: NOW });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
  const forbidden = /\bfetch\s*\(|node:(http|https|net|dns|tls|child_process|fs|worker_threads)|XMLHttpRequest|WebSocket|process\.env|Date\.now\s*\(|new Date\(\s*\)|Math\.random|require\(/;
  for (const f of listSources()) {
    const code = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!forbidden.test(code), `${path.relative(SRC_DIR, f)} uses a forbidden primitive`);
  }
});

// 18
test('18. no access to forbidden domains; domains hold no arbitration logic', () => {
  const importRe = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const f of listSources()) {
    const code = fs.readFileSync(f, 'utf8');
    for (const m of code.matchAll(importRe)) {
      const spec = m[1] ?? m[2];
      if (spec === 'node:crypto') continue;
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${f}: non-relative import ${spec}`);
      const resolved = path.resolve(path.dirname(f), spec);
      assert.ok(resolved.startsWith(SRC_DIR + path.sep), `${f} imports outside the module: ${spec}`);
      assert.ok(!/finance|analytics|china|sourcing|identity|security|tenant|brain|shopify|supabase|connectors/i.test(path.relative(SRC_DIR, resolved)), `${f}: forbidden area ${spec}`);
    }
  }
  const allowed = new Set(['../constants.js', '../lever.js', '../subject.js', '../util.js']);
  const domainFiles = listSources(path.join(SRC_DIR, 'domains'));
  assert.equal(domainFiles.length, 3);
  for (const f of domainFiles) {
    const code = fs.readFileSync(f, 'utf8');
    for (const m of code.matchAll(importRe)) assert.ok(allowed.has(m[1] ?? m[2]), `${path.basename(f)} imports ${m[1] ?? m[2]}`);
    const body = code.replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(recommend|decide|rankLexicographic|dominates|evaluateRules?|selectPriorities)\b/.test(body), `${path.basename(f)} contains arbitration logic`);
  }
});

// Three validation cases (also printed in the delivery report)
test('case A - DORMANT_INVENTORY: levers compared once by the common engine', () => {
  const s = newStore();
  const subj = accept(s, dormant());
  const d = s.decide(MERCHANT_A, subj.id, inventoryLevers(subj, fx.DORMANT_ASSUMPTIONS), NOW).decision;
  assert.equal(d.outcome, 'RECOMMENDED');
  assert.equal(d.recommended.kind, 'TEST_SMALL');
  assert.ok(d.eliminated.some((e) => e.lever_id === 'inventory.B2B_LIQUIDATION'));
});

test('case B - CASH_FLOOR_RISK: actions that worsen the hard constraint are eliminated', () => {
  const s = newStore();
  const subj = accept(s, buildCashFloorRiskSubject(fx.CASH_INPUT));
  const d = s.decide(MERCHANT_A, subj.id, [...cashLevers(subj, fx.CASH_ASSUMPTIONS), createLever(fx.AGGRAVATING_LEVER)], NOW).decision;
  assert.ok(d.eliminated.some((e) => e.lever_id === 'marketing.PAID_CAMPAIGN' && e.stage === 'RULES'));
  assert.equal(d.recommended.kind, 'COMBINED');
});

test('case C - FOOTFALL_DECLINE: insufficient data gives TO_VERIFY, never "run a campaign"', () => {
  const s = newStore();
  const subj = accept(s, buildFootfallDeclineSubject(fx.FOOTFALL_INCOMPLETE_INPUT));
  assert.equal(subj.status, 'TO_VERIFY');
  assert.deepEqual(subj.missing_data.map((m) => m.field).sort(), ['conversion_rate', 'measurement_reliability', 'seasonality_baseline']);
  const d = s.decide(MERCHANT_A, subj.id, footfallLevers(subj, fx.FOOTFALL_ASSUMPTIONS), NOW).decision;
  assert.equal(d.outcome, 'TO_VERIFY');
  assert.equal(d.recommended, null);
  assert.equal(d.levers_examined.length, 0);
  assert.equal(d.verification_needed.length, 3);
  // an unreliable counter makes the visits fact suspect -> still TO_VERIFY
  const unreliable = triageSubject(buildFootfallDeclineSubject({ ...fx.FOOTFALL_COMPLETE_INPUT, counter_reliable: false }));
  assert.equal(unreliable.status, 'TO_VERIFY');
  assert.ok(unreliable.triage.reasons.includes('SUSPECT_FACT:visits_current'));
  // with sufficient data the engine can decide (and campaign is not automatic)
  const s2 = newStore();
  const full = accept(s2, buildFootfallDeclineSubject(fx.FOOTFALL_COMPLETE_INPUT));
  assert.equal(full.status, 'TO_DECIDE');
  const d2 = s2.decide(MERCHANT_A, full.id, footfallLevers(full, fx.FOOTFALL_ASSUMPTIONS), NOW).decision;
  assert.equal(d2.outcome, 'RECOMMENDED');
  assert.notDeepEqual(d2.recommended.lever_ids, ['footfall.LOCAL_CAMPAIGN']);
});
