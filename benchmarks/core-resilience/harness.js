import {
  assertAuthorized, authorizedActions, createCapabilityRegistry, createCoreRegistry, createRecoveryBudget, createStateHub, runResilient, TERMINAL_STATE,
} from '../../src/core-resilience/index.js';
import { registerAll as registerDomains, registerCreative as registerCreativeAdapter } from '../../src/core-resilience/adapters/index.js';

// THE NORDLA CORE CHAOS BENCHMARK HARNESS. Deterministic synthetic scenarios, fake providers only (no network, no credential, no paid call). Each scenario is ISOLATED: an exception inside one is recorded and the suite
// continues. For each scenario the harness records the fields below, checks the mandatory invariants (state, evidence, tenant, authorization, boundedness, side effects) and the report is a pure function of the
// scenarios, so two runs give the same report.

export const RECORD_FIELDS = Object.freeze([
  'scenario_id', 'group', 'module', 'input_class', 'expected_core_classification', 'expected_action', 'actual_classification', 'actual_action', 'recovered', 'clarification_required', 'terminal_state',
  'state_integrity', 'evidence_integrity', 'tenant_isolation', 'provider_calls', 'recovery_depth',
]);

export const GROUPS = Object.freeze({
  A: 'CLEAN INPUT', B: 'INCOMPLETE INPUT', C: 'MALFORMED INPUT', D: 'CONTRADICTORY USER INPUT', E: 'EXTREME TEXT/DATA LENGTH', F: 'MULTILINGUAL INPUT', G: 'USER CHANGE OF MIND', H: 'PROVIDER MALFORMED OUTPUT',
  I: 'PROVIDER TIMEOUT', J: 'PROVIDER REFUSAL', K: 'TOOL CAPABILITY LIMIT', L: 'STATE INTERRUPTION', M: 'REPEATED OPERATION', N: 'DUPLICATE SIDE EFFECT', O: 'MULTI-TENANT INTERLEAVING',
  P: 'RECOVERY FAILURE', Q: 'RECOVERY BUDGET EXHAUSTION', R: 'DOMAIN RULE VIOLATION',
});

const RECOVERY_ACTIONS = new Set(['NORMALIZE', 'REASK_PROVIDER', 'RETRY_SAFE_OPERATION', 'REPLAN', 'SWITCH_CAPABILITY']);
const NON_RECOVERABLE = new Set(['SAFETY_OR_FIDELITY_BLOCK', 'STATE_INTEGRITY_ERROR', 'FATAL_SYSTEM_ERROR']);

export function createEnv() {
  const hub = createStateHub();
  const registry = registerDomains(registerCreativeAdapter(createCoreRegistry()));
  return { hub, registry, capabilities: () => createCapabilityRegistry(), markers: new Map(), effects: { count: new Map() } };
}

/** All text a tenant holds, to look for another tenant's marker. */
function tenantText(hub, tenant) {
  return JSON.stringify(hub.inspectTenant(tenant));
}

export function leakFor(hub, tenant, markers) {
  const text = tenantText(hub, tenant);
  const leaks = [];
  for (const [other, marker] of markers) if (other !== tenant && marker && text.includes(marker)) leaks.push({ tenant, foreign: other });
  return leaks;
}

function stateIntegrity(hub, report, expectations) {
  if (!report?.tenant || !report?.run_id) return true;
  let run;
  try { run = hub.inspectTenant(report.tenant)[report.run_id]; } catch { return false; }
  if (!run) return false;
  const committed = Object.keys(run.committed);
  if (new Set(committed).size !== committed.length) return false; // a stage committed twice
  if (committed.some((stage) => run.partial[stage] && !run.committed[stage])) return false;
  for (const [stage, value] of Object.entries(expectations?.committedValues ?? {})) if (JSON.stringify(run.committed[stage]) !== JSON.stringify(value)) return false; // a valid checkpoint was overwritten
  if (report.terminal_state === TERMINAL_STATE.COMPLETED && expectations?.stages && !expectations.stages.every((s) => committed.includes(s))) return false;
  return true;
}

