import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { decodePng } from '../src/creative-intelligence/png-pixels.js';
import { runLayeredCreative } from '../src/creative-runtime/index.js';
import {
  attributeDefect, buildLayerDependencyMap, createDefectRegion, createRefineMemory, DEFECT_KIND, defectsFromCandidate, defectsFromRevisionIntents, DefectError, describeMaskedEditCapability, diffArtifacts, MASKED_EDIT,
  planRepair, REFINE_POLICY, refineCreative, REPAIR_BLOCK, REPAIR_SCOPE, requestMaskedEdit, validateMaskedEditRequest,
} from '../src/creative-refine/index.js';
import {
  createLayerBudget, createLayerStore, firstRun, FOREGROUND_SCENE, HEADLINE_SCENE, layeredHarness, scriptedPort, WORLD,
} from './creative-refine-world.js';

// THE EXECUTABLE REFINE (`// RF-N`). A layered scene is produced once; a local defect is then repaired by the SMALLEST scope that answers it. Every test runs the real layered runtime (real gates, compositor, typography) behind a
// fake layer port that records every call. No provider, no network, no cost.

// RF_SCENARIOS (a comma list of B, A_PROP, A_PLATE, A_TYPE, B_FG) builds only the scenarios a run needs: a mutation sweep runs a few tests at a time. Unset: every scenario (the normal run).
const WANT = process.env.RF_SCENARIOS === undefined ? null : new Set(process.env.RF_SCENARIOS.split(',').filter(Boolean));
const want = (name) => WANT === null || WANT.has(name);
const A = await firstRun(); // the headline scene: plate + background prop + the real product + text
const B = want('B') || want('B_FG') ? await firstRun({ index: FOREGROUND_SCENE, foreground: true }) : null; // plate + background prop + the real product + a bounded foreground prop + text
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const prop = (S, kind = null) => S.candidate.artifact.nodes.props.find((p) => !kind || p.kind === kind);
const callsOf = (S) => S.port.calls.map((c) => `${c.kind}#${c.candidate_index}`);
const badProp = (S, kind) => createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: prop(S, kind).layer_id });
const doRefine = (S, defects, o = {}) => refineCreative({ candidate: S.candidate, defects, run: S.run, store: S.store, ...o });
const before = (S) => callsOf(S).length;
const sha16 = (x) => x.slice(0, 16);

assert.equal(A.candidate.status, 'READY_FOR_REVIEW', JSON.stringify([A.candidate.reason, A.candidate.fidelity?.failed]));
if (B) assert.equal(B.candidate.status, 'READY_FOR_REVIEW', JSON.stringify([B.candidate.reason, B.candidate.fidelity?.failed]));

const aCalls0 = before(A);
const A_PROP = want('A_PROP') ? await doRefine(A, [badProp(A)]) : null;
const aCalls1 = before(A);
const A_PLATE = want('A_PLATE') ? await doRefine(A, [createDefectRegion({ kind: DEFECT_KIND.PLATE_UNSUITABLE })]) : null;
const aCalls2 = before(A);
const A_TYPE = want('A_TYPE') ? await doRefine(A, [createDefectRegion({ kind: DEFECT_KIND.TEXT_ILLEGIBLE })]) : null;
const aCalls3 = before(A);
const B_FG = want('B_FG') ? await doRefine(B, [badProp(B, 'PROP_FOREGROUND')]) : null;

test('RF-1 one bad prop changes only that prop layer (and what is composed from it): one new candidate of that prop, nothing else is generated', () => {
  const r = A_PROP;
  assert.equal(r.status, 'REPAIRED', JSON.stringify([r.block, r.plan?.block]));
  assert.deepEqual(r.plan.scope, [REPAIR_SCOPE.PROP_REPAIR]);
  const p = prop(A);
  assert.deepEqual(r.layer_diff.changed, [...new Set(['COMPOSITE_BASE', 'COMPOSITE_STACK', p.node_id, 'RENDER'])].sort());
  assert.deepEqual(r.layer_diff.added, []); assert.deepEqual(r.layer_diff.removed, []);
  assert.deepEqual(callsOf(A).slice(aCalls0, aCalls1), ['PROP#2'], 'only the prop is asked for again, with the tool of the specification');
  assert.notEqual(r.after.nodes.props[0].candidate_sha256, p.candidate_sha256); assert.equal(r.after.nodes.props[0].layer_id, p.layer_id);
  assert.equal(r.candidate.status, 'READY_FOR_REVIEW'); assert.equal(r.candidate.fidelity.gate, 'PASS'); assert.equal(r.candidate.guardian.outcome, 'PASS');
  assert.equal(r.fallback_to_full_regeneration, false); assert.equal(r.original_kept, false);
});

test('RF-2 every unaffected layer keeps its hash, the plate, the other prop and the part of the stack below the product included (a foreground prop does not touch the base)', () => {
  const r = A_PROP;
  assert.deepEqual(r.after.nodes.plate, A.candidate.artifact.nodes.plate);
  assert.ok(r.layer_diff.unchanged.includes(A.candidate.artifact.nodes.plate.node_id));
  const fg = B_FG;
  assert.equal(fg.status, 'REPAIRED', JSON.stringify([fg.block, fg.plan?.block]));
  const bgBefore = prop(B, 'PROP_BACKGROUND'); const fgBefore = prop(B, 'PROP_FOREGROUND');
  assert.deepEqual(fg.after.nodes.props.find((p) => p.kind === 'PROP_BACKGROUND'), bgBefore, 'the other prop is identical, box and hashes');
  assert.deepEqual(fg.after.nodes.plate, B.candidate.artifact.nodes.plate);
  assert.equal(fg.after.nodes.composite.base_sha256, B.candidate.artifact.nodes.composite.base_sha256, 'a foreground prop is drawn above the product: the base under it is unchanged');
  assert.notEqual(fg.after.nodes.composite.stack_sha256, B.candidate.artifact.nodes.composite.stack_sha256);
  assert.notEqual(fg.after.nodes.props.find((p) => p.kind === 'PROP_FOREGROUND').candidate_sha256, fgBefore.candidate_sha256);
  assert.deepEqual(fg.layer_diff.changed.sort(), ['COMPOSITE_STACK', fgBefore.node_id, 'RENDER'].sort());
  assert.deepEqual(callsOf(B).slice(-1), ['PROP#2'], 'the foreground prop is asked for again; the plate and the other prop are not');
});

