import { createCapabilityRegistry, TERMINAL_STATE } from '../../src/core-resilience/index.js';
import { CREATIVE_POLICY, FINANCE_POLICY } from '../../src/core-resilience/adapters/index.js';
import { normalizeCompositionPlan } from '../../src/creative-brain/composition.js';
import { evaluateCandidate } from '../../src/buying/evaluate.js';
import { buildDemandFacts } from '../../src/demand/build.js';
import { buildLedger } from '../../src/metrics/ledger.js';
import { guardSyncWrites } from '../../src/sync/write-guard.js';
import { requireCollections } from '../../src/core-resilience/index.js';
import { candidate, NOW as BUY_NOW, healthyPeerFacts, policy as buyPolicy } from '../../test/fixtures/buying-sample.js';
import { CONFIG as DEMAND_CONFIG, makeDemandData, NOW as DEMAND_NOW, TZ } from '../../test/fixtures/demand-sample.js';
import { createFakeSupabase } from '../../test/fixtures/fake-supabase.js';
import {
  go, http, markerOf, meterCalls, ok, real, scenario as S, stage, failing, flaky, ids,
} from './kit.js';
import {
  AGENT_ACTOR, compositionAnswer, creativeRun, CONCEPTS, draftInvoice, issueInvoice, makeService, MERCHANT_ACTOR, OTHER_CONCEPTS, selectAnswer,
} from './workloads.js';

