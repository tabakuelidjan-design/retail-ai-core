import test from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';

import * as CI from '../src/creative-intelligence/index.js';
import {
  assessEnvironment, buildEnvironmentRequest, COMPONENT, createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst,
  createVisualProductionDirector, DECISION, DIRECTOR_CONSTANTS, displayStructuresIn, runProductPreservingCreative, selectLayoutRecipe, zoneStructure,
} from '../src/creative-runtime/index.js';
import {
  BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts,
} from './runtime-world.js';

// Regressions of the first autonomous HABB run (`// RG-N` markers). Both provider calls succeeded; the run stopped at PREFLIGHT_FAIL because (1) the layout planner chose a recipe
// with no SUBHEADLINE slot and the runtime ignored the unplaced text, (2) no brand token read on the mid-grey environment and Nordla had no recovery, and (3) the provider drew a
// phone on a stone slab although it was asked for an empty scene, and nothing checked. The stopped run also lost its evidence.

const AT = '2026-10-10T12:00:00.000Z';
const pngOf = (svg) => new Uint8Array(new Resvg(svg).render().asPng());
const flat = (hex) => ({ size: { width: 1080, height: 1350 }, svg: (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}"><rect width="${s.width}" height="${s.height}" fill="${hex}"/></svg>` });
const flatEnvironment = (hex) => fakeEnvironmentPort({ pixelsOf: (s) => pngOf(flat(hex).svg(s)) });
/** An "empty scene" in which the provider drew an object anyway: a textured block with strong edges where the product goes. */
const objectEnvironment = () => fakeEnvironmentPort({
  pixelsOf: (s) => {
    let seed = 11; const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const shapes = []; for (let i = 0; i < 260; i += 1) shapes.push(`<rect x="${(300 + r() * 480).toFixed(0)}" y="${(160 + r() * 720).toFixed(0)}" width="${(6 + r() * 30).toFixed(0)}" height="${(6 + r() * 30).toFixed(0)}" fill="${r() > 0.5 ? '#202020' : '#e0e0e0'}"/>`);
    return pngOf(`<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}"><rect width="${s.width}" height="${s.height}" fill="#bdbdbd"/>${shapes.join('')}</svg>`);
  },
});

// the direction the Director model actually returned in the real run (its recorded fields), as a fixture
const REAL_ANSWER = (over = {}) => directorAnswer({
  spatial_intent: 'PRODUCT_CENTER_TEXT_BELOW', negative_space_intent: 'BOTTOM', hierarchy: ['PRODUCT', 'HEADLINE', 'SUBHEADLINE', 'PRICE'], product_role: 'HERO', ...over,
});

function setup({ answer = REAL_ANSWER(), environment = flatEnvironment('#bdbdbd'), brand = BRAND } = {}) {
  const ledger = createDecisionLedger();
  const complete = async () => ({ text: answer, model: 'fake-director', request_id: 'dir-req-1' });
  return {
    ledger, environment, brand,
    agents: {
      analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
      director: createCreativeDirector({ ledger, complete, constants: DIRECTOR_CONSTANTS }),
      copy: createApprovedCopyAgent({ ledger }),
      visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
    },
    ports: { segmenter: createLocalProductSegmenter({ ledger }), environment },
  };
}
const run = (s) => runProductPreservingCreative({ at: AT, brief: buildBrief({ brand: s.brand }), fonts, agents: s.agents, ports: s.ports, ledger: s.ledger });

test('The planner picks a recipe with a slot for every role the copy fills, and never leaves a text unplaced', () => {
  const direction = { spatial_intent: 'PRODUCT_CENTER_TEXT_BELOW', product_role: 'HERO' };
  // RG-1 headline + subheadline + price under the product: the recipe has all three slots (it had no SUBHEADLINE slot in the failed run)
  const fit = selectLayoutRecipe(direction, ['HEADLINE', 'SUBHEADLINE', 'PRICE']);
  assert.equal(fit.recipe_id, 'PRODUCT_AND_PRICE');
  assert.ok(['HEADLINE', 'SUBHEADLINE', 'PRICE'].every((role) => CI.getLayoutRecipe(fit.recipe_id).slots.some((s) => s.role === role)));
  assert.deepEqual(fit.considered, [{ recipe_id: 'PRODUCT_AND_PRICE', missing_slots: [] }]);
  // RG-2 a hero product with text above prefers the dominant layout, and falls back to a recipe that covers the roles
  assert.equal(selectLayoutRecipe({ spatial_intent: 'PRODUCT_CENTER_TEXT_ABOVE', product_role: 'HERO' }, ['HEADLINE', 'PRICE']).recipe_id, 'PRODUCT_DOMINANT');
  // RG-3 a role no recipe of the intent has a slot for is reported, never approximated; an intent with no recipe is reported too
  const none = selectLayoutRecipe(direction, ['HEADLINE', 'BODY']);
  assert.equal(none.recipe_id, null);
  assert.equal(none.reason, 'NO_LAYOUT_RECIPE_COVERS_THE_HIERARCHY');
  assert.deepEqual(none.considered[0].missing_slots, ['BODY']);
  assert.equal(selectLayoutRecipe({ spatial_intent: 'PRODUCT_END_TEXT_START', product_role: 'HERO' }, ['HEADLINE']).reason, 'NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT');
});

test('The real run, replayed with the same direction: every text is placed, and where no brand token reads a solid brand plate carries it', async () => {
  const s = setup({ environment: flatEnvironment('#8a8a8a') });
  const result = await run(s);
  // RG-4 READY (preflight PASS, identity gate PASS) and no unplaced layer
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.preflight, result.fidelity?.failed]));
  const placement = result.ledger.find((e) => e.decision === DECISION.TYPOGRAPHY_PLACEMENT);
  assert.deepEqual(placement.outcome.unplaced, []);
  assert.equal(result.ledger.find((e) => e.decision === DECISION.LAYOUT_RECIPE).outcome.recipe_id, 'PRODUCT_AND_PRICE');
  // RG-5 no token of the palette reads on that grey, so the typography rules put plates behind the texts (the decision is theirs and recorded)
  const style = result.ledger.find((e) => e.decision === DECISION.TEXT_STYLE);
  assert.equal(style.decided_by, COMPONENT.TYPOGRAPHY_RULES);
  assert.ok(style.outcome.plates.length >= 1, JSON.stringify(style.outcome));
  const plates = result.document.layers.filter((l) => l.type === 'SHAPE');
  assert.equal(plates.length, style.outcome.plates.length);
  for (const choice of style.outcome.choices) {
    assert.ok(choice.worst_contrast >= 4.5, JSON.stringify(choice));
    if (choice.plate) assert.ok(choice.plate.best_on_environment < 4.5);
  }
  // RG-6 each plate is a solid brand token, behind its text and above the product, inside the canvas
  const palette = Object.values(BRAND.colors).map((c) => c.toUpperCase());
  for (const plate of plates) {
    assert.ok(palette.includes(plate.fill.toUpperCase()));
    assert.ok(plate.geometry.x >= 0 && plate.geometry.y >= 0 && plate.geometry.x + plate.geometry.width <= 1080 && plate.geometry.y + plate.geometry.height <= 1350);
    const text = result.document.layers.find((l) => l.id === plate.id.replace('plate-', 'text-'));
    assert.ok(plate.z_index < text.z_index);
  }
  assert.equal(result.steering.manual_creative_steering, 'NONE');
});

