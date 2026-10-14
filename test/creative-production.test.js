import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { SCENE_FORBIDDEN } from '../src/creative-brain/substitutes.js';
import {
  COMPOSITION_LAYERING, LAYER_KIND, LAYER_SOURCE, LAYER_Z, OVERLAP_LIMIT, PRODUCTION_DEPENDS_ON, PRODUCTION_POLICY, PRODUCTION_UNIT_COSTS, PRODUCTION_NODE,
  createProductionPlanner, estimateProduction, recoverLockedCopy, reassemble, reserveProduction, selectTool, TOOL_CANDIDATES, validateSceneSpec, checkTextFeasibility, textLayersOf,
} from '../src/creative-production/index.js';
import { createMemoryCheckpointStore } from '../src/creative-campaign/index.js';
import { FORMAT_RESOURCES } from '../src/creative-planning/index.js';
import {
  campaignBrief, campaignRequest, fullScript, makeCampaign,
} from './creative-campaign-world.js';
import { longText } from './creative-planning-world.js';
import { artDirectionAnswer } from './creative-brain-world.js';
import { FONT, plannedCampaign, produced } from './creative-production-world.js';

// LAYERED SCENE PRODUCTION (`// LS-N` layers, `// TI-N` text integrity, `// PV-N` provenance, `// PB-N` budget, `// PS-N` state, `// LG-N` legacy). No provider, no image: specification and gates.

const sha = (t) => createHash('sha256').update(t).digest('hex');
const sharedOf = (r) => new Map(r.shared_layers.map((l) => [l.request_key, l]));
const layersOf = (scene, kind) => scene.layers.filter((l) => l.kind === kind);

test('LS-1 every scene is a z-ordered stack: one generated plate, bounded props, exactly one real product, then the planned text', async () => {
  const { result, brief } = await produced({ assets: 7 });
  assert.equal(result.status, 'SPECIFIED'); assert.equal(result.scenes.length, 7);
  for (const s of result.scenes) {
    assert.equal(s.status, 'SPECIFIED'); assert.deepEqual(s.blocks, []);
    assert.equal(s.layers[0].kind, 'PLATE'); assert.equal(s.layers[0].source, LAYER_SOURCE.GENERATED); assert.equal(s.layers[0].z, 0);
    const product = layersOf(s, LAYER_KIND.PRODUCT);
    assert.equal(product.length, 1); assert.equal(product[0].source, LAYER_SOURCE.REAL_ASSET); assert.equal(product[0].asset_ref, brief.asset.ref); assert.equal(product[0].sha256, brief.asset.sha256); assert.equal(product[0].product_ref, brief.ids.product_ref);
    assert.deepEqual([product[0].allow_crop, product[0].allow_relight, product[0].allow_rotation, product[0].preservation], [false, false, false, 'COMPOSITE']);
    const zs = s.layers.map((l) => l.z); assert.deepEqual(zs, [...zs].sort((a, b) => a - b)); assert.equal(new Set(zs).size, zs.length);
    assert.equal(s.layers.at(-1).kind, 'TEXT'); assert.ok(layersOf(s, 'TEXT').every((l) => l.z >= LAYER_Z.TEXT));
    assert.ok(layersOf(s, 'PROP_BACKGROUND').concat(layersOf(s, 'PROP_MIDGROUND')).every((l) => l.z < product[0].z), 'background and midground props are under the product');
    assert.ok(layersOf(s, 'PROP_FOREGROUND').every((l) => l.z > product[0].z));
    assert.deepEqual(s.composite.order, s.layers.map((l) => l.layer_id)); assert.equal(s.composite.suitability_gate, 'ENVIRONMENT_SUITABILITY_UNCHANGED');
    assert.ok(s.composite.rules.includes('THE_PRODUCT_PIXELS_NEVER_CHANGE'));
    assert.deepEqual(validateSceneSpec(s, { identity: result.product_identity, sharedLayers: sharedOf(result), approvedWords: new Set() }), []);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.layers[0]));
  }
});

test('LS-2 the composition decides the layering: text-first and close crops carry no prop, a foreground prop only where the composition allows it and with a bounded overlap', async () => {
  const { result, campaign } = await produced({ assets: 9, art: { narrative_elements: [
    { element: 'a pair of worn tools laid aside at the edge of the bench', reason: 'they show the maker has just finished, the care taken in the making', zone: 'FOREGROUND' },
    { element: 'a soft window glow far behind the bench', reason: 'it places the finished piece at dusk, the quiet end of the work', zone: 'BACKGROUND' },
    { element: 'a brass scale beside the finished piece', reason: 'it shows the care taken in the making of the piece', zone: 'MIDGROUND' },
  ] } });
  const byIndex = new Map(campaign.asset_plans.map((a) => [a.index, a]));
  let sawForeground = false;
  for (const s of result.scenes) {
    const composition = byIndex.get(s.provenance.index).composition_intent; const rule = COMPOSITION_LAYERING[composition];
    const props = s.layers.filter((l) => l.kind.startsWith('PROP_'));
    assert.ok(props.length <= Math.min(rule.props, PRODUCTION_POLICY.max_props_per_asset), `${composition}: ${props.length} props`);
    if (rule.props === 0) assert.equal(props.length, 0);
    const foreground = props.filter((l) => l.kind === 'PROP_FOREGROUND');
    assert.ok(foreground.length <= 1); if (!rule.foreground) assert.equal(foreground.length, 0, `${composition} allows no foreground`);
    for (const l of foreground) { sawForeground = true; assert.deepEqual([l.overlap.policy, l.overlap.max_share_of_product, l.overlap.may_cover_protected_regions], ['EDGE_ONLY', OVERLAP_LIMIT.EDGE_ONLY, false]); }
    for (const l of props.filter((x) => x.kind !== 'PROP_FOREGROUND')) assert.deepEqual([l.overlap.policy, l.overlap.max_share_of_product], ['NONE', 0]);
  }
  assert.ok(sawForeground, 'a foreground prop was specified somewhere');
});

