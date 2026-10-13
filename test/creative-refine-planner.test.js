import test from 'node:test';
import assert from 'node:assert/strict';

import { encodePng } from '../src/creative-intelligence/png-encode.js';
import { createDecisionLedger } from '../src/creative-runtime/index.js';
import {
  attributeDefect, buildLayerDependencyMap, createDefectRegion, createRefineMemory, DEFECT_KIND, defectsFromCandidate, defectsFromRevisionIntents, DefectError, dependentsOfNodes, describeMaskedEditCapability,
  invalidationOf, KIND_FOR_INTENT, MASKED_EDIT, planRepair, protectedRegionsIntact, REFINE_POLICY, REPAIR_BLOCK, REPAIR_SCOPE, REPAIR_SCOPES, requestMaskedEdit, UPSTREAM_NODES, validateMaskedEditRequest,
} from '../src/creative-refine/index.js';
import { refineSample } from '../src/creative-refine/parity.js';

// THE REPAIR PLANNER, THE DEFECTS AND THE MASKED-EDIT INTERFACE, WITHOUT THE HEAVY WORLD (`// PL-N`): pure, deterministic, a few milliseconds each. The end-to-end behaviour is RF-1 to RF-24.

const art = () => refineSample();
const d = (kind, extra = {}) => createDefectRegion({ kind, ...extra });
const plan = (defects, extra = {}) => planRepair({ artifact: art(), defects, ...extra });
const withProps = (n) => { const a = art(); a.nodes.props = Array.from({ length: n }, (_, i) => ({ node_id: `PROP:lyr_${i}`, layer_id: `lyr_${i}`, kind: i === 0 ? 'PROP_FOREGROUND' : 'PROP_MIDGROUND', request_key: `prk_${i}`, candidate_sha256: String(i).repeat(40), placed_sha256: String(i + 1).repeat(40), box: { x: 10 + 100 * i, y: 900, width: 90, height: 120 }, z: 20 + i })); return a; };
const record = (memory, p, outcome = 'NOT_REPAIRED') => memory.record('scn_probe', { plan_id: p.plan_id, fingerprint: p.fingerprint, steps: p.steps.map((s) => ({ scope: s.scope, target: s.target, action: s.action.type })), outcome });

test('PL-1 each defect kind is answered by the one scope that fits it, with the exact targets, overrides, invalidation, reuse and cost', () => {
  const mid = plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })]);
  assert.equal(mid.status, 'PLANNED'); assert.deepEqual(mid.scope, [REPAIR_SCOPE.PROP_REPAIR]); assert.equal(mid.fallback_to_full_regeneration, false);
  assert.deepEqual(mid.steps, [{ scope: 'PROP_REPAIR', target: 'PROP:lyr_mid', layer_id: 'lyr_mid', request_key: 'prk_mid', action: { type: 'REPLACE_WITH_A_NEW_CANDIDATE', reject_candidate_sha256: '2'.repeat(40) } }]);
  assert.deepEqual(mid.overrides, { reject: [{ request_key: 'prk_mid', candidate_sha256: '2'.repeat(40) }], allowance: { prk_mid: 2 }, policy: {} });
  assert.deepEqual(mid.invalidated, ['COMPOSITE_BASE', 'COMPOSITE_STACK', 'PROP:lyr_mid', 'RENDER', 'TEXT_STYLE:HEADLINE']);
  assert.deepEqual(mid.reused, ['PLATE:plk_probe', 'PRODUCT', 'PROP:lyr_fg', 'TEXT:HEADLINE']);
  assert.deepEqual(mid.protected, ['PRODUCT', 'TEXT:HEADLINE']); assert.deepEqual(mid.upstream_untouched, ['CONCEPT', 'ART_DIRECTION', 'ASSET_PLAN', 'PRODUCT_IDENTITY']);
  assert.deepEqual(mid.cost, { regenerated_layers: 1, max_provider_calls: 2, lines: [{ request_key: 'prk_mid', max_candidates: 2, unit_eur: null, max_eur: null }], only_the_repaired_work: true });
  assert.match(mid.plan_id, /^plan-[0-9a-f]{16}$/); assert.match(mid.fingerprint, /^[0-9a-f]{24}$/); assert.match(mid.artifact_digest, /^[0-9a-f]{64}$/);
  const fg = plan([d(DEFECT_KIND.PROP_RESEMBLES_THE_PRODUCT, { layer_id: 'lyr_fg' })]);
  assert.deepEqual(fg.invalidated, ['COMPOSITE_STACK', 'PROP:lyr_fg', 'RENDER', 'TEXT_STYLE:HEADLINE'], 'a foreground prop does not touch the base under the product');
  assert.ok(fg.reused.includes('COMPOSITE_BASE') && fg.reused.includes('PROP:lyr_mid'));
  const pl = plan([d(DEFECT_KIND.PLATE_UNSUITABLE)]);
  assert.deepEqual(pl.scope, ['PLATE_REPAIR']); assert.deepEqual(pl.steps[0], { scope: 'PLATE_REPAIR', target: 'PLATE:plk_probe', request_key: 'plk_probe', action: { type: 'REPLACE_WITH_A_NEW_CANDIDATE', reject_candidate_sha256: '1'.repeat(40) } });
  assert.deepEqual(pl.invalidated, ['COMPOSITE_BASE', 'COMPOSITE_STACK', 'PLATE:plk_probe', 'RENDER', 'TEXT_STYLE:HEADLINE']); assert.deepEqual(pl.reused, ['PRODUCT', 'PROP:lyr_fg', 'PROP:lyr_mid', 'TEXT:HEADLINE']);
  const ty = plan([d(DEFECT_KIND.TEXT_ILLEGIBLE)]);
  assert.deepEqual(ty.scope, ['TYPOGRAPHY_REPAIR']); assert.deepEqual(ty.overrides, { reject: [], allowance: {}, policy: { typography: { plate_behind_text: true } } }); assert.deepEqual(ty.invalidated, ['RENDER', 'TEXT_STYLE:HEADLINE']);
  assert.deepEqual(ty.cost, { regenerated_layers: 0, max_provider_calls: 0, lines: [], only_the_repaired_work: true });
  for (const kind of [DEFECT_KIND.COMPOSITE_STALE, DEFECT_KIND.COMPOSITION_REFUSED]) {
    const c = plan([d(kind)]); assert.deepEqual(c.scope, ['COMPOSITE_REPAIR']); assert.deepEqual(c.steps[0], { scope: 'COMPOSITE_REPAIR', target: 'COMPOSITE_STACK', action: { type: 'RECOMPUTE_FROM_VALID_LAYERS' } });
    assert.deepEqual(c.invalidated, ['COMPOSITE_BASE', 'COMPOSITE_STACK', 'RENDER', 'TEXT_STYLE:HEADLINE']); assert.deepEqual(c.overrides.policy, {}); assert.equal(c.cost.max_provider_calls, 0);
  }
  const owned = plan([d(DEFECT_KIND.COMPOSITION_REFUSED, { layer_id: 'lyr_fg' })]);
  assert.deepEqual(owned.scope, ['LAYER_REMOVE_OR_REPOSITION'], 'a refused composition owned by a prop is a placement repair');
  const two = plan([d(DEFECT_KIND.PLATE_UNSUITABLE), d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' }), d(DEFECT_KIND.TEXT_ILLEGIBLE)]);
  assert.deepEqual(two.scope, ['PLATE_REPAIR', 'PROP_REPAIR', 'TYPOGRAPHY_REPAIR'].sort((a, b) => ['PLATE_REPAIR', 'PROP_REPAIR', 'TYPOGRAPHY_REPAIR'].indexOf(a) - ['PLATE_REPAIR', 'PROP_REPAIR', 'TYPOGRAPHY_REPAIR'].indexOf(b)));
  assert.equal(two.status, 'PLANNED'); assert.equal(two.cost.regenerated_layers, 2); assert.equal(two.cost.max_provider_calls, 4);
  assert.equal(plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' }), d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' })]).steps.length, 1, 'the same step is not planned twice');
});

