import test from 'node:test';
import assert from 'node:assert/strict';

import { STANDARD_PLACEMENT, standardScene } from './creative-integration-shared.js';
import * as W from './creative-integration-world.js';
import { composeLayers } from '../src/creative-production/compositor.js';
import {
  STATE, createSegmentationCache, integrateProduct, integrateScene, relightProduct, renderAcceptance, toCompositorLayers,
} from '../src/creative-integration/index.js';

// The integration pipeline end to end on drawn products (`// PI-N` markers): the real product test matrix, every explicit failure state, no fallback to a generated product, the layered compositor
// accepting the result, the multi-product scene, performance and reuse.

const scene = standardScene();
const run = (name, over = {}) => integrateProduct({ source: W.ALL[name]().rgba, scene, placement: STANDARD_PLACEMENT, shadow_kind: 'SOFT', ...over });
const results = new Map();
const ready = (name) => { if (!results.has(name)) results.set(name, run(name)); return results.get(name); };

test('Real product test matrix: every product class is segmented, integrated, and passes its gates', () => {
  for (const name of ['phoneCase', 'tumbler', 'magnet', 'framedPrint', 'giftBox', 'smallTech', 'metallic']) {
    const r = ready(name);
    // PI-1 READY_FOR_COMPOSITE with the evidence of every stage
    assert.equal(r.state, STATE.READY_FOR_COMPOSITE, `${name}: ${r.stage} ${r.reasons}`);
    assert.equal(r.matte.valid, true); assert.equal(r.identity.valid, true); assert.equal(r.artifacts.clean, true); assert.equal(r.placement.state, STATE.READY_FOR_COMPOSITE);
    // PI-2 the layers are separate values: the product, the contact shadow, the graded cut-out, the plate is unchanged
    assert.ok(r.layers.product && r.layers.shadow && r.layers.cutout && r.layers.graded_cutout);
    assert.equal(Buffer.compare(Buffer.from(scene.plate.pixels), Buffer.from(standardScene().plate.pixels)), 0);
    // PI-3 provenance: a hash of every stage and a trace
    for (const k of ['source', 'mask', 'cutout', 'graded_product', 'shadow', 'composite', 'recipe']) assert.match(r.hashes[k], /^[0-9a-f]{64}$/);
    assert.deepEqual(r.trace.map((t) => t.stage), ['SEGMENTATION', 'MATTE_QUALITY', 'PLACEMENT', 'RELIGHT', 'IDENTITY', 'ARTIFACTS']);
  }
});

test('Product identity in the final scene: the real pixels reach the composite unchanged (up to the declared grade)', () => {
  const r = ready('phoneCase'); const { product } = r.layers;
  // PI-4 where nothing covers it, an opaque product pixel is the product layer's pixel in the composite
  let checked = 0; let changed = 0;
  for (let y = 0; y < product.rgba.height; y += 1) for (let x = 0; x < product.rgba.width; x += 1) {
    const p = (y * product.rgba.width + x) * 4; if (product.rgba.pixels[p + 3] !== 255) continue;
    const d = ((product.rect.y + y) * r.composite.width + product.rect.x + x) * 4; checked += 1;
    if (r.composite.pixels[d] !== product.rgba.pixels[p] || r.composite.pixels[d + 1] !== product.rgba.pixels[p + 1] || r.composite.pixels[d + 2] !== product.rgba.pixels[p + 2]) changed += 1;
  }
  assert.ok(checked > 5000); assert.equal(changed, 0);
  // PI-5 the graded product is a bounded, recoverable derivative: the original cut-out is kept and the recipe reproduces the graded one
  assert.ok(r.relight.measured.max_luma_change <= 0.22);
  const graded = run('phoneCase', { grade: { exposure_ev: -0.2, temperature: 0.03 } }); assert.equal(graded.state, STATE.READY_FOR_COMPOSITE);
  assert.notEqual(graded.layers.cutout, graded.layers.graded_cutout); assert.notEqual(graded.hashes.cutout, graded.hashes.graded_product);
  assert.equal(graded.hashes.mask, r.hashes.mask); // the same matte, a different grade
  assert.equal(relightProduct({ cutout: graded.layers.cutout, request: graded.relight.recipe }).recipe_sha256, graded.hashes.recipe); // the recipe is the whole story
});

