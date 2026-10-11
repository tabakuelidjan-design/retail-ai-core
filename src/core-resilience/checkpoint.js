import { createHash } from 'node:crypto';

import { makeCoreError, CORE_CATEGORY, redact } from './taxonomy.js';

// NORDLA CORE RESILIENCE: STATE. A run keeps three things apart:
//   COMMITTED  the checkpoints of stages that completed and passed their validation: frozen, never overwritten by a failed stage, the only thing a recovery resumes from;
//   PARTIAL    what a failed stage left behind: kept as evidence, never mistaken for committed state;
//   JOURNAL    every event of the run, plus the METER of provider calls and cost: they live OUTSIDE the checkpoints, so a rollback or a failure never erases evidence or accounting.
// Side effects go through `once(key)`: the same key runs once; an irreversible effect whose outcome is unknown is never repeated automatically. Everything is keyed by TENANT first: a run of one tenant cannot be
// reached with the identity of another (STATE_INTEGRITY_ERROR). This fits Nordla's existing in-process stores (journals, ledgers); it does not retrofit database transactions.

const SAFE = /^[A-Za-z0-9_.:-]{1,100}$/;
const deepFreeze = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; };
const hashOf = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);

export const STAGE_STATUS = Object.freeze({ COMMITTED: 'COMMITTED', FAILED: 'FAILED', ROLLED_BACK: 'ROLLED_BACK' });

function integrity(tenant, message, code) {
  return makeCoreError({ category: CORE_CATEGORY.STATE_INTEGRITY_ERROR, code, module: 'core', stage: 'state', human_message: message, tenant });
}

class Run {
  constructor(tenant, runId) {
    this.tenant = tenant; this.runId = runId;
    this.order = []; // stage names in commit order
    this.committed = new Map(); // stage -> { value, input_hash, seq }
    this.partial = new Map(); // stage -> { value, error_code, seq }
    this.journal = [];
    this.meter = { provider_calls: 0, cost_eur: 0, by_stage: {} };
    this.effects = new Map(); // key -> { status: 'DONE' | 'UNKNOWN', result }
    this.suppressed = 0;
    this.seq = 0;
    this.terminal = null;
  }
}

