import { createHash } from 'node:crypto';

import { classifyProviderFailure, isTransient } from './provider.js';
import {
  createRecoveryBudget, decideRecovery, RECOVERY_ACTION as A, TERMINAL_STATE, terminalStateOf, assertAuthorized,
} from './recovery.js';
import { PROTOCOL_SUBCODE } from './structured-output.js';
import { CORE_CATEGORY as C, CoreError, makeCoreError, redact } from './taxonomy.js';

// NORDLA CORE RESILIENCE: THE RUN ENGINE. It runs the stages of a module's plan under the Core recovery policy. A stage is `{ name, run(ctx), validate?(value), handlers?, reaskable?, idempotent?, replannable? }`. When a stage
// fails: the failure is classified (exactly one Core category), the policy chooses the first AUTHORIZED action whose precondition holds and whose budget remains, the action is executed through the stage's own handler,
// and everything is journaled. Valid committed state is never overwritten; a failed stage leaves partial evidence only. The run ALWAYS ends in an explicit terminal state, and nothing escapes as an exception:
// an unexpected fault in a handler is itself classified and bounded.
//
// Handlers (all optional, all owned by the module):
//   normalize(error, ctx)       -> value | undefined   a deterministic, meaning-preserving repair of what failed (undefined = no repair possible)
//   reask(error, ctx)           -> value               ONE protocol re-ask of the same provider with the same request
//   replan(error, ctx)          -> { restartAt, patch? } an earlier stage to resume from, and a patch to the run input
//   switchTo(alternate, error, ctx) -> value           the same stage served by a declared equivalent capability
//   question(error)             -> string              what to ask the user

const hashOf = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);

/**
 * @param {object} o { hub, tenant, runId, module, stages, registry, input, modulePolicy, budget, capabilities, canAskUser, now }
 * @returns {Promise<object>} the report; never throws.
 */
