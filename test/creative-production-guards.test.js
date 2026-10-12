import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { encodePng } from '../src/creative-intelligence/png-encode.js';
import {
  buildSceneSpec, checkTextFeasibility, composeLayers, COMPOSITION_LAYERING, createProductionPlanner, detectSubstitutes, familiesOf, plateRequest, productionSample, productNameWords, PRODUCTION_POLICY,
  propsForAsset, recoverLockedCopy, resolveProductIdentity,
} from '../src/creative-production/index.js';
import { FORMAT_RESOURCES } from '../src/creative-planning/index.js';
import { createMemoryCheckpointStore } from '../src/creative-campaign/index.js';
import { campaignBrief } from './creative-campaign-world.js';
import { longText } from './creative-planning-world.js';
import { FONT, plannedCampaign, produced } from './creative-production-world.js';

// GUARDS OF THE LAYERED PRODUCTION (`// GP-N`): each rule has a test that fails if the rule is removed.

const sha = (t) => createHash('sha256').update(t).digest('hex');
const identityOf = (product) => resolveProductIdentity({ brief: { ...campaignBrief(), public_facts: { product } } });

test('GP-1 the name of the product is its first significant words, never a short word', () => {
  assert.deepEqual(productNameWords('Pot en verre soufflé'), ['verre', 'soufflé']);
  assert.deepEqual(productNameWords('Mug personnalisé pour les grands'), ['personnalisé', 'grands']);
  assert.deepEqual(productNameWords('Tasse en céramique émaillée blanche'), ['tasse', 'céramique', 'émaillée']);
});

test('GP-2 plurals are recognised, in the description of the product and in the text of a layer', () => {
  assert.deepEqual(familiesOf('Gourdes personnalisées'), ['DRINKWARE']);
  const bottle = identityOf('Gourde en acier');
  assert.ok(detectSubstitutes({ text: 'two cups on the bench', identity: bottle }).some((h) => h.kind === 'FAMILY'));
  assert.ok(detectSubstitutes({ text: 'a stack of mugs', identity: bottle }).some((h) => h.kind === 'FAMILY'));
});

test('GP-2b plural forms ending in -es are recognised too', () => {
  const box = identityOf('Coffret cadeau en carton');
  assert.equal(box.family, 'GIFT_BOX');
  assert.ok(detectSubstitutes({ text: 'two boxes on the bench', identity: box }).some((h) => h.kind === 'FAMILY' && h.words.includes('box')));
  assert.deepEqual(familiesOf('Des coffrets cadeaux'), ['GIFT_BOX']);
});

test('GP-3 when the family of a product is not resolved, every family its description matches applies', () => {
  const ambiguous = identityOf('Gourde et coque assorties');
  assert.equal(ambiguous.family, null);
  assert.ok(detectSubstitutes({ text: 'a flask on the bench', identity: ambiguous }).some((h) => h.kind === 'FAMILY'));
  assert.ok(detectSubstitutes({ text: 'a rubber bumper', identity: ambiguous }).length > 0);
  assert.ok(detectSubstitutes({ text: 'a cover', identity: ambiguous }).length > 0);
  assert.equal(detectSubstitutes({ text: 'a worn wooden counter', identity: ambiguous }).length, 0);
});

test('GP-4 the recovery of locked copy names what is wrong: a duplicated piece, a missing piece, a missing source; an adapted piece is not held to the locked rule', async () => {
  const body = longText(120, 4);
  const { result } = await produced({ assets: 5, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] } });
  const layers = result.scenes.flatMap((s) => s.text_layers);
  const sources = new Map([['copy://body', body]]);
  const locked = layers.find((l) => l.pieces.some((p) => p.origin === 'LOCKED'));
  const copyLayers = (fn) => { const c = JSON.parse(JSON.stringify(layers)); fn(c); return recoverLockedCopy({ layers: c, sources }); };
  const duplicated = copyLayers((c) => { const l = c.find((x) => x.layer_id === locked.layer_id); l.pieces.push({ ...l.pieces[0] }); });
  assert.ok(duplicated.problems.some((p) => p.startsWith('NOT_VERBATIM:copy://body')), duplicated.problems.join());
  const dropped = copyLayers((c) => { c.find((x) => x.layer_id === locked.layer_id).pieces = []; });
  assert.ok(dropped.problems.some((p) => p.startsWith('NOT_COMPLETE:copy://body')) || dropped.problems.some((p) => p.startsWith('NOT_VERBATIM:copy://body')));
  assert.ok(dropped.problems.some((p) => p.startsWith('NOT_COMPLETE:')), dropped.problems.join());
  const noSource = recoverLockedCopy({ layers, sources: new Map() });
  assert.equal(noSource.ok, false); assert.ok(noSource.problems.some((p) => p === 'NO_SOURCE:copy://body'));
  const adapted = copyLayers((c) => { c.push({ pieces: [{ piece_id: 'pa', unit_ref: 'copy://body', origin: 'ADAPTED', start: null, end: null, text_sha256: sha('condensed') }] }); });
  assert.equal(adapted.ok, true, 'an adapted piece is not a slice of the source and is not held to that rule');
});

