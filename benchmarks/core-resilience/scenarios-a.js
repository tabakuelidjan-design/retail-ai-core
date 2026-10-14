import { createDependencyGraph, applyChange, readInput, readStructuredReply, reconcileStatements, requireCollections, TERMINAL_STATE, runResilient, createRecoveryBudget } from '../../src/core-resilience/index.js';
import { CREATIVE_DEPENDENCIES } from '../../src/core-resilience/adapters/index.js';
import { evaluateCandidate } from '../../src/buying/evaluate.js';
import { buildDemandFacts } from '../../src/demand/build.js';
import { buildCustomerFacts } from '../../src/customers/facts.js';
import { buildLedger } from '../../src/metrics/ledger.js';
import { computeSalesMetrics } from '../../src/metrics/sales.js';
import { createMarketingCopy, loadAlibabaCreativeConfig, SpendGuard } from '../../src/marketing-creative/alibaba/index.js';
import { FinanceError } from '../../src/finance/document.js';
import { candidate, healthyPeerFacts, NOW as BUY_NOW, policy as buyPolicy } from '../../test/fixtures/buying-sample.js';
import { CONFIG as DEMAND_CONFIG, makeDemandData, NOW as DEMAND_NOW, TZ } from '../../test/fixtures/demand-sample.js';
import { makeMarketingData, NOW as MKT_NOW } from '../../test/fixtures/marketing-sample.js';
import { CONFIG as METRICS_CONFIG, FULL_WINDOW, makeData } from '../../test/fixtures/metrics-sample.js';
import {
  go, http, markerOf, ok, real, scenario as S, stage, failing, flaky,
} from './kit.js';
import {
  askFrame, creativeRun, CONCEPTS, frameAnswer, issueInvoice, makeService, MERCHANT_ACTOR,
} from './workloads.js';
import { FINANCE_POLICY } from '../../src/core-resilience/adapters/index.js';

const CONCEPTS_ANSWER = { concepts: CONCEPTS };
const DONE = { terminal: TERMINAL_STATE.COMPLETED };
const CLEAN = { classification: null, action: null, ...DONE };

// the fake provider configuration used by the Alibaba scenarios (a fake key; the fetch is a fake: no network)
const alibabaConfig = loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_API_KEY: 'chaos-fake-key-0000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'workspace-chaos' });
const jsonResponse = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(payload); } });
const copyCall = (fetchImpl) => createMarketingCopy({ config: alibabaConfig, brief: 'Return JSON', dataPolicy: { classification: 'PUBLIC' }, budget: new SpendGuard({ maxSpendEur: 1 }), fetchImpl });
const copyOk = () => jsonResponse({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 5 }, id: 'chaos-ok' });

const inputRules = { price: { kind: 'amount', required: true, factClass: 'price' }, headline: { kind: 'text', required: true, max: 120 } };
const asIssue = (readout) => { if (readout.issues.length) throw readout.issues[0]; return readout.values; };

const demandFacts = (mutate) => () => {
  const data = makeDemandData(); mutate?.(data);
  const f = buildDemandFacts({ ledger: buildLedger(data, { config: DEMAND_CONFIG }), data, now: DEMAND_NOW, timeZone: TZ, config: DEMAND_CONFIG, salesReconciled: true });
  return { products: f.products.length };
};

// ============================================================================================================ A. CLEAN INPUT
export const groupA = [
  S('A', 'core', 'clean_input', CLEAN, (env, id) => go(env, id, 'core', [ok('a'), ok('b'), ok('c')])),
  S('A', 'creative', 'clean_input', CLEAN, (env, id) => go(env, id, 'creative', [real('brain', () => creativeRun())])),
  S('A', 'finance', 'clean_input', CLEAN, (env, id) => go(env, id, 'finance', [real('invoice_paid', async () => { const { svc } = makeService(); const inv = await issueInvoice(svc); await svc.recordPayment(inv.id, { amount: '71.90', paidOn: '2026-09-25', method: 'bank_transfer' }, MERCHANT_ACTOR); return (await svc.view(inv.id)).doc.status; })], { modulePolicy: FINANCE_POLICY })),
  S('A', 'buying', 'clean_input', CLEAN, (env, id) => go(env, id, 'buying', [real('evaluate', () => evaluateCandidate({ rawCandidate: candidate(), demandFacts: healthyPeerFacts(), config: buyPolicy(), now: BUY_NOW }).verdict)])),
  S('A', 'demand', 'clean_input', CLEAN, (env, id) => go(env, id, 'demand', [real('facts', demandFacts())])),
  S('A', 'customers', 'clean_input', CLEAN, (env, id) => go(env, id, 'customers', [real('facts', () => { const d = makeMarketingData(); return Object.keys(buildCustomerFacts({ ledger: buildLedger(d, { config: METRICS_CONFIG }), data: d, now: MKT_NOW, config: METRICS_CONFIG })).length; })])),
  S('A', 'analytics', 'clean_input', CLEAN, (env, id) => go(env, id, 'analytics', [real('sales', () => computeSalesMetrics(buildLedger(makeData(), { config: METRICS_CONFIG }), FULL_WINDOW).order_count)])),
  S('A', 'creative', 'clean_input', CLEAN, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame([frameAnswer()]))])),
];