test('LS-3 a generated layer is a text-only request that names nothing of the product, with its own prompt digest, size, candidates and forbidden list', async () => {
  const { result, brief } = await produced({ assets: 7 });
  for (const r of result.shared_layers) {
    assert.equal(r.carries_input_asset, false); assert.equal(r.n, 1); assert.equal(r.candidates, PRODUCTION_POLICY.candidates_per_generated_layer);
    assert.equal(r.prompt_sha256, sha(r.prompt)); assert.match(r.request_key, /^(plk|prk)_/); assert.deepEqual(r.produced_asset, { status: 'NOT_PRODUCED', request_key: r.request_key }, 'the produced asset will be tied back to this request');
    for (const forbidden of SCENE_FORBIDDEN) assert.ok(r.negative_prompt.includes(forbidden), forbidden);
    assert.ok(/(^|\W)(no text|no logo)/i.test(r.prompt));
    assert.ok(!r.prompt.toLowerCase().includes('phone') && !r.prompt.toLowerCase().includes(brief.ids.product_ref));
    if (r.kind === 'PLATE') { assert.deepEqual(r.size, { width: 1080, height: 1350, unit: 'px' }); assert.ok(!/reserve|calm area|empty zone|keep a/i.test(r.prompt), 'a plate does not ask the generator to keep a zone empty'); }
    else { assert.deepEqual(r.size, PRODUCTION_POLICY.prop_canvas); assert.match(r.prompt, /isolated on a plain neutral ground/); }
  }
  assert.ok(result.shared_layers.some((r) => r.negative_prompt.includes('polymer') || r.negative_prompt.includes('shell')), 'the family of the product is forbidden in the negative prompt');
});

test('LS-4 generated layers are reused: a plate per crop scale and a prop per element, whatever the number of assets', async () => {
  const seven = (await produced({ assets: 7 })).result; const ten = (await produced({ assets: 9 })).result;
  for (const r of [seven, ten]) {
    const plates = r.shared_layers.filter((l) => l.kind === 'PLATE'); const props = r.shared_layers.filter((l) => l.kind === 'PROP');
    assert.ok(plates.length <= PRODUCTION_POLICY.max_plates_per_campaign && plates.length < r.scenes.length);
    assert.equal(new Set(r.shared_layers.map((l) => l.request_key)).size, r.shared_layers.length, 'no layer is requested twice');
    const used = r.scenes.flatMap((s) => s.layers.filter((l) => l.source === 'GENERATED').map((l) => l.request_key));
    assert.ok(used.length > r.shared_layers.length, 'a layer is used by more than one scene');
    for (const s of r.scenes) assert.equal(plates.find((p) => p.request_key === s.layers[0].request_key).variant, ({ WIDE: 'WIDE', MID: 'MID', CLOSE: 'CLOSE' })[s.intent.crop_scale]);
    assert.ok(props.length <= 3);
  }
  assert.ok(ten.shared_layers.length <= seven.shared_layers.length + 1 && ten.shared_layers.length <= PRODUCTION_POLICY.max_plates_per_campaign + 3, 'two more assets add at most the third plate, not an image per asset');
});

test('LS-5 the tool of each capability is chosen once, written into the scene with the candidates passed over, and no fallback exists', async () => {
  const { result } = await produced({ assets: 5 });
  for (const s of result.scenes) {
    const plate = s.tools.find((t) => t.capability === 'ENVIRONMENT_PLATE_GENERATION');
    assert.equal(plate.selected.tool_id, 'text-to-image/primary'); assert.deepEqual(plate.candidates, ['text-to-image/primary', 'text-to-image/secondary']);
    assert.equal(plate.execution_policy, 'ONLY_THE_SELECTED_TOOL');
    assert.ok(s.tools.every((t) => t.selected && t.execution_policy === 'ONLY_THE_SELECTED_TOOL'));
    assert.ok(s.tools.some((t) => t.selected.executor === 'LOCAL') && s.tools.some((t) => t.selected.executor === 'PROVIDER'));
    assert.ok(!JSON.stringify(s).toLowerCase().includes('fallback'));
    assert.deepEqual(s.tools.find((t) => t.capability === 'LOCAL_SEGMENTATION').selected.data_class, 'PRIVATE');
  }
  assert.ok(!JSON.stringify(result).match(/qwen|alibaba|openai|gemini|dashscope/i), 'no provider brand in a specification');
});