test('RF-3 the product hash is identical: the same cut-out, the same placement, the same pixels in the delivered image', () => {
  for (const r of [A_PROP, A_PLATE, A_TYPE, B_FG]) {
    assert.equal(r.status, 'REPAIRED'); assert.equal(r.product_identical, true);
    assert.deepEqual(r.after.nodes.product, r.before.nodes.product);
    assert.equal(r.candidate.fidelity.gate, 'PASS'); assert.equal(r.candidate.composition.product_pixels_changed, 0);
  }
  const old = decodePng(A.candidate.png_bytes); const now = decodePng(A_PROP.candidate.png_bytes);
  const rect = A.candidate.artifact.nodes.product.rect; let compared = 0;
  const texts = A.candidate.artifact.nodes.text.map((t) => t.geometry);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (texts.some((g) => x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height)) continue;
      const i = (y * old.width + x) * 4;
      if (old.pixels[i + 3] === 255 && old.pixels[i] === now.pixels[i] && old.pixels[i + 1] === now.pixels[i + 1] && old.pixels[i + 2] === now.pixels[i + 2]) compared += 1;
    }
  }
  assert.ok(compared > 1000, 'a large part of the real product is pixel-identical in the repaired image');
  assert.equal(A_PROP.candidate.png_sha256 === A.candidate.png_sha256, false, 'the image itself did change (the new prop)');
});

test('RF-4 locked copy stays exact in every repair: the same text nodes, the same planned digests, none redrawn', () => {
  const planned = WORLD.result.scenes[HEADLINE_SCENE].text_layers.map((t) => [t.role, t.text_sha256]);
  for (const r of [A_PROP, A_PLATE, A_TYPE]) {
    assert.equal(r.locked_copy_identical, true); assert.deepEqual(r.after.nodes.text, A.candidate.artifact.nodes.text);
    assert.deepEqual(r.after.nodes.text.map((t) => [t.role, t.text_sha256]), planned);
    assert.ok(r.candidate.text.every((e) => e.exact), 'the delivered text is the planned text, byte for byte');
  }
  assert.equal(B_FG.locked_copy_identical, true);
});

test('RF-5 a typography-only defect redraws only the text style: no provider call, no layer, no composite changes', () => {
  const r = A_TYPE;
  assert.equal(r.status, 'REPAIRED', JSON.stringify([r.block, r.plan?.block]));
  assert.deepEqual(r.plan.scope, [REPAIR_SCOPE.TYPOGRAPHY_REPAIR]);
  assert.equal(aCalls3 - aCalls2, 0); assert.equal(r.cost.provider_calls, 0); assert.equal(r.cost.spent_eur, 0);
  assert.deepEqual(r.layer_diff.changed, ['RENDER', 'TEXT_STYLE:HEADLINE']);
  for (const id of [A.candidate.artifact.nodes.plate.node_id, prop(A).node_id, 'PRODUCT', 'TEXT:HEADLINE', 'COMPOSITE_BASE', 'COMPOSITE_STACK']) assert.ok(r.layer_diff.unchanged.includes(id), id);
  assert.equal(A.candidate.artifact.nodes.text_style[0].plate, false); assert.equal(r.after.nodes.text_style[0].plate, true, 'a brand plate now sits behind the text');
  assert.deepEqual(r.after.nodes.composite, A.candidate.artifact.nodes.composite);
  assert.ok(r.plan.invalidated.every((id) => !id.startsWith('PROP') && !id.startsWith('PLATE') && id !== 'PRODUCT' && !id.startsWith('COMPOSITE')));
});

test('RF-6 a plate-only defect rebuilds only the plate: the product and the props are untouched', () => {
  const r = A_PLATE;
  assert.equal(r.status, 'REPAIRED', JSON.stringify([r.block, r.plan?.block]));
  assert.deepEqual(r.plan.scope, [REPAIR_SCOPE.PLATE_REPAIR]);
  assert.deepEqual(callsOf(A).slice(aCalls1, aCalls2), ['PLATE#2']);
  assert.notEqual(r.after.nodes.plate.candidate_sha256, A.candidate.artifact.nodes.plate.candidate_sha256);
  assert.deepEqual(r.after.nodes.props, A.candidate.artifact.nodes.props, 'the props are identical, boxes included');
  assert.deepEqual(r.after.nodes.product, A.candidate.artifact.nodes.product);
  assert.ok(r.layer_diff.changed.includes(A.candidate.artifact.nodes.plate.node_id) && !r.layer_diff.changed.includes(prop(A).node_id));
  assert.ok(r.plan.reused.includes(prop(A).node_id) && r.plan.reused.includes('PRODUCT') && r.plan.reused.includes('TEXT:HEADLINE'));
});

test('RF-7 a repair that touches the protected product pixels fails closed: nothing is run, nothing is paid, the original is kept', async () => {
  const rect = A.candidate.artifact.nodes.product.rect; const calls = before(A); const count = A.store.count(prop(A).request_key);
  const onProduct = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, region: { x: rect.x + rect.width / 2 - 5, y: rect.y + rect.height / 2 - 5, width: 10, height: 10 } });
  for (const [defect, code] of [
    [onProduct, REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS],
    [createDefectRegion({ kind: DEFECT_KIND.PRODUCT_PIXELS }), REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS],
    [createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, node_id: 'PRODUCT' }), REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS],
    [createDefectRegion({ kind: DEFECT_KIND.COPY_CHANGE }), REPAIR_BLOCK.REPAIR_WOULD_CHANGE_LOCKED_COPY],
    [createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, node_id: 'TEXT:HEADLINE' }), REPAIR_BLOCK.REPAIR_WOULD_CHANGE_LOCKED_COPY],
  ]) {
    const r = await doRefine(A, [defect]);
    assert.equal(r.status, 'BLOCKED'); assert.equal(r.block.code, code); assert.equal(r.original_kept, true); assert.equal(r.fallback_to_full_regeneration, false);
    assert.ok(r.block.replan, 'a refusal names what to do instead');
  }
  assert.equal(before(A), calls, 'zero provider calls'); assert.equal(A.store.count(prop(A).request_key), count, 'the shared layers were not touched');
  assert.deepEqual(A.store.rejected(prop(A).request_key), []);
});