export async function runResilient({
  hub, tenant, runId, module, stages, registry, input = {}, modulePolicy = null, budget = createRecoveryBudget(), capabilities = null, canAskUser = true, dataClass = 'PUBLIC',
}) {
  let state;
  try { state = hub.open(tenant, runId); } catch (error) { return engineFault(error, null, { module, tenant, runId }); }
  const report = { tenant, run_id: runId, module, terminal_state: null, action: null, error: null, question: null, completed: [], recovery_depth: 0, recoveries: [], faults: 0 };
  const names = stages.map((s) => s.name);
  let runInput = { ...input };
  let index = 0;
  const failedNormalize = new Set();
  const failedActions = new Set(); // `${stage}:${action}` whose handler failed with an unclassified fault: that action is not tried again

  const ev = (e) => state.record({ module, ...e });
  const classify = (raw, stage) => {
    const where = { module, stage, tenant, checkpoint: state.lastCheckpoint(), evidence_ref: `${runId}:${stage}` };
    const mapped = registry.classify(raw, where);
    return mapped.unmapped && looksLikeProviderFailure(raw) ? classifyProviderFailure(raw, where) : mapped;
  };

  try {
    while (index < stages.length) {
      const stage = stages[index];
      if (state.has(stage.name)) { index += 1; continue; } // resume: committed stages are not re-run
      let attempt = 0;
      let committed = false;
      while (!committed) {
        attempt += 1;
        let value;
        let error;
        try {
          value = await stage.run(makeCtx({ state, stage: stage.name, input: runInput, attempt, tenant, runId, module, capabilities }));
          stage.validate?.(value);
        } catch (raw) { error = classify(raw, stage.name); state.abort(stage.name, raw?.partial ?? null, error.code); }
        if (!error) { state.commit(stage.name, value, hashOf(runInput)); ev({ stage: stage.name, attempt, checkpoint: state.lastCheckpoint(), result: 'COMMITTED' }); committed = true; break; }

        // ---- a failure: classify, decide, execute (all bounded)
        for (let guard = 0; ; guard += 1) {
          if (guard > 64) return finish(TERMINAL_STATE.FATAL, A.FATAL_STOP, makeCoreError({ category: C.FATAL_SYSTEM_ERROR, code: 'CORE_RECOVERY_LOOP_GUARD', module, stage: stage.name, tenant }), stage);
          const ctx = recoveryContext(error, stage, { failedNormalize, failedActions, capabilities, dataClass, canAskUser, runInput });
          const decision = decideRecovery({ error, budget, modulePolicy, ctx });
          assertAuthorized(error, decision.action, modulePolicy);
          budget.spend(decision.action, ctx.costDelta ?? 0);
          report.recovery_depth = budget.used.depth;
          report.recoveries.push({ stage: stage.name, category: error.category, code: error.code, action: decision.action });
          ev({ stage: stage.name, error_category: error.category, domain_code: error.domain_code ?? error.code, recovery_action: decision.action, attempt, checkpoint: state.lastCheckpoint(), result: decision.terminal ? 'TERMINAL' : 'EXECUTING', evidence_reference: error.evidence_ref, rationale: decision.skipped.map((s) => `${s.action}:${s.why}`).join(' | ') || 'first authorized action' });
          if (decision.terminal) return finish(decision.terminal_state, decision.action, error, stage);
          const outcome = await execute(decision.action, error, stage, ctx);
          if (outcome.committed) { committed = true; break; }
          if (outcome.restart) { index = outcome.restart.index - 1; committed = true; break; }
          if (outcome.retry) break; // run the stage again
          if (outcome.failed) { error = outcome.failed; if (outcome.normalizeFailed) failedNormalize.add(stage.name); }
          if (outcome.handlerFault) failedActions.add(`${stage.name}:${outcome.handlerFault}`); // the ORIGINAL error stands; the next authorized action is tried
        }
      }
      index += 1;
    }
    report.completed = state.committedStages();
    state.terminate(TERMINAL_STATE.COMPLETED);
    ev({ stage: 'run', result: TERMINAL_STATE.COMPLETED });
    report.terminal_state = TERMINAL_STATE.COMPLETED;
    return finalize(report, state);
  } catch (fault) {
    return engineFault(fault, state, { module, tenant, runId }, report);
  }

  // ---------------------------------------------------------------------------------------------------- helpers (closures over the run)
  async function execute(action, error, stage, ctx) {
    const h = stage.handlers ?? {};
    // a recovery handler that fails with an unclassified fault does not turn a recoverable error into a fatal one: the original error stands and the next authorized action is tried
    const failure = (e, extra = {}) => {
      const classified = classify(e, stage.name);
      return classified.unmapped ? { handlerFault: action, normalizeFailed: extra.normalizeFailed } : { failed: classified, ...extra };
    };
    const accept = (value, label) => { stage.validate?.(value); state.commit(stage.name, value, hashOf(runInput)); ev({ stage: stage.name, recovery_action: action, checkpoint: state.lastCheckpoint(), result: `COMMITTED_AFTER_${label}` }); return { committed: true }; };
    try {
      switch (action) {
        case A.NORMALIZE: {
          const repaired = await h.normalize(error, makeCtx({ state, stage: stage.name, input: runInput, attempt: 0, tenant, runId, module, capabilities }));
          if (repaired === undefined) return failure(makeCoreError({ category: error.category, code: error.code, module, stage: stage.name, tenant, human_message: 'No meaning-preserving repair exists.' }), { normalizeFailed: true });
          return accept(repaired, 'NORMALIZE');
        }
        case A.REASK_PROVIDER: return accept(await h.reask(error, makeCtx({ state, stage: stage.name, input: runInput, attempt: 0, tenant, runId, module, capabilities })), 'REASK');
        case A.RETRY_SAFE_OPERATION: return { retry: true };
        case A.SWITCH_CAPABILITY: return accept(await h.switchTo(ctx.alternates[0], error, makeCtx({ state, stage: stage.name, input: runInput, attempt: 0, tenant, runId, module, capabilities })), 'SWITCH');
        case A.REPLAN: {
          const plan = await h.replan(error, makeCtx({ state, stage: stage.name, input: runInput, attempt: 0, tenant, runId, module, capabilities }));
          const at = names.indexOf(plan?.restartAt);
          if (at < 0 || at > index) return failure(makeCoreError({ category: C.TOOL_CAPABILITY_LIMIT, code: 'CORE_REPLAN_TARGET_INVALID', module, stage: stage.name, tenant, human_message: 'The replan named no earlier stage to resume from.' }));
          state.rollbackTo(plan.restartAt); // upstream stays valid; this stage and everything after is uncommitted
          if (plan.patch) runInput = { ...runInput, ...plan.patch };
          return { restart: { index: at } };
        }
        default: return failure(new Error('no executor for the action'));
      }
    } catch (e) { return failure(e, { normalizeFailed: action === A.NORMALIZE }); }
  }

  function finish(terminal, action, error, stage) {
    report.terminal_state = terminal; report.action = action; report.error = describe(error);
    if (action === A.ASK_USER) report.question = stage.handlers?.question ? safeQuestion(stage.handlers.question, error) : redact(error.human_message, 240);
    if (action === A.ROLLBACK) ev({ stage: stage.name, recovery_action: A.ROLLBACK, checkpoint: state.lastCheckpoint(), result: 'ROLLED_BACK_TO_LAST_COMMITTED_CHECKPOINT' }); // the failed stage left only partial evidence; committed state is untouched
    report.completed = state.committedStages();
    state.terminate(terminal, error.code);
    ev({ stage: 'run', error_category: error.category, result: terminal });
    return finalize(report, state);
  }
}