/** The state of all runs, partitioned by tenant. */
export function createStateHub() {
  const tenants = new Map(); // tenant -> Map(runId -> Run)
  const run = (tenant, runId, { create = false } = {}) => {
    if (!SAFE.test(String(tenant)) || !SAFE.test(String(runId))) throw integrity(null, 'A run needs a safe tenant and run identity.', 'CORE_RUN_IDENTITY_INVALID');
    const existing = tenants.get(tenant)?.get(runId);
    if (existing) return existing;
    if (!create) {
      for (const [other, otherRuns] of tenants) if (other !== tenant && otherRuns.has(runId)) throw integrity(tenant, 'That run belongs to another tenant.', 'CORE_TENANT_MISMATCH');
      throw integrity(tenant, 'No such run for this tenant.', 'CORE_RUN_NOT_FOUND_FOR_TENANT');
    }
    if (!tenants.has(tenant)) tenants.set(tenant, new Map());
    const created = new Run(tenant, runId);
    tenants.get(tenant).set(runId, created);
    return created;
  };

  const hub = {
    open: (tenant, runId) => run(tenant, runId, { create: true }) && handle(tenant, runId),
    handle: (tenant, runId) => { run(tenant, runId); return handle(tenant, runId); },
    tenants: () => [...tenants.keys()].sort(),
    runs: (tenant) => [...(tenants.get(tenant)?.keys() ?? [])].sort(),
    /** A copy of everything one tenant holds, for the isolation tests: it never contains another tenant's data. */
    exportTenant(tenant) {
      const out = {};
      for (const [id, r] of tenants.get(tenant) ?? []) out[id] = { committed: [...r.committed.keys()], partial: [...r.partial.keys()], journal: r.journal.length, meter: { ...r.meter }, terminal: r.terminal };
      return out;
    },
  };

  function handle(tenant, runId) {
    const r = () => run(tenant, runId);
    const api = {
      tenant, runId,
      /** The journal event: concise decision rationale and evidence, never reasoning, never a payload. */
      record(event) {
        const x = r();
        x.seq += 1;
        const row = Object.freeze({
          seq: x.seq, tenant, run_id: runId, module: event.module ?? null, stage: event.stage ?? null, error_category: event.error_category ?? null, domain_code: event.domain_code ?? null,
          recovery_action: event.recovery_action ?? null, attempt: event.attempt ?? 0, checkpoint: event.checkpoint ?? null, provider_call: event.provider_call ?? false,
          cost_delta: event.cost_delta ?? 0, result: event.result ?? null, evidence_reference: event.evidence_reference ? redact(event.evidence_reference, 200) : null,
          rationale: event.rationale ? redact(event.rationale, 240) : null,
        });
        x.journal.push(row);
        return row;
      },
      journal: () => [...r().journal],
      /** Provider-call accounting: survives failure and rollback. */
      meterCall(stage, costEur = 0) {
        const x = r();
        x.meter.provider_calls += 1; x.meter.cost_eur = Math.round((x.meter.cost_eur + costEur) * 1e9) / 1e9;
        x.meter.by_stage[stage] = (x.meter.by_stage[stage] ?? 0) + 1;
      },
      meterCost(stage, costEur) { const x = r(); x.meter.cost_eur = Math.round((x.meter.cost_eur + costEur) * 1e9) / 1e9; x.meter.cost_by_stage = x.meter.cost_by_stage ?? {}; x.meter.cost_by_stage[stage] = (x.meter.cost_by_stage[stage] ?? 0) + costEur; },
      meter: () => ({ ...r().meter, by_stage: { ...r().meter.by_stage } }),
      /** Commit: only a stage that passed its validation, once; a committed checkpoint is frozen and is never overwritten. */
      commit(stage, value, inputHash = null) {
        const x = r();
        if (x.committed.has(stage)) throw integrity(tenant, `Stage ${stage} is already committed: a checkpoint is never overwritten.`, 'CORE_CHECKPOINT_OVERWRITE');
        x.seq += 1;
        x.committed.set(stage, { value: deepFreeze(structuredClone(value)), input_hash: inputHash ?? hashOf(value), seq: x.seq });
        x.order.push(stage); x.partial.delete(stage);
        return `${runId}:${stage}:${x.seq}`;
      },
      /** A failed stage leaves PARTIAL evidence; committed state is untouched. */
      abort(stage, partialValue, errorCode) {
        const x = r(); x.seq += 1;
        x.partial.set(stage, { value: partialValue === undefined ? null : redactPartial(partialValue), error_code: errorCode ?? null, seq: x.seq });
      },
      get: (stage) => r().committed.get(stage)?.value,
      has: (stage) => r().committed.has(stage),
      partial: (stage) => r().partial.get(stage) ?? null,
      committedStages: () => [...r().order],
      lastCheckpoint() { const x = r(); const last = x.order.at(-1); return last ? `${runId}:${last}:${x.committed.get(last).seq}` : null; },
      /** Explicit rollback: the stages from `stage` on are uncommitted (their journal and meter stay); upstream state stays valid. Returns the stages undone. */
      rollbackTo(stage) {
        const x = r();
        const at = x.order.indexOf(stage);
        const undone = at < 0 ? [] : x.order.splice(at);
        for (const s of undone) x.committed.delete(s);
        return undone;
      },
      /** Selective invalidation (the user changed one thing): exactly these committed stages are uncommitted, the others stay valid. Returns the stages actually removed. */
      uncommit(stages) {
        const x = r();
        const removed = stages.filter((s) => x.committed.has(s));
        for (const s of removed) { x.committed.delete(s); x.order.splice(x.order.indexOf(s), 1); }
        return removed;
      },
      /** Exactly-once side effect. `irreversible`: if an attempt threw with an unknown outcome, it is NOT repeated automatically. */
      async once(key, fn, { irreversible = false } = {}) {
        const x = r();
        const known = x.effects.get(key);
        if (known?.status === 'DONE') { x.suppressed += 1; return known.result; }
        if (known?.status === 'UNKNOWN') { x.suppressed += 1; throw integrity(tenant, `The outcome of side effect ${redact(key, 60)} is unknown: it is not repeated automatically.`, 'CORE_EFFECT_OUTCOME_UNKNOWN'); }
        if (irreversible) x.effects.set(key, { status: 'UNKNOWN', result: null });
        let result;
        try { result = await fn(); } catch (error) { if (!irreversible) x.effects.delete(key); throw error; }
        x.effects.set(key, { status: 'DONE', result });
        return result;
      },
      suppressedDuplicates: () => r().suppressed,
      effectKeys: () => [...r().effects.keys()],
      terminate(state, detail = null) { const x = r(); if (x.terminal) return x.terminal; x.terminal = Object.freeze({ state, detail, seq: ++x.seq }); return x.terminal; },
      terminal: () => r().terminal,
      snapshot() { const x = r(); return { committed: [...x.order], partial: [...x.partial.keys()], terminal: x.terminal, meter: api.meter(), journal: x.journal.length }; },
    };
    return api;
  }
  return hub;
}

// partial evidence keeps shapes and short scalars, never a large private payload
function redactPartial(value, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redact(value, 160);
  if (depth > 3) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 8).map((v) => redactPartial(v, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 16).map(([k, v]) => [String(k).slice(0, 60), redactPartial(v, depth + 1)]));
  return null;
}