test('RF-8 an invalid repair scope fails closed: a scope that does not exist (a full regeneration), a scope that does not answer the defect, an unknown defect, no defect, a stale or foreign artifact', async () => {
  const defect = badProp(A); const art = A.candidate.artifact;
  assert.equal((await doRefine(A, [defect], { allowedScopes: ['FULL_REGENERATION'] })).block.code, REPAIR_BLOCK.REPAIR_SCOPE_INVALID);
  assert.equal((await doRefine(A, [defect], { allowedScopes: [REPAIR_SCOPE.PLATE_REPAIR] })).block.code, REPAIR_BLOCK.REPAIR_SCOPE_INVALID);
  assert.equal(planRepair({ artifact: art, defects: [defect], allowedScopes: [REPAIR_SCOPE.PROP_REPAIR] }).status, 'PLANNED');
  assert.throws(() => createDefectRegion({ kind: 'REGENERATE_EVERYTHING' }), DefectError);
  assert.throws(() => createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, region: { x: 0, y: 0, width: 0, height: 5 } }), DefectError);
  assert.throws(() => createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, severity: 'FATAL' }), DefectError);
  assert.equal(planRepair({ artifact: art, defects: [] }).block.code, REPAIR_BLOCK.NO_DEFECT);
  assert.equal(planRepair({ artifact: { schema: 'x' }, defects: [defect] }).block.code, REPAIR_BLOCK.ARTIFACT_INVALID);
  assert.equal(planRepair({ artifact: art, defects: [defect], expectedArtifactDigest: 'stale' }).block.code, REPAIR_BLOCK.ARTIFACT_STALE);
  assert.equal((await doRefine(A, [defect], {})).status, 'REPAIRED');
  const blockedRun = await refineCreative({ candidate: { status: 'BLOCKED', reason: 'X' }, defects: [defect], run: A.run, store: A.store });
  assert.equal(blockedRun.block.code, REPAIR_BLOCK.ARTIFACT_INVALID);
  assert.equal((await refineCreative({ candidate: A.candidate, defects: [defect], run: { ...A.run, scene_id: 'other' }, store: A.store })).block.code, REPAIR_BLOCK.SCENE_DOES_NOT_MATCH_THE_ARTIFACT);
  assert.equal(createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: 'nope' }).kind, DEFECT_KIND.PROP_UNUSABLE);
  assert.equal(planRepair({ artifact: art, defects: [createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: 'nope' })] }).block.code, REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE);
});

test('RF-9 the repair costs only the repaired work: one candidate of one layer, at the unit cost of that layer, and nothing for a deterministic repair', () => {
  const unit = WORLD.result.production.budget.unit_costs.image_eur_by_size_class;
  assert.equal(A_PROP.cost.provider_calls, 1); assert.equal(A_PROP.cost.spent_eur, unit.UP_TO_1024); assert.equal(A_PROP.cost.regenerated_layers, 1);
  assert.equal(A_PLATE.cost.provider_calls, 1); assert.equal(A_PLATE.cost.spent_eur, unit.ABOVE_1024);
  assert.equal(A_TYPE.cost.provider_calls, 0); assert.equal(A_TYPE.cost.spent_eur, 0);
  assert.equal(A_PROP.plan.cost.max_provider_calls, REFINE_POLICY.repair_candidates_per_layer);
  assert.deepEqual(A_PROP.plan.cost.lines.map((l) => l.request_key), [prop(A).request_key], 'the only priced line is the repaired layer');
  assert.equal(A_PROP.plan.cost.lines[0].unit_eur, unit.UP_TO_1024);
  assert.ok(A_PROP.cost.spent_eur < A.candidate.budget.spent_eur, 'less than producing the scene once');
  assert.equal(A_PROP.plan.cost.only_the_repaired_work, true);
});

test('RF-9b on a budget shared with the production the repair adds exactly its own spend, and a repair that would pass the ceiling is refused before any provider call', async () => {
  const S = await firstRun({ withBudget: true });
  const spentBefore = S.budget.snapshot().spent_eur; const callsBefore = S.budget.snapshot().provider_calls;
  const r = await doRefine(S, [badProp(S)], { budget: S.budget });
  assert.equal(r.status, 'REPAIRED');
  assert.equal(Math.round((S.budget.snapshot().spent_eur - spentBefore) * 1e9) / 1e9, r.cost.spent_eur); assert.equal(S.budget.snapshot().provider_calls - callsBefore, r.cost.provider_calls);
  const poor = await firstRun({ withBudget: false });
  const tiny = createLayerBudget({ production: WORLD.result });
  tiny.budget.reserve('FILL_THE_CEILING', tiny.budget.ceiling_eur - tiny.budget.reserved_eur() - 0.01);
  const calls = poor.port.calls.length;
  const refused = await doRefine(poor, [badProp(poor)], { budget: tiny });
  assert.notEqual(refused.status, 'REPAIRED'); assert.equal(poor.port.calls.length, calls, 'no provider call past the ceiling'); assert.equal(refused.original_kept, true);
});

test('RF-10 resume after a repair equals a clean deterministic build: the saved working state, replayed from scratch with no provider, gives the same delivered image', async () => {
  const r = A_PROP;
  const saved = JSON.parse(JSON.stringify(r.store.export())); // the working state, as plain JSON (what a later resilience layer persists)
  const silent = scriptedPort(); const h = layeredHarness({ layerPort: silent });
  const replay = await runLayeredCreative({ ...A.run, agents: h.agents, ports: h.ports, ledger: h.ledger, store: createLayerStore(saved) });
  assert.equal(replay.status, 'READY_FOR_REVIEW'); assert.equal(silent.calls.length, 0, 'nothing is paid for: every layer comes from the saved state');
  assert.equal(replay.png_sha256, r.candidate.png_sha256); assert.deepEqual(replay.artifact.nodes, r.after.nodes);
  // a clean store that holds only the layers the repaired candidate is made of gives the same image as well
  const clean = createLayerStore(); const cand = r.store.candidates(prop(A).request_key); const plate = r.store.candidates(A.candidate.artifact.nodes.plate.request_key);
  for (const c of plate) clean.add(A.candidate.artifact.nodes.plate.request_key, c);
  clean.add(prop(A).request_key, cand.at(-1));
  const silent2 = scriptedPort(); const h2 = layeredHarness({ layerPort: silent2 });
  const fresh = await runLayeredCreative({ ...A.run, agents: h2.agents, ports: h2.ports, ledger: h2.ledger, store: clean });
  assert.equal(fresh.png_sha256, r.candidate.png_sha256); assert.equal(silent2.calls.length, 0);
  // without the rejection the old candidate would simply be chosen again: the working state is what makes the repair stick
  assert.deepEqual(r.store.rejected(prop(A).request_key), [prop(A).candidate_sha256]);
  assert.ok(sha16(r.store.rejected(prop(A).request_key)[0]).length === 16);
  assert.equal(createLayerStore(saved).candidates(prop(A).request_key).length, 1);
  assert.equal(saved.schema, 'layer-store@1');
});

test('RF-11 no provider or tool switch happens silently: the repair runs with the tool of the specification, and a different tool is refused before any call', async () => {
  assert.deepEqual([...new Set(A.port.calls.map((c) => c.kind))].sort(), ['PLATE', 'PROP']);
  assert.ok(A.port.calls.every((c) => c.input_asset_refs.length === 0 && c.carries_input_asset === false), 'no product pixel ever leaves for a generator, in a repair either');
  const selected = A.candidate.artifact.tools.selected.map((t) => t.tool_id);
  assert.ok(selected.includes('text-to-image/primary'));
  assert.deepEqual(A.candidate.artifact.tools.executed, { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary', PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/primary' });
  const other = scriptedPort({ executes: { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary', PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/secondary' } });
  const h = layeredHarness({ layerPort: other });
  const calls = other.calls.length;
  const r = await refineCreative({ candidate: A.candidate, defects: [badProp(A)], run: { ...A.run, agents: h.agents, ports: h.ports, ledger: h.ledger }, store: A.store });
  assert.equal(r.status, 'BLOCKED'); assert.equal(r.block.code, REPAIR_BLOCK.TOOL_SWITCH_REFUSED); assert.equal(r.tool_switch, true); assert.equal(other.calls.length, calls);
  assert.deepEqual(r.block.detail.now, { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary', PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/secondary' });
  assert.ok(h.ledger.of('REFINE_RESULT').some((e) => e.outcome.reason === REPAIR_BLOCK.TOOL_SWITCH_REFUSED));
});

