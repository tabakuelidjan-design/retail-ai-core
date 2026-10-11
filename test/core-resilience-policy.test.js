import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAuthorized, authorizedActions, CATEGORIES, CORE_CATEGORY as C, CORE_POLICY, createCoreRegistry, createDomainActionMap, createErrorRegistry, createRecoveryBudget, decideRecovery,
  FORBIDDEN, makeCoreError, RECOVERY_ACTION as A, redact, safeDiagnostics, TERMINAL_ACTIONS, TERMINAL_STATE, UnauthorizedRecoveryError,
} from '../src/core-resilience/index.js';

// CORE RESILIENCE: THE TAXONOMY AND THE RECOVERY POLICY (`// CR-N` markers). Pure, offline, deterministic.

const SHOP = ['shp', 'at_'].join(''); // assembled: the repository's privacy test forbids a token-shaped literal
const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; };
const err = (category, over = {}) => makeCoreError({ category, code: 'TEST_CODE', module: 'test', stage: 'stage', ...over });

test('CR-1 the taxonomy has exactly eleven categories, and every CoreError carries the full safe record', () => {
  assert.equal(CATEGORIES.length, 11);
  for (const category of CATEGORIES) {
    const e = err(category, { domain_code: 'MODULE_SUBCODE', evidence_ref: 'run-1:stage', checkpoint: 'run-1:a:3', tenant: 'ten-1' });
    assert.equal(e.category, category);
    assert.ok(['YES', 'NO', 'CONDITIONAL'].includes(e.recoverable));
    assert.deepEqual([e.code, e.domain_code, e.module, e.stage, e.evidence_ref, e.checkpoint, e.tenant], ['TEST_CODE', 'MODULE_SUBCODE', 'test', 'stage', 'run-1:stage', 'run-1:a:3', 'ten-1']);
    assert.ok(e.human_message.length > 0);
    assert.ok(Object.isFrozen(e));
  }
  assert.throws(() => makeCoreError({ category: 'NOPE', code: 'X', module: 'm', stage: 's' }), /unknown Core category/);
  assert.throws(() => makeCoreError({ category: C.PROTOCOL_ERROR, code: 'has spaces', module: 'm', stage: 's' }), /stable machine code/);
  assert.throws(() => makeCoreError({ category: C.PROTOCOL_ERROR, code: 'X', module: '', stage: 's' }), /originating module/);
  assert.throws(() => makeCoreError({ category: C.PROTOCOL_ERROR, code: 'X', module: 'm', stage: 's', recoverable: 'MAYBE' }), /recoverable/);
});

test('CR-2 a module code maps to exactly one category, a duplicate is refused, and an unknown error is FATAL and flagged unmapped (never silently recovered)', () => {
  const registry = createErrorRegistry().register('demo', { DEMO_A: { category: C.DOMAIN_RULE_VIOLATION } });
  assert.throws(() => registry.register('demo', { DEMO_A: { category: C.INPUT_INVALID } }), /already registered/);
  assert.throws(() => registry.register('demo', { DEMO_B: { category: 'NOPE' } }), /unknown Core category/);
  const known = registry.classify(Object.assign(new Error('x'), { code: 'DEMO_A' }), { module: 'demo', stage: 's' });
  assert.deepEqual([known.category, known.code, known.unmapped], [C.DOMAIN_RULE_VIOLATION, 'DEMO_A', false]);
  const unknown = registry.classify(new TypeError('boom'), { module: 'demo', stage: 's' });
  assert.deepEqual([unknown.category, unknown.unmapped], [C.FATAL_SYSTEM_ERROR, true]);
  assert.equal(registry.classify(known, { module: 'other', stage: 's' }), known); // an existing CoreError is kept
  // two registries share nothing
  assert.equal(createErrorRegistry().lookup('demo', 'DEMO_A'), null);
});