test('PL-2 placement ladder: reposition (anchor 1, then 2 / inset 0.15, then 0.05), then remove, then the scene is replanned', () => {
  for (const [layer, expected] of [['lyr_mid', [{ type: 'REPOSITION', anchor: 1 }, { type: 'REPOSITION', anchor: 2 }]], ['lyr_fg', [{ type: 'REPOSITION', foreground_inset: 0.15 }, { type: 'REPOSITION', foreground_inset: 0.05 }]]]) {
    const memory = createRefineMemory(); const seen = []; const policies = [];
    for (let i = 0; i < 4; i += 1) {
      const p = plan([d(DEFECT_KIND.PROP_NO_ROOM, { layer_id: layer })], { memory });
      seen.push(p.status === 'PLANNED' ? p.steps[0].action : p.block.code); if (p.status === 'PLANNED') { policies.push(p.overrides.policy); record(memory, p); }
    }
    assert.deepEqual(seen, [...expected, { type: 'REMOVE' }, REPAIR_BLOCK.REFINE_ATTEMPTS_EXHAUSTED]);
    assert.deepEqual(policies[0], layer === 'lyr_mid' ? { anchors: { lyr_mid: 1 } } : { placement: { foreground_inset: 0.15 } });
    assert.deepEqual(policies[1], layer === 'lyr_mid' ? { anchors: { lyr_mid: 2 } } : { placement: { foreground_inset: 0.05 } });
    assert.deepEqual(policies[2], { drop_layers: [layer] });
  }
  // the repositions of ANOTHER layer do not count against this one
  const memory = createRefineMemory(); record(memory, plan([d(DEFECT_KIND.PROP_NO_ROOM, { layer_id: 'lyr_mid' })]));
  assert.deepEqual(plan([d(DEFECT_KIND.PROP_OVERLAP, { layer_id: 'lyr_fg' })], { memory }).steps[0].action, { type: 'REPOSITION', foreground_inset: 0.15 });
  assert.equal(plan([d(DEFECT_KIND.PROP_OVERLAP, { layer_id: 'lyr_fg' })], { memory }).scope[0], 'LAYER_REMOVE_OR_REPOSITION');
  assert.equal(REFINE_POLICY.allow_drop_of_a_prop, true); assert.equal(REFINE_POLICY.max_attempts_per_scene, 3); assert.equal(REFINE_POLICY.repair_candidates_per_layer, 2);
});

test('PL-3 typography: a plate behind the text once; never again; never without text', () => {
  const a = art(); a.nodes.text_style[0].plate = true;
  assert.equal(planRepair({ artifact: a, defects: [d(DEFECT_KIND.TEXT_ILLEGIBLE)] }).block.code, REPAIR_BLOCK.REPEATED_FAILED_REPAIR);
  assert.equal(planRepair({ artifact: a, defects: [d(DEFECT_KIND.TEXT_ILLEGIBLE)] }).block.detail.reason, 'TYPOGRAPHY_ALREADY_ON_A_PLATE');
  const some = art(); some.nodes.text_style.push({ node_id: 'TEXT_STYLE:BODY', role: 'BODY', color: '#000', font_size: 40, plate: true, style_sha256: 'e'.repeat(40) }); some.nodes.text.push({ node_id: 'TEXT:BODY', role: 'BODY', layer_id: 'lyr_b', text_sha256: 'f'.repeat(40), geometry: { x: 60, y: 1000, width: 900, height: 200 } });
  const p = planRepair({ artifact: some, defects: [d(DEFECT_KIND.TEXT_ILLEGIBLE)] });
  assert.equal(p.status, 'PLANNED'); assert.deepEqual(p.invalidated, ['RENDER', 'TEXT_STYLE:BODY', 'TEXT_STYLE:HEADLINE']);
  const none = art(); none.nodes.text_style = []; none.nodes.text = [];
  const b = planRepair({ artifact: none, defects: [d(DEFECT_KIND.TEXT_ILLEGIBLE)] });
  assert.equal(b.block.code, REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE); assert.match(b.block.detail.reason, /no text style/);
});

