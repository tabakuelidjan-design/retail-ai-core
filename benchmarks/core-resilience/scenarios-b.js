import { createCapabilityRegistry, createStateHub, TERMINAL_STATE, readInput } from '../../src/core-resilience/index.js';
import { FINANCE_POLICY, CREATIVE_POLICY } from '../../src/core-resilience/adapters/index.js';
import { FinanceError } from '../../src/finance/document.js';
import { normalizeCompositionPlan } from '../../src/creative-brain/composition.js';
import { evaluateCandidate } from '../../src/buying/evaluate.js';
import { buildDemandFacts } from '../../src/demand/build.js';
import { buildLedger } from '../../src/metrics/ledger.js';
import { guardSyncWrites, TenantWriteViolation } from '../../src/sync/write-guard.js';
import { insertInChunks, upsertInChunks } from '../../src/sync/batch.js';
import { createMarketingCopy, loadAlibabaCreativeConfig, SpendGuard } from '../../src/marketing-creative/alibaba/index.js';
import { candidate, NOW as BUY_NOW, healthyPeerFacts, policy as buyPolicy } from '../../test/fixtures/buying-sample.js';
import { CONFIG as DEMAND_CONFIG, makeDemandData, NOW as DEMAND_NOW, TZ } from '../../test/fixtures/demand-sample.js';
import { createFakeSupabase } from '../../test/fixtures/fake-supabase.js';
import {
  go, http, markerOf, meterCalls, ok, real, scenario as S, stage, failing, flaky,
} from './kit.js';
import {
  AGENT_ACTOR, compositionAnswer, creativeRun, CONCEPTS, draftInvoice, issueInvoice, makeService, MERCHANT_ACTOR, OTHER_CONCEPTS, PALE, selectAnswer,
} from './workloads.js';

const DONE = { terminal: TERMINAL_STATE.COMPLETED };
const BLOCKED = TERMINAL_STATE.BLOCKED_GRACEFULLY;
const ASKED = TERMINAL_STATE.NEEDS_USER;
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const refusal = () => Object.assign(new Error('Request rejected by the content filter'), { status: 400 });
const alibabaConfig = loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_API_KEY: 'chaos-fake-key-0000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'workspace-chaos' });
const jsonResponse = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(payload); } });
const asIssue = (r) => { if (r.issues.length) throw r.issues[0]; return r.values; };

/** Capabilities of a scenario: `origin` has the alternates given. */
const capsWith = (origin, alternates, originOver = {}) => {
  const reg = createCapabilityRegistry();
  reg.register({ id: origin, region: 'eu-central-1', data_class: 'PRIVATE', equivalentTo: alternates.map((a) => ({ id: a.id, outcome: a.outcome ?? 'SAME' })), ...originOver });
  for (const a of alternates) reg.register({ id: a.id, region: a.region ?? 'eu-central-1', data_class: a.data_class ?? 'PRIVATE', authorized: a.authorized ?? true, cross_region_allowed: a.cross_region_allowed ?? false });
  return reg;
};
const viaAlternate = { switchTo: async (alt) => ({ served_by: alt }) };

