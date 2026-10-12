import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createCoreRegistry, createRecoveryBudget, createStateHub, runResilient, TERMINAL_STATE,
} from '../src/core-resilience/index.js';
import {
  activationCategoryOf, BRAIN_CAUSE_MAP, coreErrorOfBrainStop, creativeMigrationReport, FINANCE_POLICY, financeCategoryOf, registerAll, registerCreative, RUNTIME_CAUSE_MAP, safeProviderMessage,
} from '../src/core-resilience/adapters/index.js';
import { buildRecoveryMatrix, financeCodesInSource } from '../src/core-resilience/matrix.js';
import { ACT_ERROR, PROVIDER_ERROR } from '../src/activation/constants.js';
import { TENANT_ERROR_CODES } from '../src/tenant/index.js';
import { CONNECTOR_ERROR_CODES } from '../src/tenant/connectors.js';
import { RECORD_FIELDS, createEnv, GROUPS, runChaos, runScenario } from '../benchmarks/core-resilience/harness.js';
import { SCENARIOS } from '../benchmarks/core-resilience/scenarios.js';
import { ok, scenario as S, stage } from '../benchmarks/core-resilience/kit.js';

// CORE RESILIENCE: THE ENGINE, THE ADAPTERS, SECURITY AND THE CHAOS BENCHMARK (`// CE-N` markers). Fakes only: no network, no credential, no provider.

const SHOP = ['shp', 'at_'].join(''); // assembled: the repository's privacy test forbids a token-shaped literal
const newRegistry = () => registerAll(registerCreative(createCoreRegistry()));
const run = (stages, over = {}) => runResilient({ hub: over.hub ?? createStateHub(), tenant: 't', runId: 'r', module: 'demo', stages, registry: newRegistry(), ...over });

test('CE-1 the engine never throws: a stage that fails in any way ends in an explicit terminal state with the evidence kept', async () => {
  const throwers = [() => { throw new TypeError('x'); }, () => { throw 'a string'; }, () => { throw null; }, () => { throw undefined; }, () => { throw { code: 'WEIRD' }; }, () => { throw Object.assign(new Error('y'), { status: 503 }); }];
  for (const [i, t] of throwers.entries()) {
    const hub = createStateHub();
    const report = await run([ok('a'), stage('b', async () => t())], { hub, runId: `r${i}` });
    assert.ok(Object.values(TERMINAL_STATE).includes(report.terminal_state), String(i));
    assert.deepEqual(report.completed, ['a']);
    assert.ok(hub.inspectTenant('t')[`r${i}`].terminal);
  }
});

test('CE-2 a protocol failure is normalized, then re-asked ONCE, then blocked; an unauthorized request is impossible', async () => {
  let asks = 0;
  const report = await run([stage('reply', async () => { throw Object.assign(new Error('x'), { code: 'PROVIDER_MALFORMED_JSON' }); }, { reaskable: true, handlers: { reask: async () => { asks += 1; throw Object.assign(new Error('still'), { code: 'PROVIDER_MALFORMED_JSON' }); } } })]);
  assert.equal(asks, 1);
  assert.equal(report.terminal_state, TERMINAL_STATE.RECOVERY_EXHAUSTED);
  assert.deepEqual(report.recoveries.map((r) => r.action), ['REASK_PROVIDER', 'GRACEFUL_BLOCK']);
});

test('CE-3 a safety, fidelity or integrity failure is never recovered, whatever the stage declares it can do', async () => {
  for (const code of ['TENANT_WRITE_VIOLATION', 'CORE_CHECKPOINT_OVERWRITE', 'CORE_ENGINE_FAULT']) {
    let called = 0;
    const stages = [stage('x', async () => { throw Object.assign(new Error(code), { code }); }, { idempotent: true, reaskable: true, replannable: true, capability: 'a', handlers: { normalize: async () => { called += 1; return 1; }, reask: async () => { called += 1; return 1; }, replan: async () => { called += 1; return { restartAt: 'x' }; }, switchTo: async () => { called += 1; return 1; } } })];
    const report = await run(stages);
    assert.equal(called, 0, code);
    assert.ok([TERMINAL_STATE.BLOCKED_GRACEFULLY, TERMINAL_STATE.ROLLED_BACK, TERMINAL_STATE.FATAL].includes(report.terminal_state), `${code} -> ${report.terminal_state}`);
  }
});

