import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createDecisionLedger, createLayerStore } from '../src/creative-runtime/index.js';
import {
  createDefectRegion, createRefineMemory, DEFECT_KIND, diffArtifacts, nodeDigests, refineCreative, REPAIR_BLOCK,
} from '../src/creative-refine/index.js';
import { mergePolicy } from '../src/creative-refine/refine.js';
import { refineSample } from '../src/creative-refine/parity.js';

// THE EXECUTOR'S DECISIONS WITHOUT AN IMAGE (`// EX-N`): refineCreative is given a FAKE layered runtime that returns a scripted artifact, so that every decision of the executor (preconditions, plan, tool check, the copy of the
// shared layers, the policy handed to the runtime, the cost, the verdict on the repaired candidate, the check against the plan, the memory, the ledger) is exercised in milliseconds. The real runtime is RF-1 to RF-26.

const sha = (b) => createHash('sha256').update(b).digest('hex');
const bytesOf = (n) => new Uint8Array([n, n, n, n]);
const EXECUTES = { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary', PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/primary' };

/** A delivered candidate over the probe artifact, a shared store that really holds its candidates, and the inputs of the original call. */
function env({ status = 'READY_FOR_REVIEW', run: runOver = {} } = {}) {
  const artifact = refineSample(); const store = createLayerStore();
  for (const [key, node, n] of [['plk_probe', artifact.nodes.plate, 1], ['prk_mid', artifact.nodes.props[0], 2], ['prk_fg', artifact.nodes.props[1], 4]]) { store.add(key, { index: 1, bytes: bytesOf(n), provenance: null }); node.candidate_sha256 = sha(bytesOf(n)); }
  const ledger = createDecisionLedger();
  const run = {
    scene_id: 'scn_probe', ledger, ports: { layers: { executes: { ...EXECUTES } } }, policy: {},
    production: { shared_layers: [{ request_key: 'plk_probe', size_class: 'ABOVE_1024' }, { request_key: 'prk_mid', size_class: 'UP_TO_1024' }, { request_key: 'prk_fg', size_class: 'UP_TO_1024' }], production: { budget: { unit_costs: { image_eur_by_size_class: { UP_TO_1024: 0.034, ABOVE_1024: 0.069 } } } } },
    ...runOver,
  };
  return { candidate: { status, artifact }, store, run, ledger };
}
const badMid = () => createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: 'lyr_mid' });
const newProp = (a) => { a.nodes.props[0].candidate_sha256 = 'f'.repeat(40); a.nodes.composite.base_sha256 = 'd'.repeat(40); a.nodes.composite.stack_sha256 = 'e'.repeat(40); a.nodes.render.png_sha256 = '9'.repeat(40); return a; };
/** A fake layered runtime: returns the artifact of the candidate, edited, with the given status and budget; records what it was given. */
const fake = (E, { status = 'READY_FOR_REVIEW', edit = newProp, budget = { provider_calls: 1, spent_eur: 0.034 }, extra = {}, artifact = true } = {}) => {
  const seen = []; const fn = async (input) => { seen.push(input); return { status, ...(artifact ? { artifact: edit(JSON.parse(JSON.stringify(E.candidate.artifact))) } : {}), ...(budget ? { budget } : {}), ...extra }; };
  fn.seen = seen; return fn;
};
const go = (E, over = {}) => refineCreative({ candidate: E.candidate, defects: [badMid()], run: E.run, store: E.store, ...over });