// ============================================================================================================ B. INCOMPLETE INPUT
const readPlan = (rules, input, extra = {}) => [stage('read_input', async (ctx) => asIssue(readInput(rules, ctx.input.fields, { module: ctx.module, stage: 'read_input', tenant: ctx.tenant })), extra), ok('use')];
export const groupB = [
  S('B', 'core', 'missing_price', { classification: 'MISSING_INFORMATION', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'marketing', readPlan(inputRules, null), { input: { fields: { headline: 'Spring sale' } } })),
  S('B', 'core', 'missing_with_declared_default', CLEAN, (env, id) => go(env, id, 'marketing', readPlan({ ...inputRules, price: { kind: 'amount', required: true, safeDefault: 0 } }, null), { input: { fields: { headline: 'Spring sale' } } })),
  S('B', 'core', 'missing_default_applied_by_recovery', { classification: 'MISSING_INFORMATION', action: 'NORMALIZE', ...DONE }, (env, id) => go(env, id, 'marketing', [
    stage('read_input', async (ctx) => asIssue(readInput(inputRules, ctx.input.fields, { module: ctx.module, stage: 'read_input' })), { handlers: { normalize: async () => ({ headline: 'Spring sale', price: null, defaulted: true }) } }), ok('use')], { input: { fields: { headline: 'Spring sale' } } })),
  S('B', 'core', 'empty_required_text', { classification: 'MISSING_INFORMATION', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'marketing', readPlan(inputRules, null), { input: { fields: { headline: '', price: '25' } } })),
  S('B', 'buying', 'null_like_supplier_claim', { classification: 'MISSING_INFORMATION', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'buying', readPlan({ supplier_claim: { kind: 'text', required: true, factClass: 'supplier_claim' } }, null), { input: { fields: { supplier_claim: 'N/A' } } })),
  S('B', 'core', 'whitespace_only', { classification: 'MISSING_INFORMATION', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'marketing', readPlan(inputRules, null), { input: { fields: { headline: '  \t\n ', price: '25' } } })),
  S('B', 'finance', 'missing_credit_reason', { classification: 'MISSING_INFORMATION', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'finance', [stage('credit', async () => { throw new FinanceError('REASON_REQUIRED'); })], { modulePolicy: FINANCE_POLICY })),
  S('B', 'compliance', 'missing_compliance_fact_no_user', { classification: 'MISSING_INFORMATION', action: 'GRACEFUL_BLOCK', terminal: TERMINAL_STATE.BLOCKED_GRACEFULLY }, (env, id) => go(env, id, 'compliance', readPlan({ eco_label: { kind: 'text', required: true, factClass: 'compliance' } }, null), { input: { fields: {} }, canAskUser: false })),
  S('B', 'demand', 'missing_collection', { classification: 'MISSING_INFORMATION', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'demand', [stage('guard', async (ctx) => { const problems = requireCollections({ orders: null, orderLines: [] }, ['orders', 'orderLines'], { module: 'demand', stage: 'guard', tenant: ctx.tenant }); if (problems.length) throw problems[0]; return 1; }), ok('facts')])),
];