test('PL-4 what is never repaired is refused with its own code and the replan it needs', () => {
  const table = [
    [d(DEFECT_KIND.PRODUCT_PIXELS), REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS, 'VERIFY_THE_PRODUCT_ASSET_AND_REPLAN_THE_SCENE'],
    [d(DEFECT_KIND.PROP_UNUSABLE, { node_id: 'PRODUCT' }), REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS, 'VERIFY_THE_PRODUCT_ASSET_AND_REPLAN_THE_SCENE'],
    [d(DEFECT_KIND.PROP_UNUSABLE, { region: { x: 500, y: 700, width: 8, height: 8 } }), REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS, 'VERIFY_THE_PRODUCT_ASSET_AND_REPLAN_THE_SCENE'],
    [d(DEFECT_KIND.COPY_CHANGE), REPAIR_BLOCK.REPAIR_WOULD_CHANGE_LOCKED_COPY, 'REPLAN_THE_COPY_OF_THE_ASSET'],
    [d(DEFECT_KIND.PLATE_UNSUITABLE, { node_id: 'TEXT:HEADLINE' }), REPAIR_BLOCK.REPAIR_WOULD_CHANGE_LOCKED_COPY, 'REPLAN_THE_COPY_OF_THE_ASSET'],
    [d(DEFECT_KIND.REQUIRES_PHASE_5), REPAIR_BLOCK.NOT_AVAILABLE_IN_THIS_PHASE, 'WAIT_FOR_THE_INTEGRATION_PHASE'],
    [d(DEFECT_KIND.LOCAL_PIXEL_DEFECT, { layer_id: 'lyr_mid' }), REPAIR_BLOCK.NEEDS_A_MASKED_EDIT_PROVIDER, 'CONNECT_A_MASKED_EDIT_PROVIDER_OR_REPLACE_THE_LAYER'],
    [d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_nope' }), REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT'],
    [d(DEFECT_KIND.PROP_UNUSABLE), REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT'],
    [d(DEFECT_KIND.PROP_UNUSABLE, { node_id: 'PLATE:plk_probe' }), REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT'],
    [d(DEFECT_KIND.PLATE_UNSUITABLE, { layer_id: 'lyr_mid' }), REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT'],
    [d(DEFECT_KIND.PROP_NO_ROOM, { node_id: 'PLATE:plk_probe' }), REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT'],
  ];
  for (const [defect, code, replan] of table) { const p = plan([defect]); assert.equal(p.status, 'BLOCKED', defect.kind); assert.equal(p.block.code, code, defect.kind); assert.equal(p.block.replan, replan, defect.kind); assert.deepEqual(p.steps, []); assert.deepEqual(p.scope, []); assert.equal(p.cost, null); }
  assert.equal(plan([d(DEFECT_KIND.LOCAL_PIXEL_DEFECT, { layer_id: 'lyr_mid' })], { maskedEdit: { executable: true } }).block.code, REPAIR_BLOCK.NOT_AVAILABLE_IN_THIS_PHASE);
  assert.equal(plan([d(DEFECT_KIND.LOCAL_PIXEL_DEFECT, { layer_id: 'lyr_mid' })], { maskedEdit: { executable: false } }).block.detail.masked_edit, MASKED_EDIT.NOT_CONNECTED);
  // one refused defect refuses the whole plan: a legal defect beside it does not rescue it
  assert.equal(plan([d(DEFECT_KIND.PLATE_UNSUITABLE), d(DEFECT_KIND.PRODUCT_PIXELS)]).status, 'BLOCKED');
  // the text may be the owner of a legibility defect, and of nothing else
  assert.equal(plan([d(DEFECT_KIND.TEXT_ILLEGIBLE, { node_id: 'TEXT:HEADLINE' })]).status, 'PLANNED');
  // a region on the foreground prop that overlaps the product is the prop's, not the product's
  const onFg = plan([d(DEFECT_KIND.PROP_UNUSABLE, { region: { x: 760, y: 950, width: 4, height: 4 } })]);
  assert.equal(onFg.status, 'PLANNED'); assert.equal(onFg.steps[0].target, 'PROP:lyr_fg'); assert.equal(onFg.evidence[0].via, 'REGION');
});

test('PL-5 an upstream defect is a replan request that names the upstream node, and nothing else', () => {
  const concept = plan([d(DEFECT_KIND.UPSTREAM_CONCEPT)]);
  assert.equal(concept.status, 'REPLAN_REQUIRED'); assert.deepEqual(concept.replan, { upstream_nodes: ['ART_DIRECTION', 'CONCEPT'], note: 'the defect originates upstream of the layers: a refine does not answer it' });
  assert.deepEqual(concept.invalidated, ['ART_DIRECTION', 'CONCEPT']); assert.deepEqual(concept.steps, []); assert.deepEqual(concept.reused, []); assert.equal(concept.cost, null); assert.equal(concept.overrides, null);
  const layout = plan([d(DEFECT_KIND.UPSTREAM_LAYOUT)]); assert.deepEqual(layout.replan.upstream_nodes, ['ASSET_PLAN']); assert.deepEqual(layout.invalidated, ['ASSET_PLAN']);
  const both = plan([d(DEFECT_KIND.UPSTREAM_LAYOUT), d(DEFECT_KIND.UPSTREAM_CONCEPT)]); assert.deepEqual(both.replan.upstream_nodes, ['ART_DIRECTION', 'ASSET_PLAN', 'CONCEPT']);
  const mixed = plan([d(DEFECT_KIND.PLATE_UNSUITABLE), d(DEFECT_KIND.UPSTREAM_CONCEPT)]);
  assert.equal(mixed.status, 'REPLAN_REQUIRED', 'a layer repair is not run when the creative itself is in question'); assert.deepEqual(mixed.steps, []);
  assert.match(concept.plan_id, /^plan-[0-9a-f]{16}$/); assert.equal(concept.reasons.length, 1);
});

test('PL-6 breadth: strictly fewer generated layers than the scene has, and never more than two', () => {
  const regenerate = (a, ids) => planRepair({ artifact: a, defects: ids.map((id) => (id === 'plate' ? d(DEFECT_KIND.PLATE_UNSUITABLE) : d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: id }))) });
  const two = art(); // plate + 2 props = 3 generated layers
  assert.equal(regenerate(two, ['plate', 'lyr_mid']).status, 'PLANNED');
  assert.deepEqual(regenerate(two, ['plate', 'lyr_mid', 'lyr_fg']).block, { code: REPAIR_BLOCK.REPAIR_SCOPE_TOO_BROAD, detail: { regenerated: 3, generated_layers: 3, limit: 2 }, replan: 'REPLAN_THE_SCENE' });
  const one = withProps(1); // plate + 1 prop = 2 generated layers
  assert.equal(regenerate(one, ['lyr_0']).status, 'PLANNED'); assert.equal(regenerate(one, ['plate']).status, 'PLANNED');
  assert.deepEqual(regenerate(one, ['plate', 'lyr_0']).block.detail, { regenerated: 2, generated_layers: 2, limit: 2 });
  const four = withProps(4); // plate + 4 props = 5 generated layers
  assert.equal(regenerate(four, ['plate', 'lyr_0']).status, 'PLANNED');
  assert.deepEqual(regenerate(four, ['lyr_0', 'lyr_1', 'lyr_2']).block.detail, { regenerated: 3, generated_layers: 5, limit: 2 });
  const zero = withProps(0); assert.equal(regenerate(zero, ['plate']).status, 'BLOCKED', 'regenerating the only generated layer is a regeneration');
});

test('PL-7 working memory: attempts, the ceiling, the fingerprint of a failure, per scene', () => {
  const memory = createRefineMemory(); const defect = d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' });
  const p = plan([defect], { memory }); record(memory, p, 'REPAIRED');
  assert.equal(plan([defect], { memory }).status, 'PLANNED', 'a repair that worked is not a failed repair');
  record(memory, p, 'REJECTED'); assert.equal(plan([defect], { memory }).block.code, REPAIR_BLOCK.REPEATED_FAILED_REPAIR);
  assert.equal(plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' })], { memory }).status, 'PLANNED', 'another repair is not the same repair');
  const ceiling = createRefineMemory(); for (let i = 0; i < 3; i += 1) ceiling.record('scn_probe', { plan_id: `p${i}`, fingerprint: `f${i}`, steps: [], outcome: 'REPAIRED' });
  assert.equal(plan([defect], { memory: ceiling }).block.code, REPAIR_BLOCK.REFINE_ATTEMPTS_EXHAUSTED); assert.equal(plan([defect], { memory: ceiling }).block.detail, '3 repairs of this scene were already attempted');
  const two = createRefineMemory(); for (let i = 0; i < 2; i += 1) two.record('scn_probe', { plan_id: `p${i}`, fingerprint: `f${i}`, steps: [], outcome: 'REPAIRED' });
  assert.equal(plan([defect], { memory: two }).status, 'PLANNED');
  const other = createRefineMemory(); for (let i = 0; i < 3; i += 1) other.record('another-scene', { plan_id: `p${i}`, fingerprint: `f${i}`, steps: [], outcome: 'REPAIRED' });
  assert.equal(plan([defect], { memory: other }).status, 'PLANNED', 'the memory is per scene');
  // plain data, isolated copies
  const exported = memory.export(); exported.scenes.scn_probe.attempts.length = 0; assert.equal(memory.attempts('scn_probe').length, 2);
  const list = memory.attempts('scn_probe'); list.pop(); assert.equal(memory.attempts('scn_probe').length, 2);
  assert.equal(createRefineMemory(memory.export()).attempts('scn_probe').length, 2); assert.equal(memory.export().schema, 'refine-memory@1'); assert.deepEqual(createRefineMemory().attempts('x'), []);
  const original = { plan_id: 'a' }; const m = createRefineMemory(); m.record('s', original); original.plan_id = 'changed'; assert.equal(m.attempts('s')[0].plan_id, 'a');
});

test('PL-8 pricing: the plan prices exactly the regenerated lines, to the cent of a billionth', () => {
  const pricing = { prk_mid: 0.034, plk_probe: 0.069, prk_fg: 0.034 };
  const p = plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' }), d(DEFECT_KIND.PLATE_UNSUITABLE)], { pricing });
  assert.deepEqual(p.cost.lines, [{ request_key: 'prk_mid', max_candidates: 2, unit_eur: 0.034, max_eur: 0.068 }, { request_key: 'plk_probe', max_candidates: 2, unit_eur: 0.069, max_eur: 0.138 }]);
  assert.deepEqual(plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })], { pricing: { prk_mid: 0.1 + 0.2 } }).cost.lines[0].max_eur, 0.6);
  assert.deepEqual(plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })], { pricing: { other: 1 } }).cost.lines[0], { request_key: 'prk_mid', max_candidates: 2, unit_eur: null, max_eur: null });
  assert.equal(plan([d(DEFECT_KIND.TEXT_ILLEGIBLE)], { pricing }).cost.lines.length, 0);
});