test('EX-1 a repair: the runtime gets a COPY of the layers with the old candidate rejected, the plan overrides merged into the policy, and its answer is checked, costed, remembered and recorded', async () => {
  const E = env(); const rt = fake(E); const memory = createRefineMemory(); const countBefore = E.store.count('prk_mid');
  const r = await go(E, { runtime: rt, memory });
  assert.equal(r.status, 'REPAIRED'); assert.equal(r.original_kept, false); assert.equal(r.fallback_to_full_regeneration, false); assert.equal(r.tool_switch, false); assert.equal(r.scene_id, 'scn_probe'); assert.equal(r.schema, 'repair-result@1');
  assert.equal(rt.seen.length, 1); const input = rt.seen[0];
  assert.notEqual(input.store, E.store, 'a copy of the shared layers'); assert.equal(E.store.count('prk_mid'), countBefore); assert.deepEqual(E.store.rejected('prk_mid'), []); assert.equal(E.store.allowance('prk_mid'), 0);
  assert.deepEqual(input.store.rejected('prk_mid'), [E.candidate.artifact.nodes.props[0].candidate_sha256]); assert.equal(input.store.allowance('prk_mid'), 2); assert.equal(input.store.candidates('prk_mid').length, 0); assert.equal(input.store.candidates('plk_probe').length, 1);
  assert.equal(r.store, input.store, 'the accepted copy is handed back'); assert.deepEqual(input.policy, {}); assert.equal('budget' in input, false); assert.equal(input.scene_id, 'scn_probe'); assert.equal(input.ledger, E.run.ledger);
  assert.deepEqual(r.layer_diff.changed, ['COMPOSITE_BASE', 'COMPOSITE_STACK', 'PROP:lyr_mid', 'RENDER']); assert.deepEqual(r.layer_diff.added, []); assert.deepEqual(r.layer_diff.removed, []);
  assert.equal(r.product_identical, true); assert.equal(r.locked_copy_identical, true); assert.deepEqual(r.cost, { provider_calls: 1, spent_eur: 0.034, max_provider_calls: 2, regenerated_layers: 1 }); assert.equal(r.provider_calls, 1);
  assert.equal(r.before, E.candidate.artifact); assert.equal(r.after.nodes.props[0].candidate_sha256, 'f'.repeat(40)); assert.equal(r.candidate.status, 'READY_FOR_REVIEW'); assert.match(r.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(E.ledger.entries().map((e) => e.decision), ['REFINE_DEFECTS', 'REFINE_PLAN', 'REFINE_EXECUTION', 'REFINE_RESULT']);
  assert.deepEqual(E.ledger.entries().map((e) => e.decided_by), ['nordla:refine-planner@1', 'nordla:refine-planner@1', 'nordla:refine-executor@1', 'nordla:refine-executor@1']);
  assert.deepEqual(E.ledger.entries()[0].outcome.defects, [{ id: badMid().defect_id, kind: 'PROP_UNUSABLE', source: 'OWNER_REGION', node: 'lyr_mid' }]);
  assert.deepEqual(E.ledger.entries()[2].outcome, { scope: ['PROP_REPAIR'], steps: [{ scope: 'PROP_REPAIR', target: 'PROP:lyr_mid', action: 'REPLACE_WITH_A_NEW_CANDIDATE' }], invalidated: r.plan.invalidated, reused: r.plan.reused, max_provider_calls: 2 });
  assert.equal(E.ledger.entries()[3].outcome.status, 'REPAIRED'); assert.deepEqual(E.ledger.entries()[3].outcome.changed, r.layer_diff.changed); assert.equal(E.ledger.entries()[3].outcome.unchanged, r.layer_diff.unchanged.length);
  const m = memory.attempts('scn_probe'); assert.equal(m.length, 1); assert.deepEqual([m[0].outcome, m[0].reason, m[0].plan_id, m[0].fingerprint, m[0].scope], ['REPAIRED', null, r.plan.plan_id, r.plan.fingerprint, ['PROP_REPAIR']]);
  assert.deepEqual(m[0].steps, [{ scope: 'PROP_REPAIR', target: 'PROP:lyr_mid', action: 'REPLACE_WITH_A_NEW_CANDIDATE' }]); assert.equal(m[0].before, E.candidate.artifact.nodes.render.png_sha256); assert.equal(m[0].after, '9'.repeat(40));
  assert.deepEqual(r.memory.scenes.scn_probe.attempts.length, 1); assert.ok(Object.isFrozen(r));
});

test('EX-2 on a budget shared with the production the cost is the DIFFERENCE, and the runtime is given that budget', async () => {
  const E = env(); const budget = { snapshot: () => ({ provider_calls: 5, spent_eur: 0.2 }) };
  const rt = fake(E, { budget: { provider_calls: 6, spent_eur: 0.234 } });
  const r = await go(E, { runtime: rt, budget });
  assert.equal(rt.seen[0].budget, budget); assert.deepEqual(r.cost, { provider_calls: 1, spent_eur: 0.034, max_provider_calls: 2, regenerated_layers: 1 });
  const none = await go(env(), { runtime: fake(env(), { budget: null }) });
  assert.deepEqual(none.cost, { provider_calls: 0, spent_eur: 0, max_provider_calls: 2, regenerated_layers: 1 }, 'a runtime that reports no budget reports no spend');
});

test('EX-3 only a delivered candidate with a layered artifact of the same scene is repaired; the runtime is not even asked otherwise', async () => {
  for (const status of ['READY_FOR_REVIEW', 'PREFLIGHT_FAIL', 'FIDELITY_FAIL', 'GUARDIAN_FAIL']) { const E = env({ status }); const r = await go(E, { runtime: fake(E) }); assert.equal(r.status, 'REPAIRED', status); }
  const E = env(); const rt = fake(E);
  // no artifact (the run stopped before any image) and an invalid artifact are different refusals
  for (const [candidate, code] of [[{ status: 'BLOCKED', artifact: E.candidate.artifact }, REPAIR_BLOCK.ARTIFACT_INVALID], [{ status: 'READY_FOR_REVIEW' }, REPAIR_BLOCK.NO_ARTIFACT_TO_REPAIR], [{ status: 'READY_FOR_REVIEW', artifact: { schema: 'x' } }, REPAIR_BLOCK.ARTIFACT_INVALID], [null, REPAIR_BLOCK.NO_ARTIFACT_TO_REPAIR], [undefined, REPAIR_BLOCK.NO_ARTIFACT_TO_REPAIR], [{ artifact: E.candidate.artifact }, REPAIR_BLOCK.ARTIFACT_INVALID]]) {
    const r = await refineCreative({ candidate, defects: [badMid()], run: E.run, store: E.store, runtime: rt });
    assert.equal(r.status, 'BLOCKED'); assert.equal(r.block.code, code); assert.equal(r.plan, null); assert.equal(r.original_kept, true); assert.equal(r.block.replan, 'RUN_THE_SCENE_AGAIN');
  }
  const wrong = await go(E, { runtime: rt, run: { ...E.run, scene_id: 'another' } });
  assert.deepEqual([wrong.status, wrong.block.code, wrong.block.detail, wrong.scene_id], ['BLOCKED', REPAIR_BLOCK.SCENE_DOES_NOT_MATCH_THE_ARTIFACT, { artifact: 'scn_probe', run: 'another' }, 'another']);
  assert.equal(rt.seen.length, 0, 'the runtime was never asked');
  assert.equal(E.ledger.entries().length, 0, 'nothing was recorded for a request that is not a request');
});

test('EX-4 a plan that is blocked or needs a replan runs nothing and remembers nothing; the tool of the artifact is the tool of the repair', async () => {
  const E = env(); const rt = fake(E); const memory = createRefineMemory();
  const blocked = await go(E, { runtime: rt, memory, defects: [createDefectRegion({ kind: DEFECT_KIND.PRODUCT_PIXELS })] });
  assert.deepEqual([blocked.status, blocked.block.code, blocked.original_kept, blocked.plan.status], ['BLOCKED', REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS, true, 'BLOCKED']);
  const replan = await go(E, { runtime: rt, memory, defects: [createDefectRegion({ kind: DEFECT_KIND.UPSTREAM_LAYOUT })] });
  assert.deepEqual([replan.status, replan.replan.upstream_nodes, replan.original_kept], ['REPLAN_REQUIRED', ['ASSET_PLAN'], true]);
  const none = await go(E, { runtime: rt, memory, defects: [] }); assert.equal(none.block.code, REPAIR_BLOCK.NO_DEFECT);
  assert.equal(rt.seen.length, 0); assert.deepEqual(memory.attempts('scn_probe'), []);
  for (const e of [{ ...EXECUTES, PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/secondary' }, null, {}, { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary' }]) {
    const T = env({ run: { ports: { layers: e === null ? {} : { executes: e } } } }); const t = fake(T);
    const r = await go(T, { runtime: t });
    assert.equal(r.status, 'BLOCKED'); assert.equal(r.block.code, REPAIR_BLOCK.TOOL_SWITCH_REFUSED); assert.equal(r.tool_switch, true); assert.equal(r.original_kept, true); assert.deepEqual(r.block.detail, { before: EXECUTES, now: e }); assert.equal(t.seen.length, 0);
    assert.equal(T.ledger.entries().at(-1).decision, 'REFINE_RESULT'); assert.equal(T.ledger.entries().at(-1).outcome.reason, REPAIR_BLOCK.TOOL_SWITCH_REFUSED);
  }
  const ok = await go(E, { runtime: fake(E) }); assert.equal(ok.status, 'REPAIRED');
  const nullBefore = env(); nullBefore.candidate.artifact.tools.executed = null; const nb = await go(nullBefore, { runtime: fake(nullBefore) }); assert.equal(nb.block.code, REPAIR_BLOCK.TOOL_SWITCH_REFUSED, 'a port that now declares tools is not the port that produced');
});

test('EX-5 a repaired candidate that the layered gates refuse is not a repair: the original stays, the attempt is remembered', async () => {
  for (const [status, withArtifact] of [['BLOCKED', false], ['PREFLIGHT_FAIL', true], ['FIDELITY_FAIL', true], ['GUARDIAN_FAIL', true], ['READY_FOR_REVIEW', false]]) {
    const E = env(); const memory = createRefineMemory();
    const rt = fake(E, { status, artifact: withArtifact, extra: { reason: 'WHY', replan: 'REPLAN_THE_PROP_OR_DROP_IT', detail: { x: 1 } }, budget: { provider_calls: 2, spent_eur: 0.068 } });
    const r = await go(E, { runtime: rt, memory });
    assert.equal(r.status, 'NOT_REPAIRED', status); assert.equal(r.original_kept, true); assert.equal(r.block.code, REPAIR_BLOCK.REPAIRED_CANDIDATE_REFUSED);
    assert.deepEqual(r.block.detail, { status, reason: 'WHY', blocks: { x: 1 } }); assert.equal(r.block.replan, 'REPLAN_THE_PROP_OR_DROP_IT'); assert.deepEqual(r.cost, { provider_calls: 2, spent_eur: 0.068, max_provider_calls: 2, regenerated_layers: 1 }); assert.equal(r.provider_calls, 2);
    assert.equal(E.store.count('prk_mid'), 1, 'the original store is untouched'); assert.deepEqual(E.store.rejected('prk_mid'), []);
    const m = memory.attempts('scn_probe')[0]; assert.deepEqual([m.outcome, m.reason, m.cost.provider_calls], ['NOT_REPAIRED', REPAIR_BLOCK.REPAIRED_CANDIDATE_REFUSED, 2]); assert.equal(m.after, withArtifact ? '9'.repeat(40) : null, 'the render of the refused candidate, when there is one');
    assert.equal(E.ledger.entries().at(-1).outcome.status, 'NOT_REPAIRED'); assert.equal(E.ledger.entries().at(-1).outcome.run_status, status);
  }
  const bare = env(); const rb = await go(bare, { runtime: fake(bare, { status: 'BLOCKED', artifact: false }) });
  assert.equal(rb.block.detail.reason, null); assert.equal(rb.block.detail.blocks, null); assert.equal(rb.block.replan, 'REPLAN_THE_SCENE');
});

test('EX-6 a repair is checked against its plan: any change outside it, to the product or to the locked text, or more calls than the allowance, is rejected and the original kept', async () => {
  const cases = [
    ['the plate changed', (a) => { newProp(a); a.nodes.plate.candidate_sha256 = '1'.repeat(40); return a; }, { provider_calls: 1 }, ['PLATE:plk_probe'], true, true],
    ['another prop changed', (a) => { newProp(a); a.nodes.props[1].placed_sha256 = '1'.repeat(40); return a; }, { provider_calls: 1 }, ['PROP:lyr_fg'], true, true],
    ['the product changed', (a) => { newProp(a); a.nodes.product.cutout_sha256 = '1'.repeat(40); return a; }, { provider_calls: 1 }, ['PRODUCT'], false, true],
    ['the product moved', (a) => { newProp(a); a.nodes.product.rect.x += 1; return a; }, { provider_calls: 1 }, ['PRODUCT'], false, true],
    ['the locked text changed', (a) => { newProp(a); a.nodes.text[0].text_sha256 = '1'.repeat(40); return a; }, { provider_calls: 1 }, ['TEXT:HEADLINE'], true, false],
    ['the locked text moved', (a) => { newProp(a); a.nodes.text[0].geometry.y += 1; return a; }, { provider_calls: 1 }, ['TEXT:HEADLINE'], true, false],
    ['a layer appeared', (a) => { newProp(a); a.nodes.props.push({ ...a.nodes.props[0], node_id: 'PROP:lyr_new', layer_id: 'lyr_new' }); return a; }, { provider_calls: 1 }, ['PROP:lyr_new'], true, true],
    ['a layer disappeared that the plan kept', (a) => { newProp(a); a.nodes.props.pop(); return a; }, { provider_calls: 1 }, ['PROP:lyr_fg'], true, true],
    ['more calls than the allowance', newProp, { provider_calls: 3 }, [], true, true],
  ];
  for (const [name, edit, b, outside, productIdentical, textIdentical] of cases) {
    const E = env(); const memory = createRefineMemory();
    const r = await go(E, { runtime: fake(E, { edit, budget: { provider_calls: b.provider_calls, spent_eur: 0.1 } }), memory });
    assert.equal(r.status, 'BLOCKED', name); assert.equal(r.block.code, REPAIR_BLOCK.REPAIR_OUTSIDE_ITS_SCOPE, name); assert.equal(r.original_kept, true, name);
    assert.deepEqual(r.block.detail, { outside, product_identical: productIdentical, locked_copy_identical: textIdentical, provider_calls: b.provider_calls, max_provider_calls: 2 }, name); assert.equal(r.block.replan, 'REPLAN_THE_SCENE');
    assert.equal(memory.attempts('scn_probe')[0].outcome, 'REJECTED', name); assert.equal(E.ledger.entries().at(-1).outcome.status, 'REJECTED'); assert.equal(r.cost.provider_calls, b.provider_calls);
  }
  const exact = env(); const ok = await go(exact, { runtime: fake(exact, { budget: { provider_calls: 2, spent_eur: 0.068 } }) });
  assert.equal(ok.status, 'REPAIRED', 'exactly the allowance is allowed'); assert.equal(ok.cost.provider_calls, 2);
});

test('EX-7 a repair that changed nothing did nothing; a layer that leaves with its own repair is a repair', async () => {
  const E = env(); const memory = createRefineMemory();
  const r = await go(E, { runtime: fake(E, { edit: (a) => a }), memory });
  assert.deepEqual([r.status, r.block.code, r.block.detail, r.block.replan, r.original_kept], ['NOT_REPAIRED', REPAIR_BLOCK.REPAIR_HAD_NO_EFFECT, { changed: [] }, 'REPLAN_THE_SCENE', true]);
  assert.deepEqual([memory.attempts('scn_probe')[0].outcome, memory.attempts('scn_probe')[0].reason], ['NOT_REPAIRED', REPAIR_BLOCK.REPAIR_HAD_NO_EFFECT]);
  // a repair that changed ONE node (the render) is a repair
  const one = env(); const single = await go(one, { runtime: fake(one, { edit: (a) => { a.nodes.render.png_sha256 = '9'.repeat(40); return a; }, budget: { provider_calls: 1, spent_eur: 0.034 } }) });
  assert.equal(single.status, 'REPAIRED'); assert.deepEqual(single.layer_diff.changed, ['RENDER']);
  // removing the prop is what a REMOVE plan asks for
  const ladder = createRefineMemory();
  for (let i = 0; i < 2; i += 1) ladder.record('scn_probe', { plan_id: `p${i}`, fingerprint: `f${i}`, outcome: 'NOT_REPAIRED', steps: [{ scope: 'LAYER_REMOVE_OR_REPOSITION', target: 'PROP:lyr_mid', action: 'REPOSITION' }] });
  const rm = env(); const rt = fake(rm, { budget: { provider_calls: 0, spent_eur: 0 }, edit: (a) => { a.nodes.props.shift(); a.nodes.composite.base_sha256 = 'd'.repeat(40); a.nodes.composite.stack_sha256 = 'e'.repeat(40); a.nodes.render.png_sha256 = '9'.repeat(40); return a; } });
  const removed = await refineCreative({ candidate: rm.candidate, defects: [createDefectRegion({ kind: DEFECT_KIND.PROP_NO_ROOM, layer_id: 'lyr_mid' })], run: rm.run, store: rm.store, memory: ladder, runtime: rt });
  assert.equal(removed.status, 'REPAIRED'); assert.deepEqual(removed.layer_diff.removed, ['PROP:lyr_mid']); assert.deepEqual(rt.seen[0].policy, { drop_layers: ['lyr_mid'] }); assert.equal(removed.cost.provider_calls, 0); assert.equal(rt.seen[0].store.rejected('prk_mid').length, 0);
});

test('EX-8 the policy given to the runtime is the original policy with the overrides of the plan merged in; the allowed scopes and the gate findings are honoured', async () => {
  assert.deepEqual(mergePolicy(), {}); assert.deepEqual(mergePolicy({ a: 1 }), { a: 1 }); assert.deepEqual(mergePolicy(undefined, { b: 2 }), { b: 2 });
  assert.deepEqual(mergePolicy({ drop_layers: ['b'] }, { anchors: { y: 2 } }), { drop_layers: ['b'], anchors: { y: 2 } }, 'a key on one side only is kept as it is');
  assert.deepEqual(mergePolicy({ drop_layers: ['b', 'a'], anchors: { x: 1 }, placement: { m: 1, n: 2 }, typography: { p: 1 }, keep: true }, { drop_layers: ['c', 'a'], anchors: { y: 2 }, placement: { n: 9 }, typography: { q: 2 } }),
    { drop_layers: ['a', 'b', 'c'], anchors: { x: 1, y: 2 }, placement: { m: 1, n: 9 }, typography: { p: 1, q: 2 }, keep: true });
  assert.deepEqual(mergePolicy({ placement: { m: 1 } }, {}), { placement: { m: 1 } }); assert.deepEqual(mergePolicy({}, { anchors: { y: 2 } }), { anchors: { y: 2 } }); assert.deepEqual(mergePolicy({ drop_layers: ['z'] }, {}), { drop_layers: ['z'] });
  const E = env({ run: { policy: { placement: { foreground_inset: 0.8 }, typography: { other: true } } } }); const rt = fake(E, { budget: { provider_calls: 0, spent_eur: 0 }, edit: (a) => { a.nodes.text_style[0].plate = true; a.nodes.text_style[0].style_sha256 = '7'.repeat(40); a.nodes.render.png_sha256 = '9'.repeat(40); return a; } });
  const t = await go(E, { runtime: rt, defects: [createDefectRegion({ kind: DEFECT_KIND.TEXT_ILLEGIBLE })] });
  assert.equal(t.status, 'REPAIRED'); assert.deepEqual(rt.seen[0].policy, { placement: { foreground_inset: 0.8 }, typography: { other: true, plate_behind_text: true } }); assert.deepEqual(t.layer_diff.changed, ['RENDER', 'TEXT_STYLE:HEADLINE']);
  const scoped = env(); const r = await go(scoped, { runtime: fake(scoped), allowedScopes: ['PLATE_REPAIR'] }); assert.equal(r.block.code, REPAIR_BLOCK.REPAIR_SCOPE_INVALID);
  // without defects the findings of the gates of the candidate are used
  const gated = env({ status: 'PREFLIGHT_FAIL' }); gated.candidate.preflight = { checks: [{ code: 'INSUFFICIENT_CONTRAST', status: 'FAIL' }] };
  const g = await refineCreative({ candidate: gated.candidate, run: gated.run, store: gated.store, runtime: fake(gated, { edit: (a) => { a.nodes.text_style[0].plate = true; a.nodes.text_style[0].style_sha256 = '7'.repeat(40); a.nodes.render.png_sha256 = '9'.repeat(40); return a; }, budget: { provider_calls: 0, spent_eur: 0 } }) });
  assert.equal(g.status, 'REPAIRED'); assert.deepEqual(g.plan.scope, ['TYPOGRAPHY_REPAIR']); assert.equal(g.plan.defects[0].source, 'GATE');
  const quiet = env(); assert.equal((await refineCreative({ candidate: quiet.candidate, run: quiet.run, store: quiet.store, runtime: fake(quiet) })).block.code, REPAIR_BLOCK.NO_DEFECT);
  // the pricing the plan shows is the price list of the production
  const priced = env(); const p = await go(priced, { runtime: fake(priced) }); assert.deepEqual(p.plan.cost.lines, [{ request_key: 'prk_mid', max_candidates: 2, unit_eur: 0.034, max_eur: 0.068 }]);
  const plate = env(); const pl = await go(plate, { runtime: fake(plate, { edit: (a) => { a.nodes.plate.candidate_sha256 = '1'.repeat(40); a.nodes.composite.base_sha256 = 'd'.repeat(40); a.nodes.composite.stack_sha256 = 'e'.repeat(40); a.nodes.render.png_sha256 = '9'.repeat(40); return a; } }), defects: [createDefectRegion({ kind: DEFECT_KIND.PLATE_UNSUITABLE })] });
  assert.equal(pl.plan.cost.lines[0].unit_eur, 0.069); assert.equal(pl.status, 'REPAIRED');
});

test('EX-9 the digest of a node, and the difference between two artifacts, ignore the upstream and report added, removed, changed and unchanged', () => {
  const a = refineSample(); const d = nodeDigests(a);
  assert.ok(!('CONCEPT' in d) && !('ART_DIRECTION' in d)); assert.equal(Object.keys(d).length, 9); assert.equal(nodeDigests({}), null); assert.equal(nodeDigests(null), null);
  const b = refineSample(); b.nodes.props.pop(); b.nodes.props[0].box.x += 1; b.nodes.text.push({ node_id: 'TEXT:BODY', role: 'BODY', layer_id: 'l', text_sha256: 'a'.repeat(40), geometry: { x: 0, y: 0, width: 1, height: 1 } });
  b.nodes.text_style.push({ node_id: 'TEXT_STYLE:BODY', role: 'BODY', color: '#000', font_size: 1, plate: false, style_sha256: 'b'.repeat(40) });
  const diff = diffArtifacts(a, b);
  assert.deepEqual(diff.removed, ['PROP:lyr_fg']); assert.deepEqual(diff.added, ['TEXT:BODY', 'TEXT_STYLE:BODY']); assert.deepEqual(diff.changed, ['PROP:lyr_mid']);
  assert.ok(!diff.unchanged.includes('PROP:lyr_fg') && !diff.unchanged.includes('TEXT:BODY') && !diff.unchanged.includes('PROP:lyr_mid'), 'a removed, an added and a changed node are never unchanged');
  assert.deepEqual(diff.unchanged, Object.keys(nodeDigests(a)).filter((id) => !['PROP:lyr_mid', 'PROP:lyr_fg'].includes(id)).sort());
  assert.ok(diff.unchanged.includes('PRODUCT') && diff.unchanged.includes('PLATE:plk_probe')); assert.deepEqual(diffArtifacts(a, a), { changed: [], added: [], removed: [], unchanged: Object.keys(d).sort() });
  assert.equal(diffArtifacts(a, {}), null); assert.equal(diffArtifacts({}, a), null);
});

test('EX-9 a candidate whose hard fidelity gate could not be MEASURED is repaired only when the caller accepts it, and its rerun is judged on the same footing', async () => {
  const unmeasured = (E, over = {}) => ({ ...E.candidate, status: 'BLOCKED', fidelity: { gate: 'NOT_MEASURABLE' }, png_bytes: bytesOf(7), ...over });
  const rerunUnmeasured = { status: 'BLOCKED', extra: { fidelity: { gate: 'NOT_MEASURABLE' }, png_bytes: bytesOf(8) } };
  // the strict default: its own refusal, the runtime is not even asked, nothing remembered
  const E1 = env(); const rt1 = fake(E1, rerunUnmeasured); const memory1 = createRefineMemory();
  const refused = await refineCreative({ candidate: unmeasured(E1), defects: [badMid()], run: E1.run, store: E1.store, runtime: rt1, memory: memory1 });
  assert.deepEqual([refused.status, refused.block.code, refused.plan, refused.original_kept], ['BLOCKED', REPAIR_BLOCK.FIDELITY_NOT_MEASURABLE, null, true]); assert.equal(rt1.seen.length, 0); assert.equal(memory1.attempts('scn_probe').length, 0);
  // accepted by the caller: repaired, the product and the locked copy proven unchanged by the diff
  const E2 = env(); const ok = await refineCreative({ candidate: unmeasured(E2), defects: [badMid()], run: E2.run, store: E2.store, runtime: fake(E2, rerunUnmeasured), allowUnmeasurableIdentity: true });
  assert.equal(ok.status, 'REPAIRED'); assert.equal(ok.product_identical, true); assert.equal(ok.locked_copy_identical, true); assert.equal(ok.candidate.status, 'BLOCKED');
  // the rerun must be on the SAME footing: a rerun refused for another reason (guardian missing, fidelity measured and not passed) is not a repair
  for (const [name, extra] of [['guardian missing', { fidelity: { gate: 'PASS' }, png_bytes: bytesOf(8), reason: 'BRAND_GUARDIAN_NOT_CONFIGURED' }], ['no image', { fidelity: { gate: 'NOT_MEASURABLE' } }]]) {
    const E = env(); const r = await refineCreative({ candidate: unmeasured(E), defects: [badMid()], run: E.run, store: E.store, runtime: fake(E, { status: 'BLOCKED', extra }), allowUnmeasurableIdentity: true });
    assert.equal(r.status, 'NOT_REPAIRED', name); assert.equal(r.block.code, REPAIR_BLOCK.REPAIRED_CANDIDATE_REFUSED);
  }
  // an unmeasured rerun is never accepted for a candidate that WAS measured, whatever the caller said, nor without the caller's acceptance
  for (const allow of [true, false]) {
    const E = env(); const r = await refineCreative({ candidate: E.candidate, defects: [badMid()], run: E.run, store: E.store, runtime: fake(E, rerunUnmeasured), allowUnmeasurableIdentity: allow });
    assert.equal(r.status, 'NOT_REPAIRED', `allow=${allow}`); assert.equal(r.block.code, REPAIR_BLOCK.REPAIRED_CANDIDATE_REFUSED);
  }
  // a measured rerun (READY) of an unmeasured candidate is accepted as before
  const E3 = env(); assert.equal((await refineCreative({ candidate: unmeasured(E3), defects: [badMid()], run: E3.run, store: E3.store, runtime: fake(E3), allowUnmeasurableIdentity: true })).status, 'REPAIRED');
});