test('LS-6 the same inputs give the same specification, byte for byte', async () => {
  const a = await produced({ assets: 6 }); const b = await produced({ assets: 6 });
  assert.equal(a.result.production.production_id, b.result.production.production_id);
  assert.deepEqual(a.result.scenes.map((s) => s.scene_id), b.result.scenes.map((s) => s.scene_id));
  assert.equal(JSON.stringify(a.result.shared_layers), JSON.stringify(b.result.shared_layers));
});

test('TI-1 the text of a layer is the text of the plan, with its digest and its pieces, in the order of the slots', async () => {
  const { result, campaign } = await produced({ assets: 7 });
  const plans = campaign.content_plans[0].assets;
  result.scenes.forEach((s, i) => {
    assert.deepEqual(s.text_layers.map((l) => l.text), plans[i].slots.map((x) => x.text));
    s.text_layers.forEach((l, j) => {
      assert.equal(l.text_sha256, sha(l.text)); assert.deepEqual(l.pieces.map((p) => p.piece_id), plans[i].slots[j].pieces.map((p) => p.piece_id));
      for (const p of l.pieces) assert.equal(p.text_sha256, sha(plans[i].slots[j].pieces.find((q) => q.piece_id === p.piece_id).text));
    });
  });
});

test('TI-2 the locked copy is recoverable byte for byte from the layers and the caption alone', async () => {
  const body = longText(300, 5);
  const { result, request } = await produced({ assets: 7, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] } });
  assert.equal(result.production.copy_integrity.recoverable, true); assert.deepEqual(result.production.copy_integrity.problems, []); assert.ok(result.production.copy_integrity.pieces_checked > 5);
  const layers = result.scenes.flatMap((s) => s.text_layers);
  const pieces = layers.flatMap((l) => l.pieces).filter((p) => p.origin === 'LOCKED');
  assert.equal(reassemble(body, pieces), body, 'the source is rebuilt exactly, with the whitespace it had');
  assert.equal(request.copy[0].text, body);
  const recovered = recoverLockedCopy({ layers, sources: new Map([['copy://body', body]]) });
  assert.ok(recovered.ok); assert.equal(recovered.recovered.get('copy://body'), body);
});

test('TI-3 a tampered piece, a missing piece or a reordered piece is seen and blocks the production', async () => {
  const body = longText(120, 4);
  const base = await produced({ assets: 5, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] } });
  const layers = base.result.scenes.flatMap((s) => s.text_layers);
  const sources = new Map([['copy://body', body]]);
  const mutate = (fn) => { const copy = JSON.parse(JSON.stringify(layers)); fn(copy); return recoverLockedCopy({ layers: copy, sources }); };
  assert.equal(mutate(() => {}).ok, true);
  assert.equal(mutate((c) => { c.find((l) => l.pieces.some((p) => p.origin === 'LOCKED')).pieces[0].text_sha256 = sha('other'); }).ok, false);
  assert.equal(mutate((c) => { c.find((l) => l.pieces.some((p) => p.origin === 'LOCKED')).pieces = []; }).ok, false);
  assert.equal(mutate((c) => { const l = c.find((x) => x.pieces.some((p) => p.origin === 'LOCKED')); l.pieces[0].end -= 3; }).ok, false);
  // a content plan whose piece text was altered after planning is refused by the production planner
  const tainted = JSON.parse(JSON.stringify(base.campaign));
  const piece = tainted.content_plans[0].assets.flatMap((a) => a.slots).flatMap((s) => s.pieces).find((p) => p.origin === 'LOCKED' && p.unit_ref === 'copy://body');
  piece.text = `${piece.text} (edited)`;
  const out = await base.planner.plan({ campaignResult: tainted, brief: base.brief, request: base.request });
  assert.equal(out.status, 'BLOCKED'); assert.ok(out.production.blocks.some((b) => b.code === 'LOCKED_COPY_NOT_RECOVERABLE'));
  assert.equal(out.production.copy_integrity.recoverable, false);
});

test('TI-4 copy that the composition cannot carry is a block that asks for replanning: it is never truncated, rewritten or compressed', async () => {
  const wide = `${'x'.repeat(130)}`;
  const body = `${longText(60, 2)} ${wide} ${longText(60, 2)}`;
  const { result, campaign } = await produced({ assets: 6, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] } }, { font: FONT });
  assert.equal(result.status, 'BLOCKED');
  const blocked = result.scenes.filter((s) => s.status === 'BLOCKED');
  assert.ok(blocked.length >= 1 && blocked.length < result.scenes.length, 'only the scenes that cannot carry their copy are blocked');
  for (const s of blocked) {
    const b = s.blocks.find((x) => x.code === 'LOCKED_COPY_DOES_NOT_FIT_THE_COMPOSITION');
    assert.equal(b.detail.replan, 'DISTRIBUTE_THE_COPY_OVER_MORE_OR_HEAVIER_ASSETS_OR_THE_CAPTION');
    assert.ok(b && b.detail.basis === 'REAL_TYPOGRAPHY_ON_THE_REAL_TEXT' && b.detail.reasons.some((r) => r.startsWith('BODY_DOES_NOT_FIT_THE_REGION_IN_THE_REAL_FONT')));
    assert.equal(s.layers.length, 0); assert.equal(s.composite, null);
    const planned = campaign.content_plans[0].assets[s.provenance.index].slots;
    assert.deepEqual(s.text_layers.map((l) => l.text), planned.map((x) => x.text), 'the text is exactly the planned text');
    assert.ok(s.text_layers.some((l) => l.text.includes(wide)), 'the long word is whole');
  }
  assert.equal(result.production.copy_integrity.recoverable, true, 'the copy is still recoverable: nothing was changed');
  // the scenes that can carry their copy are not held back by the others
  assert.ok(result.scenes.some((s) => s.status === 'SPECIFIED'));
  // without a font the check is the measured capacity only, and says so
  const noFont = await produced({ assets: 6, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] } });
  assert.equal(noFont.result.scenes.filter((s) => s.status === 'BLOCKED').length, 0);
});