test('GP-5 a glyph the font does not have is a reason to replan, never a substitution', () => {
  const resource = FORMAT_RESOURCES[0];
  const text = '𓀀𓀁𓀂 𓀃𓀄';
  const out = checkTextFeasibility({ slots: [{ role: 'BODY', text, chars: text.length }], density: 'MEDIUM', resource, font: FONT });
  assert.ok(out.reasons.includes('BODY_HAS_A_GLYPH_THE_FONT_DOES_NOT_HAVE'), out.reasons.join());
  assert.equal(out.fits, false);
});

test('GP-6 the composition decides how many props an asset carries, the policy bounds them, and at most one is in the foreground', () => {
  const elements = [
    { element: 'a brass scale', zone: 'MIDGROUND' }, { element: 'a window glow', zone: 'BACKGROUND' }, { element: 'worn tools', zone: 'FOREGROUND' }, { element: 'a folded cloth', zone: 'FOREGROUND' },
  ];
  assert.deepEqual(propsForAsset({ elements, composition: 'TEXT_FIRST', index: 0 }), []);
  assert.deepEqual(propsForAsset({ elements, composition: 'CLOSE_CROP', index: 0 }), []);
  const full = propsForAsset({ elements, composition: 'FULL_BLEED_SCENE', index: 0 });
  assert.ok(full.length <= 2 && full.filter((e) => e.zone === 'FOREGROUND').length <= 1);
  const foregrounds = propsForAsset({ elements: elements.filter((e) => e.zone === 'FOREGROUND'), composition: 'WIDE_ESTABLISHING', index: 0 });
  assert.equal(foregrounds.length, 1, 'two foreground elements give one foreground prop');
  assert.equal(propsForAsset({ elements, composition: 'PRODUCT_CENTERED', index: 0, maxProps: 0 }).length, 0);
  assert.equal(propsForAsset({ elements: elements.filter((e) => e.zone !== 'FOREGROUND'), composition: 'FULL_BLEED_SCENE', index: 0, maxProps: 1 }).length, 1);
  assert.equal(propsForAsset({ elements: elements.filter((e) => e.zone !== 'FOREGROUND'), composition: 'FULL_BLEED_SCENE', index: 0 }).length, 2);
  assert.equal(propsForAsset({ elements: elements.filter((e) => e.zone === 'FOREGROUND'), composition: 'PRODUCT_OFFSET', index: 0 }).length, 0, 'no foreground where the composition forbids it');
  assert.equal(PRODUCTION_POLICY.max_props_per_asset, 2);
  assert.deepEqual(Object.fromEntries(Object.entries(COMPOSITION_LAYERING).map(([k, v]) => [k, v.props])), { PRODUCT_CENTERED: 1, PRODUCT_OFFSET: 1, TEXT_FIRST: 0, FULL_BLEED_SCENE: 2, SPLIT_PANEL: 1, CLOSE_CROP: 0, WIDE_ESTABLISHING: 2 });
  assert.equal(propsForAsset({ elements: elements.slice(0, 3), composition: 'FULL_BLEED_SCENE', index: 1 })[0].element === propsForAsset({ elements: elements.slice(0, 3), composition: 'FULL_BLEED_SCENE', index: 0 })[0].element, false, 'the position rotates the elements');
});

