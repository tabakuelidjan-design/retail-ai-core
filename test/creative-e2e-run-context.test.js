import test from 'node:test';
import assert from 'node:assert/strict';

import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import {
  INVALIDATES, OPERATION, RUN_UNIT_COSTS, STAGE, STAGE_ORDER, RunBudgetError, RunInvariantError, createRunContext,
} from '../src/creative-e2e/index.js';

// The authoritative run context (`// RC-N` markers): one budget, one chain of operation ids, reservations, reuse, checkpoints, resume. Pure, no image, no provider.

const make = (over = {}) => createRunContext({ run_id: 'run-test-1', ceiling_eur: 1, ledger: createDecisionLedger(), at: '2026-10-14T00:00:00.000Z', ...over });

test('Operation ids are unique, ordered per kind, deterministic, and never reused', () => {
  const a = make(); const b = make();
  const ids = (ctx) => { const out = []; for (let i = 0; i < 3; i += 1) { const op = ctx.operations.begin({ kind: OPERATION.BRAIN_TEXT, key: `k${i}`, estimate_eur: 0.03, executor: 'PROVIDER' }); out.push(op.id); op.complete(); } const l = ctx.operations.begin({ kind: OPERATION.LOCAL, executor: 'LOCAL' }); out.push(l.id); l.complete(); return out; };
  const x = ids(a); const y = ids(b);
  // RC-1 the format, the per-kind counter, determinism between two runs of the same id
  assert.deepEqual(x, ['run-test-1:BRAIN_TEXT:0001', 'run-test-1:BRAIN_TEXT:0002', 'run-test-1:BRAIN_TEXT:0003', 'run-test-1:LOCAL:0001']); assert.deepEqual(x, y);
  // RC-2 a failed operation keeps its id: the next one does not reuse it
  const f = a.operations.begin({ kind: OPERATION.IMAGE_GENERATION, key: 'img1', estimate_eur: 0.1, executor: 'PROVIDER' }); f.fail('boom');
  const g = a.operations.begin({ kind: OPERATION.IMAGE_GENERATION, key: 'img2', estimate_eur: 0.1, executor: 'PROVIDER' });
  assert.notEqual(f.id, g.id); assert.equal(new Set(a.operations.ids()).size, a.operations.ids().length);
  // RC-3 a run id that is not a plain token is refused
  for (const bad of ['', 'a b', 'x'.repeat(65), 'ab', null]) assert.throws(() => make({ run_id: bad }), (e) => e instanceof RunInvariantError && e.code === 'RUN_ID_INVALID');
});

test('There is no anonymous or free paid operation', () => {
  const ctx = make();
  // RC-4 a paid kind needs an estimate; an unknown kind is refused; a local operation costs nothing
  assert.throws(() => ctx.operations.begin({ kind: OPERATION.IMAGE_GENERATION, executor: 'PROVIDER' }), (e) => e.code === 'A_PAID_OPERATION_NEEDS_AN_ESTIMATE');
  assert.throws(() => ctx.operations.begin({ kind: OPERATION.BRAIN_TEXT, estimate_eur: 0, executor: 'PROVIDER' }), (e) => e.code === 'A_PAID_OPERATION_NEEDS_AN_ESTIMATE');
  assert.throws(() => ctx.operations.begin({ kind: 'MAGIC', estimate_eur: 1 }), (e) => e.code === 'OPERATION_KIND_UNKNOWN');
  assert.throws(() => ctx.operations.begin({ kind: OPERATION.LOCAL, estimate_eur: 0.5 }), (e) => e.code === 'A_LOCAL_OPERATION_COSTS_NOTHING');
  assert.equal(ctx.operations.list().length, 0); // none of the refusals created an operation
  // RC-5 every paid kind of the vocabulary is covered
  for (const kind of [OPERATION.BRAIN_TEXT, OPERATION.ASSET_DIRECTOR_TEXT, OPERATION.IMAGE_GENERATION, OPERATION.SEGMENTATION_PROVIDER, OPERATION.MASKED_EDIT, OPERATION.VISION_CRITIC, OPERATION.UPSCALE]) {
    const op = ctx.operations.begin({ kind, key: kind, estimate_eur: 0.01, executor: 'PROVIDER' }); assert.match(op.id, new RegExp(`:${kind}:0001$`)); op.complete();
  }
});