test('TI-5 checkTextFeasibility never changes the text and states its basis', () => {
  const resource = FORMAT_RESOURCES[0];
  const slot = (role, text) => ({ role, text, chars: text.length });
  const ok = checkTextFeasibility({ slots: [slot('HEADLINE', 'Bonjour'), slot('BODY', longText(30, 1).slice(0, 200))], density: 'MEDIUM', resource, font: FONT });
  assert.deepEqual([ok.fits, ok.basis, ok.reasons], [true, 'REAL_TYPOGRAPHY_ON_THE_REAL_TEXT', []]);
  assert.deepEqual(checkTextFeasibility({ slots: [slot('HEADLINE', 'x'.repeat(101))], density: 'LOW', resource }).reasons, ['HEADLINE_OVER_ITS_MEASURED_CAPACITY']);
  assert.deepEqual(checkTextFeasibility({ slots: [slot('BODY', 'x'.repeat(resource.slide_capacity.TEXT_LED.chars + 1))], density: 'TEXT_LED', resource }).reasons, ['BODY_OVER_THE_TEXT_LED_CAPACITY']);
  assert.deepEqual(checkTextFeasibility({ slots: [slot('BODY', 'x'.repeat(resource.slide_capacity.HIGH.chars + 1))], density: 'HIGH', resource }).reasons, ['BODY_OVER_ITS_DENSITY_CLASS']);
  assert.equal(checkTextFeasibility({ slots: [slot('BODY', 'é'.repeat(5))], density: 'LOW', resource, font: FONT }).fits, true, 'a LOW asset is judged in the MEDIUM region');
  assert.equal(textLayersOf({ contentAsset: { slots: [] }, scenePrefix: {}, placementText: 'X' }).length, 0);
});

test('PV-1 every scene traces back, id by id, from the request through the content plan, the campaign and the asset plan to its layers and to the pinned product', async () => {
  const { result, campaign, request, brief } = await produced({ assets: 7 });
  const c = campaign.campaign_plan;
  for (const s of result.scenes) {
    const p = s.provenance;
    assert.equal(p.request_ref, request.request_ref); assert.equal(p.campaign_id, c.campaign_id);
    assert.ok(c.content_plan_ids.includes(p.content_plan_id)); assert.ok(c.asset_plan_ids.includes(p.asset_plan_id));
    assert.deepEqual([p.art_direction_id, p.concept_id, p.frame_id], [c.art_direction_id, c.concept_id, c.frame_id]);
    assert.deepEqual(p.product, { identity_id: result.product_identity.identity_id, product_ref: brief.ids.product_ref, asset_ref: brief.asset.ref, sha256: brief.asset.sha256 });
    const asset = campaign.asset_plans.find((a) => a.asset_plan_id === p.asset_plan_id);
    assert.equal(asset.content_asset_id, p.content_asset_id);
  }
  assert.equal(result.production.campaign_id, c.campaign_id); assert.equal(result.production.product_identity_id, result.product_identity.identity_id);
  assert.deepEqual(result.production.scene_ids, result.scenes.map((s) => s.scene_id));
});

test('PV-2 only the product layer holds the product; no generated layer holds a product, a reference or an input pixel', async () => {
  const { result } = await produced({ assets: 7 });
  for (const s of result.scenes) {
    for (const l of s.layers) {
      if (l.source === LAYER_SOURCE.GENERATED) { assert.ok(!('product_ref' in l) && !('asset_ref' in l) && !('sha256' in l) && !('identity_id' in l)); assert.notEqual(l.kind, LAYER_KIND.PRODUCT); }
      if (l.source === LAYER_SOURCE.REAL_ASSET) assert.equal(l.kind, LAYER_KIND.PRODUCT);
    }
  }
  assert.ok(result.shared_layers.every((r) => r.carries_input_asset === false));
  assert.ok(!JSON.stringify(result.shared_layers).includes(result.product_identity.sha256) && !JSON.stringify(result.shared_layers).includes(result.product_identity.asset_ref));
});