function evidenceIntegrity(hub, report) {
  if (!report?.tenant || !report?.run_id) return false;
  let run;
  try { run = hub.inspectTenant(report.tenant)[report.run_id]; } catch { return false; }
  if (!run || !run.terminal) return false; // every run ends in an explicit terminal state
  const seqs = run.journal.map((e) => e.seq);
  if (seqs.some((s, i) => i > 0 && s <= seqs[i - 1])) return false;
  const actions = run.journal.filter((e) => e.recovery_action && e.result !== 'COMMITTED' && !String(e.result).startsWith('COMMITTED_AFTER')).length;
  if (actions < (report.recoveries?.length ?? 0)) return false; // each executed recovery left an event
  if (JSON.stringify(run.journal).match(/sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/)) return false; // no credential in the journal
  return true;
}

/** Runs ONE scenario in isolation. Never throws. */
export async function runScenario(scenario, env) {
  const record = Object.fromEntries(RECORD_FIELDS.map((f) => [f, null]));
  Object.assign(record, { scenario_id: scenario.id, group: scenario.group, module: scenario.module, input_class: scenario.input_class, expected_core_classification: scenario.expect.classification ?? null, expected_action: scenario.expect.action ?? null });
  const outcome = { record, problems: [], extra: {} };
  try {
    const built = await scenario.run(env);
    const reports = built.reports ?? [built.report];
    const report = built.report ?? reports[0];
    const first = report.recoveries?.[0] ?? null;
    record.actual_classification = first?.category ?? null;
    record.actual_action = first?.action ?? null;
    record.terminal_state = report.terminal_state;
    record.recovered = report.terminal_state === TERMINAL_STATE.COMPLETED && (report.recoveries?.length ?? 0) > 0;
    record.clarification_required = reports.some((r) => r.terminal_state === TERMINAL_STATE.NEEDS_USER);
    // a run resumed under the same identity reports a cumulative meter: count each run once, at its highest
    const perRun = new Map(); for (const r of reports) perRun.set(`${r.tenant}/${r.run_id}`, Math.max(perRun.get(`${r.tenant}/${r.run_id}`) ?? 0, r.provider_calls ?? 0));
    record.provider_calls = [...perRun.values()].reduce((n, v) => n + v, 0);
    record.recovery_depth = Math.max(...reports.map((r) => r.recovery_depth ?? 0));
    record.state_integrity = reports.every((r) => stateIntegrity(env.hub, r, built.expectations));
    record.evidence_integrity = reports.every((r) => evidenceIntegrity(env.hub, r));
    const leaks = (built.tenants ?? [report.tenant]).flatMap((t) => leakFor(env.hub, t, env.markers));
    record.tenant_isolation = leaks.length === 0 && (built.isolationOk ?? true);
    // ---- invariants
    for (const r of reports) {
      if (!r.terminal_state || !Object.values(TERMINAL_STATE).includes(r.terminal_state)) outcome.problems.push('UNCLASSIFIED_TERMINAL_STATE');
      for (const rec of r.recoveries ?? []) {
        try { assertAuthorized({ category: rec.category }, rec.action, built.modulePolicy ?? null); } catch { outcome.problems.push(`UNAUTHORIZED_RECOVERY:${rec.category}:${rec.action}`); }
        if (NON_RECOVERABLE.has(rec.category) && RECOVERY_ACTIONS.has(rec.action)) outcome.problems.push(`FATAL_SILENTLY_RECOVERED:${rec.category}:${rec.action}`);
      }
      if ((r.recovery_depth ?? 0) > (built.maxDepth ?? 4) || (r.recoveries?.length ?? 0) > (built.maxRecoveries ?? 40)) outcome.problems.push('UNBOUNDED_RECOVERY');
      if (scenario.expect.recoverableCategory && r.terminal_state === TERMINAL_STATE.FATAL && !(r.error && NON_RECOVERABLE.has(r.error.category))) outcome.problems.push('RECOVERABLE_TREATED_AS_FATAL');
    }
    if (!record.state_integrity) outcome.problems.push('STATE_CORRUPTION');
    if (!record.evidence_integrity) outcome.problems.push('EVIDENCE_LOSS');
    if (!record.tenant_isolation) outcome.problems.push('CROSS_TENANT_LEAKAGE');
    if ((built.duplicateEffects ?? 0) > 0) outcome.problems.push('DUPLICATE_IRREVERSIBLE_SIDE_EFFECT');
    // ---- expectation
    const e = scenario.expect;
    if ('classification' in e && e.classification !== record.actual_classification) outcome.problems.push(`CLASSIFICATION_EXPECTED_${e.classification}_GOT_${record.actual_classification}`);
    if ('action' in e && e.action !== record.actual_action) outcome.problems.push(`ACTION_EXPECTED_${e.action}_GOT_${record.actual_action}`);
    if (e.terminal && e.terminal !== record.terminal_state) outcome.problems.push(`TERMINAL_EXPECTED_${e.terminal}_GOT_${record.terminal_state}`);
    if (e.finalAction && e.finalAction !== report.action) outcome.problems.push(`FINAL_ACTION_EXPECTED_${e.finalAction}_GOT_${report.action}`);
    if (built.check) { const bad = built.check(built, report, env); if (bad) outcome.problems.push(`CHECK_FAILED:${bad}`); }
    outcome.extra = { protocol_repairs: built.protocolRepairs ?? 0, faults: reports.reduce((n, r) => n + (r.faults ?? 0), 0), recoveries: reports.flatMap((r) => r.recoveries ?? []) };
  } catch (error) {
    outcome.problems.push(`SCENARIO_EXCEPTION:${error?.name}:${String(error?.message).slice(0, 80)}`);
    record.terminal_state = record.terminal_state ?? 'SCENARIO_EXCEPTION';
  }
  return outcome;
}