test('CR-3 nothing sensitive survives: credentials, tokens, long hex strings and e-mail addresses are redacted from messages, diagnostics and evidence', () => {
  const secrets = ['sk-abcdef1234567890', 'Bearer abcdefghijklmnop12345', 'api_key=hunter2hunter2', `${SHOP}0123456789abcdef0123`, `eyJ${'a'.repeat(20)}.${'b'.repeat(12)}.sig`, 'AKIA0123456789ABCDEF', 'a'.repeat(8) + 'f'.repeat(32), 'owner@example.com', `-----${'BEGIN'} PRIVATE KEY-----`];
  for (const secret of secrets) assert.ok(!redact(`failed with ${secret} inside`).includes(secret.slice(0, 14)), secret);
  const e = makeCoreError({ category: C.PROVIDER_FAILURE, code: 'X', module: 'm', stage: 's', human_message: `rejected key sk-abcdef1234567890 for owner@example.com`, diagnostics: { token: 'Bearer abcdefghijklmnop12345', nested: { deep: 'x' }, list: [1, 2], n: 4, ok: true, 'bad key!': 'x' }, evidence_ref: 'ref sk-abcdef1234567890' });
  assert.doesNotMatch(JSON.stringify(e), /sk-abcdef|owner@example|abcdefghijklmnop/);
  assert.deepEqual(Object.keys(e.diagnostics).sort(), ['n', 'ok', 'token']); // scalars only, safe key names only
  assert.deepEqual(safeDiagnostics({ a: 'x'.repeat(500) }).a.length <= 203, true);
});

test('CR-4 the Core policy: the authorized actions of every category, in order, as designed', () => {
  assert.deepEqual(CORE_POLICY[C.PROTOCOL_ERROR], [A.NORMALIZE, A.REASK_PROVIDER, A.GRACEFUL_BLOCK]);
  assert.deepEqual(CORE_POLICY[C.MISSING_INFORMATION], [A.NORMALIZE, A.ASK_USER, A.GRACEFUL_BLOCK]);
  assert.deepEqual(CORE_POLICY[C.USER_CONTRADICTION], [A.NORMALIZE, A.ASK_USER, A.GRACEFUL_BLOCK]);
  assert.deepEqual(CORE_POLICY[C.PROVIDER_FAILURE], [A.RETRY_SAFE_OPERATION, A.SWITCH_CAPABILITY, A.ASK_USER, A.GRACEFUL_BLOCK]);
  assert.deepEqual(CORE_POLICY[C.TOOL_CAPABILITY_LIMIT], [A.REPLAN, A.SWITCH_CAPABILITY, A.ASK_USER, A.GRACEFUL_BLOCK]);
  assert.deepEqual(CORE_POLICY[C.STATE_INTEGRITY_ERROR], [A.ROLLBACK, A.FATAL_STOP]);
  assert.deepEqual(CORE_POLICY[C.FATAL_SYSTEM_ERROR], [A.FATAL_STOP]);
  assert.ok(!CORE_POLICY[C.SAFETY_OR_FIDELITY_BLOCK].some((a) => [A.NORMALIZE, A.REASK_PROVIDER, A.RETRY_SAFE_OPERATION, A.SWITCH_CAPABILITY, A.REPLAN].includes(a)));
  for (const category of CATEGORIES) assert.ok(CORE_POLICY[category].some((a) => TERMINAL_ACTIONS.includes(a)), `${category} always has a terminal exit`);
});

test('CR-5 a module can only be stricter than Core or choose inside it, and can never add what is forbidden for a safety, integrity or fatal failure', () => {
  const evil = { extend: Object.fromEntries([C.SAFETY_OR_FIDELITY_BLOCK, C.STATE_INTEGRITY_ERROR, C.FATAL_SYSTEM_ERROR].map((c) => [c, Object.values(A)])) };
  for (const category of [C.SAFETY_OR_FIDELITY_BLOCK, C.STATE_INTEGRITY_ERROR, C.FATAL_SYSTEM_ERROR]) {
    const allowed = authorizedActions(category, evil);
    for (const forbidden of FORBIDDEN[category]) assert.ok(!allowed.includes(forbidden), `${category} must never allow ${forbidden}`);
  }
  assert.deepEqual(authorizedActions(C.PROVIDER_FAILURE, { forbid: { [C.PROVIDER_FAILURE]: [A.RETRY_SAFE_OPERATION] } }), [A.SWITCH_CAPABILITY, A.ASK_USER, A.GRACEFUL_BLOCK]);
  assert.deepEqual(authorizedActions(C.DOMAIN_RULE_VIOLATION, { allow: { [C.DOMAIN_RULE_VIOLATION]: [A.REPLAN, A.GRACEFUL_BLOCK] } }), [A.REPLAN, A.GRACEFUL_BLOCK]);
  assert.deepEqual(authorizedActions(C.DOMAIN_RULE_VIOLATION, { allow: { [C.DOMAIN_RULE_VIOLATION]: [A.REPLAN] } }).at(-1), A.GRACEFUL_BLOCK); // a terminal exit is always added
  assert.equal(authorizedActions(C.RECOVERABLE_EXECUTION_ERROR, { prefer: { [C.RECOVERABLE_EXECUTION_ERROR]: [A.ASK_USER] }, extend: { [C.RECOVERABLE_EXECUTION_ERROR]: [A.ASK_USER] } })[0], A.ASK_USER);
  assert.throws(() => assertAuthorized(err(C.SAFETY_OR_FIDELITY_BLOCK), A.NORMALIZE), UnauthorizedRecoveryError);
  assert.throws(() => assertAuthorized(err(C.PROTOCOL_ERROR), A.REPLAN), (e) => e.code === 'CORE_UNAUTHORIZED_RECOVERY');
  assert.equal(assertAuthorized(err(C.PROTOCOL_ERROR), A.REASK_PROVIDER), true);
});