test('RF-12 the legacy single-image path is unchanged: its source is byte for byte the Phase 3 file, and the refine knows nothing of it and cannot fall back to it', () => {
  const legacy = readFileSync(new URL('../src/creative-runtime/runtime.js', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(legacy.replace(/\r\n/g, '\n')).digest('hex').slice(0, 40), '3fba9a734799299992540f3f846520da5018d55e');
  for (const f of ['refine', 'planner', 'defects', 'dependency-map', 'memory', 'masked-edit', 'constants', 'index']) {
    const src = readFileSync(new URL(`../src/creative-refine/${f}.js`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/runProductPreservingCreative|creative-runtime\/runtime\.js|fallback_to_single_image:\s*true/.test(src), `${f} does not reach the single-image runtime`);
  }
  for (const r of [A_PROP, A_PLATE, A_TYPE, B_FG]) { assert.equal(r.fallback_to_full_regeneration, false); assert.equal(r.candidate.fallback_to_single_image, false); assert.equal(r.candidate.strategy, 'LAYERED_SCENE_PRODUCTION'); }
});

test('RF-13 the masked-edit interface exists and reports honestly that no provider is connected: nothing is faked, nothing is executed', async () => {
  const cap = describeMaskedEditCapability({});
  assert.equal(cap.interface, MASKED_EDIT.INTERFACE_READY); assert.equal(cap.provider, MASKED_EDIT.NOT_CONNECTED); assert.equal(cap.executable, false); assert.equal(cap.tool_id, null);
  assert.deepEqual(cap.request_fields, ['source_image', 'mask', 'instruction', 'protected_regions', 'expected_output_class', 'provenance', 'cost_estimate_eur']);
  const request = { source_image: { sha256: 'a'.repeat(40), width: 100, height: 100 }, mask: { width: 100, height: 100, regions: [{ x: 0, y: 0, width: 20, height: 20 }] }, instruction: 'remove the smudge', protected_regions: [{ x: 50, y: 50, width: 40, height: 40 }], expected_output_class: 'REGION_PATCH', provenance: { requested_by: 'nordla:refine-planner@1' }, cost_estimate_eur: 0.04 };
  assert.deepEqual(validateMaskedEditRequest(request), { ok: true, problems: [] });
  const none = await requestMaskedEdit({ ports: {}, request });
  assert.equal(none.status, MASKED_EDIT.NOT_CONNECTED); assert.equal(none.executed, false); assert.equal(none.output, null); assert.equal(none.capability.provider, MASKED_EDIT.NOT_CONNECTED);
  // a repair that needs it says so and is refused: it is not an executable scope
  const r = await doRefine(A, [createDefectRegion({ kind: DEFECT_KIND.LOCAL_PIXEL_DEFECT, layer_id: prop(A).layer_id })]);
  assert.equal(r.status, 'BLOCKED'); assert.equal(r.block.code, REPAIR_BLOCK.NEEDS_A_MASKED_EDIT_PROVIDER); assert.equal(r.block.detail.masked_edit, MASKED_EDIT.NOT_CONNECTED);
  // the request is validated before anything, whether or not a provider exists
  const touching = await requestMaskedEdit({ ports: {}, request: { ...request, mask: { width: 100, height: 100, regions: [{ x: 45, y: 45, width: 20, height: 20 }] } } });
  assert.equal(touching.reason, 'MASK_TOUCHES_A_PROTECTED_REGION'); assert.equal(touching.executed, false);
  for (const bad of [{ ...request, instruction: ' ' }, { ...request, expected_output_class: 'WHOLE_IMAGE' }, { ...request, provenance: {} }, { ...request, cost_estimate_eur: -1 }, { ...request, mask: { width: 99, height: 100, regions: [] } }, { ...request, protected_regions: [{ x: 0, y: 0, width: 0, height: 4 }] }, { ...request, source_image: { sha256: 1 } }]) assert.equal(validateMaskedEditRequest(bad).ok, false);
  // a connected provider (a test double) is reached only through an open gate, and its output is accepted only if the protected pixels are intact
  const calls = []; const double = { tool_id: 'test-double/masked-edit', async edit(req) { calls.push(req); return { output_bytes: A.candidate.png_bytes }; } };
  assert.equal(describeMaskedEditCapability({ maskedEdit: double }).executable, true); assert.equal(describeMaskedEditCapability({ maskedEdit: { edit() {}, tool_id: '' } }).executable, false);
  const closed = await requestMaskedEdit({ ports: { maskedEdit: double }, request, gate: { status: 'READY_PENDING_OWNER_GO' } });
  assert.equal(closed.reason, 'PROVIDER_GATE_NOT_OPEN'); assert.equal(calls.length, 0);
  const png = A.candidate.png_bytes; const img = decodePng(png);
  const full = { ...request, source_image: { sha256: sha(png).slice(0, 40), width: img.width, height: img.height }, mask: { width: img.width, height: img.height, regions: [{ x: 0, y: 0, width: 10, height: 10 }] }, protected_regions: [{ x: 100, y: 100, width: 50, height: 50 }] };
  const ok = await requestMaskedEdit({ ports: { maskedEdit: double }, request: full, sourcePng: png, gate: { status: 'OPEN_BY_OWNER' } });
  assert.equal(ok.status, 'EXECUTED'); assert.equal(calls.length, 1);
  const tampered = { tool_id: 'test-double/masked-edit', async edit() { return { output_bytes: B.candidate.png_bytes }; } };
  const rejected = await requestMaskedEdit({ ports: { maskedEdit: tampered }, request: full, sourcePng: png, gate: { status: 'OPEN_BY_OWNER' } });
  assert.equal(rejected.status, 'REJECTED'); assert.equal(rejected.reason, 'OUTPUT_CHANGED_A_PROTECTED_REGION'); assert.equal(rejected.output, null);
});

test('RF-14 dependency-aware invalidation: a repair invalidates the target and what is made from it, never the reasoning upstream, the product, or the locked text', () => {
  const art = A.candidate.artifact; const map = buildLayerDependencyMap(art);
  assert.equal(map.schema, 'layer-dependency-map@1'); assert.equal(map.digest, buildLayerDependencyMap(art).digest);
  const planned = (kind, extra = {}) => planRepair({ artifact: art, defects: [createDefectRegion({ kind, ...extra })] });
  const prop1 = planned(DEFECT_KIND.PROP_UNUSABLE, { layer_id: prop(A).layer_id });
  assert.deepEqual(prop1.invalidated, [...new Set(['COMPOSITE_BASE', 'COMPOSITE_STACK', prop(A).node_id, 'RENDER', 'TEXT_STYLE:HEADLINE'])].sort());
  assert.ok(prop1.reused.includes(art.nodes.plate.node_id) && prop1.reused.includes('PRODUCT') && prop1.reused.includes('TEXT:HEADLINE'));
  const type1 = planned(DEFECT_KIND.TEXT_ILLEGIBLE);
  assert.deepEqual(type1.invalidated, ['RENDER', 'TEXT_STYLE:HEADLINE']);
  const plate1 = planned(DEFECT_KIND.PLATE_UNSUITABLE);
  assert.deepEqual(plate1.invalidated, ['COMPOSITE_BASE', 'COMPOSITE_STACK', art.nodes.plate.node_id, 'RENDER', 'TEXT_STYLE:HEADLINE'].sort());
  assert.ok(plate1.reused.includes(prop(A).node_id), 'the props do not depend on the plate');
  const composite = planned(DEFECT_KIND.COMPOSITE_STALE);
  assert.deepEqual(composite.invalidated, ['COMPOSITE_BASE', 'COMPOSITE_STACK', 'RENDER', 'TEXT_STYLE:HEADLINE']);
  for (const p of [prop1, type1, plate1, composite]) {
    assert.equal(p.status, 'PLANNED'); assert.deepEqual(p.upstream_untouched, ['CONCEPT', 'ART_DIRECTION', 'ASSET_PLAN', 'PRODUCT_IDENTITY']);
    assert.ok(!p.invalidated.some((id) => ['CONCEPT', 'ART_DIRECTION', 'ASSET_PLAN', 'PRODUCT_IDENTITY', 'PRODUCT', 'TEXT:HEADLINE'].includes(id)), 'protected and upstream nodes are never invalidated by a layer repair');
    assert.deepEqual(p.protected, ['PRODUCT', 'TEXT:HEADLINE']);
  }
  // an upstream defect is a REPLAN request: the upstream node is named because the defect truly originates there, and no layer is repaired in its place
  const up = planned(DEFECT_KIND.UPSTREAM_CONCEPT);
  assert.equal(up.status, 'REPLAN_REQUIRED'); assert.deepEqual(up.replan.upstream_nodes, ['ART_DIRECTION', 'CONCEPT']); assert.deepEqual(up.steps, []);
  assert.equal(planned(DEFECT_KIND.UPSTREAM_LAYOUT).replan.upstream_nodes[0], 'ASSET_PLAN');
  assert.equal(planned(DEFECT_KIND.REQUIRES_PHASE_5).block.code, REPAIR_BLOCK.NOT_AVAILABLE_IN_THIS_PHASE);
});

test('RF-15 no repair is a regeneration: a plan that regenerates (nearly) every generated layer of the scene is refused as too broad', () => {
  const plate = createDefectRegion({ kind: DEFECT_KIND.PLATE_UNSUITABLE });
  const p1 = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: prop(A).layer_id });
  const both = planRepair({ artifact: A.candidate.artifact, defects: [plate, p1] });
  assert.equal(both.status, 'BLOCKED'); assert.equal(both.block.code, REPAIR_BLOCK.REPAIR_SCOPE_TOO_BROAD); assert.deepEqual(both.block.detail, { regenerated: 2, generated_layers: 2, limit: 2 });
  const art = B.candidate.artifact;
  const bg = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: prop(B, 'PROP_BACKGROUND').layer_id }); const fg = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: prop(B, 'PROP_FOREGROUND').layer_id });
  const two = planRepair({ artifact: art, defects: [plate, fg] });
  assert.equal(two.status, 'PLANNED'); assert.equal(two.cost.regenerated_layers, 2); assert.equal(two.cost.max_provider_calls, 4);
  assert.equal(planRepair({ artifact: art, defects: [plate, bg, fg] }).block.code, REPAIR_BLOCK.REPAIR_SCOPE_TOO_BROAD);
  assert.equal(REFINE_POLICY.max_regenerated_layers, 2);
});