test('The Phase 3 deterministic compositor accepts the integrated layers and measures that the product pixels are unchanged', () => {
  const r = ready('giftBox'); const plate = scene.plate;
  const layers = toCompositorLayers({ placed: r.layers.product, shadow: r.layers.shadow, plate });
  // PI-6 plate < midground (the shadow) < product, in the compositor's explicit z-order
  const out = composeLayers({ canvas: { width: plate.width, height: plate.height }, layers });
  assert.equal(out.status, 'COMPOSED', JSON.stringify(out.report.problems));
  assert.ok(out.report.product_pixels_checked > 1000); assert.equal(out.report.product_pixels_changed, 0);
  assert.deepEqual(out.report.layer_order, ['plate', 'contact_shadow', 'product']);
});

test('Every explicit failure state is reachable, names its stage and reasons, and delivers no layers', () => {
  const stops = [];
  // PI-7 SEGMENTATION_FAILED: a ground that is not plain
  stops.push(integrateProduct({ source: W.clutteredGround().rgba, scene, placement: STANDARD_PLACEMENT }));
  assert.equal(stops[0].state, STATE.SEGMENTATION_FAILED); assert.deepEqual(stops[0].reasons, ['BACKGROUND_NOT_PLAIN']);
  // PI-8 a white product on a near-white ground: stopped by the segmentation or, failing that, by the matte checks
  const low = integrateProduct({ source: W.lowContrast().rgba, scene, placement: STANDARD_PLACEMENT }); stops.push(low);
  assert.ok([STATE.SEGMENTATION_LOW_CONFIDENCE, STATE.SEGMENTATION_FAILED, STATE.MATTE_INVALID].includes(low.state), low.state); // the two layers together never deliver it
  // PI-9 several objects and no explicit selection: SEGMENTATION_FAILED (ambiguous), not a guess
  const amb = integrateProduct({ source: W.multiObject().rgba, scene, placement: STANDARD_PLACEMENT }); stops.push(amb); assert.deepEqual(amb.reasons, ['AMBIGUOUS_SELECTION']);
  // PI-10 MATTE_INVALID: a port that returns a dilated matte (ground inside the product) with a high confidence
  const base = W.ALL.phoneCase(); const good = ready('phoneCase').segmentation;
  const fat = Uint8Array.from(good.alpha); const w = base.rgba.width;
  for (let y = 1; y < base.rgba.height - 1; y += 1) for (let x = 1; x < w - 1; x += 1) if (good.alpha[y * w + x] >= 128) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) fat[(y + dy) * w + x + dx] = 255;
  const matte = integrateProduct({ source: base.rgba, scene, placement: STANDARD_PLACEMENT, port: { id: 'bad-port', segment: () => ({ ...good, alpha: fat, bounds: { x0: good.bounds.x0 - 1, y0: good.bounds.y0 - 1, x1: good.bounds.x1 + 1, y1: good.bounds.y1 + 1 }, source: undefined }) } }); stops.push(matte);
  assert.equal(matte.state, STATE.MATTE_INVALID); assert.ok(matte.reasons.length > 0);
  // PI-11 PLACEMENT_INVALID: the product would stand in the sky
  const place = run('magnet', { placement: { x: 450, y: 300, scale: 0.7 } }); stops.push(place); assert.equal(place.state, STATE.PLACEMENT_INVALID); assert.ok(place.reasons.includes('CONTACT_ABOVE_THE_HORIZON'));
  // PI-12 RELIGHT_OUT_OF_BOUNDS: an explicit request beyond the bounds is refused, not clamped
  const rel = run('phoneCase', { grade: { exposure_ev: 1.2 } }); stops.push(rel); assert.equal(rel.state, STATE.RELIGHT_OUT_OF_BOUNDS); assert.ok(rel.reasons[0].startsWith('exposure_ev'));
  // PI-13 PRODUCT_IDENTITY_RISK: an explicit grade whose combined colour change leaves the identity envelope
  const id = run('phoneCase', { grade: { temperature: 0.06, tint: 0.04, saturation: 0.1, exposure_ev: -0.4, local_gain: 0.15, light_angle_deg: 0 } }); stops.push(id);
  assert.ok([STATE.PRODUCT_IDENTITY_RISK, STATE.RELIGHT_OUT_OF_BOUNDS].includes(id.state));
  // PI-14 SHADOW_INVALID: an impossible light
  const sh = run('magnet', { scene: { ...scene, light: { angle_deg: 120, elevation_deg: 0, softness: 0.5 } } }); stops.push(sh); assert.equal(sh.state, STATE.SHADOW_INVALID);
  // PI-15 INTEGRATION_ARTIFACT: the plate already carries a shadow where the product stands
  const dark = { ...scene.plate, pixels: Uint8Array.from(scene.plate.pixels) };
  for (let y = 598; y < 610; y += 1) for (let x = 330; x < 570; x += 1) for (let c = 0; c < 3; c += 1) dark.pixels[(y * 900 + x) * 4 + c] = Math.round(dark.pixels[(y * 900 + x) * 4 + c] * 0.5);
  const art = run('magnet', { scene: { ...scene, plate: dark } }); stops.push(art); assert.equal(art.state, STATE.INTEGRATION_ARTIFACT); assert.ok(art.reasons.includes('PLATE_SHADOW_AT_CONTACT'));
  // PI-16 the scene too dark for the product: COLOR_* is an artifact, not silently graded away
  const night = { ...scene.plate, pixels: scene.plate.pixels.map((v, i) => (i % 4 === 3 ? v : Math.round(v * 0.3))) };
  const dim = run('magnet', { scene: { ...scene, plate: night } }); stops.push(dim); assert.equal(dim.state, STATE.INTEGRATION_ARTIFACT); assert.ok(dim.reasons.some((r) => r.startsWith('COLOR_')));
  // PI-17 every stop: a classified state, a stage, reasons, and NO layers and NO png (nothing is delivered as ready)
  for (const s of stops) { assert.notEqual(s.state, STATE.READY_FOR_COMPOSITE); assert.ok(s.stage && Array.isArray(s.reasons) && s.reasons.length > 0); assert.equal(s.layers, undefined); assert.equal(s.png, undefined); }
});