// ============================================================================================================ J. PROVIDER REFUSAL
export const groupJ = [
  S('J', 'marketing-creative', 'content_policy_refusal', { classification: 'PROVIDER_FAILURE', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => go(env, id, 'marketing-creative', [stage('image', async () => { throw refusal(); }, { idempotent: true })])),
  S('J', 'marketing-creative', 'refusal_with_equivalent_authorized_alternate', { classification: 'PROVIDER_FAILURE', action: 'SWITCH_CAPABILITY', ...DONE }, (env, id) => go(env, id, 'marketing-creative', [stage('image', async () => { throw refusal(); }, { capability: 'image-a', handlers: viaAlternate })], { capabilities: capsWith('image-a', [{ id: 'image-b' }]) })),
  S('J', 'marketing-creative', 'refusal_only_a_degrading_alternate_exists', { classification: 'PROVIDER_FAILURE', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'marketing-creative', [stage('image', async () => { throw refusal(); }, { capability: 'image-a', handlers: viaAlternate })], { capabilities: capsWith('image-a', [{ id: 'image-lite', outcome: 'DEGRADES' }]) })),
  S('J', 'marketing-creative', 'credentials_rejected', { classification: 'PROVIDER_FAILURE', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => go(env, id, 'marketing-creative', [stage('call', async () => { throw http(401); }, { idempotent: true })])),
  S('J', 'marketing-creative', 'real_text_call_rejected', { classification: 'PROVIDER_FAILURE', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => go(env, id, 'marketing-creative', [real('copy', () => createMarketingCopy({ config: alibabaConfig, brief: 'Return JSON', dataPolicy: { classification: 'PUBLIC' }, budget: new SpendGuard({ maxSpendEur: 1 }), fetchImpl: async () => { meterCalls(1); return jsonResponse({ code: 'DataInspectionFailed' }, 400); } }), { idempotent: true })])),
  S('J', 'marketing-creative', 'model_not_found', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'marketing-creative', [stage('call', async () => { throw Object.assign(new Error('model not found'), { status: 404 }); })])),
  S('J', 'marketing-creative', 'alternate_in_another_region_is_not_used', { classification: 'PROVIDER_FAILURE', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => go(env, id, 'marketing-creative', [stage('image', async () => { throw refusal(); }, { capability: 'image-a', handlers: viaAlternate })], { capabilities: capsWith('image-a', [{ id: 'image-asia', region: 'ap-southeast-1' }]) })),
  S('J', 'marketing-creative', 'alternate_that_would_widen_the_data_class_is_not_used', { classification: 'PROVIDER_FAILURE', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => go(env, id, 'marketing-creative', [stage('image', async () => { throw refusal(); }, { capability: 'image-a', handlers: viaAlternate })], { dataClass: 'PRIVATE', capabilities: capsWith('image-a', [{ id: 'image-public-only', data_class: 'PUBLIC' }]) })),
];

// ============================================================================================================ K. TOOL CAPABILITY LIMIT
const layoutLimit = () => Object.assign(new Error('no layout fits'), { cause: 'LAYOUT_CAPABILITY_LIMIT' });
const layoutStage = (extra) => stage('layout', async (ctx) => { if (ctx.input.layout !== 'simple') throw layoutLimit(); return { layout: 'simple', marker: ctx.input.marker }; }, extra);
export const groupK = [
  S('K', 'creative', 'layout_cannot_fit_replanned', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'REPLAN', ...DONE }, (env, id) => go(env, id, 'creative', [ok('observe'), layoutStage({ replannable: true, handlers: { replan: async () => ({ restartAt: 'layout', patch: { layout: 'simple' } }) } }), ok('render')])),
  S('K', 'creative', 'layout_cannot_fit_equivalent_capability', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'SWITCH_CAPABILITY', ...DONE }, (env, id) => go(env, id, 'creative', [layoutStage({ capability: 'layout-relational', handlers: viaAlternate })], { capabilities: capsWith('layout-relational', [{ id: 'layout-grid' }]) })),
  S('K', 'creative', 'layout_cannot_fit_nothing_to_try', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'creative', [layoutStage()])),
  S('K', 'creative', 'layout_cannot_fit_nobody_to_ask', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => go(env, id, 'creative', [layoutStage()], { canAskUser: false })),
  S('K', 'creative', 'segmentation_confidence_insufficient', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'creative', [stage('segment', async () => { throw Object.assign(new Error('low confidence'), { cause: 'VISUAL_PRODUCTION_PLAN_FAILURE' }); })])),
  S('K', 'creative', 'critic_unavailable_equivalent_critic_declared', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'SWITCH_CAPABILITY', ...DONE }, (env, id) => go(env, id, 'creative', [failing('critic', 'PROVIDER_CAPABILITY_UNAVAILABLE', {}, { capability: 'critic-a', handlers: viaAlternate })], { capabilities: capsWith('critic-a', [{ id: 'critic-b' }]) })),
  S('K', 'core', 'parser_unavailable', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'marketing', [failing('parse', 'PROVIDER_CAPABILITY_UNAVAILABLE')])),
  S('K', 'finance', 'bank_connector_not_configured', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'finance', [stage('bank', async () => { throw new FinanceError('BANK_NOT_CONFIGURED'); })], { modulePolicy: FINANCE_POLICY })),
  S('K', 'creative', 'replan_names_no_earlier_stage', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'REPLAN', terminal: ASKED }, (env, id) => go(env, id, 'creative', [layoutStage({ replannable: true, handlers: { replan: async () => ({ restartAt: 'does-not-exist' }) } })])),
];

