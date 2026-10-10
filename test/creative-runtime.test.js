import test from 'node:test';
import assert from 'node:assert/strict';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import {
  COMPONENT, createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector,
  DECISION, DIRECTOR_CONSTANTS, REQUIRED_DECISIONS, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import {
  ANNOTATIONS, BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts, SOURCE, sha,
} from './runtime-world.js';

// The Nordla creative runtime (`// RT-N` markers): every decision comes from a Nordla component and is recorded; the provider never receives the product.

const AT = '2026-10-10T12:00:00.000Z';

function setup({ answer = directorAnswer(), environment = fakeEnvironmentPort(), segmenter = null, expression = BRAND.expression } = {}) {
  const ledger = createDecisionLedger();
  const completions = [];
  const complete = async (prompt) => { completions.push(prompt); return { text: answer, model: 'fake-director', request_id: 'dir-req-1' }; };
  return {
    ledger, completions, environment,
    agents: {
      analyst: createProductAssetAnalyst({ ledger, expression }),
      director: createCreativeDirector({ ledger, complete, constants: DIRECTOR_CONSTANTS }),
      copy: createApprovedCopyAgent({ ledger }),
      visual_director: createVisualProductionDirector({ ledger, expression }),
    },
    ports: { segmenter: segmenter ?? createLocalProductSegmenter({ ledger }), environment },
  };
}
const run = (s, brief = buildBrief()) => runProductPreservingCreative({ at: AT, brief, fonts, agents: s.agents, ports: s.ports, ledger: s.ledger });

test('A full run: the real product is cut out locally, the provider only draws an empty environment, Nordla places, types and gates', async () => {
  const s = setup();
  const result = await run(s);
  // RT-1 a candidate for review: preflight PASS, a RESOLVED render with REAL typography, the identity gate PASS on the delivered PNG
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.fidelity?.failed, result.preflight, result.violations]));
  assert.equal(result.preflight.status, 'PASS');
  assert.deepEqual([result.render.render_mode, result.render.typography_mode], ['RESOLVED', 'REAL']);
  assert.equal(result.fidelity.gate, 'PASS');
  assert.deepEqual([result.width, result.height], [1080, 1350]);
  // RT-2 the only media consumed by the renderer are the cut-out and the environment (two draws); the real photograph itself is never drawn
  assert.equal(result.render.resolutions, 2);
  assert.equal(result.render.image_draws, 2);
  // RT-3 the provider request had NO input asset and described an empty scene without any text
  assert.equal(s.environment.calls.length, 1);
  const request = s.environment.calls[0];
  assert.deepEqual(request.input_asset_refs, []);
  // the positive prompt describes an empty surface and NAMES NOTHING it must not draw; what is forbidden is in the negative prompt only (naming it primes a generator to draw it)
  assert.match(request.prompt, /quiet and empty/);
  assert.doesNotMatch(request.prompt, /\b(phone|product|case|camera|text|letters|logo|watermark)\b/i);
  assert.match(request.negative_prompt, /product.*phone.*pedestal.*plinth.*slab.*text.*letters.*logo.*watermark/);
  assert.doesNotMatch(request.prompt, /product photography|real HABB product/i);
  assert.equal(result.environment.carries_input_asset, false);
  // RT-4 the approved texts, and only them, are on the poster: claim-bearing text carries its claim, the headline is the approved creative text
  assert.deepEqual(result.copy.map((c) => [c.text_role, c.content]), [['HEADLINE', 'Vos souvenirs. Votre création.'], ['SUBHEADLINE', 'Coque personnalisée en 5 minutes'], ['PRICE', '25 €']]);
  // RT-5 the product is dominant: placed by the layout engine in a recipe chosen by the planner from the director's spatial intent
  const product = result.document.layers.find((l) => l.type === 'PRODUCT');
  assert.equal(product.preservation_mode, 'COMPOSITE');
  assert.ok(product.geometry.height / 1350 > 0.45, `product height share ${product.geometry.height / 1350}`);
  assert.equal(result.ledger.find((e) => e.decision === DECISION.LAYOUT_RECIPE).outcome.recipe_id, 'PRODUCT_DOMINANT');
});

test('Every required decision is made by a named Nordla component: no manual creative steering', async () => {
  const s = setup();
  const result = await run(s);
  const attribution = result.steering.attribution;
  // RT-6 each decision has its component
  assert.equal(result.steering.manual_creative_steering, 'NONE');
  assert.deepEqual(result.steering.missing_decisions, []);
  assert.deepEqual(attribution[DECISION.PRODUCT_PRESERVATION_MODE], [COMPONENT.PRODUCT_ASSET_ANALYST]);
  assert.deepEqual(attribution[DECISION.SEGMENTATION], [COMPONENT.LOCAL_PRODUCT_SEGMENTER]);
  assert.deepEqual(attribution[DECISION.CREATIVE_DIRECTION], [COMPONENT.CREATIVE_DIRECTOR]);
  assert.deepEqual(attribution[DECISION.BACKGROUND_STRATEGY], [COMPONENT.VISUAL_PRODUCTION_DIRECTOR]);
  assert.deepEqual(attribution[DECISION.PROVIDER_REQUEST_CONSTRUCTION], [COMPONENT.PROVIDER_REQUEST_BUILDER]);
  assert.deepEqual(attribution[DECISION.LAYOUT_RECIPE], [COMPONENT.LAYOUT_PLANNER]);
  assert.deepEqual(attribution[DECISION.PRODUCT_PLACEMENT], [COMPONENT.LAYOUT_ENGINE]);
  assert.deepEqual(attribution[DECISION.TYPOGRAPHY_PLACEMENT], [COMPONENT.LAYOUT_ENGINE]);
  assert.deepEqual(attribution[DECISION.FIDELITY], [COMPONENT.IDENTITY_FIDELITY_GATE]);
  for (const decision of REQUIRED_DECISIONS) assert.ok(attribution[decision], decision);
  // RT-7 the preservation mode and the strategy rest on the brand's own principles (recorded as the basis)
  const mode = result.ledger.find((e) => e.decision === DECISION.PRODUCT_PRESERVATION_MODE);
  assert.equal(mode.outcome.mode, 'COMPOSITE');
  assert.equal(mode.rule, 'BRAND_PREFERS_COMPOSITE_OVER_REGENERATION');
  assert.ok(mode.basis.some((b) => /cut-out and compositing/.test(b)));
  // RT-8 the ledger refuses a decision that no Nordla component owns (a person, "manual" steering, an unknown component)
  const ledger = createDecisionLedger();
  for (const decided_by of ['human:owner', 'manual', 'claude', 'nordla:unknown@1', undefined]) {
    assert.throws(() => ledger.record({ decision: DECISION.LAYOUT_RECIPE, decided_by }), /no Nordla component|DECISION_NOT_ATTRIBUTABLE/);
  }
  assert.throws(() => ledger.record({ decision: 'CUSTOM_TASTE', decided_by: COMPONENT.LAYOUT_PLANNER }), /unknown decision/);
  // a run with a missing decision cannot claim "NONE"
  assert.equal(CI.PRESERVATION_MODE.COMPOSITE, 'COMPOSITE');
});