test('GP-7 a capability with no admissible tool blocks the scene by name: a canvas too large for the only tool is not sent to it', () => {
  const s = productionSample();
  const big = { ...s.contentAsset, canvas: { width: 3000, height: 3000, unit: 'px' } };
  const plate = plateRequest({ artDirection: { art_direction_id: 'cad_probe', atmosphere: 'A quiet morning workshop.', material_language: 'worn wood.', lighting_intent: 'soft light.', forbidden_decorative_noise: ['confetti'] }, canvas: big.canvas, variant: 'WIDE', identity: s.identity, approvedWords: new Set() });
  const scene = buildSceneSpec({
    chain: { ...s.scene.provenance, request_ref: 'r' }, assetPlan: { asset_plan_id: 'apl_big', index: 0, narrative_role: 'HOOK', composition_intent: 'WIDE_ESTABLISHING', imagery_intent: 'PRODUCT_IN_CONTEXT', crop_scale: 'WIDE', density: { density_class: 'LOW' } }, contentAsset: big, identity: s.identity, plate: plate.request, props: [], resource: FORMAT_RESOURCES[0], feasibility: { fits: true, reasons: [] },
  });
  assert.equal(scene.status, 'BLOCKED'); assert.deepEqual(scene.blocks.map((b) => b.code), ['NO_TOOL_FOR_A_CAPABILITY']); assert.deepEqual(scene.blocks[0].detail.capabilities, ['ENVIRONMENT_PLATE_GENERATION']);
  assert.equal(scene.layers.length, 0);
});

test('GP-8 a look-alike in a secondary element, or in the atmosphere that feeds a plate, blocks the production and names where', async () => {
  const base = await produced({ assets: 5 });
  const art = base.campaign.shared.art_direction;
  const run = (patch) => base.planner.plan({ campaignResult: { ...base.campaign, shared: { ...base.campaign.shared, art_direction: { ...art, ...patch } } }, brief: base.brief, request: base.request });
  const secondary = await run({ permitted_secondary_elements: ['a bare polymer shell'] });
  assert.equal(secondary.status, 'BLOCKED'); assert.ok(secondary.production.blocks.find((b) => b.code === 'ART_DIRECTION_HOLDS_A_SUBSTITUTE').detail.elements.some((e) => e.element === 'a bare polymer shell'));
  const atmosphere = await run({ atmosphere: 'A workshop where a bare polymer shell waits.' });
  assert.equal(atmosphere.status, 'BLOCKED');
  const layerBlock = atmosphere.production.blocks.find((b) => b.code === 'ART_DIRECTION_HOLDS_A_SUBSTITUTE' && b.detail.request_key);
  assert.ok(layerBlock && layerBlock.detail.request_key.startsWith('plk_') && layerBlock.detail.hits.length > 0);
  assert.ok(atmosphere.scenes.every((s) => s.layers.length === 0));
});

test('GP-9 only the layers a specified scene uses are requested: a scene whose copy does not fit asks for nothing', async () => {
  const wide = 'x'.repeat(130);
  const body = `${longText(60, 2)} ${wide} ${longText(60, 2)}`;
  const { result } = await produced({ assets: 6, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] } }, { font: FONT });
  assert.ok(result.scenes.some((s) => s.status === 'BLOCKED'));
  const used = new Set(result.scenes.filter((s) => s.status === 'SPECIFIED').flatMap((s) => s.layers.filter((l) => l.source === 'GENERATED').map((l) => l.request_key)));
  assert.ok(result.shared_layers.length > 0 && result.shared_layers.every((r) => used.has(r.request_key)), 'every requested layer is used by a scene that will be made');
});

test('GP-9b when no scene can carry its copy, nothing at all is requested from a generator', async () => {
  const wide = 'x'.repeat(130);
  const body = Array(24).fill(wide).join(' ');
  const { result } = await produced({ assets: 6, requestOver: { copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] } }, { font: FONT });
  assert.ok(result.scenes.length > 0 && result.scenes.every((s) => s.status === 'BLOCKED'));
  assert.deepEqual(result.shared_layers, []); assert.equal(result.production.budget.generated_layers, 0);
  assert.equal(result.production.copy_integrity.recoverable, true);
});

test('GP-10 a corrupted checkpoint is caught: a stored scene whose product is not the pinned one blocks the production', async () => {
  const store = createMemoryCheckpointStore();
  const first = await produced({ assets: 5, store });
  const corrupted = store.peek();
  corrupted.nodes['SCENE:L0:2'].artifact.layers.find((l) => l.kind === 'PRODUCT').sha256 = 'f'.repeat(64);
  const resumed = await createProductionPlanner({ store: createMemoryCheckpointStore(corrupted) }).plan({ campaignResult: first.campaign, brief: first.brief, request: first.request });
  assert.equal(resumed.status, 'BLOCKED');
  const broken = resumed.production.blocks.find((b) => b.code === 'PROVENANCE_BROKEN');
  assert.ok(broken && broken.detail.problems.some((p) => p.rule === 'EXACTLY_ONE_PRODUCT_LAYER_AND_IT_IS_THE_REAL_ASSET'));
  assert.deepEqual(resumed.executed, [], 'the checkpoint was reused as stored and the check caught it');
});