test('No silent fallback to a generated product: the only collaborator is the segmentation port, and it is asked once', () => {
  // PI-18 a refused product is never replaced: the result of a stop carries no composite built from anything but the source
  const stopped = integrateProduct({ source: W.clutteredGround().rgba, scene, placement: STANDARD_PLACEMENT });
  assert.equal(stopped.composite, undefined);
  // PI-19 the port is called once per source + selection even across two integrations (cache); no other collaborator exists
  let calls = 0; const cache = createSegmentationCache(); const f = W.magnet(); const seg = ready('magnet').segmentation;
  const port = { id: 'counting', segment: () => { calls += 1; return { ...seg, source: undefined }; } };
  const a = integrateProduct({ source: f.rgba, scene, placement: STANDARD_PLACEMENT, port, cache }); const b = integrateProduct({ source: f.rgba, scene, placement: { ...STANDARD_PLACEMENT, x: 500 }, port, cache });
  assert.equal(calls, 1); assert.equal(a.state, STATE.READY_FOR_COMPOSITE); assert.equal(b.state, STATE.READY_FOR_COMPOSITE);
  // PI-20 a port result below the confidence minimum stops the integration
  const lowPort = integrateProduct({ source: f.rgba, scene, placement: STANDARD_PLACEMENT, port: { id: 'weak', segment: () => ({ ...seg, confidence: 0.3 }) } });
  assert.equal(lowPort.state, STATE.SEGMENTATION_LOW_CONFIDENCE);
});