test('PL-9 the dependency map: every node, every dependency, the digest, and the closure', () => {
  const map = buildLayerDependencyMap(art()); const by = Object.fromEntries(map.nodes.map((n) => [n.node_id, n]));
  assert.deepEqual(map.nodes.filter((n) => n.upstream).map((n) => n.node_id), [...UPSTREAM_NODES]);
  assert.deepEqual(by['PLATE:plk_probe'].depends_on, ['ART_DIRECTION']); assert.deepEqual(by['PROP:lyr_mid'].depends_on, ['ART_DIRECTION', 'PRODUCT_IDENTITY']); assert.deepEqual(by.PRODUCT.depends_on, ['PRODUCT_IDENTITY']);
  assert.deepEqual(by['TEXT:HEADLINE'].depends_on, ['ASSET_PLAN']); assert.deepEqual(by.COMPOSITE_BASE.depends_on, ['PLATE:plk_probe', 'PROP:lyr_mid']); assert.deepEqual(by.COMPOSITE_STACK.depends_on, ['PLATE:plk_probe', 'PROP:lyr_mid', 'PROP:lyr_fg', 'PRODUCT']);
  assert.deepEqual(by['TEXT_STYLE:HEADLINE'].depends_on, ['COMPOSITE_STACK', 'TEXT:HEADLINE']); assert.deepEqual(by.RENDER.depends_on, ['COMPOSITE_BASE', 'PRODUCT', 'PROP:lyr_fg', 'TEXT:HEADLINE', 'TEXT_STYLE:HEADLINE']);
  assert.deepEqual(map.nodes.filter((n) => n.protected).map((n) => n.node_id), ['PRODUCT', 'TEXT:HEADLINE']);
  assert.equal(by.PRODUCT.digest.length, 64); assert.equal(by['PLATE:plk_probe'].digest, '1'.repeat(40)); assert.equal(by.RENDER.digest, 'c'.repeat(40));
  assert.equal(buildLayerDependencyMap(art()).digest, map.digest); const other = art(); other.nodes.props[0].box.x += 1; assert.notEqual(buildLayerDependencyMap(other).digest, map.digest);
  const noRender = art(); noRender.nodes.render.png_sha256 = undefined; assert.equal(by.RENDER.digest, 'c'.repeat(40)); assert.equal(buildLayerDependencyMap(noRender).nodes.find((n) => n.node_id === 'RENDER').digest, null);
  for (const broken of [null, {}, { ...art(), schema: 'x' }, { ...art(), nodes: { ...art().nodes, plate: undefined } }, { ...art(), nodes: { ...art().nodes, props: {} } }, { ...art(), nodes: { ...art().nodes, product: undefined } }, { ...art(), nodes: { ...art().nodes, text: null } }, { ...art(), nodes: { ...art().nodes, text_style: null } }, { ...art(), nodes: { ...art().nodes, composite: undefined } }]) assert.equal(buildLayerDependencyMap(broken), null);
  assert.deepEqual(dependentsOfNodes(map, ['PLATE:plk_probe']), ['COMPOSITE_BASE', 'COMPOSITE_STACK', 'RENDER', 'TEXT_STYLE:HEADLINE']);
  assert.deepEqual(dependentsOfNodes(map, ['COMPOSITE_BASE', 'COMPOSITE_STACK']), ['RENDER', 'TEXT_STYLE:HEADLINE']);
  assert.deepEqual(dependentsOfNodes(map, ['RENDER']), []);
  const inv = invalidationOf(map, ['PROP:lyr_mid']); assert.deepEqual(inv.reached_protected, []); assert.deepEqual(inv.reached_upstream, []);
  assert.deepEqual(invalidationOf(map, ['PRODUCT']).reached_protected, ['PRODUCT']); assert.deepEqual(invalidationOf(map, ['ART_DIRECTION']).reached_upstream, ['ART_DIRECTION']);
  assert.ok(invalidationOf(map, ['ART_DIRECTION']).invalidated.includes('PLATE:plk_probe'), 'an upstream change does reach the layers made from it');
  assert.deepEqual(invalidationOf(map, ['RENDER']).reused.includes('RENDER'), false);
});