test('GP-11 a change of the generation policy recomputes the shared layers: a stale candidate count is never reused', async () => {
  const store = createMemoryCheckpointStore();
  const first = await produced({ assets: 5, store });
  assert.ok(first.result.shared_layers.every((r) => r.candidates === 2));
  const again = await createProductionPlanner({ store, policy: { ...PRODUCTION_POLICY, candidates_per_generated_layer: 3 } }).plan({ campaignResult: first.campaign, brief: first.brief, request: first.request });
  assert.ok(again.executed.some((e) => e.startsWith('SCENE_PLATE:')) && again.executed.some((e) => e.startsWith('SCENE_PROP:')));
  assert.ok(again.shared_layers.every((r) => r.candidates === 3));
  const size = createProductionPlanner({ store, policy: { ...PRODUCTION_POLICY, candidates_per_generated_layer: 3, prop_canvas: { width: 512, height: 512, unit: 'px' } } });
  const resized = await size.plan({ campaignResult: first.campaign, brief: first.brief, request: first.request });
  assert.ok(resized.executed.some((e) => e.startsWith('SCENE_PROP:')) && resized.shared_layers.filter((r) => r.kind === 'PROP').every((r) => r.size.width === 512));
});

test('GP-12 the bytes of the product are part of its identity: other bytes than the pinned ones recompute the identity and make the production intent-only', async () => {
  const pixels = Uint8Array.from([1, 2, 3, 4]);
  const store = createMemoryCheckpointStore();
  const brief = { ...campaignBrief(), asset: { ...campaignBrief().asset, sha256: createHash('sha256').update(pixels).digest('hex') } };
  const first = await plannedCampaign({ assets: 5, briefOver: { asset: brief.asset }, store });
  const planner = createProductionPlanner({ store });
  const ok = await planner.plan({ campaignResult: first.campaign, brief, request: first.request, bytes: pixels });
  assert.equal(ok.status, 'SPECIFIED'); assert.equal(ok.product_identity.status, 'VERIFIED');
  const other = await planner.plan({ campaignResult: first.campaign, brief, request: first.request, bytes: Uint8Array.from([9, 9, 9]) });
  assert.ok(other.executed.includes('PRODUCT_IDENTITY')); assert.equal(other.status, 'INTENT_ONLY'); assert.ok(other.product_identity.reasons.includes('ASSET_BYTES_DO_NOT_MATCH_THE_PINNED_HASH'));
});

test('GP-13 only verified or approved facts approve a word that makes a claim', async () => {
  const claimArt = { atmosphere: 'A certified workshop, calm and focused.' };
  const estimate = await produced({ assets: 5, art: claimArt, requestOver: { facts: [{ fact_ref: 'fact://e', kind: 'COMMERCIAL', status: 'ESTIMATE', statement: 'Atelier certified, about' }] } });
  assert.equal(estimate.result.status, 'BLOCKED');
  const unknown = await produced({ assets: 5, art: claimArt, requestOver: { facts: [{ fact_ref: 'fact://u', kind: 'COMMERCIAL', status: 'UNKNOWN', statement: 'Atelier certified' }] } });
  assert.equal(unknown.result.status, 'BLOCKED');
  const verified = await produced({ assets: 5, art: claimArt, requestOver: { facts: [{ fact_ref: 'fact://v', kind: 'COMMERCIAL', status: 'VERIFIED', statement: 'Atelier certified by the guild' }] } });
  assert.equal(verified.result.status, 'SPECIFIED');
});

test('GP-14 a translucent pixel of the product is blended with what is under it and is not compared with the source', () => {
  const solid = (w, h, rgba) => { const px = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i += 1) px.set(rgba, i * 4); return px; };
  const png = (w, h, px) => encodePng({ width: w, height: h, pixels: px });
  const pr = solid(20, 20, [20, 40, 160, 255]);
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 20; x += 1) pr.set([20, 40, 160, 128], (y * 20 + x) * 4);
  const out = composeLayers({
    canvas: { width: 60, height: 60 },
    layers: [
      { layer_id: 'plate', kind: 'PLATE', z: 0, png: png(60, 60, solid(60, 60, [230, 225, 215, 255])), x: 0, y: 0 },
      { layer_id: 'product', kind: 'PRODUCT', z: 30, png: png(20, 20, pr), x: 10, y: 10 },
    ],
  });
  assert.equal(out.status, 'COMPOSED'); assert.equal(out.report.product_pixels_changed, 0); assert.ok(out.report.product_pixels_checked > 0 && out.report.product_pixels_checked < 400);
});