const looksLikeProviderFailure = (e) => Number.isInteger(e?.status) || ['AbortError', 'TimeoutError'].includes(e?.name) || /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+|HTTP_TIMEOUT|TIMEOUT|NETWORK)$/.test(String(e?.code ?? ''));

function safeQuestion(fn, error) { try { return redact(fn(error), 300); } catch { return redact(error.human_message, 240); } }

function describe(error) {
  return { category: error.category, code: error.code, domain_code: error.domain_code, module: error.module, stage: error.stage, recoverable: error.recoverable, human_message: error.human_message, evidence_ref: error.evidence_ref, checkpoint: error.checkpoint, diagnostics: error.diagnostics, unmapped: error.unmapped };
}

function finalize(report, state) {
  report.provider_calls = state.meter().provider_calls;
  report.cost_eur = state.meter().cost_eur;
  report.journal_events = state.journal().length;
  return report;
}

function engineFault(fault, state, ids, report = null) {
  const error = makeCoreError({ category: C.FATAL_SYSTEM_ERROR, code: 'CORE_ENGINE_FAULT', module: ids.module ?? 'core', stage: 'engine', tenant: ids.tenant, human_message: 'The resilience engine itself failed; the run was stopped.', diagnostics: { name: fault?.name, message: fault?.message } });
  try { state?.terminate(TERMINAL_STATE.FATAL, error.code); state?.record({ module: ids.module, stage: 'engine', error_category: error.category, result: TERMINAL_STATE.FATAL }); } catch { /* the state is the thing that failed */ }
  const base = report ?? { tenant: ids.tenant, run_id: ids.runId, module: ids.module, completed: [], recovery_depth: 0, recoveries: [], faults: 0, question: null };
  return { ...base, terminal_state: TERMINAL_STATE.FATAL, action: A.FATAL_STOP, error: describe(error), faults: (base.faults ?? 0) + 1, provider_calls: state ? state.meter().provider_calls : 0, cost_eur: state ? state.meter().cost_eur : 0, journal_events: state ? state.journal().length : 0 };
}

/** The context a stage sees: its input (a copy), its attempt, and the three safe doors to the outside: the metered provider call, the exactly-once effect, and the committed upstream state. */
function makeCtx({ state, stage, input, attempt, tenant, runId, module, capabilities }) {
  return {
    tenant, runId, module, stage, attempt, input: structuredClone(input), capabilities,
    upstream: (name) => state.get(name),
    async callProvider(fn, { costEur = 0 } = {}) {
      state.meterCall(stage, 0); // an attempt is counted even if it fails
      const out = await fn();
      const cost = typeof costEur === 'function' ? costEur(out) : costEur;
      if (cost) state.meterCost(stage, cost);
      return out;
    },
    once: (key, fn, opts) => state.once(`${stage}:${key}`, fn, opts),
    meterAttempt: (n = 1, costEur = 0) => { for (let i = 0; i < n; i += 1) state.meterCall(stage, i === 0 ? costEur : 0); },
  };
}

function recoveryContext(error, stage, { failedNormalize, failedActions, capabilities, dataClass, canAskUser, runInput }) {
  const h = stage.handlers ?? {};
  const sub = PROTOCOL_SUBCODE[error.code];
  const alternates = stage.capability && capabilities ? capabilities.alternatesFor(stage.capability, { data_class: dataClass }) : { safe: [], degrading: [] };
  return {
    normalizable: typeof h.normalize === 'function' && !failedNormalize.has(stage.name) && (error.category !== C.PROTOCOL_ERROR || sub?.normalize !== false || stage.normalizeProtocol === true),
    reaskable: stage.reaskable === true && typeof h.reask === 'function' && (sub?.reask ?? false),
    idempotent: stage.idempotent === true,
    transient: isTransient(error) || error.diagnostics?.transient === true,
    replannable: stage.replannable === true && typeof h.replan === 'function',
    alternates: typeof h.switchTo === 'function' ? alternates.safe : [],
    degradingAlternates: alternates.degrading,
    canAskUser,
    failedActions: new Set([...failedActions].filter((k) => k.startsWith(`${stage.name}:`)).map((k) => k.slice(stage.name.length + 1))),
    costDelta: stage.recoveryCostEur ?? 0, // what ONE more recovery attempt of this stage is declared to cost
    runInput,
  };
}

export { CoreError, classifyProviderFailure, terminalStateOf };