// ============================================================================================================ C. MALFORMED INPUT
const GOOD_JSON = JSON.stringify({ title: 'Spring sale', body: 'Fresh arrivals' });
const structured = (texts, extra = {}) => {
  let n = 0;
  return stage('read_reply', async (ctx) => { const r = readStructuredReply(texts[Math.min(n, texts.length - 1)], { module: ctx.module, stage: 'read_reply', expectedKeys: ['title', 'body'] }); n += 1; if (!r.ok) throw r.error; return r.value; },
    { reaskable: true, handlers: { reask: async () => { n = texts.length - 1; const r = readStructuredReply(texts[n], { module: 'marketing', stage: 'read_reply', expectedKeys: ['title', 'body'] }); if (!r.ok) throw r.error; return r.value; } }, ...extra });
};
export const groupC = [
  S('C', 'creative', 'broken_array_repaired_by_brain', { ...CLEAN }, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame(['{"what_we_show": ["broken"', frameAnswer()]))]).then((b) => ({ ...b, protocolRepairs: 1 }))),
  S('C', 'creative', 'broken_twice', { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: TERMINAL_STATE.BLOCKED_GRACEFULLY }, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame(['{"what_we_show": [', '{"what_we_show": ["still']))])),
  S('C', 'marketing', 'malformed_json_reasked', { classification: 'PROTOCOL_ERROR', action: 'REASK_PROVIDER', ...DONE }, (env, id) => go(env, id, 'marketing', [structured(['{"title": "x", "body": [', GOOD_JSON])])),
  S('C', 'marketing', 'empty_body', { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: TERMINAL_STATE.BLOCKED_GRACEFULLY }, (env, id) => go(env, id, 'marketing', [structured(['   ', GOOD_JSON])])),
  S('C', 'marketing', 'duplicate_keys', { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: TERMINAL_STATE.BLOCKED_GRACEFULLY }, (env, id) => go(env, id, 'marketing', [structured(['{"title": "a", "title": "b", "body": "c"}', GOOD_JSON])])),
  S('C', 'marketing', 'ambiguous_amount', { classification: 'INPUT_INVALID', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'marketing', readPlan(inputRules, null), { input: { fields: { headline: 'Sale', price: '1.250' } } })),
  S('C', 'marketing', 'not_an_amount', { classification: 'INPUT_INVALID', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'marketing', readPlan(inputRules, null), { input: { fields: { headline: 'Sale', price: 'cheap' } } })),
  S('C', 'marketing', 'number_where_text_expected', { classification: 'INPUT_INVALID', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'marketing', readPlan(inputRules, null), { input: { fields: { headline: 42, price: '25' } } })),
  S('C', 'marketing', 'wrapper_unwrapped', CLEAN, (env, id) => go(env, id, 'marketing', [structured([JSON.stringify({ answer: JSON.parse(GOOD_JSON) })])])),
];

// ============================================================================================================ D. CONTRADICTORY USER INPUT
const reconcileStage = (statements, opts = {}, extra = {}) => stage('reconcile', async (ctx) => { const r = reconcileStatements(statements, { ...opts, module: ctx.module, stage: 'reconcile', tenant: ctx.tenant }); if (r.contradictions.length) throw r.contradictions[0]; return r.resolved; }, extra);
const ASK = { classification: 'USER_CONTRADICTION', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER };
export const groupD = [
  S('D', 'marketing', 'two_values_one_key', ASK, (env, id) => go(env, id, 'marketing', [reconcileStage([{ key: 'audience', value: 'teenagers' }, { key: 'audience', value: 'retirees' }])])),
  S('D', 'marketing', 'explicit_reversal_with_priority_rule', CLEAN, (env, id) => go(env, id, 'marketing', [reconcileStage([{ key: 'tone', value: 'playful' }, { key: 'tone', value: 'serious', explicit_change: true }], { priority: { tone: 'LATEST_WINS' } })])),
  S('D', 'marketing', 'reversal_without_priority_rule', ASK, (env, id) => go(env, id, 'marketing', [reconcileStage([{ key: 'tone', value: 'playful' }, { key: 'tone', value: 'serious', explicit_change: true }])])),
  S('D', 'marketing', 'same_value_written_differently', CLEAN, (env, id) => go(env, id, 'marketing', [reconcileStage([{ key: 'city', value: 'Namur' }, { key: 'city', value: '  namur ' }])])),
  S('D', 'finance', 'two_amounts', { ...ASK }, (env, id) => go(env, id, 'finance', [reconcileStage([{ key: 'amount', value: '25.00' }, { key: 'amount', value: '30.00' }])], { modulePolicy: FINANCE_POLICY })),
  S('D', 'creative', 'incompatible_audience', ASK, (env, id) => go(env, id, 'creative', [reconcileStage([{ key: 'audience', value: 'children only' }, { key: 'audience', value: 'adults only' }])])),
  S('D', 'marketing', 'resolved_by_explicit_priority_through_recovery', { ...ASK, action: 'NORMALIZE', ...DONE }, (env, id) => go(env, id, 'marketing', [reconcileStage([{ key: 'tone', value: 'a' }, { key: 'tone', value: 'b' }], {}, { handlers: { normalize: async () => ({ tone: 'b', by: 'explicit_user_priority_rule' }) } })])),
];