test('CE-4 a failed stage never overwrites valid state, and a resumed run starts from the right checkpoint without duplicating work', async () => {
  const hub = createStateHub(); let aRuns = 0;
  const plan = (fail) => [stage('a', async () => { aRuns += 1; return { v: 'A' }; }), stage('b', async () => { if (fail) throw Object.assign(new Error('x'), { code: 'INPUT_NOT_USABLE' }); return { v: 'B' }; }), ok('c')];
  const first = await run(plan(true), { hub });
  assert.equal(first.terminal_state, TERMINAL_STATE.NEEDS_USER);
  const second = await run(plan(false), { hub });
  assert.equal(second.terminal_state, TERMINAL_STATE.COMPLETED);
  assert.equal(aRuns, 1); // the committed stage was not run again
  assert.deepEqual(hub.handle('t', 'r').get('a'), { v: 'A' });
});

test('CE-5 provider-call and cost accounting survive failure, retry and rollback', async () => {
  const hub = createStateHub();
  const report = await run([stage('call', async (ctx) => { ctx.meterAttempt(1, 0.02); throw Object.assign(new Error('t'), { status: 503 }); }, { idempotent: true })], { hub, budget: createRecoveryBudget({ safe_retries: 2 }) });
  assert.equal(report.provider_calls, 3); // the first attempt and two retries are all counted
  assert.equal(report.cost_eur, 0.06);
  assert.equal(hub.handle('t', 'r').meter().provider_calls, 3);
});

test('CE-6 every recovery event is explainable: module, stage, category, domain code, action, attempt, checkpoint, provider call, cost, result, evidence reference; no secret in it', async () => {
  const hub = createStateHub();
  await run([ok('a'), stage('b', async () => { throw Object.assign(new Error('rejected key sk-abcdef1234567890'), { status: 503 }); }, { idempotent: true })], { hub });
  const journal = hub.handle('t', 'r').journal();
  const recovery = journal.find((e) => e.recovery_action === 'RETRY_SAFE_OPERATION');
  for (const field of ['module', 'stage', 'error_category', 'domain_code', 'recovery_action', 'attempt', 'checkpoint', 'provider_call', 'cost_delta', 'result', 'evidence_reference']) assert.ok(field in recovery, field);
  assert.equal(recovery.error_category, 'PROVIDER_FAILURE');
  assert.match(recovery.checkpoint, /^r:a:/);
  assert.doesNotMatch(JSON.stringify(journal), /sk-abcdef/);
  assert.ok(journal.every((e, i) => i === 0 || e.seq > journal[i - 1].seq));
});

test('CE-7 the adapters give every real module code exactly one Core meaning (finance, activation, tenant, connectors, creative), and Finance is never normalized or replanned', () => {
  const registry = newRegistry();
  const finance = financeCodesInSource();
  assert.ok(finance.length > 40);
  for (const code of finance) assert.ok(financeCategoryOf(code), code);
  for (const code of [...Object.values(PROVIDER_ERROR), ...Object.values(ACT_ERROR)]) assert.ok(activationCategoryOf(code), code);
  for (const code of [...Object.values(TENANT_ERROR_CODES), ...Object.values(CONNECTOR_ERROR_CODES)]) { const e = registry.classify(Object.assign(new Error(code), { code }), { module: 'tenant', stage: 's' }); assert.equal(e.unmapped, false, code); }
  assert.equal(financeCategoryOf('PAYMENT_EXCEEDS_REMAINING'), 'DOMAIN_RULE_VIOLATION');
  assert.equal(financeCategoryOf('APPROVAL_REQUIRES_A_MERCHANT_ACTOR'), 'SAFETY_OR_FIDELITY_BLOCK');
  assert.equal(financeCategoryOf('CONCURRENT_MODIFICATION'), 'STATE_INTEGRITY_ERROR');
  assert.equal(activationCategoryOf('PUBLISH_RESULT_UNKNOWN'), 'STATE_INTEGRITY_ERROR'); // maybe published: never retried blindly
  const m = buildRecoveryMatrix();
  for (const [category, row] of Object.entries(m.categories)) for (const action of ['NORMALIZE', 'REPLAN', 'SWITCH_CAPABILITY', 'REASK_PROVIDER']) assert.ok(!row.effective.finance.includes(action), `finance ${category} ${action}`);
  assert.ok(!m.categories.PROVIDER_FAILURE.effective.finance.includes('SWITCH_CAPABILITY'));
});