test('RF-16 working memory: a placement defect escalates reposition, reposition, remove, then the scene is replanned; a failed repair is never repeated; the memory is plain data that resumes', async () => {
  const art = A.candidate.artifact; const defect = createDefectRegion({ kind: DEFECT_KIND.PROP_NO_ROOM, layer_id: prop(A).layer_id });
  const memory = createRefineMemory();
  const steps = [];
  for (let i = 0; i < 4; i += 1) {
    const plan = planRepair({ artifact: art, defects: [defect], memory });
    steps.push(plan.status === 'PLANNED' ? plan.steps[0].action : plan.block.code);
    if (plan.status === 'PLANNED') memory.record(art.scene_id, { plan_id: plan.plan_id, fingerprint: plan.fingerprint, steps: plan.steps.map((s) => ({ scope: s.scope, target: s.target, action: s.action.type })), outcome: 'NOT_REPAIRED' });
  }
  assert.deepEqual(steps, [{ type: 'REPOSITION', anchor: 1 }, { type: 'REPOSITION', anchor: 2 }, { type: 'REMOVE' }, REPAIR_BLOCK.REFINE_ATTEMPTS_EXHAUSTED]);
  const resumed = createRefineMemory(JSON.parse(JSON.stringify(memory.export())));
  assert.equal(resumed.attempts(art.scene_id).length, 3); assert.equal(planRepair({ artifact: art, defects: [defect], memory: resumed }).block.code, REPAIR_BLOCK.REFINE_ATTEMPTS_EXHAUSTED);
  assert.equal(resumed.export().schema, 'refine-memory@1');
  // the same failed repair of the same artifact is not repeated
  const m2 = createRefineMemory(); const p = planRepair({ artifact: art, defects: [badProp(A)] });
  m2.record(art.scene_id, { plan_id: p.plan_id, fingerprint: p.fingerprint, steps: [], outcome: 'NOT_REPAIRED' });
  assert.equal(planRepair({ artifact: art, defects: [badProp(A)], memory: m2 }).block.code, REPAIR_BLOCK.REPEATED_FAILED_REPAIR);
  const m3 = createRefineMemory(); m3.record(art.scene_id, { plan_id: p.plan_id, fingerprint: p.fingerprint, steps: [], outcome: 'REPAIRED' });
  assert.equal(planRepair({ artifact: art, defects: [badProp(A)], memory: m3 }).status, 'PLANNED', 'a repair that worked is not a failed one');
});