test('PL-10 a defect is a validated, deterministic statement; its owner is the topmost layer at its place', () => {
  const a = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: 'lyr_mid' }); const b = createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: 'lyr_mid' });
  assert.deepEqual(a, b); assert.match(a.defect_id, /^def-[0-9a-f]{16}$/); assert.notEqual(a.defect_id, createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, layer_id: 'lyr_fg' }).defect_id); assert.ok(Object.isFrozen(a) && Object.isFrozen(a.evidence));
  assert.deepEqual(a.evidence, { observed_in: 'OWNER_REGION', rule: null, measurement: null }); assert.equal(a.severity, 'MEDIUM'); assert.equal(a.source, 'OWNER_REGION'); assert.equal(a.region, null); assert.equal(a.reason, null);
  for (const bad of [{ kind: 'X' }, { kind: DEFECT_KIND.PROP_UNUSABLE, source: 'MAGIC' }, { kind: DEFECT_KIND.PROP_UNUSABLE, severity: 'NONE' }, { kind: DEFECT_KIND.PROP_UNUSABLE, region: { x: 0, y: 0, width: 1 } }, { kind: DEFECT_KIND.PROP_UNUSABLE, region: { x: NaN, y: 0, width: 1, height: 1 } }, { kind: DEFECT_KIND.PROP_UNUSABLE, region: { x: 0, y: 0, width: -1, height: 1 } }, { kind: DEFECT_KIND.PROP_UNUSABLE, region: { x: 0, y: 0, width: 1, height: 0 } }]) assert.throws(() => createDefectRegion(bad), DefectError);
  assert.equal(new DefectError('m').code, REPAIR_BLOCK.DEFECT_INVALID);
  createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, region: { x: 0, y: 0, width: 1, height: 1 }, severity: 'HIGH' });
  const at = (region, extra = {}) => attributeDefect(art(), d(DEFECT_KIND.PROP_UNUSABLE, { region, ...extra }));
  assert.deepEqual(at({ x: 770, y: 990, width: 2, height: 2 }), { node_id: 'PROP:lyr_fg', via: 'REGION', touches_product: true });
  assert.deepEqual(at({ x: 100, y: 990, width: 2, height: 2 }), { node_id: 'PROP:lyr_mid', via: 'REGION', touches_product: false });
  assert.deepEqual(at({ x: 500, y: 700, width: 2, height: 2 }), { node_id: 'PRODUCT', via: 'REGION', touches_product: true });
  assert.deepEqual(at({ x: 500, y: 150, width: 2, height: 2 }), { node_id: 'TEXT:HEADLINE', via: 'REGION', touches_product: false });
  assert.deepEqual(at({ x: 10, y: 10, width: 2, height: 2 }), { node_id: 'PLATE:plk_probe', via: 'REGION', touches_product: false });
  assert.deepEqual(at({ x: 4000, y: 10, width: 2, height: 2 }), { node_id: null, via: 'NONE', touches_product: false });
  assert.deepEqual(attributeDefect(art(), d(DEFECT_KIND.PROP_UNUSABLE)), { node_id: null, via: 'NONE', touches_product: false });
  assert.deepEqual(attributeDefect(art(), d(DEFECT_KIND.PROP_UNUSABLE, { node_id: 'RENDER' })), { node_id: 'RENDER', via: 'NODE', touches_product: false });
  assert.deepEqual(attributeDefect(art(), d(DEFECT_KIND.PROP_UNUSABLE, { node_id: 'COMPOSITE_STACK', region: { x: 500, y: 700, width: 2, height: 2 } })), { node_id: 'COMPOSITE_STACK', via: 'NODE', touches_product: true });
  assert.deepEqual(attributeDefect(art(), d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' })), { node_id: 'PROP:lyr_fg', via: 'LAYER', touches_product: false });
  assert.equal(attributeDefect(art(), d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'zzz' })).node_id, null);
  // the region is tested at its CENTRE, and the product is above a midground prop at the same place
  const stacked = art(); stacked.nodes.props[0].box = { x: 300, y: 400, width: 480, height: 700 };
  assert.equal(attributeDefect(stacked, d(DEFECT_KIND.PROP_UNUSABLE, { region: { x: 500, y: 700, width: 2, height: 2 } })).node_id, 'PRODUCT');
  const fgOver = art(); fgOver.nodes.props[1].box = { x: 300, y: 400, width: 480, height: 700 };
  assert.equal(attributeDefect(fgOver, d(DEFECT_KIND.PROP_UNUSABLE, { region: { x: 500, y: 700, width: 2, height: 2 } })).node_id, 'PROP:lyr_fg', 'a foreground prop over the product owns the pixels');
  const textOver = art(); textOver.nodes.text[0].geometry = { x: 300, y: 400, width: 480, height: 700 };
  assert.equal(attributeDefect(textOver, d(DEFECT_KIND.PROP_UNUSABLE, { region: { x: 500, y: 700, width: 2, height: 2 } })).node_id, 'TEXT:HEADLINE');
  const edge = at({ x: 1079, y: 1349, width: 1, height: 1 }); assert.equal(edge.node_id, 'PLATE:plk_probe');
  assert.equal(at({ x: 1080, y: 10, width: 1, height: 1 }).node_id, null, 'the plate ends at the canvas');
});