test('CE-8 Creative Brain is migrated: every contract code, Brain cause, runtime cause and creative action has a Core meaning, and the Brain keeps its richer vocabulary', () => {
  const report = creativeMigrationReport(newRegistry());
  assert.deepEqual(report.gaps, []);
  assert.equal(report.migrated, true);
  const stop = coreErrorOfBrainStop({ cause: 'COMPOSITION_RELATIONS_CONTRADICTORY', code: 'BRAIN_RULE_VIOLATION', brain_stage: 'COMPOSE' });
  assert.deepEqual([stop.category, stop.code, stop.domain_code, stop.stage], ['DOMAIN_RULE_VIOLATION', 'COMPOSITION_RELATIONS_CONTRADICTORY', 'BRAIN_RULE_VIOLATION', 'COMPOSE']);
  assert.equal(BRAIN_CAUSE_MAP.NO_CONCEPT_MEETS_BAR, 'DOMAIN_RULE_VIOLATION');
  assert.equal(RUNTIME_CAUSE_MAP.ENVIRONMENT_NOT_EMPTY, 'SAFETY_OR_FIDELITY_BLOCK');
  assert.equal(coreErrorOfBrainStop({ cause: 'SOMETHING_NEW' }).unmapped, true);
});

test('CE-9 provider messages for logs and summaries carry no body, row data, credential or request id', () => {
  const message = safeProviderMessage(new Error(`Shopify GraphQL HTTP 502: {"row":"alice@example.com","token":"${SHOP}0123456789abcdef0123"} request chatcmpl-abc`));
  assert.doesNotMatch(message, /alice|shpat_|chatcmpl|row/);
  assert.match(message, /^PROVIDER_UNAVAILABLE \(5xx\)/);
});

test('CE-10 the benchmark: at least 120 scenarios over all 18 groups, isolated, deterministic, with every mandatory criterion at zero', async () => {
  const report = await runChaos(SCENARIOS);
  assert.ok(report.scenarios >= 120);
  assert.deepEqual(Object.keys(report.groups).sort(), Object.keys(GROUPS).sort());
  for (const [group, g] of Object.entries(report.groups)) assert.ok(g.scenarios >= 5, `${group} has ${g.scenarios}`);
  assert.deepEqual(report.criteria, Object.fromEntries(Object.keys(report.criteria).map((k) => [k, 0])), JSON.stringify(report.failed_scenarios));
  assert.deepEqual(report.failed_scenarios, []);
  assert.equal(report.rates.classification_coverage, 1);
  assert.equal(report.NORDLA_CORE_RESILIENCE_READY, 'YES');
  for (const r of report.records) assert.deepEqual(Object.keys(r).sort(), [...RECORD_FIELDS].sort(), r.scenario_id);
  const modules = new Set(report.records.map((r) => r.module));
  for (const m of ['creative', 'finance', 'buying', 'demand', 'customers', 'analytics', 'sync', 'tenant', 'marketing-creative', 'compliance']) assert.ok(modules.has(m), m);
  assert.equal(new Set(report.records.map((r) => r.scenario_id)).size, report.scenarios); // unique ids
});

test('CE-11 the benchmark report is a pure function of the scenarios: two runs give the same report', async () => {
  const strip = (r) => JSON.stringify({ ...r, records: r.records });
  const a = await runChaos(SCENARIOS); const b = await runChaos(SCENARIOS);
  assert.equal(strip(a), strip(b));
});

test('CE-12 a scenario that fails is recorded and the suite continues; the readiness refuses a failing run', async () => {
  const broken = S('A', 'core', 'clean_input', { classification: null, action: null, terminal: 'COMPLETED' }, async () => { throw new Error('the scenario itself is broken'); });
  const wrongExpectation = S('A', 'core', 'clean_input', { classification: 'PROTOCOL_ERROR', action: 'GRACEFUL_BLOCK', terminal: 'BLOCKED_GRACEFULLY' }, async (env, id) => (await import('../benchmarks/core-resilience/kit.js')).go(env, id, 'core', [ok('a')]));
  const fine = S('A', 'core', 'clean_input', { classification: null, action: null, terminal: 'COMPLETED' }, async (env, id) => (await import('../benchmarks/core-resilience/kit.js')).go(env, id, 'core', [ok('a')]));
  const report = await runChaos([broken, wrongExpectation, fine]);
  assert.equal(report.scenarios, 3);
  assert.deepEqual(report.failed_scenarios.map((f) => f.problems[0].split(':')[0]), ['SCENARIO_EXCEPTION', 'CLASSIFICATION_EXPECTED_PROTOCOL_ERROR_GOT_null']);
  assert.equal(report.records[2].terminal_state, 'COMPLETED'); // the suite went on
  assert.equal(report.NORDLA_CORE_RESILIENCE_READY, 'NO'); // and fewer than 120 scenarios / failures: not ready
  assert.ok(report.criteria.uncaught_exceptions >= 1);
});