test('CR-6 the decision: first authorized action whose precondition holds and whose budget remains; preconditions are respected', () => {
  const budget = () => createRecoveryBudget();
  const d = (category, ctx = {}, b = budget(), modulePolicy = null) => decideRecovery({ error: err(category), budget: b, modulePolicy, ctx });
  assert.equal(d(C.PROTOCOL_ERROR, { normalizable: true }).action, A.NORMALIZE);
  assert.equal(d(C.PROTOCOL_ERROR, { reaskable: true }).action, A.REASK_PROVIDER);
  assert.equal(d(C.PROTOCOL_ERROR, {}).action, A.GRACEFUL_BLOCK);
  assert.equal(d(C.MISSING_INFORMATION, {}).action, A.ASK_USER);
  assert.equal(d(C.MISSING_INFORMATION, { canAskUser: false }).action, A.GRACEFUL_BLOCK);
  assert.equal(d(C.MISSING_INFORMATION, { normalizable: true }).action, A.NORMALIZE);
  assert.equal(d(C.PROVIDER_FAILURE, { idempotent: true, transient: true }).action, A.RETRY_SAFE_OPERATION);
  assert.equal(d(C.PROVIDER_FAILURE, { idempotent: true, transient: false }).action, A.GRACEFUL_BLOCK); // a refusal is not retried
  assert.equal(d(C.PROVIDER_FAILURE, { idempotent: false, transient: true }).action, A.GRACEFUL_BLOCK); // a non-idempotent call is not retried
  assert.equal(d(C.PROVIDER_FAILURE, { alternates: ['b'] }).action, A.SWITCH_CAPABILITY);
  assert.equal(d(C.PROVIDER_FAILURE, { degradingAlternates: ['lite'] }).action, A.ASK_USER);
  assert.equal(d(C.TOOL_CAPABILITY_LIMIT, { replannable: true }).action, A.REPLAN);
  assert.equal(d(C.STATE_INTEGRITY_ERROR, {}).action, A.ROLLBACK);
  assert.equal(d(C.FATAL_SYSTEM_ERROR, {}).action, A.FATAL_STOP);
  assert.equal(d(C.SAFETY_OR_FIDELITY_BLOCK, { normalizable: true, replannable: true, idempotent: true, alternates: ['x'], reaskable: true }).action, A.GRACEFUL_BLOCK);
  assert.equal(d(C.DOMAIN_RULE_VIOLATION, {}).action, A.ASK_USER);
  assert.equal(d(C.PROTOCOL_ERROR, { normalizable: true, failedActions: new Set([A.NORMALIZE]), reaskable: true }).action, A.REASK_PROVIDER); // a failed action is not tried again
});