test('PL-11 the gates of a delivered candidate and the critic vocabulary map to defects, exactly', () => {
  const pf = defectsFromCandidate({ status: 'PREFLIGHT_FAIL', preflight: { checks: [{ code: 'INSUFFICIENT_CONTRAST', status: 'FAIL', evidence: { ratio: 2.1 } }, { code: 'LEGIBLE_SIZE', status: 'WARN' }, { code: 'SAFE_ZONE', status: 'FAIL' }, { code: 'ASPECT', status: 'PASS' }, { code: 'HIDDEN', status: 'NOT_APPLICABLE' }] } });
  assert.deepEqual(pf.map((x) => [x.kind, x.evidence.rule, x.source]), [[DEFECT_KIND.TEXT_ILLEGIBLE, 'INSUFFICIENT_CONTRAST', 'GATE'], [DEFECT_KIND.TEXT_ILLEGIBLE, 'LEGIBLE_SIZE', 'GATE'], [DEFECT_KIND.COMPOSITION_REFUSED, 'SAFE_ZONE', 'GATE']]);
  assert.deepEqual(pf[0].evidence, { observed_in: 'creative-preflight', rule: 'INSUFFICIENT_CONTRAST', measurement: { ratio: 2.1 } }); assert.equal(pf[0].reason, 'the preflight check INSUFFICIENT_CONTRAST failed');
  assert.deepEqual(defectsFromCandidate({ status: 'PREFLIGHT_FAIL', preflight: { checks: [{ code: 'X', status: 'FAIL' }] } })[0].evidence.measurement, null);
  const fid = defectsFromCandidate({ status: 'FIDELITY_FAIL', fidelity: { failed: [{ check: 'PIECE_COUNT', observation: 'INSTANCE_COUNT', outcome: 'FAIL', evidence: { ncc: 0.9 } }, { check: 'GEOMETRY', observation: 'OUTLINE_EDGE', outcome: 'FAIL' }] } });
  assert.deepEqual(fid.map((x) => [x.kind, x.evidence.rule, x.evidence.observed_in]), [[DEFECT_KIND.PROP_RESEMBLES_THE_PRODUCT, 'PIECE_COUNT/INSTANCE_COUNT', 'identity-fidelity-gate'], [DEFECT_KIND.PRODUCT_PIXELS, 'GEOMETRY/OUTLINE_EDGE', 'identity-fidelity-gate']]);
  const gd = defectsFromCandidate({ status: 'GUARDIAN_FAIL', guardian: { rule_results: [{ rule_id: 'MIN_CONTRAST', outcome: 'FAIL' }, { rule_id: 'READABLE_TEXT', outcome: 'FAIL' }, { rule_id: 'LOGO_PLACEMENT', outcome: 'FAIL' }, { rule_id: 'OK', outcome: 'PASS' }] } });
  assert.deepEqual(gd.map((x) => x.kind), [DEFECT_KIND.TEXT_ILLEGIBLE, DEFECT_KIND.COMPOSITION_REFUSED, DEFECT_KIND.COMPOSITION_REFUSED]); assert.deepEqual(gd.map((x) => x.evidence.observed_in), ['brand-guardian', 'brand-guardian', 'brand-guardian']);
  assert.deepEqual(defectsFromCandidate({ status: 'READY_FOR_REVIEW' }), []); assert.deepEqual(defectsFromCandidate(null), []); assert.deepEqual(defectsFromCandidate({ status: 'PREFLIGHT_FAIL' }), []);
  assert.deepEqual(Object.keys(KIND_FOR_INTENT).sort(), ['ADJUST_CLAIM_PRESENTATION', 'CLARIFY_TEXT_HIERARCHY', 'CLARIFY_VISUAL_HIERARCHY', 'ELEVATE_RETAIL_QUALITY', 'IMPROVE_PRODUCT_ENVIRONMENT_INTEGRATION', 'INCREASE_PRODUCT_DOMINANCE', 'INTEGRATE_PRICE_WITH_THE_COMPOSITION', 'REBALANCE_COMPOSITION', 'REBALANCE_WHITESPACE', 'RECONSIDER_THE_OVERALL_CONCEPT', 'REDUCE_TEMPLATE_FEEL', 'REFINE_TYPOGRAPHIC_COMPOSITION', 'REGENERATE_CLEANER_ENVIRONMENT', 'STRENGTHEN_BRAND_EXPRESSION']);
  assert.deepEqual(KIND_FOR_INTENT, {
    REGENERATE_CLEANER_ENVIRONMENT: DEFECT_KIND.PLATE_UNSUITABLE, CLARIFY_TEXT_HIERARCHY: DEFECT_KIND.TEXT_ILLEGIBLE, REFINE_TYPOGRAPHIC_COMPOSITION: DEFECT_KIND.TEXT_ILLEGIBLE, ADJUST_CLAIM_PRESENTATION: DEFECT_KIND.TEXT_ILLEGIBLE, INTEGRATE_PRICE_WITH_THE_COMPOSITION: DEFECT_KIND.TEXT_ILLEGIBLE,
    CLARIFY_VISUAL_HIERARCHY: DEFECT_KIND.PROP_NO_ROOM, REBALANCE_COMPOSITION: DEFECT_KIND.PROP_NO_ROOM, REBALANCE_WHITESPACE: DEFECT_KIND.PROP_NO_ROOM, INCREASE_PRODUCT_DOMINANCE: DEFECT_KIND.UPSTREAM_LAYOUT, IMPROVE_PRODUCT_ENVIRONMENT_INTEGRATION: DEFECT_KIND.REQUIRES_PHASE_5,
    STRENGTHEN_BRAND_EXPRESSION: DEFECT_KIND.UPSTREAM_CONCEPT, ELEVATE_RETAIL_QUALITY: DEFECT_KIND.UPSTREAM_CONCEPT, REDUCE_TEMPLATE_FEEL: DEFECT_KIND.UPSTREAM_CONCEPT, RECONSIDER_THE_OVERALL_CONCEPT: DEFECT_KIND.UPSTREAM_CONCEPT,
  });
  const mapped = defectsFromRevisionIntents(['REGENERATE_CLEANER_ENVIRONMENT', { intent: 'CLARIFY_TEXT_HIERARCHY' }], { layer_id: 'lyr_mid' });
  assert.deepEqual(mapped.map((x) => [x.kind, x.source, x.layer_id, x.evidence.rule, x.reason]), [[DEFECT_KIND.PLATE_UNSUITABLE, 'CRITIQUE', 'lyr_mid', 'REGENERATE_CLEANER_ENVIRONMENT', 'critique: REGENERATE_CLEANER_ENVIRONMENT'], [DEFECT_KIND.TEXT_ILLEGIBLE, 'CRITIQUE', 'lyr_mid', 'CLARIFY_TEXT_HIERARCHY', 'critique: CLARIFY_TEXT_HIERARCHY']]);
  assert.deepEqual(defectsFromRevisionIntents(undefined), []); assert.deepEqual(defectsFromRevisionIntents(null), []);
  assert.throws(() => defectsFromRevisionIntents([{ nothing: 1 }]), DefectError);
  const withRegion = defectsFromRevisionIntents(['REBALANCE_COMPOSITION'], { region: { x: 1, y: 2, width: 3, height: 4 }, node_id: 'PROP:lyr_mid' })[0]; assert.deepEqual(withRegion.region, { x: 1, y: 2, width: 3, height: 4 }); assert.equal(withRegion.node_id, 'PROP:lyr_mid');
});