test('A provider that draws an object in the environment is refused before composition, with the measurement as evidence', async () => {
  const s = setup({ environment: objectEnvironment() });
  const result = await run(s);
  // RG-7 refused by the suitability gate, before preflight, render or fidelity
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'ENVIRONMENT_NOT_EMPTY');
  assert.ok(result.suitability.measured.strong_edge_share > result.suitability.limit.max_strong_edge_share);
  const gate = result.ledger.find((e) => e.decision === DECISION.ENVIRONMENT_SUITABILITY);
  assert.equal(gate.decided_by, COMPONENT.ENVIRONMENT_SUITABILITY_GATE);
  assert.equal(gate.outcome.suitable, false);
  assert.equal(result.ledger.find((e) => e.decision === DECISION.PREFLIGHT), undefined);
  assert.equal(result.png_bytes, undefined);
  // RG-8 the stopped run keeps its evidence: the direction, the copy, the environment provenance and the segmentation quality
  assert.equal(result.direction.spatial_intent, 'PRODUCT_CENTER_TEXT_BELOW');
  assert.deepEqual(result.copy.map((c) => c.text_role), ['HEADLINE', 'SUBHEADLINE', 'PRICE']);
  assert.equal(result.environment.request_id, 'env-req-1');
  assert.equal(result.segmentation.quality.confident, true);
  // RG-9 a stopped run is not "manual steering": every decision it made has a Nordla component, and it says which decisions it did not reach
  assert.equal(result.steering.manual_creative_steering, 'NONE');
  assert.equal(result.steering.run_complete, false);
  assert.ok(result.steering.decisions_not_reached.includes(DECISION.FIDELITY));
});