test('One budget: reserve before the work, settle after, release on failure, refuse beyond the ceiling', () => {
  const ctx = make({ ceiling_eur: 0.1 });
  // RC-6 a reservation holds money; settlement spends the actual amount
  const op = ctx.operations.begin({ kind: OPERATION.IMAGE_GENERATION, key: 'a', estimate_eur: 0.06, executor: 'PROVIDER' });
  assert.equal(ctx.budget.snapshot().reserved_eur, 0.06); assert.equal(ctx.budget.snapshot().available_eur, 0.04);
  op.complete({ actual_eur: 0.05 }); assert.deepEqual([ctx.budget.snapshot().spent_eur, ctx.budget.snapshot().reserved_eur], [0.05, 0]);
  // RC-7 beyond the ceiling: refused BEFORE any operation exists, and the ledger names it
  const before = ctx.operations.list().length;
  assert.throws(() => ctx.operations.begin({ kind: OPERATION.IMAGE_GENERATION, key: 'b', estimate_eur: 0.06, executor: 'PROVIDER' }), (e) => e instanceof RunBudgetError && e.detail.available_eur === 0.05);
  assert.equal(ctx.operations.list().length, before);
  assert.ok(ctx.ledger.entries().some((r) => r.outcome.event === 'RUN_BUDGET_REFUSED'));
  // RC-8 a failed operation releases its reservation: nothing is spent
  const f = ctx.operations.begin({ kind: OPERATION.IMAGE_GENERATION, key: 'c', estimate_eur: 0.05, executor: 'PROVIDER' }); f.fail('provider down');
  assert.deepEqual([ctx.budget.snapshot().spent_eur, ctx.budget.snapshot().reserved_eur, ctx.budget.snapshot().available_eur], [0.05, 0, 0.05]);
  // RC-9 the ceiling is exact: a reservation of exactly the remainder is allowed, a settlement above its reservation is an invariant error
  const exact = ctx.operations.begin({ kind: OPERATION.IMAGE_GENERATION, key: 'd', estimate_eur: 0.05, executor: 'PROVIDER' });
  assert.throws(() => exact.complete({ actual_eur: 0.051 }), (e) => e.code === 'SETTLEMENT_ABOVE_THE_RESERVATION');
  assert.throws(() => ctx.budget.reserve('x', -1), (e) => e.code === 'RESERVATION_AMOUNT_INVALID');
  assert.throws(() => createRunContext({ run_id: 'run-abc', ceiling_eur: -1, ledger: null, at: 'x' }), (e) => e.code === 'CEILING_INVALID');
});

test('A settled request is never paid twice; wrapped ports are operations', async () => {
  const ctx = make();
  // RC-10 the same text request returns the settled answer without calling the port again
  let calls = 0; const complete = async () => { calls += 1; return { text: 'hello', model: 'm' }; };
  const wrapped = ctx.wrapComplete(complete, OPERATION.BRAIN_TEXT);
  const one = await wrapped({ system: 's', user: 'u' }); const two = await wrapped({ system: 's', user: 'u' }); await wrapped({ system: 's', user: 'other' });
  assert.equal(calls, 2); assert.deepEqual(one, two);
  assert.equal(ctx.operations.providerCalls().length, 2); assert.equal(ctx.budget.snapshot().spent_eur, 2 * RUN_UNIT_COSTS.text_stage_eur);
  // RC-11 a failing text call releases and rethrows
  const bad = ctx.wrapComplete(async () => { throw Object.assign(new Error('x'), { code: 'PROVIDER_DOWN' }); }, OPERATION.ASSET_DIRECTOR_TEXT);
  await assert.rejects(() => bad({ system: 'a' }), /x/); assert.equal(ctx.operations.list().at(-1).state, 'FAILED'); assert.equal(ctx.budget.snapshot().reserved_eur, 0);
  // RC-12 a layer port: each call an operation priced from the plan; asking a settled image request again is an invariant error, not a second charge
  const layer = ctx.wrapLayerPort({ executes: { A: 'tool' }, live: false, generate: async () => ({ output_bytes: new Uint8Array(1), provenance: {} }) }, () => 0.034);
  assert.deepEqual(layer.executes, { A: 'tool' }); assert.equal(layer.live, false);
  await layer.generate({ request: { request_key: 'plk_1' }, candidate_index: 1 }); const spent = ctx.budget.snapshot().spent_eur;
  await assert.rejects(() => layer.generate({ request: { request_key: 'plk_1' }, candidate_index: 1 }), (e) => e.code === 'A_SETTLED_IMAGE_REQUEST_WAS_ASKED_AGAIN');
  assert.equal(ctx.budget.snapshot().spent_eur, spent);
  await layer.generate({ request: { request_key: 'plk_1' }, candidate_index: 2 }); assert.equal(ctx.operations.providerCalls().filter((o) => o.kind === OPERATION.IMAGE_GENERATION).length, 2);
});