test('PV-3 a layer cannot introduce a claim or a dimension that nobody approved: the production is blocked and the layer named', async () => {
  const claim = await produced({ assets: 5, art: { atmosphere: 'A certified workshop, calm and focused.' } });
  assert.equal(claim.result.status, 'BLOCKED');
  const b = claim.result.production.blocks.find((x) => x.code === 'UNSUPPORTED_CLAIM_IN_A_LAYER');
  assert.ok(b && b.detail.claims.includes('certified') && b.detail.request_key.startsWith('plk_'));
  assert.ok(claim.result.scenes.every((s) => s.status === 'BLOCKED' && s.layers.length === 0));
  // the same word is fine when the approved copy says it
  const approved = await produced({ assets: 5, art: { atmosphere: 'A certified workshop, calm and focused.' }, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: `Atelier certified. ${longText(100, 4)}` }] } });
  assert.equal(approved.result.status, 'SPECIFIED');
  // a figure in what feeds a generator is a dimension nobody approved
  const base = await produced({ assets: 5 });
  const art = base.campaign.shared.art_direction;
  const tainted = { ...base.campaign, shared: { ...base.campaign.shared, art_direction: { ...art, atmosphere: 'A workshop table forty centimetres wide, 40 cm.' } } };
  const out = await base.planner.plan({ campaignResult: tainted, brief: base.brief, request: base.request });
  assert.ok(out.production.blocks.some((x) => x.code === 'UNSUPPORTED_CLAIM_IN_A_LAYER' && x.detail.digits === true));
});

test('PV-4 breaking any rule of a real scene is named by the validator', async () => {
  const { result } = await produced({ assets: 5 });
  const scene = JSON.parse(JSON.stringify(result.scenes[1])); const id = result.product_identity; const shared = sharedOf(result);
  const check = (fn, rule) => { const s = JSON.parse(JSON.stringify(scene)); fn(s); assert.ok(validateSceneSpec(s, { identity: id, sharedLayers: shared }).includes(rule), rule); };
  check((s) => { s.layers.find((l) => l.kind === 'PRODUCT').sha256 = 'f'.repeat(64); }, 'EXACTLY_ONE_PRODUCT_LAYER_AND_IT_IS_THE_REAL_ASSET');
  check((s) => { s.layers.push({ ...s.layers.find((l) => l.kind === 'PRODUCT'), layer_id: 'dup', z: 31 }); }, 'EXACTLY_ONE_PRODUCT_LAYER_AND_IT_IS_THE_REAL_ASSET');
  check((s) => { s.layers.find((l) => l.kind === 'PLATE').asset_ref = id.asset_ref; }, 'NO_GENERATED_LAYER_IS_THE_PRODUCT');
  check((s) => { s.layers.reverse(); }, 'Z_ORDER_IS_THE_BAND_ORDER');
  check((s) => { s.text_layers[0].text_sha256 = 'x'; s.layers.find((l) => l.kind === 'TEXT').text_sha256 = 'x'; }, 'TEXT_LAYERS_FOLLOW_FROM_THE_PLANNED_PIECES');
  check((s) => { delete s.provenance.campaign_id; }, 'PROVENANCE_IS_COMPLETE_FROM_THE_REQUEST_TO_THE_LAYERS');
  check((s) => { s.tools[0].selected = null; }, 'EVERY_TOOL_IS_SELECTED_AND_USED_ALONE');
  assert.deepEqual(validateSceneSpec(scene, { identity: id, sharedLayers: new Map() }).includes('EVERY_GENERATED_LAYER_HAS_ITS_REQUEST'), true);
});

test('PB-1 the cost is deterministic and auditable: every line has a label, a count and a unit cost, reserved in a fixed order under the ceiling', async () => {
  const { result, campaign } = await produced({ assets: 7 });
  const b = result.production.budget;
  assert.equal(b.ceiling_eur, 2); assert.equal(b.within_ceiling, true); assert.equal(b.candidates_per_generated_layer, 2); assert.equal(b.reuse_level, 0);
  assert.equal(b.estimated_worst_case_eur, 1.272); assert.equal(b.generated_layers, result.shared_layers.length);
  assert.equal(b.rows.reduce((n, r) => Math.round((n + r.eur) * 1e9) / 1e9, 0), b.estimated_worst_case_eur);
  assert.deepEqual(b.rows.map((r) => r.label.split(':')[0]), ['SHARED_PLANNING_STAGES', 'ASSET_PLANNING_STAGES', ...result.shared_layers.map(() => 'GENERATED_LAYER'), 'CRITIC_CALLS']);
  assert.deepEqual(b.rows[0], { label: 'SHARED_PLANNING_STAGES', eur: campaign.campaign_plan.budget.shared_eur });
  assert.deepEqual(b.unit_costs, PRODUCTION_UNIT_COSTS);
  const again = await produced({ assets: 7 });
  assert.deepEqual(again.result.production.budget.rows, b.rows);
  const e = estimateProduction({ sharedStagesEur: 0.3, assets: 2, layers: [{ request_key: 'a', size_class: 'ABOVE_1024', candidates: 2 }, { request_key: 'b', size_class: 'UP_TO_1024', candidates: 3 }] });
  assert.deepEqual(e.lines.map((l) => [l.label, l.count, l.eur]), [['SHARED_PLANNING_STAGES', 1, 0.3], ['ASSET_PLANNING_STAGES', 4, 0.12], ['GENERATED_LAYER:a', 2, 0.138], ['GENERATED_LAYER:b', 3, 0.102], ['CRITIC_CALLS', 4, 0.04]]);
  assert.equal(e.total_eur, 0.7);
  assert.equal(reserveProduction({ estimate: e, ceilingEur: 0.7 }).ok, true); assert.equal(reserveProduction({ estimate: e, ceilingEur: 0.69 }).ok, false);
  const refused = reserveProduction({ estimate: e, ceilingEur: 0.6 });
  assert.equal(refused.error.code, 'CAMPAIGN_BUDGET_EXCEEDED'); assert.ok(refused.error.label); assert.ok(refused.reserved_eur <= 0.6);
});

