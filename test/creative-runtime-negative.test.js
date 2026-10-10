import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

import * as CI from '../src/creative-intelligence/index.js';
import {
  COMPONENT, createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector,
  DECISION, DIRECTOR_CONSTANTS, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import { productSvg } from './identity-preserve-world.js';
import {
  ANNOTATIONS, BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts,
} from './runtime-world.js';

// The runtime when it must stop (`// RN-N` markers): the provider never receives a product, a bad direction never reaches a provider, and nothing is ever "approximately" done.

const AT = '2026-10-10T12:00:00.000Z';

function setup({ answer = directorAnswer(), environment = fakeEnvironmentPort(), segmenter = null } = {}) {
  const ledger = createDecisionLedger();
  const complete = async () => ({ text: answer, model: 'fake-director', request_id: 'dir-req-1' });
  return {
    ledger, environment,
    agents: {
      analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
      director: createCreativeDirector({ ledger, complete, constants: DIRECTOR_CONSTANTS }),
      copy: createApprovedCopyAgent({ ledger }),
      visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
    },
    ports: { segmenter: segmenter ?? createLocalProductSegmenter({ ledger }), environment },
  };
}
const run = (s, brief = buildBrief()) => runProductPreservingCreative({ at: AT, brief, fonts, agents: s.agents, ports: s.ports, ledger: s.ledger });
const pngOf = (svg) => new Uint8Array(new Resvg(svg).render().asPng());

test('A direction that asks for what the brand forbids, or is not a valid direction, stops the run before any provider call', async () => {
  // RN-1 hearts / gold / glow / leaves are forbidden by the brand's own lists: the request builder refuses, the environment provider is never called
  for (const visual of ['a soft studio with decorative hearts and a warm glow', 'a surface with golden light and fake gold details', 'a bed of leaves and foliage']) {
    const s = setup({ answer: directorAnswer({ visual_intent: visual }) });
    const result = await run(s);
    assert.equal(result.status, 'BLOCKED', visual);
    assert.equal(result.reason, 'DIRECTION_VIOLATES_BRAND_FORBIDDEN_VISUALS', visual);
    assert.equal(s.environment.calls.length, 0, visual);
  }
  // RN-2 a direction outside the contract is refused by the C1 trust boundary (no silent repair): an unknown spatial intent, an extra field, a repeated role, not JSON
  for (const answer of [directorAnswer({ spatial_intent: 'CENTRE_EVERYTHING' }), directorAnswer({ prompt: 'draw a product' }), directorAnswer({ hierarchy: ['PRICE', 'PRICE'] }), 'I would suggest a nice poster']) {
    const s = setup({ answer });
    await assert.rejects(run(s));
    assert.equal(s.environment.calls.length, 0);
  }
  // RN-3 a spatial intent with no recipe is reported, not approximated
  const blockedRecipe = await run(setup({ answer: directorAnswer({ spatial_intent: 'PRODUCT_END_TEXT_START' }) }));
  assert.equal(blockedRecipe.reason, 'NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT');
});

test('The provider never receives a product: a request that carries the real asset is refused', async () => {
  // RN-4 a Visual Production Director that asks a provider to take the real asset is stopped by the runtime
  const s = setup();
  s.agents.visual_director = CI.defineCreativeAgent(CI.AGENT_ROLE.VISUAL_PRODUCTION_DIRECTOR, () => ({
    requests: [
      { request_id: 'segment-product', capability: 'PRODUCT_SEGMENT', purpose: 'REFERENCE', input_asset_refs: ['asset://test/runtime/real-case'], privacy_class: 'BUSINESS', text_policy: 'NO_CRITICAL_TEXT', forbidden_transformations: ['REDRAW_PRODUCT'] },
      { request_id: 'environment', capability: 'IMAGE_GENERATE', purpose: 'BACKGROUND', input_asset_refs: ['asset://test/runtime/real-case'], privacy_class: 'BUSINESS', text_policy: 'NO_CRITICAL_TEXT', forbidden_transformations: ['REDRAW_PRODUCT'] },
    ],
  }));
  const result = await run(s);
  assert.equal(result.reason, 'A_PROVIDER_REQUEST_MAY_NOT_CARRY_A_PRODUCT_ASSET');
  assert.equal(s.environment.calls.length, 0);
  // RN-5 a request that would put critical text into provider pixels is refused by the C1 contract itself
  const textInPixels = setup();
  textInPixels.agents.visual_director = CI.defineCreativeAgent(CI.AGENT_ROLE.VISUAL_PRODUCTION_DIRECTOR, () => ({
    requests: [{ request_id: 'environment', capability: 'IMAGE_GENERATE', purpose: 'BACKGROUND', input_asset_refs: [], privacy_class: 'PUBLIC', text_policy: 'TEXT_ALLOWED', forbidden_transformations: [] }],
  }));
  await assert.rejects(run(textInPixels));
  assert.equal(textInPixels.environment.calls.length, 0);
});

test('No composite strategy, no trusted mask, a bad environment, or a wrong cut-out: the run stops and says why (never READY_FOR_REVIEW)', async () => {
  // RN-6 a product with no cut-out outline is not composited: PIXEL_PRESERVE, no provider
  const noOutline = setup();
  const stopped = await run(noOutline, buildBrief({ identity_annotations: { ...ANNOTATIONS, outline: null } }));
  assert.equal(stopped.reason, 'THE_PRODUCT_PRESERVING_RUNTIME_NEEDS_A_COMPOSITE_STRATEGY');
  assert.equal(stopped.preservation_mode, 'PIXEL_PRESERVE');
  assert.equal(noOutline.environment.calls.length, 0);
  // RN-7 a mask that cannot be trusted stops the run BEFORE the environment is generated
  const weak = setup({ segmenter: { async segment() { return { quality: { confident: false, edge_step_positive_share: 0.2 } }; } } });
  assert.equal((await run(weak)).reason, 'SEGMENTATION_LOW_CONFIDENCE');
  assert.equal(weak.environment.calls.length, 0);
  // RN-8 an environment of the wrong size, or that is not an image, stops the run
  const wrongSize = setup({ environment: fakeEnvironmentPort({ pixelsOf: () => pngOf('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#dddddd"/></svg>') }) });
  assert.equal((await run(wrongSize)).reason, 'THE_ENVIRONMENT_SIZE_DIFFERS_FROM_THE_CANVAS');
  const notAnImage = setup({ environment: fakeEnvironmentPort({ pixelsOf: () => new TextEncoder().encode('not an image') }) });
  assert.equal((await run(notAnImage)).reason, 'THE_ENVIRONMENT_IS_NOT_A_DECODABLE_PNG');
  // RN-9 a cut-out that is NOT the real product (another printed picture) fails the identity gate: FIDELITY_FAIL, never READY_FOR_REVIEW
  const real = createLocalProductSegmenter({ ledger: createDecisionLedger() });
  const product = Buffer.from(pngOf(productSvg({ artworkSeed: 7 }))).toString('base64');
  const forgedSource = pngOf(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#5a5148"/><image x="150" y="120" width="300" height="500" href="data:image/png;base64,${product}"/></svg>`);
  const forging = setup({ segmenter: { async segment({ asset, annotations }) { return real.segment({ asset: { ...asset, bytes: forgedSource }, annotations }); } } });
  const forged = await run(forging);
  assert.equal(forged.status, 'FIDELITY_FAIL');
  assert.ok(forged.fidelity.failed.some((f) => f.check === 'PRODUCT_IDENTITY'));
});

test('Approved text only, and text colours from the brand tokens against the real environment', async () => {
  // RN-10 a hierarchy role with no approved text (CTA) is left unfilled and reported; nothing is written
  const result = await run(setup({ answer: directorAnswer({ hierarchy: ['HEADLINE', 'PRODUCT', 'PRICE', 'CTA'] }) }));
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.fidelity?.failed]));
  const copy = result.ledger.find((e) => e.decision === DECISION.COPY_SELECTION);
  assert.deepEqual(copy.outcome.unfilled_roles, ['CTA']);
  assert.deepEqual(result.copy.map((c) => c.text_role), ['HEADLINE', 'PRICE']);
  // RN-11 the price carries its claim and the exact approved wording; the headline is the approved creative text and has no claim
  const price = result.document.layers.find((l) => l.text_role === 'PRICE');
  assert.equal(price.claim_ref, 'claim://test/price');
  assert.equal(price.content, '25 €');
  assert.equal(result.document.layers.find((l) => l.text_role === 'HEADLINE').claim_ref, null);
  // RN-12 every text colour is a token of the brand palette that reads on the environment behind it, chosen by the typography rules
  const palette = Object.values(BRAND.colors).map((c) => c.toUpperCase());
  const style = result.ledger.find((e) => e.decision === DECISION.TEXT_STYLE);
  assert.equal(style.decided_by, COMPONENT.TYPOGRAPHY_RULES);
  for (const layer of result.document.layers.filter((l) => l.type === 'TEXT')) assert.ok(palette.includes(layer.color.toUpperCase()), layer.color);
  assert.ok(style.outcome.choices.every((c) => c.worst_contrast >= 4.5), JSON.stringify(style.outcome.choices));
  // RN-12b the rule picks the BEST token, not just a readable one: the headline takes the highest worst-case contrast, the price the most saturated token that reads
  const headline = style.outcome.choices.find((c) => c.role === 'HEADLINE');
  assert.equal(headline.worst_contrast, Math.max(...headline.candidates.map((c) => c.contrast)));
  const priceChoice = style.outcome.choices.find((c) => c.role === 'PRICE');
  const saturation = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1)); };
  const reading = priceChoice.candidates.filter((c) => c.contrast >= 4.5);
  const accent = [...reading].sort((x, y) => saturation(BRAND.colors[y.token]) - saturation(BRAND.colors[x.token]) || y.contrast - x.contrast)[0];
  assert.equal(priceChoice.token, accent.token);
});

test('The runtime reads no clock, no network and no environment, and holds no provider, model name or secret', async () => {
  const dir = new URL('../src/creative-runtime/', import.meta.url);
  for (const file of await readdir(dir)) {
    const source = await readFile(new URL(file, dir), 'utf8');
    // RN-13 no clock, randomness, network or environment access, no provider / model identifier, no key
    assert.doesNotMatch(source, /Date\.now\(|new Date\(\)|Math\.random|randomUUID|fetch\(|node:https?|node:net|process\.env|sk-[A-Za-z0-9]{8,}|qwen|alibaba/i, file);
  }
});