// ============================================================================================================ L. STATE INTERRUPTION
const flakySupabase = (failOnCall, mode = 'upsert') => {
  const base = createFakeSupabase(); let calls = 0; let failed = false;
  return { base, client: { ...base, async [mode](...args) { calls += 1; if (calls === failOnCall && !failed) { failed = true; throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); } return base[mode](...args); } } };
};
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `row-${i + 1}`, merchant_id: 'm', v: i }));
export const groupL = [
  S('L', 'finance', 'concurrent_modification_after_progress', { classification: 'STATE_INTEGRITY_ERROR', action: 'ROLLBACK', terminal: TERMINAL_STATE.ROLLED_BACK }, (env, id) => go(env, id, 'finance', [ok('read'), stage('write', async () => { throw new FinanceError('CONCURRENT_MODIFICATION'); })], { modulePolicy: FINANCE_POLICY, expectations: { stages: [] } })),
  S('L', 'marketing', 'resume_after_interruption_skips_committed_work', { classification: null, action: null, ...DONE }, async (env, id) => {
    const plan = () => [stage('a', async (ctx) => { await ctx.callProvider(async () => 0); return { stage: 'a', marker: ctx.input.marker }; }), stage('read', async (ctx) => asIssue(readInput({ headline: { kind: 'text', required: true } }, ctx.input.fields, { module: 'marketing', stage: 'read' }))), stage('use', async (ctx) => { await ctx.callProvider(async () => 0); return { stage: 'use', marker: ctx.input.marker }; })];
    const first = await go(env, id, 'marketing', plan(), { input: { fields: {} } });
    const second = await go(env, id, 'marketing', plan(), { input: { fields: { headline: 'Done' } } });
    return { ...second, reports: [first.report, second.report], check: (_b, r) => (first.report.terminal_state !== ASKED ? 'FIRST_RUN_SHOULD_HAVE_ASKED' : r.provider_calls !== 2 ? `PROVIDER_CALLS_${r.provider_calls}_INSTEAD_OF_2` : null) };
  }),
  S('L', 'sync', 'connection_lost_mid_upsert_safe_to_repeat', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', ...DONE }, (env, id) => {
    const { base, client } = flakySupabase(2);
    return go(env, id, 'sync', [real('upsert', async () => { meterCalls(1); await upsertInChunks(client, 'products', rows(5), { onConflict: 'id', chunkSize: 2 }); return base._tables.get('products').length; }, { idempotent: true })]).then((b) => ({ ...b, check: () => (base._tables.get('products').length === 5 ? null : 'DUPLICATE_OR_MISSING_ROWS') }));
  }),
  S('L', 'sync', 'connection_lost_mid_insert_not_repeated', { classification: 'PROVIDER_FAILURE', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => {
    const { base, client } = flakySupabase(2, 'insert');
    return go(env, id, 'sync', [real('insert', async () => { await insertInChunks(client, 'events', rows(5), { chunkSize: 2 }); }, { idempotent: false })]).then((b) => ({ ...b, check: () => ((base._tables.get('events') ?? []).length === 2 ? null : 'PARTIAL_WRITE_NOT_KEPT_AS_IS') }));
  }),
  S('L', 'core', 'run_of_another_tenant_cannot_be_reached', { classification: 'STATE_INTEGRITY_ERROR', action: 'ROLLBACK', terminal: TERMINAL_STATE.ROLLED_BACK }, (env, id) => {
    env.hub.open('ten-l-other', `run-${id.toLowerCase()}-shared`);
    return go(env, id, 'core', [ok('a'), stage('reach', async (ctx) => { env.hub.handle(ctx.tenant, `run-${id.toLowerCase()}-shared`); return 1; })]);
  }),
  S('L', 'core', 'committed_checkpoint_cannot_be_overwritten', { classification: 'STATE_INTEGRITY_ERROR', action: 'ROLLBACK', terminal: TERMINAL_STATE.ROLLED_BACK }, (env, id) => go(env, id, 'core', [ok('a'), stage('overwrite', async (ctx) => { env.hub.handle(ctx.tenant, ctx.runId).commit('a', { stage: 'a', evil: true }); return 1; })], { expectations: { committedValues: {} } }).then(async (b) => ({ ...b, check: () => (JSON.stringify(env.hub.handle(b.tenants[0], `run-${id.toLowerCase()}`).get('a')).includes('evil') ? 'OVERWRITTEN' : null) }))),
  S('L', 'marketing', 'irreversible_effect_with_unknown_outcome_never_repeated', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', terminal: TERMINAL_STATE.ROLLED_BACK }, async (env, id) => {
    let sent = 0;
    const b = await go(env, id, 'marketing', [stage('send_email', async (ctx) => ctx.once('welcome-email', async () => { sent += 1; throw timeoutError(); }, { irreversible: true }), { idempotent: true })]);
    return { ...b, duplicateEffects: sent > 1 ? sent - 1 : 0 };
  }),
];