test('Several products in one scene: explicit selections, depth order, and one failing product fails the scene', () => {
  const m = W.multiObject(); const sc = standardScene();
  const products = [
    { id: 'red', selection: { mode: 'IDS', ids: ['o2'] }, placement: { x: 300, y: 560, scale: 0.7 }, shadow_kind: 'SOFT' },
    { id: 'navy', selection: { mode: 'IDS', ids: ['o1'] }, placement: { x: 560, y: 620, scale: 0.6 }, shadow_kind: 'SOFT' },
  ];
  const cache = createSegmentationCache();
  // PI-21 two products from one photograph, each integrated against the scene so far, ordered by depth (the farther first)
  const out = integrateScene({ source: m.rgba, products, scene: sc, cache });
  assert.equal(out.state, STATE.READY_FOR_COMPOSITE, JSON.stringify(out.reasons)); assert.deepEqual(out.results.map((r) => r.id), ['red', 'navy']);
  // PI-22 the source was analysed once for both (the second selection hit the cache)
  assert.ok(cache.stats.hits >= 1);
  // PI-23 one product that cannot be placed stops the whole scene and names it
  const bad = integrateScene({ source: m.rgba, products: [products[0], { ...products[1], placement: { x: 560, y: 300, scale: 0.6 } }], scene: sc, cache });
  assert.equal(bad.state, STATE.PLACEMENT_INVALID); assert.equal(bad.failed_product, 'navy'); assert.equal(bad.png, undefined);
  // PI-24 an unselected product is rejected: AUTO on a multi-object photograph is ambiguous
  const amb = integrateScene({ source: m.rgba, products: [{ id: 'x', selection: { mode: 'AUTO' }, placement: { x: 300, y: 560, scale: 0.7 } }], scene: sc });
  assert.equal(amb.state, STATE.SEGMENTATION_FAILED);
});

test('Visual acceptance output: seven views per candidate, as separate images and one sheet', () => {
  const f = W.phoneCase(); const r = ready('phoneCase'); const v = renderAcceptance({ source: f.rgba, result: r });
  // PI-25
  for (const name of ['SOURCE', 'MASK', 'COMPOSITE', 'EDGE CLOSE-UP', 'CONTACT SHADOW CLOSE-UP', 'PRODUCT FIDELITY DIFF', 'FINAL SCENE']) { assert.ok(v.panels[name] instanceof Uint8Array, name); assert.equal(v.panels[name][1], 0x50); }
  assert.equal(v.sheet[1], 0x50); assert.ok(v.sheet.length > 5000);
  // PI-26 deterministic
  assert.equal(Buffer.compare(Buffer.from(renderAcceptance({ source: f.rgba, result: r }).sheet), Buffer.from(v.sheet)), 0);
});

test('Performance is measured, bounded, and a reused mask costs almost nothing', () => {
  const f = W.giftBox(); const cache = createSegmentationCache();
  const first = integrateProduct({ source: f.rgba, scene, placement: STANDARD_PLACEMENT, cache });
  const second = integrateProduct({ source: f.rgba, scene, placement: { ...STANDARD_PLACEMENT, x: 520 }, cache });
  // PI-27 every stage is timed
  for (const k of ['segmentation', 'matte_quality', 'cutout', 'placement', 'relight_identity', 'shadow', 'composite', 'artifacts']) assert.ok(first.timings_ms[k] >= 0, k);
  // PI-28 the second integration of the same source and selection reuses the mask: its segmentation time is a small fraction of the first
  assert.ok(second.timings_ms.segmentation < first.timings_ms.segmentation * 0.2, `${second.timings_ms.segmentation} vs ${first.timings_ms.segmentation}`);
  // PI-29 a whole integration of a 360 x 320 photograph into a 900 x 700 scene stays within a generous bound
  assert.ok(Object.values(first.timings_ms).reduce((a, b) => a + b, 0) < 20000);
});