// ============================================================================================================ E. EXTREME TEXT / DATA LENGTH
const fieldPlan = (value, max = 2000, multiline = false) => [stage('read_input', async (ctx) => asIssue(readInput({ copy: { kind: 'text', required: true, max, multiline } }, { copy: value }, { module: ctx.module, stage: 'read_input', tenant: ctx.tenant }))), ok('use')];
export const groupE = [
  S('E', 'marketing', 'one_hundred_thousand_characters', { classification: 'INPUT_INVALID', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'marketing', fieldPlan('word '.repeat(20000)))),
  S('E', 'marketing', 'one_character', CLEAN, (env, id) => go(env, id, 'marketing', fieldPlan('A'))),
  S('E', 'marketing', 'long_marketing_copy_within_limit', CLEAN, (env, id) => go(env, id, 'marketing', fieldPlan(`${'Notre collection de printemps, pensée pour durer.\n'.repeat(30)}`, 2000, true))),
  S('E', 'marketing', 'exactly_at_the_limit', CLEAN, (env, id) => go(env, id, 'marketing', fieldPlan('x'.repeat(2000)))),
  S('E', 'marketing', 'one_over_the_limit', { classification: 'INPUT_INVALID', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'marketing', fieldPlan('x'.repeat(2001)))),
  S('E', 'demand', 'ten_thousand_rows', CLEAN, (env, id) => go(env, id, 'demand', [real('guard', () => requireCollections({ orders: Array.from({ length: 10000 }, (_, i) => ({ i })) }, ['orders']).length)])),
  S('E', 'marketing', 'deeply_nested_json', CLEAN, (env, id) => go(env, id, 'marketing', [stage('read', async (ctx) => { const nested = `${'{"a":'.repeat(400)}1${'}'.repeat(400)}`; const r = readStructuredReply(nested, { module: ctx.module, stage: 'read' }); if (!r.ok) throw r.error; return 'parsed'; })])),
  S('E', 'creative', 'frame_field_over_its_contract_limit', { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: TERMINAL_STATE.BLOCKED_GRACEFULLY }, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame([{ ...frameAnswer(), rationale: 'r'.repeat(301) }]))])),
];

// ============================================================================================================ F. MULTILINGUAL INPUT
const textRun = (value, expectKept) => (env, id) => go(env, id, 'marketing', [stage('read_input', async (ctx) => { const r = readInput({ copy: { kind: 'text', required: true, max: 500, multiline: true } }, { copy: value }, { module: ctx.module, stage: 'read_input', tenant: ctx.tenant }); if (r.issues.length) throw r.issues[0]; if (expectKept && !expectKept(r.values.copy)) throw Object.assign(new Error('meaning changed'), { code: 'MEANING_CHANGED_BY_NORMALIZATION' }); return r.values; })]);
export const groupF = [
  S('F', 'marketing', 'french_decomposed_accents', CLEAN, textRun('Été à Namur', (v) => v === 'Été à Namur')),
  S('F', 'marketing', 'dutch', CLEAN, textRun('Mooie hoesjes met uw eigen foto', (v) => v === 'Mooie hoesjes met uw eigen foto')),
  S('F', 'marketing', 'arabic_with_bidi_marks', CLEAN, textRun('مرحبا ‏بكم', (v) => v.includes('‏'))),
  S('F', 'marketing', 'cjk_and_latin_mixed', CLEAN, textRun('春天特卖 Spring Sale セール', (v) => v === '春天特卖 Spring Sale セール')),
  S('F', 'marketing', 'emoji_family_with_joiners', CLEAN, textRun('Pour la famille \u{1F468}‍\u{1F469}‍\u{1F467}', (v) => v.includes('‍'))),
  S('F', 'marketing', 'persian_non_joiner', CLEAN, textRun('می‌خواهم', (v) => v.includes('‌'))),
  S('F', 'marketing', 'mixed_language_sentence', CLEAN, textRun('Commandez maintenant — bestel nu — order now!', (v) => v === 'Commandez maintenant — bestel nu — order now!')),
  S('F', 'marketing', 'zero_width_space_inside_word', CLEAN, textRun('Pri​x fi​nal', (v) => v === 'Prix final')),
];