test('PB-2 reuse comes before anything else: when the layers do not fit, plates are shared more, and no quality parameter moves', async () => {
  const reference = (await produced({ assets: 7 })).result;
  const policy = { ...PRODUCTION_POLICY, candidates_per_generated_layer: 7 };
  const tight = (await produced({ assets: 7 }, { policy })).result;
  const b = tight.production.budget;
  assert.equal(tight.status, 'SPECIFIED'); assert.equal(b.within_ceiling, true); assert.ok(b.reuse_level >= 1, `reuse level ${b.reuse_level}`); assert.ok(b.estimated_worst_case_eur <= 2);
  assert.equal(b.candidates_per_generated_layer, 7);
  assert.ok(tight.shared_layers.filter((l) => l.kind === 'PLATE').length < reference.shared_layers.filter((l) => l.kind === 'PLATE').length, 'fewer distinct plates');
  for (const r of tight.shared_layers) { assert.equal(r.candidates, 7); assert.deepEqual(r.size, r.kind === 'PLATE' ? { width: 1080, height: 1350, unit: 'px' } : PRODUCTION_POLICY.prop_canvas); assert.equal(r.n, 1); }
  assert.deepEqual(tight.shared_layers.filter((l) => l.kind === 'PROP').map((l) => l.element).sort(), reference.shared_layers.filter((l) => l.kind === 'PROP').map((l) => l.element).sort(), 'the scene is as rich: no prop is dropped to save money');
  assert.ok(tight.scenes.every((s) => s.status === 'SPECIFIED' && s.layers.filter((l) => l.kind.startsWith('PROP_')).length === reference.scenes.find((x) => x.provenance.index === s.provenance.index).layers.filter((l) => l.kind.startsWith('PROP_')).length));
  const plates = new Set(tight.scenes.map((s) => s.layers[0].request_key)); assert.equal(plates.size, tight.shared_layers.filter((l) => l.kind === 'PLATE').length);
});

test('PB-3 a budget that cannot hold the layers blocks the production explicitly: no cheaper image is asked for, no layer is specified', async () => {
  const { result } = await produced({ assets: 7 }, { policy: { ...PRODUCTION_POLICY, candidates_per_generated_layer: 30 } });
  assert.equal(result.status, 'BLOCKED');
  const b = result.production.blocks.find((x) => x.code === 'PRODUCTION_BLOCKED_BY_BUDGET');
  assert.ok(b); assert.equal(b.detail.ceiling_eur, 2); assert.ok(b.detail.estimated_eur > 2); assert.equal(b.detail.error.code, 'CAMPAIGN_BUDGET_EXCEEDED');
  assert.equal(result.production.budget.within_ceiling, false); assert.equal(result.production.budget.reuse_level, 2, 'the most reuse was tried');
  assert.ok(result.scenes.every((s) => s.status === 'BLOCKED' && s.layers.length === 0 && s.text_layers.length > 0));
  assert.ok(result.shared_layers.every((r) => r.candidates === 30 && r.n === 1), 'the quality parameters are the policy\'s, not a degraded version');
});

test('PS-1 a resumed production is exactly the clean one: nothing is recomputed, nothing differs', async () => {
  const store = createMemoryCheckpointStore();
  const first = await produced({ assets: 6, store });
  assert.ok(first.result.executed.length > 6);
  const again = createProductionPlanner({ store }).plan({ campaignResult: first.campaign, brief: first.brief, request: first.request });
  const resumed = await again;
  assert.deepEqual(resumed.executed, []); assert.equal(resumed.reused.length, first.result.executed.length);
  assert.equal(resumed.production.production_id, first.result.production.production_id);
  assert.deepEqual(resumed.scenes, first.result.scenes);
  const clean = await produced({ assets: 6 });
  assert.equal(clean.result.production.production_id, first.result.production.production_id);
  assert.deepEqual(clean.result.scenes.map((s) => s.scene_id), resumed.scenes.map((s) => s.scene_id));
});

test('PS-2 a production interrupted at any node resumes to the same specification', async () => {
  const clean = await produced({ assets: 5 });
  const total = clean.result.executed.length;
  for (const stopAt of [2, Math.floor(total / 2), total - 1]) {
    const inner = createMemoryCheckpointStore();
    let saves = 0;
    const flaky = { load: () => inner.load(), save: async (s) => { saves += 1; if (saves === stopAt) throw new Error('disk full'); return inner.save(s); } };
    const base = await plannedCampaign({ assets: 5, store: inner });
    await assert.rejects(createProductionPlanner({ store: flaky }).plan({ campaignResult: base.campaign, brief: base.brief, request: base.request }), /disk full/);
    const resumed = await createProductionPlanner({ store: inner }).plan({ campaignResult: base.campaign, brief: base.brief, request: base.request });
    assert.equal(resumed.production.production_id, clean.result.production.production_id, `after ${stopAt}`);
    assert.deepEqual(resumed.scenes.map((s) => s.scene_id), clean.result.scenes.map((s) => s.scene_id));
    assert.ok(resumed.executed.length < total, `after ${stopAt}: only the missing nodes were computed`);
  }
});