test('CE-13 the harness detects what it must detect: a leak between tenants, an unauthorized recovery and a fatal error silently recovered', async () => {
  const env = createEnv();
  const leak = S('O', 'core', 'multi_tenant_interleaving', { terminal: 'COMPLETED' }, async (e, id) => {
    const { go } = await import('../benchmarks/core-resilience/kit.js');
    const a = await go(e, `${id}-a`, 'core', [ok('a')]); const b = await go(e, `${id}-b`, 'core', [ok('a')]);
    e.hub.handle(b.tenants[0], `run-${id.toLowerCase()}-b`).record({ module: 'x', result: `copied ${e.markers.get(a.tenants[0])}` }); // tenant B's journal now holds A's private marker
    return { ...a, tenants: [...a.tenants, ...b.tenants] };
  });
  const out = await runScenario(leak, env);
  assert.ok(out.problems.includes('CROSS_TENANT_LEAKAGE'));
  const fake = S('R', 'core', 'domain_rule_violation', {}, async () => ({ report: { tenant: 'x', run_id: 'y', terminal_state: 'COMPLETED', recoveries: [{ category: 'SAFETY_OR_FIDELITY_BLOCK', action: 'NORMALIZE' }], recovery_depth: 1 } }));
  const bad = await runScenario(fake, createEnv());
  assert.ok(bad.problems.includes('FATAL_SILENTLY_RECOVERED:SAFETY_OR_FIDELITY_BLOCK:NORMALIZE'));
  assert.ok(bad.problems.includes('UNAUTHORIZED_RECOVERY:SAFETY_OR_FIDELITY_BLOCK:NORMALIZE'));
});

test('CE-14 the committed recovery matrix is the one the real policy produces (never edited by hand)', async () => {
  const committed = JSON.parse(await readFile(new URL('../docs/architecture/nordla-core-resilience-matrix.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildRecoveryMatrix())));
  assert.equal(Object.keys(committed.categories).length, 11);
});

test('CE-15 no live call can happen in the benchmark: the global fetch is never used', async () => {
  const real = globalThis.fetch; let used = 0;
  globalThis.fetch = () => { used += 1; throw new Error('NETWORK_FORBIDDEN'); };
  try { await runChaos(SCENARIOS.slice(0, 60)); } finally { globalThis.fetch = real; }
  assert.equal(used, 0);
});

test('CE-16 a replan resumes from an EARLIER committed stage: that stage and everything after it is uncommitted and runs again, the stages before it do not', async () => {
  const hub = createStateHub(); const ran = { a: 0, b: 0, c: 0 };
  const stages = [
    stage('a', async () => { ran.a += 1; return { a: ran.a }; }),
    stage('b', async () => { ran.b += 1; return { b: ran.b }; }),
    stage('c', async (ctx) => { ran.c += 1; if (ctx.input.fixed !== true) throw Object.assign(new Error('x'), { code: 'PROVIDER_CAPABILITY_UNAVAILABLE' }); return { c: ran.c }; }, { replannable: true, handlers: { replan: async () => ({ restartAt: 'b', patch: { fixed: true } }) } }),
  ];
  const report = await run(stages, { hub });
  assert.equal(report.terminal_state, TERMINAL_STATE.COMPLETED);
  assert.deepEqual(ran, { a: 1, b: 2, c: 2 }); // a kept, b and c redone
  assert.deepEqual(hub.handle('t', 'r').get('b'), { b: 2 });
});

test('CE-17 a run that never reached a terminal state is reported as evidence loss by the harness', async () => {
  const env = createEnv();
  env.hub.open('ten-x', 'run-x').commit('a', 1); // opened, never terminated
  const open = S('A', 'core', 'clean_input', {}, async () => ({ report: { tenant: 'ten-x', run_id: 'run-x', terminal_state: 'COMPLETED', recoveries: [], recovery_depth: 0, provider_calls: 0 } }));
  const out = await runScenario(open, env);
  assert.ok(out.problems.includes('EVIDENCE_LOSS'));
});