const DONE = { terminal: TERMINAL_STATE.COMPLETED };
const BLOCKED = TERMINAL_STATE.BLOCKED_GRACEFULLY;
const ASKED = TERMINAL_STATE.NEEDS_USER;
const EXHAUSTED = TERMINAL_STATE.RECOVERY_EXHAUSTED;
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const refusal = () => Object.assign(new Error('Request rejected by the content filter'), { status: 400 });
const pause = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ============================================================================================================ O. MULTI-TENANT INTERLEAVING
// Five synthetic merchants of five unrelated businesses run at the same time through the SAME hub, registry and process. They are test worlds only: nothing about them is known to Core.
const WORLDS = [
  ['jewellery', (sid) => [stage('retouch', async (ctx) => { await pause(3); if (ctx.attempt === 1) throw timeoutError(); return { marker: ctx.input.marker }; }, { idempotent: true }), ok('publish')], { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', terminal: DONE.terminal }],
  ['restaurant', () => [stage('menu', async (ctx) => { await pause(1); throw Object.assign(new Error('x'), { code: 'INPUT_REQUIRED_FIELD_MISSING' }); }), ok('publish')], { classification: 'MISSING_INFORMATION', action: 'ASK_USER', terminal: ASKED }],
  ['saas', () => [stage('copy', async () => { await pause(2); throw Object.assign(new Error('x'), { code: 'PROVIDER_MALFORMED_JSON' }); })], { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }],
  ['gifts', () => [ok('personalize'), ok('preview')], { classification: null, action: null, terminal: DONE.terminal }],
  ['automotive', () => [ok('quote'), stage('stock', async () => { await pause(2); throw Object.assign(new Error('x'), { code: 'CORE_CHECKPOINT_OVERWRITE' }); })], { classification: 'STATE_INTEGRITY_ERROR', action: 'ROLLBACK', terminal: TERMINAL_STATE.ROLLED_BACK }],
];
const runWorlds = (env, id, worlds = WORLDS) => Promise.all(worlds.map(([name, plan]) => go(env, `${id}-${name}`, `${name}`, plan(name), { input: { business: name, secret: `SECRET-OF-${name.toUpperCase()}` } })));

export const groupO = [
  S('O', 'core', 'five_businesses_interleaved', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', ...DONE }, async (env, id) => {
    const built = await runWorlds(env, id);
    return { ...built[0], reports: built.map((b) => b.report), tenants: built.flatMap((b) => b.tenants), check: (_b, _r) => built.map((b, i) => (b.report.terminal_state === WORLDS[i][2].terminal ? null : `${WORLDS[i][0]}:${b.report.terminal_state}`)).find(Boolean) ?? null };
  }),
  S('O', 'core', 'same_run_id_for_three_tenants_at_once', { classification: null, action: null, ...DONE }, async (env, id) => {
    const built = await Promise.all(['x', 'y', 'z'].map((t) => go(env, `${id}-${t}`, 'core', [stage('a', async (ctx) => { await pause(2); return { marker: ctx.input.marker }; }), ok('b')], { runId: 'run-shared-o2' })));
    return { ...built[0], reports: built.map((b) => b.report), tenants: built.flatMap((b) => b.tenants), check: () => (new Set(built.map((b) => JSON.stringify(env.hub.handle(b.tenants[0], 'run-shared-o2').get('a')))).size === 3 ? null : 'STATE_SHARED') };
  }),
  S('O', 'core', 'cost_accounting_stays_per_tenant', { classification: null, action: null, ...DONE }, async (env, id) => {
    const built = await Promise.all([1, 2, 3].map((n) => go(env, `${id}-${n}`, 'core', [stage('calls', async (ctx) => { for (let i = 0; i < n * 2; i += 1) { ctx.meterAttempt(1, 0.01 * n); await pause(1); } return 1; })])));
    return { ...built[0], reports: built.map((b) => b.report), tenants: built.flatMap((b) => b.tenants), check: () => (built.every((b, i) => b.report.provider_calls === (i + 1) * 2) ? null : 'COST_OR_CALLS_MIXED') };
  }),
  S('O', 'core', 'capability_authorization_is_per_tenant', { classification: 'PROVIDER_FAILURE', action: 'SWITCH_CAPABILITY', ...DONE }, async (env, id) => {
    const caps = (authorized) => { const r = createCapabilityRegistry(); r.register({ id: 'img-a', region: 'eu', data_class: 'PRIVATE', equivalentTo: [{ id: 'img-b', outcome: 'SAME' }] }); r.register({ id: 'img-b', region: 'eu', data_class: 'PRIVATE', authorized }); return r; };
    const plan = () => [stage('img', async () => { throw refusal(); }, { capability: 'img-a', handlers: { switchTo: async (alt) => ({ alt }) } })];
    const [a, b] = await Promise.all([go(env, `${id}-a`, 'core', plan(), { capabilities: caps(true) }), go(env, `${id}-b`, 'core', plan(), { capabilities: caps(false) })]);
    return { ...a, reports: [a.report, b.report], tenants: [...a.tenants, ...b.tenants], check: () => (a.report.terminal_state === TERMINAL_STATE.COMPLETED && b.report.terminal_state === BLOCKED ? null : `A:${a.report.terminal_state}_B:${b.report.terminal_state}`) };
  }),
  S('O', 'creative', 'three_brain_runs_interleaved', { classification: null, action: null, ...DONE }, async (env, id) => {
    const built = await Promise.all(['p', 'q', 'r'].map((t) => go(env, `${id}-${t}`, 'creative', [real('brain', () => creativeRun())])));
    return { ...built[0], reports: built.map((b) => b.report), tenants: built.flatMap((b) => b.tenants), check: () => (built.every((b) => b.report.terminal_state === TERMINAL_STATE.COMPLETED && b.report.provider_calls === 8) ? null : 'A_RUN_WAS_AFFECTED') };
  }),
  S('O', 'core', 'a_tenant_sees_only_its_own_runs', { classification: null, action: null, ...DONE }, async (env, id) => {
    const built = await Promise.all(['m', 'n'].map((t) => go(env, `${id}-${t}`, 'core', [ok('a')])));
    return { ...built[0], reports: built.map((b) => b.report), tenants: built.flatMap((b) => b.tenants), check: () => (env.hub.runs(built[0].tenants[0]).every((r) => r === `run-${id.toLowerCase()}-m`) && env.hub.runs(built[1].tenants[0]).every((r) => r === `run-${id.toLowerCase()}-n`) ? null : 'FOREIGN_RUN_VISIBLE') };
  }),
  S('O', 'core', 'one_tenant_failing_fatally_does_not_stop_the_others', { classification: 'FATAL_SYSTEM_ERROR', action: 'FATAL_STOP', terminal: TERMINAL_STATE.FATAL }, async (env, id) => {
    const [bad, good1, good2] = await Promise.all([
      go(env, `${id}-bad`, 'core', [stage('x', async () => { await pause(2); throw new TypeError('boom'); })]), go(env, `${id}-g1`, 'core', [ok('a'), ok('b')]), go(env, `${id}-g2`, 'core', [ok('a'), ok('b')]),
    ]);
    return { ...bad, reports: [bad.report, good1.report, good2.report], tenants: [...bad.tenants, ...good1.tenants, ...good2.tenants], check: () => (good1.report.terminal_state === TERMINAL_STATE.COMPLETED && good2.report.terminal_state === TERMINAL_STATE.COMPLETED ? null : 'NEIGHBOUR_AFFECTED') };
  }),
];

// ============================================================================================================ P. RECOVERY FAILURE
export const groupP = [
  S('P', 'core', 'normalize_handler_throws', { classification: 'INPUT_INVALID', action: 'NORMALIZE', terminal: ASKED }, (env, id) => go(env, id, 'core', [failing('read', 'INPUT_NOT_USABLE', {}, { handlers: { normalize: async () => { throw new TypeError('bug in the handler'); } } })])),
  S('P', 'core', 'normalize_finds_no_repair', { classification: 'INPUT_INVALID', action: 'NORMALIZE', terminal: ASKED }, (env, id) => go(env, id, 'core', [failing('read', 'INPUT_NOT_USABLE', {}, { handlers: { normalize: async () => undefined } })])),
  S('P', 'core', 'reasked_answer_is_malformed_again', { classification: 'PROTOCOL_ERROR', action: 'REASK_PROVIDER', terminal: EXHAUSTED }, (env, id) => go(env, id, 'core', [failing('reply', 'PROVIDER_MALFORMED_JSON', {}, { reaskable: true, handlers: { reask: async () => { throw Object.assign(new Error('still broken'), { code: 'PROVIDER_MALFORMED_JSON' }); } } })])),
  S('P', 'core', 'replan_handler_throws', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'REPLAN', terminal: ASKED }, (env, id) => go(env, id, 'core', [failing('layout', 'PROVIDER_CAPABILITY_UNAVAILABLE', {}, { replannable: true, handlers: { replan: async () => { throw new TypeError('bug in the handler'); } } })])),
  S('P', 'core', 'switch_handler_throws', { classification: 'PROVIDER_FAILURE', action: 'SWITCH_CAPABILITY', terminal: BLOCKED }, (env, id) => {
    const caps = createCapabilityRegistry(); caps.register({ id: 'a', region: 'eu', data_class: 'PRIVATE', equivalentTo: [{ id: 'b', outcome: 'SAME' }] }); caps.register({ id: 'b', region: 'eu', data_class: 'PRIVATE' });
    return go(env, id, 'core', [stage('img', async () => { throw refusal(); }, { capability: 'a', handlers: { switchTo: async () => { throw new TypeError('alternate crashed'); } } })], { capabilities: caps });
  }),
  S('P', 'core', 'recovered_value_fails_validation', { classification: 'INPUT_INVALID', action: 'NORMALIZE', terminal: ASKED }, (env, id) => go(env, id, 'core', [failing('read', 'INPUT_NOT_USABLE', {}, { validate: (v) => { if (v.bad) throw Object.assign(new Error('still bad'), { code: 'INPUT_NOT_USABLE' }); }, handlers: { normalize: async () => ({ bad: true }) } })])),
  S('P', 'core', 'the_resilience_engine_itself_fails', { terminal: TERMINAL_STATE.FATAL }, (env, id) => go(env, id, 'core', [failing('x', 'ANYTHING')], { registry: { classify() { throw new Error('registry down'); } } })),
];