test('PS-3 changing one slide-level input recomputes only the scene that depends on it', async () => {
  const store = createMemoryCheckpointStore();
  const first = await produced({ assets: 6, store });
  const script = { frame: [], ideate: [], select: [], art_direct: [], asset: [{ imagery_brief: 'A different view of the workshop table', composition_note: 'Centred in the frame', rationale: 'ok' }] };
  const world = makeCampaign({ script, store });
  const changed = await world.planner.plan({ brief: first.brief, request: first.request, options: { asset_hints: [{ index: 3, imagery_hint: 'show the product in a hand' }] } });
  assert.deepEqual(changed.executed, ['ASSET_PLAN:L0:3']);
  const out = await createProductionPlanner({ store }).plan({ campaignResult: changed, brief: first.brief, request: first.request });
  assert.deepEqual(out.executed, ['SCENE:L0:3']);
  assert.ok(out.reused.includes('PRODUCT_IDENTITY') && out.reused.some((r) => r.startsWith('SCENE_PLATE:')) && out.reused.some((r) => r.startsWith('SCENE_PROP:')));
  assert.equal(out.reused.filter((r) => r.startsWith('SCENE:')).length, 5);
  assert.notEqual(out.scenes[3].scene_id, first.result.scenes[3].scene_id);
  assert.deepEqual(out.scenes.filter((_, i) => i !== 3).map((s) => s.scene_id), first.result.scenes.filter((_, i) => i !== 3).map((s) => s.scene_id));
});

test('PS-4 a change of the shared art direction recomputes the shared layers and every scene, and keeps the product identity', async () => {
  const store = createMemoryCheckpointStore();
  const first = await produced({ assets: 5, store });
  const script = await fullScript({ assets: 12, audience: 'Des grands-parents qui veulent offrir un souvenir de leurs petits-enfants.' });
  script.art_direct = [artDirectionAnswer({ atmosphere: 'A bright seaside kiosk, open and airy.', narrative_elements: [{ element: 'a coil of rope on the quay', reason: 'it shows the care taken in the making of the piece', zone: 'MIDGROUND' }] })];
  const world = makeCampaign({ script, store });
  const request = { ...first.request, audience: 'Des grands-parents' };
  const changed = await world.planner.plan({ brief: first.brief, request });
  assert.ok(changed.executed.includes('ART_DIRECTION') && changed.shared.art_direction.atmosphere.includes('seaside'));
  const out = await createProductionPlanner({ store }).plan({ campaignResult: changed, brief: first.brief, request });
  assert.ok(out.reused.includes('PRODUCT_IDENTITY') && !out.executed.includes('PRODUCT_IDENTITY'));
  assert.ok(out.executed.some((e) => e.startsWith('SCENE_PLATE:')) && out.executed.some((e) => e.startsWith('SCENE_PROP:')));
  assert.equal(out.executed.filter((e) => e.startsWith('SCENE:')).length, 5);
  assert.notEqual(out.production.production_id, first.result.production.production_id);
  assert.ok(out.shared_layers.every((r) => r.model_text.some((t) => t.includes('seaside') || t.includes('rope') || t.includes('kiosk') || t.includes('seaside') || r.kind === 'PROP')));
});

test('PS-5 a change of the product identity recomputes the identity, the layers and the scenes', async () => {
  const store = createMemoryCheckpointStore();
  const first = await produced({ assets: 5, store });
  const other = { ...first.brief, asset: { ...first.brief.asset, sha256: sha('another photograph') } };
  const out = await createProductionPlanner({ store }).plan({ campaignResult: first.campaign, brief: other, request: first.request });
  assert.ok(out.executed.includes('PRODUCT_IDENTITY')); assert.equal(out.executed.filter((e) => e.startsWith('SCENE:')).length, 5);
  assert.notEqual(out.product_identity.identity_id, first.result.product_identity.identity_id);
  assert.ok(out.scenes.every((s) => s.provenance.product.sha256 === other.asset.sha256));
  assert.deepEqual(PRODUCTION_DEPENDS_ON[PRODUCTION_NODE.SCENE], ['ASSET_PLAN', 'SCENE_PLATE', 'SCENE_PROP', 'PRODUCT_IDENTITY']);
  assert.deepEqual(PRODUCTION_DEPENDS_ON[PRODUCTION_NODE.PLATE], ['ART_DIRECTION']);
});

test('LG-1 the legacy single-image flow is untouched: a single asset, a campaign that still needs a decision, or no campaign is never produced as layers', async () => {
  const world = makeCampaign({ script: await fullScript() });
  const single = await world.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_format: 'SINGLE_IMAGE', copy: [{ copy_ref: 'copy://h', mode: 'COPY_LOCKED', role: 'HEADLINE', text: 'Vos souvenirs. Votre création.' }] }) });
  const store = createMemoryCheckpointStore();
  const planner = createProductionPlanner({ store });
  assert.deepEqual(await planner.plan({ campaignResult: single, brief: campaignBrief(), request: campaignRequest({ requested_format: 'SINGLE_IMAGE' }) }), { status: 'NOT_A_CAMPAIGN', reason: 'NOT_A_MULTI_ASSET_PLAN' });
  const tight = makeCampaign({ script: await fullScript(), ceilingEur: 0.5 });
  const needs = await tight.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 7 }) });
  assert.equal(needs.status, 'NEEDS_USER_DECISION');
  assert.deepEqual(await planner.plan({ campaignResult: needs, brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 7 }) }), { status: 'CAMPAIGN_NOT_PLANNED', reason: 'NEEDS_USER_DECISION' });
  assert.equal((await planner.plan({ campaignResult: null, brief: campaignBrief(), request: campaignRequest() })).status, 'NOT_A_CAMPAIGN');
  assert.equal(store.saves(), 0, 'nothing was stored for any of them');
});