test('PL-12 the masked-edit request is validated field by field, a mask that touches a protected region is refused, and nothing executes without a provider and an open gate', async () => {
  const good = { source_image: { sha256: 'a'.repeat(40), width: 100, height: 100 }, mask: { width: 100, height: 100, regions: [{ x: 0, y: 0, width: 20, height: 20 }] }, instruction: 'x', protected_regions: [{ x: 50, y: 50, width: 40, height: 40 }], expected_output_class: 'PROP_LAYER', provenance: { requested_by: 'r' }, cost_estimate_eur: 0 };
  assert.deepEqual(validateMaskedEditRequest(good), { ok: true, problems: [] });
  const bad = (over) => validateMaskedEditRequest({ ...good, ...over }).problems;
  assert.deepEqual(bad({ source_image: undefined }), ['SOURCE_IMAGE_NEEDS_SHA256_WIDTH_HEIGHT']); assert.deepEqual(bad({ source_image: { sha256: 'a', width: 1 } }), ['SOURCE_IMAGE_NEEDS_SHA256_WIDTH_HEIGHT', 'MASK_SIZE_DIFFERS_FROM_THE_SOURCE']);
  assert.deepEqual(bad({ mask: undefined }), ['MASK_NEEDS_SIZE_AND_REGIONS_OR_PNG']); assert.deepEqual(bad({ mask: { width: 100, height: 100 } }), ['MASK_NEEDS_SIZE_AND_REGIONS_OR_PNG']); assert.deepEqual(bad({ mask: { width: 100, regions: [] } }), ['MASK_NEEDS_SIZE_AND_REGIONS_OR_PNG']);
  assert.deepEqual(bad({ mask: { width: 99, height: 100, regions: [] } }), ['MASK_SIZE_DIFFERS_FROM_THE_SOURCE']); assert.deepEqual(bad({ mask: { width: 100, height: 99, regions: [] } }), ['MASK_SIZE_DIFFERS_FROM_THE_SOURCE']);
  assert.deepEqual(bad({ instruction: '' }), ['INSTRUCTION_REQUIRED']); assert.deepEqual(bad({ instruction: 5 }), ['INSTRUCTION_REQUIRED']);
  assert.deepEqual(bad({ protected_regions: 'x' }), ['PROTECTED_REGIONS_MUST_BE_RECTANGLES']); assert.deepEqual(bad({ protected_regions: [{ x: 1, y: 1, width: 0, height: 5 }] }), ['PROTECTED_REGIONS_MUST_BE_RECTANGLES']); assert.deepEqual(bad({ protected_regions: [null] }), ['PROTECTED_REGIONS_MUST_BE_RECTANGLES']);
  assert.deepEqual(bad({ expected_output_class: 'WHOLE_IMAGE' }), ['OUTPUT_CLASS_NOT_ALLOWED']); assert.deepEqual(bad({ provenance: undefined }), ['PROVENANCE_REQUIRED']); assert.deepEqual(bad({ provenance: { x: 1 } }), ['PROVENANCE_REQUIRED']);
  assert.deepEqual(bad({ cost_estimate_eur: -0.01 }), ['COST_ESTIMATE_REQUIRED']); assert.deepEqual(bad({ cost_estimate_eur: 'x' }), ['COST_ESTIMATE_REQUIRED']); assert.deepEqual(validateMaskedEditRequest(undefined).ok, false);
  assert.deepEqual(bad({ mask: { width: 100, height: 100, regions: [{ x: 45, y: 45, width: 20, height: 20 }] } }), ['MASK_TOUCHES_A_PROTECTED_REGION']);
  assert.deepEqual(bad({ mask: { width: 100, height: 100, regions: [{ x: 90, y: 50, width: 10, height: 10 }] } }), [], 'a mask that only touches the edge is outside');
  // a PNG mask: white and opaque is editable
  const pixels = new Uint8Array(100 * 100 * 4); for (let i = 0; i < 100 * 100; i += 1) pixels.set([0, 0, 0, 255], i * 4);
  const paint = (x0, y0, x1, y1) => { const p = new Uint8Array(pixels); for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) p.set([255, 255, 255, 255], (y * 100 + x) * 4); return encodePng({ width: 100, height: 100, pixels: p }); };
  assert.deepEqual(bad({ mask: { width: 100, height: 100, png: paint(0, 0, 10, 10) } }), []); assert.deepEqual(bad({ mask: { width: 100, height: 100, png: paint(60, 60, 70, 70) } }), ['MASK_TOUCHES_A_PROTECTED_REGION']);
  const transparent = new Uint8Array(100 * 100 * 4); for (let i = 0; i < 100 * 100; i += 1) transparent.set([255, 255, 255, 0], i * 4); assert.deepEqual(bad({ mask: { width: 100, height: 100, png: encodePng({ width: 100, height: 100, pixels: transparent }) } }), [], 'a transparent pixel is not editable');
  const grey = new Uint8Array(100 * 100 * 4); for (let i = 0; i < 100 * 100; i += 1) grey.set([100, 100, 100, 255], i * 4); assert.deepEqual(bad({ mask: { width: 100, height: 100, png: encodePng({ width: 100, height: 100, pixels: grey }) } }), [], 'a dark pixel is not editable');
  // protected pixels
  const src = encodePng({ width: 100, height: 100, pixels }); const changed = new Uint8Array(pixels); changed.set([9, 9, 9, 255], (60 * 100 + 60) * 4);
  assert.deepEqual(protectedRegionsIntact({ source: src, output: src, protectedRegions: good.protected_regions }), { intact: true });
  assert.deepEqual(protectedRegionsIntact({ source: src, output: encodePng({ width: 100, height: 100, pixels: changed }), protectedRegions: good.protected_regions }), { intact: false, reason: 'A_PROTECTED_PIXEL_CHANGED', at: { x: 60, y: 60 } });
  assert.deepEqual(protectedRegionsIntact({ source: src, output: encodePng({ width: 100, height: 100, pixels: changed }), protectedRegions: [{ x: 0, y: 0, width: 10, height: 10 }] }), { intact: true });
  assert.deepEqual(protectedRegionsIntact({ source: src, output: encodePng({ width: 50, height: 50, pixels: new Uint8Array(50 * 50 * 4) }), protectedRegions: [] }), { intact: false, reason: 'OUTPUT_SIZE_DIFFERS' });
  for (const [ch, at] of [[3, 0], [0, 1], [1, 2], [2, 3]]) { const px = new Uint8Array(pixels); px[(60 * 100 + 60) * 4 + ch] = ch === 3 ? 7 : 5; assert.equal(protectedRegionsIntact({ source: src, output: encodePng({ width: 100, height: 100, pixels: px }), protectedRegions: good.protected_regions }).intact, false, `channel ${ch} (${at})`); }
  // the flow, with a ledger
  const ledger = createDecisionLedger(); const calls = []; const double = { tool_id: 't', async edit(r) { calls.push(r); return { output_bytes: src }; } };
  const r1 = await requestMaskedEdit({ ports: {}, request: good, ledger }); assert.deepEqual([r1.status, r1.executed, r1.output], ['PROVIDER_NOT_CONNECTED', false, null]);
  const r2 = await requestMaskedEdit({ ports: { maskedEdit: double }, request: good, ledger, gate: { status: 'NOT_READY' } }); assert.deepEqual([r2.status, r2.reason, r2.executed], ['BLOCKED', 'PROVIDER_GATE_NOT_OPEN', false]); assert.equal(calls.length, 0);
  const r3 = await requestMaskedEdit({ ports: { maskedEdit: double }, request: good, ledger, gate: { status: 'OPEN_BY_OWNER' } }); assert.deepEqual([r3.status, r3.executed], ['EXECUTED', true]); assert.equal(calls.length, 1); assert.equal(r3.output.output_bytes, src);
  const r4 = await requestMaskedEdit({ ports: { maskedEdit: double }, request: { ...good, instruction: '' }, ledger, gate: { status: 'OPEN_BY_OWNER' } }); assert.deepEqual([r4.status, r4.reason, r4.executed], ['BLOCKED', 'REQUEST_INVALID', false]); assert.equal(calls.length, 1);
  const r5 = await requestMaskedEdit({ ports: { maskedEdit: double }, request: { ...good, mask: { width: 100, height: 100, regions: [{ x: 45, y: 45, width: 20, height: 20 }] } }, ledger, gate: { status: 'OPEN_BY_OWNER' } }); assert.equal(r5.reason, 'MASK_TOUCHES_A_PROTECTED_REGION'); assert.equal(calls.length, 1);
  const tamper = { tool_id: 't', async edit() { return { output_bytes: encodePng({ width: 100, height: 100, pixels: changed }) }; } };
  const r6 = await requestMaskedEdit({ ports: { maskedEdit: tamper }, request: good, sourcePng: src, ledger, gate: { status: 'OPEN_BY_OWNER' } }); assert.deepEqual([r6.status, r6.reason, r6.output], ['REJECTED', 'OUTPUT_CHANGED_A_PROTECTED_REGION', null]);
  assert.deepEqual(ledger.entries().map((e) => e.outcome.status), ['PROVIDER_NOT_CONNECTED', 'BLOCKED', 'EXECUTED', 'BLOCKED', 'BLOCKED', 'REJECTED']);
  assert.ok(ledger.entries().every((e) => e.decision === 'MASKED_EDIT_REQUEST' && e.decided_by === 'nordla:masked-edit-capability@1' && e.basis[0] === 'a'.repeat(40)));
  const cap = describeMaskedEditCapability({ maskedEdit: double }); assert.deepEqual([cap.provider, cap.executable, cap.tool_id], ['PROVIDER_CONNECTED', true, 't']); assert.deepEqual(describeMaskedEditCapability(undefined).provider, 'PROVIDER_NOT_CONNECTED');
  assert.equal(describeMaskedEditCapability({ maskedEdit: { tool_id: 't' } }).executable, false); assert.equal(describeMaskedEditCapability({ maskedEdit: { edit() {} } }).executable, false); assert.ok(Object.isFrozen(describeMaskedEditCapability({})));
});