test('RF-17 reposition and remove are executable, free and local: one prop moves or leaves, every other layer keeps its hash, nothing is generated', async () => {
  const memory = createRefineMemory();
  const defect = createDefectRegion({ kind: DEFECT_KIND.PROP_NO_ROOM, layer_id: prop(A).layer_id });
  const calls = before(A);
  const moved = await doRefine(A, [defect], { memory });
  assert.ok(['REPAIRED', 'NOT_REPAIRED'].includes(moved.status), JSON.stringify(moved.block));
  if (moved.status === 'REPAIRED') {
    assert.notDeepEqual(moved.after.nodes.props[0].box, prop(A).box); assert.equal(moved.after.nodes.props[0].candidate_sha256, prop(A).candidate_sha256, 'the same prop image, another place');
    assert.deepEqual(moved.after.nodes.plate, A.candidate.artifact.nodes.plate); assert.deepEqual(moved.after.nodes.product, A.candidate.artifact.nodes.product);
  }
  assert.equal(moved.cost.provider_calls, 0); assert.equal(before(A), calls);
  // the third rung: remove
  const ladder = createRefineMemory();
  for (const i of [1, 2]) ladder.record(A.candidate.artifact.scene_id, { plan_id: `p${i}`, fingerprint: `f${i}`, steps: [{ scope: REPAIR_SCOPE.LAYER_REMOVE_OR_REPOSITION, target: prop(A).node_id, action: 'REPOSITION' }], outcome: 'NOT_REPAIRED' });
  const removed = await doRefine(A, [defect], { memory: ladder });
  assert.equal(removed.status, 'REPAIRED', JSON.stringify([removed.block, removed.plan?.block]));
  assert.deepEqual(removed.plan.overrides.policy.drop_layers, [prop(A).layer_id]);
  assert.equal(removed.after.nodes.props.length, 0); assert.deepEqual(removed.layer_diff.removed, [prop(A).node_id]);
  assert.deepEqual(removed.after.nodes.plate, A.candidate.artifact.nodes.plate); assert.deepEqual(removed.after.nodes.product, A.candidate.artifact.nodes.product); assert.deepEqual(removed.after.nodes.text, A.candidate.artifact.nodes.text);
  assert.equal(removed.cost.provider_calls, 0); assert.equal(removed.cost.spent_eur, 0); assert.equal(removed.candidate.status, 'READY_FOR_REVIEW');
  assert.ok(removed.candidate.ledger.some((e) => e.decision === 'BACKGROUND_STRATEGY' && e.outcome.dropped?.includes(prop(A).layer_id)));
});

test('RF-18 only a prop can be dropped (never the plate, the product or a text), and only by its id', async () => {
  const h = layeredHarness({ layerPort: scriptedPort() });
  for (const id of [A.candidate.artifact.nodes.plate.request_key, 'nope', WORLD.result.scenes[HEADLINE_SCENE].layers.find((l) => l.kind === 'PRODUCT').layer_id, WORLD.result.scenes[HEADLINE_SCENE].text_layers[0].layer_id]) {
    const r = await runLayeredCreative({ ...A.run, agents: h.agents, ports: h.ports, ledger: h.ledger, store: createLayerStore(), policy: { drop_layers: [id] } });
    assert.equal(r.status, 'BLOCKED'); assert.equal(r.reason, 'LAYER_CANNOT_BE_DROPPED'); assert.equal(r.provider_calls, 0);
  }
});

test('RF-19 a failed repair keeps the original: the replacement is refused by its own gate, the original layers and the shared store are untouched, and the same repair is not repeated', async () => {
  const { propOnBusyGround, propOnGround } = await import('./creative-layered-runtime-world.js');
  const stubborn = scriptedPort({ prop: ({ candidate_index: n }) => (n === 1 ? propOnGround() : propOnBusyGround()) });
  const T = await firstRun({ port: stubborn });
  assert.equal(T.candidate.status, 'READY_FOR_REVIEW');
  const keyCount = T.store.count(prop(T).request_key); const calls = stubborn.calls.length; const memory = createRefineMemory();
  const r = await doRefine(T, [badProp(T)], { memory });
  assert.equal(r.status, 'NOT_REPAIRED'); assert.equal(r.block.code, REPAIR_BLOCK.REPAIRED_CANDIDATE_REFUSED); assert.equal(r.original_kept, true);
  assert.equal(stubborn.calls.length - calls, REFINE_POLICY.repair_candidates_per_layer, 'bounded by the allowance of the plan');
  assert.equal(T.store.count(prop(T).request_key), keyCount, 'the original store was not modified'); assert.deepEqual(T.store.rejected(prop(T).request_key), []);
  assert.equal(T.candidate.status, 'READY_FOR_REVIEW'); assert.equal(memory.attempts(T.candidate.artifact.scene_id)[0].outcome, 'NOT_REPAIRED');
  const again = await doRefine(T, [badProp(T)], { memory });
  assert.equal(again.block.code, REPAIR_BLOCK.REPEATED_FAILED_REPAIR); assert.equal(stubborn.calls.length - calls, REFINE_POLICY.repair_candidates_per_layer, 'no call for a repeated repair');
});

test('RF-20 a repair that changes anything outside its plan is rejected: the original stays, and the memory records why', async () => {
  const swapped = scriptedPort(); const T = await firstRun({ port: swapped });
  const otherPlate = (await import('./creative-layered-runtime-world.js')).calmPlate({ width: 1080, height: 1350 }, ['#f5efe6', '#e2d6c4']);
  // a store that serves a DIFFERENT plate to the repair than the one the candidate was made of (a corrupted shared state): the plan keeps the plate, so this is outside the plan
  const rogue = { ...T.store, fork() { const f = T.store.fork(); const plateKey = T.candidate.artifact.nodes.plate.request_key; return { ...f, candidates: (key) => (key === plateKey ? [{ index: 1, bytes: otherPlate, provenance: null }] : f.candidates(key)) }; } };
  const memory = createRefineMemory();
  const r = await refineCreative({ candidate: T.candidate, defects: [badProp(T)], run: T.run, store: rogue, memory });
  assert.equal(r.status, 'BLOCKED'); assert.equal(r.block.code, REPAIR_BLOCK.REPAIR_OUTSIDE_ITS_SCOPE); assert.ok(r.block.detail.outside.includes(T.candidate.artifact.nodes.plate.node_id)); assert.equal(r.original_kept, true);
  assert.equal(memory.attempts(T.candidate.artifact.scene_id)[0].outcome, 'REJECTED');
});