test('LG-2 the production is additive and offline: only the readiness gate and the layered runtime import it, the single-image runtime knows nothing of it, and it imports no single-image runtime and no provider', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
  const files = walk(new URL('../src/', import.meta.url)).filter((f) => f.pathname.endsWith('.js'));
  const importers = files.filter((f) => !f.pathname.includes('/creative-production/') && readFileSync(f, 'utf8').includes('creative-production/')).map((f) => f.pathname.split('/src/')[1]);
  assert.deepEqual(importers.filter((f) => !f.startsWith('creative-readiness/') && !f.startsWith('creative-e2e/') && f !== 'creative-runtime/layered-runtime.js'), []);
  for (const f of files.filter((x) => x.pathname.includes('/creative-production/'))) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!/from '\.\.\/creative-runtime\/(runtime|index|agents|request-builder)\.js'/.test(text), `${f.pathname} imports no runtime`);
    assert.ok(!/from '\.\.\/marketing-creative|fetch\(|node:https?|node:net/.test(text), `${f.pathname} calls no provider`);
    assert.ok(!/qwen|alibaba|dashscope|openai/i.test(text), `${f.pathname} names no provider`);
  }
});

test('LG-3 the routing is explicit: ranked candidates, the admissible one chosen, the others named with why, nothing else ever substituted', () => {
  assert.deepEqual(TOOL_CANDIDATES.ENVIRONMENT_PLATE_GENERATION.map((c) => c.tool_id), ['text-to-image/primary', 'text-to-image/secondary']);
  const chosen = selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PUBLIC', sideMax: 1350 });
  assert.equal(chosen.selected.tool_id, 'text-to-image/primary'); assert.deepEqual(chosen.rejected, []); assert.equal(chosen.execution_policy, 'ONLY_THE_SELECTED_TOOL');
  assert.equal(selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PRIVATE', sideMax: 100 }).selected, null, 'a provider never receives private data');
  assert.deepEqual(selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PRIVATE', sideMax: 100 }).rejected.map((r) => r.reason), ['DATA_CLASS_NOT_ACCEPTED', 'NOT_WIRED']);
  assert.equal(selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PUBLIC', sideMax: 4000 }).selected, null);
  assert.deepEqual(selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PUBLIC', sideMax: 4000 }).rejected.map((r) => r.reason), ['SIZE_NOT_ACCEPTED', 'NOT_WIRED']);
  assert.equal(selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PUBLIC', regions: ['LOCAL'], sideMax: 100 }).selected, null);
  assert.deepEqual(selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PUBLIC', regions: ['LOCAL'], sideMax: 100 }).rejected[0], { tool_id: 'text-to-image/primary', reason: 'REGION_NOT_ALLOWED' });
  assert.equal(selectTool('UNKNOWN_CAPABILITY', { dataClass: 'PUBLIC' }).selected, null);
  assert.equal(selectTool('LOCAL_SEGMENTATION', { dataClass: 'PRIVATE' }).selected.region, 'LOCAL');
  assert.equal(selectTool('DETERMINISTIC_TEXT', { dataClass: 'PUBLIC' }).selected.tool_id, 'typography/real-fonts');
});

test('FZ-1 FUZZ: whatever the campaign, a production is specified or explicitly blocked, never invents text, never exceeds the ceiling, and its ids are stable', async () => {
  const mulberry = (seed) => () => { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = mulberry(303); const pick = (xs) => xs[Math.floor(r() * xs.length)];
  for (let n = 0; n < 25; n += 1) {
    const text = longText(pick([60, 120, 300, 450]), pick([2, 4, 6]));
    const assets = pick([3, 4, 5, 6, 7, 8, 9, 10]);
    const a = await produced({ assets, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text }] } }, { font: pick([null, FONT]) });
    if (!a.result.production) continue;
    const { result } = a;
    assert.ok(['SPECIFIED', 'BLOCKED', 'INTENT_ONLY'].includes(result.status), `fuzz ${n}`);
    assert.ok(result.production.budget.reserved_eur === undefined || result.production.budget.estimated_worst_case_eur <= result.production.budget.ceiling_eur || result.status === 'BLOCKED', `fuzz ${n}: ceiling`);
    for (const [i, s] of result.scenes.entries()) {
      assert.deepEqual(s.text_layers.map((l) => l.text), a.campaign.content_plans[0].assets[i].slots.map((x) => x.text), `fuzz ${n}/${i}: the text is the plan's`);
      if (s.status === 'SPECIFIED') assert.deepEqual(validateSceneSpec(s, { identity: result.product_identity, sharedLayers: sharedOf(result), approvedWords: new Set() }), [], `fuzz ${n}/${i}`);
      else assert.equal(s.layers.length, 0);
    }
    assert.equal(result.production.copy_integrity.recoverable, true, `fuzz ${n}: recoverable`);
  }
});