test('PL-13 scopes are a closed set, the plan is deterministic and frozen, and a request with no name defaults only where there is a single candidate', () => {
  assert.deepEqual([...REPAIR_SCOPES], ['PROP_REPAIR', 'PLATE_REPAIR', 'TYPOGRAPHY_REPAIR', 'COMPOSITE_REPAIR', 'LAYER_REMOVE_OR_REPOSITION']);
  const defect = d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' }); const p = plan([defect]);
  assert.deepEqual(p, plan([defect])); assert.ok(Object.isFrozen(p) && Object.isFrozen(p.block ?? p));
  assert.notEqual(p.plan_id, plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' })]).plan_id); assert.notEqual(p.artifact_digest, planRepair({ artifact: withProps(1), defects: [d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_0' })] }).artifact_digest);
  const single = withProps(1);
  assert.equal(planRepair({ artifact: single, defects: [d(DEFECT_KIND.PROP_UNUSABLE)] }).steps[0].target, 'PROP:lyr_0'); assert.equal(planRepair({ artifact: single, defects: [d(DEFECT_KIND.PROP_NO_ROOM)] }).steps[0].target, 'PROP:lyr_0');
  assert.equal(planRepair({ artifact: single, defects: [d(DEFECT_KIND.PROP_UNUSABLE)] }).evidence[0].via, 'ONLY_PROP'); assert.equal(plan([d(DEFECT_KIND.PLATE_UNSUITABLE)]).evidence[0].via, 'ONLY_PLATE');
  assert.equal(plan([d(DEFECT_KIND.PROP_UNUSABLE)]).block.code, REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, 'two props: nothing is guessed');
  assert.equal(planRepair({ artifact: withProps(0), defects: [d(DEFECT_KIND.PROP_UNUSABLE)] }).block.code, REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE);
  assert.equal(plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'unknown' })]).block.code, REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, 'a named but unknown layer is never re-targeted');
  assert.equal(plan([d(DEFECT_KIND.PLATE_UNSUITABLE, { node_id: 'unknown' })]).block.code, REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE);
  assert.equal(planRepair({ artifact: art(), defects: [defect], expectedArtifactDigest: p.artifact_digest }).status, 'PLANNED'); assert.equal(planRepair({ artifact: art(), defects: [defect], expectedArtifactDigest: 'x' }).block.code, REPAIR_BLOCK.ARTIFACT_STALE);
  assert.equal(plan(undefined).block.code, REPAIR_BLOCK.NO_DEFECT); assert.equal(plan('x').block.code, REPAIR_BLOCK.NO_DEFECT); assert.equal(plan([]).block.code, REPAIR_BLOCK.NO_DEFECT);
  assert.equal(plan([defect], { allowedScopes: ['PROP_REPAIR', 'PLATE_REPAIR'] }).status, 'PLANNED'); assert.equal(plan([defect], { allowedScopes: [] }).block.code, REPAIR_BLOCK.REPAIR_SCOPE_INVALID); assert.equal(plan([defect], { allowedScopes: ['PROP_REPAIR', 'NOPE'] }).block.code, REPAIR_BLOCK.REPAIR_SCOPE_INVALID);
  assert.deepEqual(plan([defect], { allowedScopes: ['NOPE'] }).block.detail, { planned: ['PROP_REPAIR'], allowed: ['NOPE'] });
});