test('Checkpoints: reusable only for the same input; a redone stage invalidates its dependents and nothing upstream', () => {
  const ctx = make();
  for (const s of STAGE_ORDER) ctx.checkpoints.save(s, { input_sha256: `in-${s}`, payload: { s } });
  // RC-13 reusable for the same input only
  assert.equal(ctx.checkpoints.reusable(STAGE.SEGMENTATION, `in-${STAGE.SEGMENTATION}`), true); assert.equal(ctx.checkpoints.reusable(STAGE.SEGMENTATION, 'other'), false);
  // RC-14 invalidating a stage invalidates exactly what depends on it (the table INVALIDATES): the plans and the asset upstream stay valid
  const hit = ctx.checkpoints.invalidate(STAGE.SEGMENTATION);
  assert.deepEqual(hit, [STAGE.SEGMENTATION, ...INVALIDATES[STAGE.SEGMENTATION]]);
  for (const s of [STAGE.REQUEST, STAGE.ASSET, STAGE.FORMAT_PLAN, STAGE.BRAIN_PLAN]) assert.notEqual(ctx.checkpoints.get(s), null, s);
  for (const s of hit) assert.equal(ctx.checkpoints.get(s), null, s);
  // RC-15 a refine failure invalidates only the final gates (the product, the cut-out and the layers survive)
  const c2 = make(); for (const s of STAGE_ORDER) c2.checkpoints.save(s, { input_sha256: s, payload: null });
  assert.deepEqual(c2.checkpoints.invalidate(STAGE.REFINE), [STAGE.REFINE, STAGE.FINAL_GATES]); assert.notEqual(c2.checkpoints.get(STAGE.INTEGRATION), null);
  // RC-16 the dependency table is well formed: every stage invalidates only LATER stages
  for (const [stage, later] of Object.entries(INVALIDATES)) for (const l of later) assert.ok(STAGE_ORDER.indexOf(l) > STAGE_ORDER.indexOf(stage), `${stage} -> ${l}`);
  assert.throws(() => ctx.checkpoints.save('NOPE', { input_sha256: 'x', payload: 1 }), (e) => e.code === 'STAGE_UNKNOWN');
});

test('Resume: the exported state restores operations, results, reservations and checkpoints; another run id is refused', async () => {
  const a = make(); const complete = async () => ({ text: 'x' });
  const w = a.wrapComplete(complete, OPERATION.BRAIN_TEXT); await w({ system: 'one' });
  a.checkpoints.save(STAGE.ASSET, { input_sha256: 'i', payload: { n: 1 } });
  const state = JSON.parse(JSON.stringify(a.exportState())); // a plain JSON round trip
  const b = make({ resume: state });
  // RC-17 the settled request is reused without a call, the counters continue, the budget carries over
  let calls = 0; const w2 = b.wrapComplete(async () => { calls += 1; return { text: 'y' }; }, OPERATION.BRAIN_TEXT);
  assert.deepEqual(await w2({ system: 'one' }), { text: 'x' }); assert.equal(calls, 0);
  await w2({ system: 'two' }); assert.equal(calls, 1); assert.equal(b.operations.ids().at(-1), 'run-test-1:BRAIN_TEXT:0002');
  assert.equal(b.budget.snapshot().spent_eur, 2 * RUN_UNIT_COSTS.text_stage_eur);
  assert.equal(b.checkpoints.reusable(STAGE.ASSET, 'i'), true);
  // RC-18 a state of another run is refused
  assert.throws(() => make({ run_id: 'other-run', resume: state }), (e) => e.code === 'RESUME_STATE_IS_NOT_THIS_RUN');
  assert.throws(() => make({ resume: { ...state, schema: 'x' } }), (e) => e.code === 'RESUME_STATE_IS_NOT_THIS_RUN');
});