// ============================================================================================================ G. USER CHANGE OF MIND
const STAGES = CREATIVE_DEPENDENCIES.stages.map((s) => s.name);
const countingPlan = () => STAGES.map((name) => stage(name, async (ctx) => { await ctx.callProvider(async () => 0); return { stage: name, marker: ctx.input.marker, rev: ctx.input.rev ?? 0 }; }));
/** Runs the whole plan, applies the user's change(s), runs again: only the invalidated stages run again. */
const changeRun = (changes, expectRecompute) => async (env, id) => {
  const first = await go(env, id, 'creative', countingPlan());
  const run = env.hub.handle(first.tenants[0], `run-${id.toLowerCase()}`);
  const before = Object.fromEntries(STAGES.map((s) => [s, run.get(s)]));
  const plans = changes.map((c) => applyChange(CREATIVE_DEPENDENCIES, run, c));
  const lastPlan = plans.at(-1);
  const second = await go(env, id, 'creative', countingPlan(), { input: { rev: 2 } });
  const preserved = lastPlan.preserved.filter((s) => before[s]);
  return { ...second, reports: [first.report, second.report], expectations: { committedValues: Object.fromEntries(preserved.map((s) => [s, before[s]])) },
    check: (_b, report) => (JSON.stringify(lastPlan.recompute) !== JSON.stringify(expectRecompute) ? `RECOMPUTE_${JSON.stringify(lastPlan.recompute)}` : report.provider_calls - first.report.provider_calls !== expectRecompute.length ? `RERAN_${report.provider_calls - first.report.provider_calls}_STAGES` : null) };
};
const ALL = STAGES;
export const groupG = [
  S('G', 'creative', 'headline_changed', CLEAN, changeRun([[{ fact: 'headline', change: 'CHANGED' }]], ['COMPOSE', 'SCENE', 'PRODUCTION_STRATEGY', 'PRODUCTION', 'CRITICS'])),
  S('G', 'creative', 'product_changed', CLEAN, changeRun([[{ fact: 'product', change: 'CHANGED' }]], ALL.filter((s) => s !== 'xx'))),
  S('G', 'creative', 'audience_changed', CLEAN, changeRun([[{ fact: 'audience', change: 'CHANGED' }]], ALL.filter((s) => s !== 'OBSERVE'))),
  S('G', 'creative', 'price_removed', CLEAN, changeRun([[{ fact: 'price', change: 'REMOVED' }]], ['COMPOSE', 'SCENE', 'PRODUCTION_STRATEGY', 'PRODUCTION', 'CRITICS'])),
  S('G', 'creative', 'brand_changed', CLEAN, changeRun([[{ fact: 'brand', change: 'CHANGED' }]], ALL)),
  S('G', 'creative', 'headline_changed_then_reverted', CLEAN, changeRun([[{ fact: 'headline', change: 'CHANGED' }], [{ fact: 'headline', change: 'CHANGED' }]], ['COMPOSE', 'SCENE', 'PRODUCTION_STRATEGY', 'PRODUCTION', 'CRITICS'])),
  S('G', 'creative', 'claim_added', CLEAN, changeRun([[{ fact: 'claim', change: 'ADDED' }]], ['COMPOSE', 'SCENE', 'PRODUCTION_STRATEGY', 'PRODUCTION', 'CRITICS'])),
  S('G', 'creative', 'unknown_fact_changed', { classification: 'INPUT_INVALID', action: 'ASK_USER', terminal: TERMINAL_STATE.NEEDS_USER }, (env, id) => go(env, id, 'creative', [stage('change', async () => { applyChange(CREATIVE_DEPENDENCIES, { uncommit: () => [], record: () => {} }, [{ fact: 'favourite_colour', change: 'CHANGED' }]); return 1; })])),
];

