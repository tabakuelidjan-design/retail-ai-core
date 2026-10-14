import { createHash } from 'node:crypto';

import {
  INVALIDATES, OPERATION, PAID_OPERATIONS, RUN_UNIT_COSTS, STAGE_ORDER,
} from './constants.js';

// THE AUTHORITATIVE RUN CONTEXT. One run = one id, one ledger, ONE budget, ONE chain of operation ids, one list of provider calls, one set of checkpoints. No module of the chain keeps a budget or an id of its
// own that the others cannot see: every paid or externally executed operation is begun here (it gets a unique id and a reservation BEFORE it starts), settled here after it, or released here if it failed.
//
// Operation ids are `<run_id>:<KIND>:<NNNN>` (a counter per kind): unique inside the run, deterministic for a deterministic run, never reused (not after a failure either). A paid operation without an estimate,
// or of an unknown kind, is refused: there is no anonymous paid operation. An operation whose KEY (a hash of its request) was already settled is reported as `reused` so that its caller does not pay twice.

const sha = (text) => createHash('sha256').update(text).digest('hex');
const round = (x) => Math.round(x * 1e9) / 1e9;

export class RunBudgetError extends Error {
  constructor(detail) { super(`BUDGET_EXCEEDED: ${detail.label} needs ${detail.requested_eur} EUR, ${detail.available_eur} EUR available of ${detail.ceiling_eur}`); this.name = 'RunBudgetError'; this.code = 'BUDGET_EXCEEDED'; this.detail = detail; }
}
export class RunInvariantError extends Error {
  constructor(code, detail = {}) { super(code); this.name = 'RunInvariantError'; this.code = code; this.detail = detail; }
}

/**
 * @param {object} input { run_id, ceiling_eur, ledger, at, resume? (the object returned by `exportState`) }
 */