test('RF-21 a stale composite is repaired by recomputing only the composite from valid layers (no layer, no cost), and a consistent one reports that the repair had no effect', async () => {
  const stale = JSON.parse(JSON.stringify(A.candidate)); stale.artifact.nodes.composite.stack_sha256 = 'f'.repeat(64);
  const bad = { ...A.candidate, artifact: Object.freeze(stale.artifact) };
  const r = await refineCreative({ candidate: bad, defects: [createDefectRegion({ kind: DEFECT_KIND.COMPOSITE_STALE })], run: A.run, store: A.store });
  assert.equal(r.status, 'REPAIRED', JSON.stringify([r.block, r.plan?.block]));
  assert.deepEqual(r.plan.scope, [REPAIR_SCOPE.COMPOSITE_REPAIR]); assert.deepEqual(r.layer_diff.changed, ['COMPOSITE_STACK']); assert.equal(r.cost.provider_calls, 0);
  assert.equal(r.after.nodes.composite.stack_sha256, A.candidate.artifact.nodes.composite.stack_sha256);
  const consistent = await doRefine(A, [createDefectRegion({ kind: DEFECT_KIND.COMPOSITE_STALE })]);
  assert.equal(consistent.status, 'NOT_REPAIRED'); assert.equal(consistent.block.code, REPAIR_BLOCK.REPAIR_HAD_NO_EFFECT); assert.equal(consistent.original_kept, true);
});

test('RF-22 critique to action: the revision vocabulary of the critic maps to a layer repair, or to the honest statement that it is a replan or not available; nothing maps to regenerating everything', () => {
  const kinds = (intents) => defectsFromRevisionIntents(intents).map((d) => d.kind);
  assert.deepEqual(kinds(['REGENERATE_CLEANER_ENVIRONMENT', 'CLARIFY_TEXT_HIERARCHY', 'REBALANCE_COMPOSITION']), [DEFECT_KIND.PLATE_UNSUITABLE, DEFECT_KIND.TEXT_ILLEGIBLE, DEFECT_KIND.PROP_NO_ROOM]);
  assert.deepEqual(kinds(['RECONSIDER_THE_OVERALL_CONCEPT', 'REDUCE_TEMPLATE_FEEL', 'INCREASE_PRODUCT_DOMINANCE', 'IMPROVE_PRODUCT_ENVIRONMENT_INTEGRATION']), [DEFECT_KIND.UPSTREAM_CONCEPT, DEFECT_KIND.UPSTREAM_CONCEPT, DEFECT_KIND.UPSTREAM_LAYOUT, DEFECT_KIND.REQUIRES_PHASE_5]);
  assert.throws(() => defectsFromRevisionIntents(['MAKE_IT_POP']), DefectError);
  assert.ok(defectsFromRevisionIntents([{ intent: 'REFINE_TYPOGRAPHIC_COMPOSITION' }])[0].source === 'CRITIQUE');
  const art = A.candidate.artifact;
  assert.equal(planRepair({ artifact: art, defects: defectsFromRevisionIntents(['REGENERATE_CLEANER_ENVIRONMENT']) }).scope[0], REPAIR_SCOPE.PLATE_REPAIR);
  assert.equal(planRepair({ artifact: art, defects: defectsFromRevisionIntents(['RECONSIDER_THE_OVERALL_CONCEPT']) }).status, 'REPLAN_REQUIRED');
  // the gates of a delivered candidate already name defects
  const named = defectsFromCandidate({ status: 'PREFLIGHT_FAIL', preflight: { checks: [{ code: 'INSUFFICIENT_CONTRAST', status: 'FAIL' }, { code: 'SAFE_ZONE', status: 'FAIL' }, { code: 'OK', status: 'PASS' }] } });
  assert.deepEqual(named.map((d) => d.kind), [DEFECT_KIND.TEXT_ILLEGIBLE, DEFECT_KIND.COMPOSITION_REFUSED]);
  const fidelity = defectsFromCandidate({ status: 'FIDELITY_FAIL', fidelity: { failed: [{ check: 'PIECE_COUNT', observation: 'INSTANCE_COUNT', outcome: 'FAIL' }, { check: 'GEOMETRY', observation: 'OUTLINE_EDGE', outcome: 'FAIL' }] } });
  assert.deepEqual(fidelity.map((d) => d.kind), [DEFECT_KIND.PROP_RESEMBLES_THE_PRODUCT, DEFECT_KIND.PRODUCT_PIXELS]);
  assert.equal(planRepair({ artifact: art, defects: fidelity }).block.code, REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS);
  assert.deepEqual(defectsFromCandidate({ status: 'READY_FOR_REVIEW' }), []);
  assert.deepEqual(defectsFromCandidate({ status: 'GUARDIAN_FAIL', guardian: { rule_results: [{ rule_id: 'MIN_CONTRAST', outcome: 'FAIL' }, { rule_id: 'LOGO', outcome: 'PASS' }] } }).map((d) => d.kind), [DEFECT_KIND.TEXT_ILLEGIBLE]);
  // the only prop of a scene is the owner of a prop defect named by a gate; with two props the owner cannot be guessed
  assert.equal(planRepair({ artifact: art, defects: [createDefectRegion({ kind: DEFECT_KIND.PROP_RESEMBLES_THE_PRODUCT, source: 'GATE' })] }).status, 'PLANNED');
  assert.equal(planRepair({ artifact: B.candidate.artifact, defects: [createDefectRegion({ kind: DEFECT_KIND.PROP_RESEMBLES_THE_PRODUCT, source: 'GATE' })] }).block.code, REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE);
});

test('RF-23 a defect is attributed to the layer that owns the pixels: the topmost layer at the region, the product and the locked text protected', () => {
  const n = B.candidate.artifact.nodes; const centre = (b) => ({ x: b.x + b.width / 2 - 2, y: b.y + b.height / 2 - 2, width: 4, height: 4 });
  const at = (region) => attributeDefect(B.candidate.artifact, createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, region }));
  assert.equal(at(centre(n.props.find((p) => p.kind === 'PROP_FOREGROUND').box)).node_id, n.props.find((p) => p.kind === 'PROP_FOREGROUND').node_id);
  assert.equal(at(centre(n.props.find((p) => p.kind === 'PROP_BACKGROUND').box)).node_id, n.props.find((p) => p.kind === 'PROP_BACKGROUND').node_id);
  const product = at(centre(n.product.rect)); assert.equal(product.node_id, 'PRODUCT'); assert.equal(product.touches_product, true);
  assert.equal(at(centre(n.text[0].geometry)).node_id, `TEXT:${n.text[0].role}`);
  assert.equal(at({ x: 1075, y: 1, width: 4, height: 4 }).node_id, n.plate.node_id);
  assert.equal(at({ x: 5000, y: 5000, width: 4, height: 4 }).node_id, null);
  assert.equal(attributeDefect(B.candidate.artifact, createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE })).via, 'NONE');
  assert.equal(attributeDefect(B.candidate.artifact, createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, node_id: n.plate.node_id })).via, 'NODE');
  assert.equal(attributeDefect(B.candidate.artifact, createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, node_id: 'unknown' })).node_id, null);
});