// ============================================================================================================ H. PROVIDER MALFORMED OUTPUT
const BLOCK = { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: TERMINAL_STATE.BLOCKED_GRACEFULLY };
export const groupH = [
  S('H', 'creative', 'wrapped_frame', CLEAN, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame([{ answer: frameAnswer() }]))])),
  S('H', 'creative', 'duplicate_key_frame', BLOCK, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame([JSON.stringify(frameAnswer()).replace('{', '{"felt":"another feeling of the same field",')]))])),
  S('H', 'creative', 'unknown_key_frame', BLOCK, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame([{ ...frameAnswer(), surprise: 'x' }]))])),
  S('H', 'creative', 'list_given_as_string', BLOCK, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame([{ ...frameAnswer(), generic_risks: 'one; two' }]))])),
  S('H', 'creative', 'empty_provider_body', BLOCK, (env, id) => go(env, id, 'creative', [real('frame', () => askFrame(['']))])),
  S('H', 'creative', 'critic_answer_malformed', BLOCK, (env, id) => go(env, id, 'creative', [failing('critic', 'PROVIDER_MALFORMED_CRITIC', {}, { reaskable: true, handlers: { reask: async () => 1 } })])),
  S('H', 'creative', 'invalid_image_result', BLOCK, (env, id) => go(env, id, 'creative', [failing('environment', 'PROVIDER_INVALID_IMAGE')])),
  S('H', 'creative', 'brain_run_ideation_broken_twice', { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: TERMINAL_STATE.BLOCKED_GRACEFULLY }, (env, id) => go(env, id, 'creative', [real('brain', () => creativeRun({ ideate: ['{"concepts": [{"central_idea": "x"', '{"concepts": [{"central_idea": "y"'] }))])),
  S('H', 'creative', 'brain_run_ideation_repaired_once', { ...CLEAN }, (env, id) => go(env, id, 'creative', [real('brain', () => creativeRun({ ideate: ['{"concepts": [{"central_idea": "x"', CONCEPTS_ANSWER] }))]).then((b) => ({ ...b, protocolRepairs: 1 }))),
  S('H', 'creative', 'brain_run_frame_wrapped', CLEAN, (env, id) => go(env, id, 'creative', [real('brain', () => creativeRun({ frame: [{ answer: frameAnswer() }] }))])),
];

// ============================================================================================================ I. PROVIDER TIMEOUT
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const RETRIED = { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', ...DONE };
export const groupI = [
  S('I', 'marketing-creative', 'timeout_then_success', RETRIED, (env, id) => go(env, id, 'marketing-creative', [flaky('call', 1, timeoutError, { idempotent: true })])),
  S('I', 'marketing-creative', 'timeout_every_time', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', terminal: TERMINAL_STATE.RECOVERY_EXHAUSTED }, (env, id) => go(env, id, 'marketing-creative', [stage('call', async () => { throw timeoutError(); }, { idempotent: true })])),
  S('I', 'marketing-creative', 'timeout_of_a_paid_call_not_retried', { classification: 'PROVIDER_FAILURE', action: 'GRACEFUL_BLOCK', terminal: TERMINAL_STATE.BLOCKED_GRACEFULLY }, (env, id) => go(env, id, 'marketing-creative', [flaky('image', 1, timeoutError, { idempotent: false })])),
  S('I', 'marketing-creative', 'etimedout_code', RETRIED, (env, id) => go(env, id, 'marketing-creative', [flaky('call', 1, () => Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }), { idempotent: true })])),
  S('I', 'marketing-creative', 'rate_limited_then_success', RETRIED, (env, id) => go(env, id, 'marketing-creative', [flaky('call', 1, () => http(429, { retryAfterMs: 1000 }), { idempotent: true })])),
  S('I', 'marketing-creative', 'real_text_call_timeout_then_success', RETRIED, (env, id) => {
    let n = 0;
    return go(env, id, 'marketing-creative', [real('copy', () => copyCall(async () => { n += 1; if (n === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return copyOk(); }), { idempotent: true })]);
  }),
  S('I', 'marketing-creative', 'real_text_call_503_then_success', RETRIED, (env, id) => {
    let n = 0;
    return go(env, id, 'marketing-creative', [real('copy', () => copyCall(async () => { n += 1; return n === 1 ? jsonResponse({ code: 'ServiceUnavailable' }, 503) : copyOk(); }), { idempotent: true })]);
  }),
  S('I', 'marketing-creative', 'connection_reset', RETRIED, (env, id) => go(env, id, 'marketing-creative', [flaky('call', 1, () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), { idempotent: true })])),
];