test('When no brand colour pair reads at all, the run stops with its evidence instead of rendering unreadable text', async () => {
  const murky = { ...BRAND, colors: { a: '#7a7a7a', b: '#808080', c: '#868686' } };
  const result = await run(setup({ environment: flatEnvironment('#8a8a8a'), brand: murky }));
  // RG-10 NO_BRAND_COLOUR_PAIR_READS, with the direction and the environment kept
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'NO_BRAND_COLOUR_PAIR_READS');
  assert.ok(result.direction && result.environment);
});

test('The environment request names nothing it must not draw, refuses display structures, and the suitability measure is calibrated on the real evidence', () => {
  const expression = BRAND.expression;
  const direction = { visual_intent: 'a clean, bright studio surface with soft directional daylight', concept: 'a calm hero', negative_space_intent: 'BOTTOM', direction_id: 'cdr_x' };
  // RG-11 the positive prompt holds no forbidden object word; the negative prompt holds them (and the display furniture)
  const request = buildEnvironmentRequest({ direction, expression, canvas: { width: 1080, height: 1350 } });
  assert.doesNotMatch(request.prompt, /\b(phone|product|case|camera|text|letters|logo|watermark|pedestal|plinth|slab)\b/i);
  assert.match(request.negative_prompt, /phone.*smartphone.*pedestal.*plinth.*podium.*slab/);
  assert.match(request.prompt, /lower part of the frame stays calm/);
  // RG-12 a direction that asks for a display structure is refused (the first real environment had a stone slab with a phone on it)
  assert.deepEqual(displayStructuresIn('soft light on a stone slab and a marble plinth'), ['slab', 'plinth']);
  assert.deepEqual(displayStructuresIn('a seamless stand-alone backdrop'), []);
  assert.throws(() => buildEnvironmentRequest({ direction: { ...direction, visual_intent: 'a stone plinth in soft light' }, expression, canvas: { width: 1080, height: 1350 } }), (e) => e.code === 'DIRECTION_ASKS_FOR_A_DISPLAY_STRUCTURE');
  // RG-13 the suitability measure: a calm gradient passes, a textured block fails, an unmeasurable zone is not suitable
  const calm = { width: 400, height: 400, pixels: Uint8Array.from({ length: 400 * 400 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 150 + ((Math.floor(i / 4) % 400) >> 6))) };
  const box = { x: 100, y: 100, width: 200, height: 200 };
  assert.equal(assessEnvironment({ environment: calm, productBox: box }).suitable, true);
  const busy = { ...calm, pixels: Uint8Array.from(calm.pixels).map((v, i) => (i % 4 === 3 ? 255 : (((Math.floor(i / 4) * 2654435761) >>> 24) % 2 ? 20 : 235))) };
  assert.equal(assessEnvironment({ environment: busy, productBox: box }).suitable, false);
  assert.ok(zoneStructure(busy, box).strong_edge_share > 0.5);
  assert.equal(assessEnvironment({ environment: calm, productBox: { x: 900, y: 900, width: 50, height: 50 } }).suitable, false);
});