/** Runs every scenario (each isolated) and builds the deterministic report. */
export async function runChaos(scenarios, { env = null } = {}) {
  const shared = env ?? createEnv();
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(String(e?.message).slice(0, 80));
  process.on('uncaughtException', onUncaught); process.on('unhandledRejection', onUncaught);
  const outcomes = [];
  try { for (const s of scenarios) outcomes.push(await runScenario(s, shared)); } finally { process.off('uncaughtException', onUncaught); process.off('unhandledRejection', onUncaught); }
  return buildReport(scenarios, outcomes, uncaught);
}

const count = (outcomes, prefix) => outcomes.reduce((n, o) => n + o.problems.filter((p) => p.startsWith(prefix)).length, 0);
const rate = (n, d) => (d === 0 ? null : Math.round((n / d) * 10000) / 10000);

export function buildReport(scenarios, outcomes, uncaught = []) {
  const records = outcomes.map((o) => o.record);
  const n = records.length;
  const byGroup = {};
  for (const [i, o] of outcomes.entries()) {
    const g = (byGroup[scenarios[i].group] ??= { name: GROUPS[scenarios[i].group], scenarios: 0, completed: 0, recovered: 0, clarification: 0, blocked: 0, failed: 0 });
    g.scenarios += 1;
    if (o.record.terminal_state === 'COMPLETED') g.completed += 1;
    if (o.record.recovered) g.recovered += 1;
    if (o.record.clarification_required) g.clarification += 1;
    if (['BLOCKED_GRACEFULLY', 'RECOVERY_EXHAUSTED', 'ROLLED_BACK'].includes(o.record.terminal_state)) g.blocked += 1;
    if (o.problems.length) g.failed += 1;
  }
  const byModule = {};
  for (const [i, o] of outcomes.entries()) {
    const m = (byModule[scenarios[i].module] ??= { scenarios: 0, classified: 0, unmapped: 0 });
    m.scenarios += 1;
    const classified = o.record.terminal_state && o.record.terminal_state !== 'SCENARIO_EXCEPTION';
    if (classified) m.classified += 1;
  }
  const recoveries = outcomes.flatMap((o) => o.extra.recoveries ?? []);
  const metrics = {
    scenarios: n,
    completed: records.filter((r) => r.terminal_state === 'COMPLETED').length,
    recovered_automatically: records.filter((r) => r.recovered).length,
    clarification_required: records.filter((r) => r.clarification_required).length,
    gracefully_blocked: records.filter((r) => ['BLOCKED_GRACEFULLY', 'RECOVERY_EXHAUSTED'].includes(r.terminal_state)).length,
    fatal: records.filter((r) => r.terminal_state === 'FATAL').length,
    rolled_back: records.filter((r) => r.terminal_state === 'ROLLED_BACK').length,
    provider_recoveries: recoveries.filter((r) => ['RETRY_SAFE_OPERATION', 'SWITCH_CAPABILITY', 'REASK_PROVIDER'].includes(r.action)).length,
    protocol_repairs: outcomes.reduce((a, o) => a + (o.extra.protocol_repairs ?? 0), 0) + recoveries.filter((r) => r.action === 'REASK_PROVIDER').length,
    total_recovery_depth: records.reduce((a, r) => a + (r.recovery_depth ?? 0), 0),
    max_recovery_depth: Math.max(0, ...records.map((r) => r.recovery_depth ?? 0)),
  };
  const rates = {
    completion_rate: rate(metrics.completed, n), automatic_recovery_rate: rate(metrics.recovered_automatically, n), clarification_rate: rate(metrics.clarification_required, n), graceful_block_rate: rate(metrics.gracefully_blocked, n),
    provider_recovery_rate: rate(metrics.provider_recoveries, recoveries.length || 1), protocol_repair_rate: rate(metrics.protocol_repairs, n), average_recovery_depth: rate(metrics.total_recovery_depth, n),
    classification_coverage: rate(records.filter((r) => r.terminal_state && r.terminal_state !== 'SCENARIO_EXCEPTION').length, n),
  };
  const criteria = {
    process_crashes: 0,
    uncaught_exceptions: uncaught.length + count(outcomes, 'SCENARIO_EXCEPTION'),
    state_corruption: count(outcomes, 'STATE_CORRUPTION'),
    cross_tenant_leakage: count(outcomes, 'CROSS_TENANT_LEAKAGE'),
    evidence_loss: count(outcomes, 'EVIDENCE_LOSS'),
    unclassified_terminal_states: count(outcomes, 'UNCLASSIFIED_TERMINAL_STATE'),
    unauthorized_recoveries: count(outcomes, 'UNAUTHORIZED_RECOVERY'),
    recoverable_treated_as_fatal: count(outcomes, 'RECOVERABLE_TREATED_AS_FATAL'),
    fatal_silently_recovered: count(outcomes, 'FATAL_SILENTLY_RECOVERED'),
    unbounded_recovery_loops: count(outcomes, 'UNBOUNDED_RECOVERY'),
    duplicate_irreversible_side_effects: count(outcomes, 'DUPLICATE_IRREVERSIBLE_SIDE_EFFECT'),
    expectation_failures: outcomes.filter((o) => o.problems.some((p) => /^(CLASSIFICATION|ACTION|TERMINAL|FINAL_ACTION|CHECK_FAILED)/.test(p))).length,
  };
  const ready = Object.values(criteria).every((v) => v === 0) && n >= 120 && rates.classification_coverage === 1;
  return {
    benchmark: 'NORDLA_CORE_CHAOS_BENCHMARK', scenarios: n, groups: byGroup, by_module: byModule, metrics, rates, criteria,
    failed_scenarios: outcomes.filter((o) => o.problems.length).map((o) => ({ id: o.record.scenario_id, problems: o.problems })),
    records, NORDLA_CORE_RESILIENCE_READY: ready ? 'YES' : 'NO',
  };
}

export { createRecoveryBudget, runResilient, authorizedActions };