test('RF-24 the artifact and the repair are deterministic and plain: the same defects give the same plan, and the result carries a digest that changes with the image', () => {
  const d = [badProp(A)];
  assert.deepEqual(planRepair({ artifact: A.candidate.artifact, defects: d }), planRepair({ artifact: A.candidate.artifact, defects: d }));
  assert.equal(A_PROP.plan.plan_id, planRepair({ artifact: A.candidate.artifact, defects: d, pricing: null }).plan_id);
  assert.notEqual(A_PROP.digest, A_PLATE.digest);
  assert.deepEqual(diffArtifacts(A.candidate.artifact, A.candidate.artifact).changed, []);
  assert.equal(diffArtifacts({}, {}), null);
  assert.ok(Object.isFrozen(A.candidate.artifact) && Object.isFrozen(A_PROP) && Object.isFrozen(A_PROP.plan));
  assert.ok(A_PROP.ledger.some((e) => e.decision === 'REFINE_PLAN') && A_PROP.ledger.some((e) => e.decision === 'REFINE_EXECUTION') && A_PROP.ledger.some((e) => e.decision === 'REFINE_RESULT' && e.outcome.status === 'REPAIRED'));
  assert.equal(A_PROP.candidate.steering.manual_creative_steering, 'NONE');
});

test('RF-25 an upstream defect through the executor is a replan request: nothing is run, nothing is paid, nothing is remembered as an attempt, the original is kept', async () => {
  const calls = before(A); const memory = createRefineMemory();
  const r = await doRefine(A, [createDefectRegion({ kind: DEFECT_KIND.UPSTREAM_CONCEPT })], { memory });
  assert.equal(r.status, 'REPLAN_REQUIRED'); assert.deepEqual(r.replan.upstream_nodes, ['ART_DIRECTION', 'CONCEPT']); assert.equal(r.original_kept, true); assert.equal(r.plan.status, 'REPLAN_REQUIRED');
  assert.equal(before(A), calls); assert.deepEqual(memory.attempts(A.candidate.artifact.scene_id), []); assert.equal(r.fallback_to_full_regeneration, false);
  assert.ok(r.ledger.some((e) => e.decision === 'REFINE_PLAN' && e.outcome.status === 'REPLAN_REQUIRED' && e.outcome.replan.upstream_nodes.includes('CONCEPT')));
  // a delivered candidate with no defect has nothing to repair; a gate finding with no owner is refused, never guessed
  const none = await refineCreative({ candidate: A.candidate, run: A.run, store: A.store });
  assert.equal(none.status, 'BLOCKED'); assert.equal(none.block.code, REPAIR_BLOCK.NO_DEFECT); assert.equal(before(A), calls);
});

test('RF-27 the layered runtime itself refuses a prop tool other than the one the specification selected, before any call (the check a repair relies on)', async () => {
  const other = scriptedPort({ executes: { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary', PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/secondary' } });
  const h = layeredHarness({ layerPort: other });
  const r = await runLayeredCreative({ ...A.run, agents: h.agents, ports: h.ports, ledger: h.ledger, store: createLayerStore() });
  assert.equal(r.status, 'BLOCKED'); assert.equal(r.reason, 'TOOL_DIFFERS_FROM_THE_SELECTED_TOOL'); assert.equal(r.provider_calls, 0); assert.equal(other.calls.length, 0);
  assert.deepEqual(r.detail, [{ capability: 'PROP_ON_PLAIN_GROUND_GENERATION', selected: 'text-to-image/primary', executed: 'text-to-image/secondary' }]);
});

test('RF-28 an allowance of ONE candidate is exactly one call and one reserved candidate: used when it is good, and a stop after exactly one call when it is refused', async () => {
  const { propOnBusyGround, propOnGround } = await import('./creative-layered-runtime-world.js');
  for (const good of [true, false]) {
    const port = scriptedPort({ prop: ({ candidate_index: n }) => (n === 1 || good ? propOnGround({ colour: n === 1 ? '#7a4b2a' : '#2a6b4a' }) : propOnBusyGround()) });
    const T = await firstRun({ port }); const store = T.store.fork(); store.reject(prop(T).request_key, prop(T).candidate_sha256, 1);
    const calls = port.calls.length; const h = layeredHarness({ layerPort: port });
    const r = await runLayeredCreative({ ...T.run, agents: h.agents, ports: h.ports, ledger: h.ledger, store });
    assert.equal(port.calls.length - calls, 1, 'one call, never two'); assert.deepEqual(port.calls.slice(calls).map((c) => c.candidate_index), [2]);
    const reserved = r.ledger.find((e) => e.decision === 'LAYER_BUDGET_RESERVATION').outcome.layers ?? [];
    assert.deepEqual(reserved.map((l) => [l.request_key, l.candidates]), [[prop(T).request_key, 1]], 'one candidate reserved, not the two of the specification');
    if (good) assert.equal(r.status, 'READY_FOR_REVIEW'); else { assert.equal(r.status, 'BLOCKED'); assert.equal(r.reason, 'GENERATED_LAYER_REJECTED'); }
  }
});

test('RF-26 a repair may use its whole allowance: a second candidate that is refused and a third that is accepted is a repair of exactly two calls, and it is remembered', async () => {
  const { propOnBusyGround, propOnGround } = await import('./creative-layered-runtime-world.js');
  const port = scriptedPort({ prop: ({ candidate_index: n }) => (n === 2 ? propOnBusyGround() : propOnGround({ colour: ['#7a4b2a', '#2a6b4a', '#4a2a6b'][n - 1] ?? '#6b4a2a' })) });
  const T = await firstRun({ port }); const memory = createRefineMemory(); const calls = port.calls.length;
  const r = await doRefine(T, [badProp(T)], { memory });
  assert.equal(r.status, 'REPAIRED', JSON.stringify([r.block, r.plan?.block]));
  assert.deepEqual(port.calls.slice(calls).map((c) => `${c.kind}#${c.candidate_index}`), ['PROP#2', 'PROP#3']); assert.equal(r.cost.provider_calls, 2); assert.equal(r.cost.provider_calls, r.plan.cost.max_provider_calls);
  const unit = WORLD.result.production.budget.unit_costs.image_eur_by_size_class.UP_TO_1024; assert.equal(r.cost.spent_eur, Math.round(2 * unit * 1e9) / 1e9);
  assert.notEqual(r.after.nodes.props[0].candidate_sha256, prop(T).candidate_sha256);
  const entry = memory.attempts(T.candidate.artifact.scene_id)[0];
  assert.deepEqual([entry.outcome, entry.reason, entry.scope, entry.plan_id, entry.fingerprint], ['REPAIRED', null, ['PROP_REPAIR'], r.plan.plan_id, r.plan.fingerprint]); assert.equal(entry.cost.provider_calls, 2); assert.equal(entry.before, T.candidate.artifact.nodes.render.png_sha256); assert.equal(entry.after, r.after.nodes.render.png_sha256);
  assert.equal(r.memory.schema, 'refine-memory@1'); assert.equal(r.store.count(prop(T).request_key), 3); assert.deepEqual(r.store.rejected(prop(T).request_key), [prop(T).candidate_sha256]);
});