export function createRunContext({
  run_id: runId, ceiling_eur: ceiling, ledger, at, resume = null,
}) {
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(runId ?? '')) throw new RunInvariantError('RUN_ID_INVALID', { run_id: runId });
  if (!(Number.isFinite(ceiling) && ceiling >= 0)) throw new RunInvariantError('CEILING_INVALID', { ceiling_eur: ceiling });
  const reservations = new Map(); // id -> { label, eur, state: RESERVED|SETTLED|RELEASED, actual }
  const ops = []; // every operation of the run, in order
  const counters = {}; const settledKeys = new Map(); // key -> op id
  const results = new Map(); // key -> JSON result of a settled text operation (so a repeated request is not paid twice)
  const checkpoints = new Map(); // stage -> { stage, input_sha256, payload_sha256, payload, saved_at_op, valid }
  let spent = 0; let seq = 0; let failure = null;

  if (resume) {
    if (resume.schema !== 'run-state@1' || resume.run_id !== runId) throw new RunInvariantError('RESUME_STATE_IS_NOT_THIS_RUN', { expected: runId, got: resume.run_id });
    for (const o of resume.operations) { ops.push({ ...o }); counters[o.kind] = Math.max(counters[o.kind] ?? 0, Number(o.id.split(':').pop())); if (o.state === 'SETTLED') settledKeys.set(o.key, o.id); seq += 1; }
    for (const [k, v] of Object.entries(resume.results ?? {})) results.set(k, v);
    for (const r of resume.reservations) reservations.set(r.id, { ...r });
    spent = resume.budget.spent_eur;
    for (const c of resume.checkpoints) checkpoints.set(c.stage, { ...c });
  }
  const reservedOf = () => round([...reservations.values()].filter((r) => r.state === 'RESERVED').reduce((t, r) => t + r.eur, 0));
  const available = () => round(ceiling - spent - reservedOf());
  const snapshot = () => ({ ceiling_eur: ceiling, spent_eur: round(spent), reserved_eur: reservedOf(), available_eur: available(), operations: ops.length, provider_calls: ops.filter((o) => o.paid && o.state !== 'FAILED_BEFORE_CALL').length });

  const note = (event, outcome) => ledger?.record?.({ decision: 'E2E_RUN_EVENT', decided_by: 'nordla:creative-e2e-run-context@1', rule: 'ONE_RUN_ONE_BUDGET_ONE_OPERATION_ID_CHAIN', basis: [runId], outcome: { event, ...outcome } });

  const budget = Object.freeze({
    ceiling_eur: ceiling,
    reserve(label, eur) {
      if (!(Number.isFinite(eur) && eur >= 0)) throw new RunInvariantError('RESERVATION_AMOUNT_INVALID', { label, eur });
      if (round(eur) > available() + 1e-12) { const d = { label, requested_eur: round(eur), available_eur: available(), ceiling_eur: ceiling, spent_eur: round(spent) }; note('RUN_BUDGET_REFUSED', d); throw new RunBudgetError(d); }
      const id = `res-${reservations.size + 1}`; reservations.set(id, { id, label, eur: round(eur), state: 'RESERVED', actual: null });
      return id;
    },
    settle(id, actual) {
      const r = reservations.get(id); if (!r || r.state !== 'RESERVED') throw new RunInvariantError('RESERVATION_NOT_OPEN', { id });
      if (actual > r.eur + 1e-12) throw new RunInvariantError('SETTLEMENT_ABOVE_THE_RESERVATION', { id, reserved_eur: r.eur, actual });
      r.state = 'SETTLED'; r.actual = round(actual); spent = round(spent + actual);
    },
    release(id) { const r = reservations.get(id); if (!r || r.state !== 'RESERVED') return false; r.state = 'RELEASED'; return true; },
    snapshot,
  });

  const operations = Object.freeze({
    /**
     * Begin an operation. PAID kinds need `estimate_eur > 0` and reserve it now (a refusal throws RunBudgetError and no operation is created). `key` identifies the request: an identical settled key is `reused`.
     * @returns {{ reused: boolean, id: string, complete: Function, fail: Function, result?: any }}
     */
    begin({ kind, key = null, estimate_eur: estimate = 0, executor = 'LOCAL', basis = [] }) {
      if (!Object.values(OPERATION).includes(kind)) throw new RunInvariantError('OPERATION_KIND_UNKNOWN', { kind });
      const paid = PAID_OPERATIONS.includes(kind);
      if (paid && !(Number.isFinite(estimate) && estimate > 0)) throw new RunInvariantError('A_PAID_OPERATION_NEEDS_AN_ESTIMATE', { kind });
      if (!paid && estimate !== 0) throw new RunInvariantError('A_LOCAL_OPERATION_COSTS_NOTHING', { kind, estimate });
      const opKey = key ?? `${kind}#${ops.length + 1}`;
      if (settledKeys.has(opKey) && paid) {
        const prior = ops.find((o) => o.id === settledKeys.get(opKey));
        note('OPERATION_REUSED', { kind, key: opKey, id: prior.id, calls_saved: 1 });
        return { reused: true, id: prior.id, result: results.get(opKey), complete() {}, fail() {} };
      }
      const reservation = paid ? budget.reserve(`${kind}:${opKey.slice(0, 60)}`, estimate) : null; // refused here: nothing was created
      counters[kind] = (counters[kind] ?? 0) + 1; seq += 1;
      const id = `${runId}:${kind}:${String(counters[kind]).padStart(4, '0')}`;
      if (ops.some((o) => o.id === id)) throw new RunInvariantError('OPERATION_ID_REUSED', { id });
      const op = { id, kind, key: opKey, paid, executor, estimate_eur: round(estimate), actual_eur: null, state: 'BEGUN', reservation, basis, seq };
      ops.push(op); note('OPERATION_BEGUN', { id, kind, key: opKey, estimate_eur: op.estimate_eur, executor });
      return {
        reused: false,
        id,
        complete({ actual_eur: actual = estimate, result = undefined } = {}) {
          if (op.state !== 'BEGUN') throw new RunInvariantError('OPERATION_NOT_OPEN', { id, state: op.state });
          if (reservation) budget.settle(reservation, actual);
          op.state = 'SETTLED'; op.actual_eur = round(actual); settledKeys.set(opKey, id);
          if (result !== undefined) results.set(opKey, result);
          note('OPERATION_SETTLED', { id, kind, actual_eur: op.actual_eur });
        },
        fail(reason = 'ERROR') {
          if (op.state !== 'BEGUN') return;
          if (reservation) budget.release(reservation);
          op.state = 'FAILED'; op.failure = String(reason).slice(0, 160); note('OPERATION_FAILED', { id, kind, reason: op.failure, released_eur: op.estimate_eur });
        },
      };
    },
    list: () => ops.map((o) => ({ ...o })),
    providerCalls: () => ops.filter((o) => o.paid && o.state !== 'FAILED_BEFORE_CALL').map((o) => ({ id: o.id, kind: o.kind, key: o.key, state: o.state, estimate_eur: o.estimate_eur, actual_eur: o.actual_eur })),
    ids: () => ops.map((o) => o.id),
  });

  /** A text port wrapped so that every call is an operation: unique id, reservation, ledger, settlement; an identical settled request returns the settled answer without a call. */
  function wrapComplete(complete, kind) {
    return async (instruction) => {
      const key = `${kind}:${sha(JSON.stringify(instruction))}`;
      const op = operations.begin({ kind, key, estimate_eur: RUN_UNIT_COSTS.text_stage_eur, executor: 'PROVIDER', basis: [instruction?.stage ?? 'text'] });
      if (op.reused) return op.result;
      try { const out = await complete(instruction); op.complete({ result: out }); return out; } catch (e) { op.fail(e?.code ?? e?.message ?? 'ERROR'); throw e; }
    };
  }

  /** A layer port (the generator of plates and props) wrapped the same way: the unit price comes from the production plan. The wrapper keeps `executes` and `live` as they are. */
  function wrapLayerPort(port, unitCostOf) {
    return Object.freeze({
      executes: port.executes, live: port.live,
      async generate(args) {
        const { request, candidate_index: index = 1 } = args;
        const unit = unitCostOf(request);
        const op = operations.begin({ kind: OPERATION.IMAGE_GENERATION, key: `IMG:${request.request_key}#${index}`, estimate_eur: unit, executor: 'PROVIDER', basis: [request.request_key] });
        if (op.reused) throw new RunInvariantError('A_SETTLED_IMAGE_REQUEST_WAS_ASKED_AGAIN', { key: request.request_key, index });
        try { const out = await port.generate(args); op.complete({ actual_eur: unit }); return out; } catch (e) { op.fail(e?.code ?? e?.message ?? 'ERROR'); throw e; }
      },
    });
  }

  const cps = Object.freeze({
    /** Save the checkpoint of a stage: the hash of what it was computed FROM and of what it produced, and the (JSON) payload to resume from. */
    save(stage, { input_sha256: input, payload, meta = {} }) {
      if (!STAGE_ORDER.includes(stage)) throw new RunInvariantError('STAGE_UNKNOWN', { stage });
      const json = JSON.stringify(payload ?? null);
      checkpoints.set(stage, { stage, input_sha256: input, payload_sha256: sha(json), payload: payload ?? null, meta, valid: true, at_operation: ops.length });
      note('CHECKPOINT_SAVED', { stage, input_sha256: input, payload_sha256: sha(json) });
    },
    get: (stage) => { const c = checkpoints.get(stage); return c && c.valid ? c : null; },
    /** A checkpoint is reusable only if it is valid AND was computed from the same input. */
    reusable: (stage, input) => { const c = checkpoints.get(stage); return Boolean(c && c.valid && c.input_sha256 === input); },
    /** Redo a stage: it and ONLY what depends on it are invalidated (see INVALIDATES). */
    invalidate(stage) {
      const hit = [stage, ...(INVALIDATES[stage] ?? [])].filter((s) => checkpoints.has(s) && checkpoints.get(s).valid);
      for (const s of hit) checkpoints.get(s).valid = false;
      note('CHECKPOINTS_INVALIDATED', { from: stage, invalidated: hit });
      return hit;
    },
    list: () => STAGE_ORDER.filter((s) => checkpoints.has(s)).map((s) => { const c = checkpoints.get(s); return { stage: s, valid: c.valid, input_sha256: c.input_sha256, payload_sha256: c.payload_sha256 }; }),
  });

  return Object.freeze({
    run_id: runId, at, ledger, budget, operations, checkpoints: cps, wrapComplete, wrapLayerPort,
    setFailure(f) { failure = f; note('RUN_FAILURE', f); },
    failure: () => failure,
    results: results,
    /** Plain JSON: everything needed to resume this run in another process (settled keys, results, reservations, checkpoints with their payloads). */
    exportState: () => ({
      schema: 'run-state@1', run_id: runId, at,
      operations: ops.map((o) => ({ ...o })), results: Object.fromEntries(results.entries()), reservations: [...reservations.values()].map((r) => ({ ...r })),
      budget: { ceiling_eur: ceiling, spent_eur: round(spent) }, checkpoints: [...checkpoints.values()].map((c) => ({ ...c })),
    }),
  });
}