// ============================================================================================================ Q. RECOVERY BUDGET EXHAUSTION
const alwaysTimeout = (extra = {}) => stage('call', async () => { throw timeoutError(); }, { idempotent: true, ...extra });
export const groupQ = [
  S('Q', 'core', 'no_reask_allowed', { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: EXHAUSTED }, (env, id) => go(env, id, 'core', [failing('reply', 'PROVIDER_MALFORMED_JSON', {}, { reaskable: true, handlers: { reask: async () => 1 } })], { limits: { provider_repairs: 0 } })),
  S('Q', 'core', 'retry_limit_reached', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', terminal: EXHAUSTED }, (env, id) => go(env, id, 'core', [alwaysTimeout()], { limits: { safe_retries: 3, depth: 6 }, check: (_b, r) => (r.recovery_depth === 3 ? null : `DEPTH_${r.recovery_depth}`) })),
  S('Q', 'core', 'replan_limit_reached', { classification: 'TOOL_CAPABILITY_LIMIT', action: 'REPLAN', terminal: ASKED }, (env, id) => go(env, id, 'core', [failing('layout', 'PROVIDER_CAPABILITY_UNAVAILABLE', {}, { replannable: true, handlers: { replan: async () => ({ restartAt: 'layout' }) } })], { limits: { replans: 2 }, check: (_b, r) => (r.recovery_depth === 2 ? null : `DEPTH_${r.recovery_depth}`) })),
  S('Q', 'core', 'depth_limit_reached', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', terminal: EXHAUSTED }, (env, id) => go(env, id, 'core', [alwaysTimeout()], { limits: { depth: 1, safe_retries: 9 } })),
  S('Q', 'core', 'cost_limit_reached', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', terminal: EXHAUSTED }, (env, id) => go(env, id, 'core', [alwaysTimeout({ recoveryCostEur: 0.4 })], { limits: { cost_eur: 1.0, safe_retries: 10, depth: 10 }, check: (_b, r) => (r.recovery_depth === 2 ? null : `DEPTH_${r.recovery_depth}`) })),
  S('Q', 'core', 'time_limit_reached', { classification: 'PROVIDER_FAILURE', action: 'RETRY_SAFE_OPERATION', terminal: EXHAUSTED }, (env, id) => { let t = 0; return go(env, id, 'core', [alwaysTimeout()], { limits: { elapsed_ms: 2500, safe_retries: 10, depth: 10 }, clock: () => { t += 1000; return t; } }); }),
  S('Q', 'core', 'capability_switch_limit_reached', { classification: 'PROVIDER_FAILURE', action: 'SWITCH_CAPABILITY', terminal: EXHAUSTED }, (env, id) => {
    const caps = createCapabilityRegistry(); caps.register({ id: 'a', region: 'eu', data_class: 'PRIVATE', equivalentTo: [{ id: 'b', outcome: 'SAME' }] }); caps.register({ id: 'b', region: 'eu', data_class: 'PRIVATE' });
    return go(env, id, 'core', [stage('img', async () => { throw refusal(); }, { capability: 'a', handlers: { switchTo: async () => { throw refusal(); } } })], { capabilities: caps });
  }),
];

// ============================================================================================================ R. DOMAIN RULE VIOLATION
const feeds = (rows) => Array.isArray(rows);
export const groupR = [
  S('R', 'finance', 'payment_exceeds_the_balance', { classification: 'DOMAIN_RULE_VIOLATION', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'finance', [real('pay', async () => { const { svc } = makeService(); const inv = await issueInvoice(svc); await svc.recordPayment(inv.id, { amount: '30.00', paidOn: '2026-09-25', method: 'cash' }, MERCHANT_ACTOR); await svc.recordPayment(inv.id, { amount: '50.00', paidOn: '2026-09-26' }, MERCHANT_ACTOR); })], { modulePolicy: FINANCE_POLICY })),
  S('R', 'finance', 'credit_note_on_a_draft', { classification: 'DOMAIN_RULE_VIOLATION', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'finance', [real('credit', async () => { const { svc } = makeService(); const d = await svc.create(draftInvoice(), AGENT_ACTOR); await svc.createCreditNote(d.id, {}, AGENT_ACTOR); })], { modulePolicy: FINANCE_POLICY })),
  S('R', 'finance', 'payment_on_a_paid_invoice', { classification: 'DOMAIN_RULE_VIOLATION', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'finance', [real('pay', async () => { const { svc } = makeService(); const inv = await issueInvoice(svc); await svc.recordPayment(inv.id, { amount: '71.90', paidOn: '2026-09-25', method: 'cash' }, MERCHANT_ACTOR); await svc.recordPayment(inv.id, { amount: '1.00', paidOn: '2026-09-26' }, MERCHANT_ACTOR); })], { modulePolicy: FINANCE_POLICY })),
  S('R', 'finance', 'an_agent_cannot_approve', { classification: 'SAFETY_OR_FIDELITY_BLOCK', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => go(env, id, 'finance', [real('approve', async () => { const { svc } = makeService(); const d = await svc.create(draftInvoice(), AGENT_ACTOR); await svc.submit(d.id, AGENT_ACTOR); await svc.decide(d.id, 'APPROVE', AGENT_ACTOR); })], { modulePolicy: FINANCE_POLICY })),
  S('R', 'creative', 'every_concept_rejected_is_a_valid_rejection', { classification: 'DOMAIN_RULE_VIOLATION', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => {
    const rejectAll = [{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }];
    return go(env, id, 'creative', [real('brain', () => creativeRun({ ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }], select: [selectAnswer(CONCEPTS, rejectAll), selectAnswer(OTHER_CONCEPTS, rejectAll)] }))], { modulePolicy: CREATIVE_POLICY });
  }),
  S('R', 'creative', 'contradictory_composition_in_a_real_run', { classification: 'DOMAIN_RULE_VIOLATION', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => {
    const bad = { ...compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' } }), hero_relationship: 'PRODUCT_RECEDES_INTO_SCENE', visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'BALANCED', PRICE: 'QUIET', PRODUCT: 'DOMINANT' } };
    return go(env, id, 'creative', [real('brain', () => creativeRun({ compose: [bad] }))], { modulePolicy: CREATIVE_POLICY });
  }),
  S('R', 'creative', 'contradictory_composition_replanned', { classification: 'DOMAIN_RULE_VIOLATION', action: 'REPLAN', ...DONE }, (env, id) => {
    const bad = { ...compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' } }), hero_relationship: 'PRODUCT_RECEDES_INTO_SCENE', visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'BALANCED', PRICE: 'QUIET', PRODUCT: 'DOMINANT' } };
    const answers = [bad, compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' } })];
    return go(env, id, 'creative', [ok('art_direct'), stage('compose', async (ctx) => normalizeCompositionPlan(JSON.parse(JSON.stringify(answers[Math.min(ctx.input.round ?? 0, 1)]))), { replannable: true, handlers: { replan: async () => ({ restartAt: 'compose', patch: { round: 1 } }) } })], { modulePolicy: CREATIVE_POLICY });
  }),
  S('R', 'buying', 'candidate_file_cannot_be_read', { classification: 'INPUT_INVALID', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'buying', [stage('evaluate', async () => { const v = evaluateCandidate({ rawCandidate: { unit_price: 1 }, demandFacts: healthyPeerFacts(), config: buyPolicy(), now: BUY_NOW }); const reason = v.reason_codes?.[0]; if (reason === 'INVALID_CANDIDATE_FILE') throw Object.assign(new Error(reason), { code: reason }); return v.verdict; })])),
  S('R', 'tenant', 'write_to_another_tenant_is_refused', { classification: 'SAFETY_OR_FIDELITY_BLOCK', action: 'GRACEFUL_BLOCK', terminal: BLOCKED }, (env, id) => {
    const merchant = '11111111-1111-4111-8111-111111111111'; const supa = createFakeSupabase();
    const guarded = guardSyncWrites(supa, { merchantId: merchant, connectorId: 'c-1', externalId: 'shop-1' });
    return go(env, id, 'tenant', [real('write', () => guarded.upsert('products', [{ merchant_id: '22222222-2222-4222-8222-222222222222', source_id: 'p1' }], { onConflict: 'source_id' }))]).then((b) => ({ ...b, check: () => ((supa._tables.get('products') ?? []).length === 0 ? null : 'FOREIGN_ROW_WRITTEN') }));
  }),
  S('R', 'demand', 'null_orders_unguarded_is_an_unclassified_fatal_error', { classification: 'FATAL_SYSTEM_ERROR', action: 'FATAL_STOP', terminal: TERMINAL_STATE.FATAL }, (env, id) => go(env, id, 'demand', [real('facts', () => { const data = makeDemandData(); data.orders = null; return buildDemandFacts({ ledger: buildLedger(data, { config: DEMAND_CONFIG }), data, now: DEMAND_NOW, timeZone: TZ, config: DEMAND_CONFIG, salesReconciled: true }); })]).then((b) => ({ ...b, check: (_x, r) => (r.error?.unmapped === true ? null : 'SHOULD_BE_FLAGGED_UNMAPPED') }))),
  S('R', 'demand', 'null_orders_guarded_asks_for_the_data', { classification: 'MISSING_INFORMATION', action: 'ASK_USER', terminal: ASKED }, (env, id) => go(env, id, 'demand', [stage('guard', async (ctx) => { const data = makeDemandData(); data.orders = null; const problems = requireCollections(data, ['orders', 'orderLines', 'variants'], { module: 'demand', stage: 'guard', tenant: ctx.tenant }); if (problems.length) throw problems[0]; return 1; })])),
];