// ============================================================================================================ M. REPEATED OPERATION
export const groupM = [
  S('M', 'core', 'same_run_twice_does_no_work_again', { classification: null, action: null, ...DONE }, async (env, id) => {
    const plan = () => ['a', 'b', 'c'].map((name) => stage(name, async (ctx) => { await ctx.callProvider(async () => 0); return { stage: name, marker: ctx.input.marker }; }));
    const first = await go(env, id, 'core', plan()); const second = await go(env, id, 'core', plan());
    return { ...second, reports: [first.report, second.report], check: (_b, r) => (r.provider_calls === first.report.provider_calls ? null : `SECOND_RUN_DID_WORK:${r.provider_calls}`) };
  }),
  S('M', 'core', 'retry_does_not_duplicate_committed_state', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', ...DONE }, (env, id) => go(env, id, 'core', [ok('a'), flaky('b', 2, timeoutError, { idempotent: true }), ok('c')], { expectations: { stages: ['a', 'b', 'c'] }, check: (_b, r) => (r.completed.length === 3 && new Set(r.completed).size === 3 ? null : 'DUPLICATE_STAGE') })),
  S('M', 'marketing', 'effect_repeated_inside_one_stage_runs_once', { classification: null, action: null, ...DONE }, async (env, id) => {
    let sent = 0;
    const b = await go(env, id, 'marketing', [stage('notify', async (ctx) => { for (let i = 0; i < 4; i += 1) await ctx.once('notify-owner', async () => { sent += 1; return 'sent'; }); return 'done'; })]);
    return { ...b, duplicateEffects: sent > 1 ? sent - 1 : 0, check: () => (sent === 1 ? null : `SENT_${sent}`) };
  }),
  S('M', 'marketing', 'corrected_answer_after_a_question_resumes', { classification: null, action: null, ...DONE }, async (env, id) => {
    const plan = () => [ok('a'), stage('read', async (ctx) => asIssue(readInput({ price: { kind: 'amount', required: true, factClass: 'price' } }, ctx.input.fields, { module: 'marketing', stage: 'read' }))), ok('b')];
    const first = await go(env, id, 'marketing', plan(), { input: { fields: { price: '1.250' } } });
    const second = await go(env, id, 'marketing', plan(), { input: { fields: { price: '1250,00' } } });
    return { ...second, reports: [first.report, second.report], check: () => (first.report.terminal_state === ASKED ? null : 'FIRST_RUN_SHOULD_HAVE_ASKED') };
  }),
  S('M', 'core', 'same_run_id_in_two_tenants_stays_separate', { classification: null, action: null, ...DONE }, async (env, id) => {
    const a = await go(env, `${id}-a`, 'core', [ok('a')], { runId: 'run-shared' }); const b = await go(env, `${id}-b`, 'core', [ok('a')], { runId: 'run-shared' });
    return { ...a, reports: [a.report, b.report], tenants: [...a.tenants, ...b.tenants], check: () => (JSON.stringify(env.hub.handle(a.tenants[0], 'run-shared').get('a')) !== JSON.stringify(env.hub.handle(b.tenants[0], 'run-shared').get('a')) ? null : 'SAME_STATE') };
  }),
  S('M', 'core', 'same_failure_twice_gives_the_same_decision', { classification: 'PROVIDER_FAILURE', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, async (env, id) => {
    const a = await go(env, `${id}-a`, 'core', [stage('x', async () => { throw refusal(); })]); const b = await go(env, `${id}-b`, 'core', [stage('x', async () => { throw refusal(); })]);
    return { ...a, reports: [a.report, b.report], tenants: [...a.tenants, ...b.tenants], check: () => (JSON.stringify(a.report.recoveries) === JSON.stringify(b.report.recoveries) ? null : 'NOT_DETERMINISTIC') };
  }),
];

// ============================================================================================================ N. DUPLICATE SIDE EFFECT
export const groupN = [
  S('N', 'marketing', 'five_concurrent_attempts_one_effect', { classification: null, action: null, ...DONE }, async (env, id) => {
    let n = 0;
    const b = await go(env, id, 'marketing', [stage('publish', async (ctx) => { await Promise.all(Array.from({ length: 5 }, () => ctx.once('publish-post', async () => { n += 1; await new Promise((r) => setTimeout(r, 5)); return 'p'; }))); return 'ok'; })]);
    return { ...b, duplicateEffects: n > 1 ? n - 1 : 0, check: () => (n === 1 ? null : `EFFECT_RAN_${n}_TIMES`) };
  }),
  S('N', 'finance', 'payment_attempted_twice_recorded_once', { classification: null, action: null, ...DONE }, async (env, id) => {
    const { svc } = makeService(); const inv = await issueInvoice(svc); let paid = 0;
    const b = await go(env, id, 'finance', [stage('pay', async (ctx) => { for (let i = 0; i < 2; i += 1) await ctx.once(`pay-${inv.id}-1`, async () => { paid += 1; return svc.recordPayment(inv.id, { amount: '30.00', paidOn: '2026-09-25', method: 'cash' }, MERCHANT_ACTOR); }); return 'ok'; })], { modulePolicy: FINANCE_POLICY });
    const view = await svc.view(inv.id);
    return { ...b, duplicateEffects: paid > 1 ? paid - 1 : 0, check: () => (view.settlement.paidCents === 3000 ? null : `PAID_${view.settlement.paidCents}`) };
  }),
  S('N', 'marketing', 'email_with_unknown_outcome_after_a_timeout', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', terminal: TERMINAL_STATE.ROLLED_BACK }, async (env, id) => {
    let sent = 0;
    const b = await go(env, id, 'marketing', [stage('mail', async (ctx) => ctx.once('mail-1', async () => { sent += 1; throw Object.assign(new Error('socket'), { code: 'ECONNRESET' }); }, { irreversible: true }), { idempotent: true })]);
    return { ...b, duplicateEffects: sent > 1 ? sent - 1 : 0 };
  }),
  S('N', 'marketing', 'effect_done_then_failure_then_retry', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', ...DONE }, async (env, id) => {
    let sent = 0;
    const b = await go(env, id, 'marketing', [stage('notify', async (ctx) => { await ctx.once('notify-1', async () => { sent += 1; }); if (ctx.attempt === 1) throw timeoutError(); return 'ok'; }, { idempotent: true })]);
    return { ...b, duplicateEffects: sent > 1 ? sent - 1 : 0, check: () => (sent === 1 ? null : `SENT_${sent}`) };
  }),
  S('N', 'marketing', 'same_key_in_two_stages_is_two_effects', { classification: null, action: null, ...DONE }, async (env, id) => {
    let n = 0;
    const eff = async () => { n += 1; };
    const b = await go(env, id, 'marketing', [stage('one', async (ctx) => { await ctx.once('k', eff); return 1; }), stage('two', async (ctx) => { await ctx.once('k', eff); return 2; })]);
    return { ...b, check: () => (n === 2 ? null : `EFFECTS_${n}`) };
  }),
  S('N', 'marketing', 'suppressed_duplicates_are_counted', { classification: null, action: null, ...DONE }, async (env, id) => {
    const b = await go(env, id, 'marketing', [stage('x', async (ctx) => { for (let i = 0; i < 3; i += 1) await ctx.once('k', async () => 1); return 1; })]);
    return { ...b, check: () => (env.hub.handle(b.tenants[0], `run-${id.toLowerCase()}`).suppressedDuplicates() === 2 ? null : 'SUPPRESSION_NOT_COUNTED') };
  }),
];