test('CR-7 every recovery is bounded: counters, depth, cost and time end in a classified terminal state, never a loop', () => {
  const b = createRecoveryBudget({ safe_retries: 2, depth: 5 });
  const ctx = { idempotent: true, transient: true };
  const error = err(C.PROVIDER_FAILURE);
  const taken = [];
  for (let i = 0; i < 20; i += 1) { const d = decideRecovery({ error, budget: b, ctx }); taken.push(d.action); if (d.terminal) { assert.equal(d.terminal_state, TERMINAL_STATE.RECOVERY_EXHAUSTED); break; } b.spend(d.action); }
  assert.deepEqual(taken, [A.RETRY_SAFE_OPERATION, A.RETRY_SAFE_OPERATION, A.GRACEFUL_BLOCK]);
  assert.throws(() => b.spend(A.RETRY_SAFE_OPERATION), (e) => e.code === 'CORE_RECOVERY_BUDGET_REFUSED' && e.reason === 'SAFE_RETRIES_EXHAUSTED');
  assert.throws(() => createRecoveryBudget({ depth: -1 }), RangeError);
  const cost = createRecoveryBudget({ cost_eur: 1, depth: 10, safe_retries: 10 });
  cost.spend(A.RETRY_SAFE_OPERATION, 0.6);
  assert.equal(cost.refusal(A.RETRY_SAFE_OPERATION, 0.6), 'RECOVERY_COST_EXHAUSTED');
  let t = 0; const timed = createRecoveryBudget({ elapsed_ms: 100 }, { clock: () => (t += 60) });
  assert.equal(timed.refusal(A.REPLAN), null); assert.equal(timed.refusal(A.REPLAN), 'RECOVERY_TIME_EXHAUSTED');
  assert.equal(timed.refusal(A.GRACEFUL_BLOCK), null); // a terminal exit is never refused for time
});

test('CR-8 property: for every category, any context and any budget, the decision is authorized, deterministic, and either terminal or within budget', () => {
  const random = lcg(20261012);
  for (let i = 0; i < 4000; i += 1) {
    const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)];
    const ctx = { normalizable: random() < 0.5, reaskable: random() < 0.5, idempotent: random() < 0.5, transient: random() < 0.5, replannable: random() < 0.5, alternates: random() < 0.5 ? ['x'] : [], degradingAlternates: random() < 0.3 ? ['y'] : [], canAskUser: random() < 0.8, failedActions: new Set(Object.values(A).filter(() => random() < 0.15)) };
    const limits = { provider_repairs: Math.floor(random() * 3), safe_retries: Math.floor(random() * 3), replans: Math.floor(random() * 3), capability_switches: Math.floor(random() * 3), depth: Math.floor(random() * 5) };
    const policy = random() < 0.3 ? { forbid: { [category]: Object.values(A).filter(() => random() < 0.4) } } : null;
    const b1 = createRecoveryBudget(limits); const b2 = createRecoveryBudget(limits);
    const error = err(category);
    const first = decideRecovery({ error, budget: b1, modulePolicy: policy, ctx });
    const again = decideRecovery({ error, budget: b2, modulePolicy: policy, ctx });
    assert.deepEqual(first, again);
    assert.ok(authorizedActions(category, policy).includes(first.action) || first.action === A.GRACEFUL_BLOCK || first.action === A.FATAL_STOP);
    if (NON_RECOVERING.has(category)) assert.ok(![A.NORMALIZE, A.REASK_PROVIDER, A.RETRY_SAFE_OPERATION, A.SWITCH_CAPABILITY, A.REPLAN].includes(first.action), `${category} -> ${first.action}`);
    if (!first.terminal) assert.equal(b1.refusal(first.action), null);
    if (first.terminal) assert.ok(first.terminal_state);
  }
});
const NON_RECOVERING = new Set([C.SAFETY_OR_FIDELITY_BLOCK, C.STATE_INTEGRITY_ERROR, C.FATAL_SYSTEM_ERROR]);

test('CR-9 a domain action keeps its meaning and maps onto Core semantics', () => {
  const map = createDomainActionMap('demo', { RECONCEPT: { core: A.REPLAN, scope: 'IDEATE' } });
  assert.deepEqual({ ...map.RECONCEPT }, { domain_action: 'RECONCEPT', module: 'demo', core: A.REPLAN, scope: 'IDEATE' });
  assert.throws(() => createDomainActionMap('demo', { X: { core: 'INVENTED' } }), /not a Core action/);
  const registry = createCoreRegistry();
  assert.equal(registry.lookup('*', 'PROVIDER_MALFORMED_JSON').category, C.PROTOCOL_ERROR);
  assert.equal(registry.lookup('*', 'PROVIDER_TIMEOUT').category, C.PROVIDER_FAILURE);
  assert.equal(registry.lookup('*', 'CORE_TENANT_MISMATCH').category, C.STATE_INTEGRITY_ERROR);
});
