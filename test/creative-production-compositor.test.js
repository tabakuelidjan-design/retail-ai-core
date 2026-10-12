import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePng } from '../src/creative-intelligence/png-pixels.js';
import { encodePng } from '../src/creative-intelligence/png-encode.js';
import { rasterizeToPixels } from '../src/creative-intelligence/production-render.js';
import {
  composeLayers, evaluateProviderGate, GATE_REASON, GATE_STATUS, OVERLAP_LIMIT,
} from '../src/creative-production/index.js';
import { produced } from './creative-production-world.js';

// THE LAYER COMPOSITOR (`// LC-N`) AND THE PROVIDER GATE (`// PG-N`): deterministic, pixel-exact, measured, refusing. Synthetic pixels only.

const solid = (width, height, [r, g, b, a = 255], mark = null) => {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) pixels.set([r, g, b, a], i * 4);
  if (mark) for (let y = mark.y; y < mark.y + mark.h; y += 1) for (let x = mark.x; x < mark.x + mark.w; x += 1) pixels.set(mark.rgba, (y * width + x) * 4);
  return encodePng({ width, height, pixels });
};
const CANVAS = { width: 200, height: 200 };
const plate = { layer_id: 'plate', kind: 'PLATE', z: 0, png: solid(200, 200, [230, 225, 215]), x: 0, y: 0 };
const back = { layer_id: 'back', kind: 'PROP_MIDGROUND', z: 20, png: solid(40, 40, [200, 40, 40]), x: 20, y: 20 };
const product = { layer_id: 'product', kind: 'PRODUCT', z: 30, png: solid(60, 80, [20, 40, 160], { x: 10, y: 10, w: 8, h: 8, rgba: [255, 255, 255, 255] }), x: 80, y: 60 };
const front = (overlap = { policy: 'EDGE_ONLY' }, x = 130, y = 70, size = 30) => ({
  layer_id: 'front', kind: 'PROP_FOREGROUND', z: 40, png: solid(size, size, [30, 160, 60]), x, y, overlap,
});
const pixelAt = (png, x, y) => { const d = decodePng(png); const i = (y * d.width + x) * 4; return [...d.pixels.slice(i, i + 4)]; };
const compose = (layers, extra = {}) => composeLayers({ canvas: CANVAS, layers, ...extra });

test('LC-1 the layers are composed in the explicit z-order, exactly', () => {
  const out = compose([front(), product, plate, back]);
  assert.equal(out.status, 'COMPOSED'); assert.deepEqual(out.report.layer_order, ['plate', 'back', 'product', 'front']);
  assert.deepEqual(pixelAt(out.png, 5, 5), [230, 225, 215, 255], 'the plate');
  assert.deepEqual(pixelAt(out.png, 30, 30), [200, 40, 40, 255], 'the prop under the product');
  assert.deepEqual(pixelAt(out.png, 100, 100), [20, 40, 160, 255], 'the real product');
  assert.deepEqual(pixelAt(out.png, 92, 72), [255, 255, 255, 255], 'a marker of the product is intact');
  assert.deepEqual(pixelAt(out.png, 130, 80), [30, 160, 60, 255], 'the foreground prop is above the product');
  assert.equal(out.report.product_pixels_changed, 0); assert.ok(out.report.product_pixels_checked > 0);
});

test('LC-2 the composition is deterministic: the same layers give the same bytes, whatever the order they are given in', () => {
  const a = compose([plate, back, product, front()]); const b = compose([front(), back, product, plate]);
  assert.deepEqual(Buffer.from(a.png), Buffer.from(b.png));
});

test('LC-3 a foreground prop may cover only the edge of the product, within its policy', () => {
  const edge = compose([plate, back, product, front({ policy: 'EDGE_ONLY' }, 130, 70, 30)]);
  assert.equal(edge.status, 'COMPOSED'); assert.ok(edge.report.foreground[0].share_of_product > 0 && edge.report.foreground[0].share_of_product <= OVERLAP_LIMIT.EDGE_ONLY);
  const none = compose([plate, back, product, front({ policy: 'NONE' }, 130, 70, 30)]);
  assert.equal(none.status, 'REFUSED'); assert.ok(none.report.problems.some((p) => p.startsWith('OVERLAP_EXCEEDS_ITS_POLICY')));
  const deep = compose([plate, back, product, front({ policy: 'EDGE_ONLY' }, 110, 80, 40)]);
  assert.equal(deep.status, 'REFUSED'); assert.ok(deep.report.problems.some((p) => p.startsWith('OVERLAP_EXCEEDS_ITS_POLICY'))); assert.equal(deep.png, null, 'a refused composition produces no image');
  const apart = compose([plate, back, product, front({ policy: 'NONE' }, 160, 20, 20)]);
  assert.equal(apart.status, 'COMPOSED'); assert.equal(apart.report.foreground[0].covered_pixels, 0);
});

test('LC-4 a foreground prop never covers a protected region of the product', () => {
  const region = { x: 120, y: 70, width: 8, height: 8 };
  const covers = compose([plate, back, product, front({ policy: 'EDGE_ONLY' }, 118, 66, 12)], { protectedRegions: [region] });
  assert.equal(covers.status, 'REFUSED'); assert.ok(covers.report.problems.some((p) => p.startsWith('COVERS_A_PROTECTED_REGION'))); assert.ok(covers.report.foreground[0].covered_protected_pixels > 0);
  const clear = compose([plate, back, product, front({ policy: 'EDGE_ONLY' }, 130, 70, 30)], { protectedRegions: [{ x: 82, y: 62, width: 8, height: 8 }] });
  assert.equal(clear.status, 'COMPOSED');
});

test('LC-5 the real product is never altered: a rasterizer that changes its pixels is caught', () => {
  const faulty = (svg) => { const r = rasterizeToPixels(svg); const p = (100 * r.width + 100) * 4; r.pixels[p] = 0; return r; };
  const out = compose([plate, back, product, front()], { rasterize: faulty });
  assert.equal(out.status, 'REFUSED'); assert.ok(out.report.problems.includes('THE_PRODUCT_PIXELS_CHANGED')); assert.ok(out.report.product_pixels_changed > 0);
});

test('LC-6 the structure is refused when it is not a scene: no product, two products, text, a layer outside its band, two layers at one height', () => {
  assert.ok(compose([plate, back]).report.problems.includes('EXACTLY_ONE_PRODUCT_LAYER'));
  assert.ok(compose([plate, product, { ...product, layer_id: 'p2', z: 31 }]).report.problems.includes('EXACTLY_ONE_PRODUCT_LAYER'));
  assert.ok(compose([plate, product, { layer_id: 'text', kind: 'TEXT', z: 50, png: solid(10, 10, [0, 0, 0]), x: 0, y: 0 }]).report.problems.includes('TEXT_IS_NOT_DRAWN_HERE'));
  assert.ok(compose([plate, product, { ...back, z: 45 }]).report.problems.some((p) => p.startsWith('Z_NOT_IN_THE_BAND')));
  assert.ok(compose([plate, product, { ...back, z: 0 }]).report.problems.some((p) => p.startsWith('Z_NOT_UNIQUE') || p.startsWith('Z_NOT_IN_THE_BAND')));
  assert.ok(compose([plate, product, { ...back, kind: 'PROP_BACKGROUND', z: 35 }]).report.problems.some((p) => p.startsWith('Z_NOT_IN_THE_BAND') || p.startsWith('ABOVE_THE_PRODUCT')));
  assert.ok(compose([plate, product, { ...back, kind: 'PROP_MIDGROUND', z: 20 }, { ...back, layer_id: 'back2', z: 20, x: 100, y: 150 }]).report.problems.some((p) => p.startsWith('Z_NOT_UNIQUE')));
});

test('LC-7 transparent pixels of a layer cover nothing: a prop cut out of its ground leaves the plate visible around it', () => {
  const cutout = { ...back, png: solid(40, 40, [200, 40, 40, 0], { x: 10, y: 10, w: 20, h: 20, rgba: [200, 40, 40, 255] }) };
  const out = compose([plate, cutout, product]);
  assert.deepEqual(pixelAt(out.png, 22, 22), [230, 225, 215, 255], 'the transparent corner shows the plate'); assert.deepEqual(pixelAt(out.png, 40, 40), [200, 40, 40, 255]);
});

test('PG-1 the provider gate fails closed on every condition, names each, and never calls a provider', async () => {
  const { result } = await produced({ assets: 5 });
  const ready = { ready: true, status: 'CREATIVE_PIPELINE_READY' };
  const open = (over = {}) => evaluateProviderGate({ production: result, readiness: ready, ...over });
  assert.equal(open().status, GATE_STATUS.READY_PENDING_OWNER_GO); assert.deepEqual(open().reasons, [GATE_REASON.OWNER_GO_PENDING]);
  assert.equal(open({ ownerGo: true }).status, GATE_STATUS.OPEN_BY_OWNER); assert.deepEqual(open({ ownerGo: true }).reasons, []);
  assert.equal(open().provider_calls, 0); assert.equal(open({ ownerGo: true }).provider_calls, 0);
  const cases = [
    ['no production', { production: null }, GATE_REASON.PRODUCTION_NOT_SPECIFIED],
    ['no readiness', { readiness: null }, GATE_REASON.PIPELINE_NOT_READY],
    ['readiness not ready', { readiness: { ready: false, status: 'NOT_READY' } }, GATE_REASON.PIPELINE_NOT_READY],
    ['readiness ready but another status', { readiness: { ready: true, status: 'CREATIVE_BRAIN_CONTRACT_PARITY_READY' } }, GATE_REASON.PIPELINE_NOT_READY],
    ['compositor not wired', { runtime: { wired: false } }, GATE_REASON.COMPOSITOR_NOT_WIRED_TO_THE_RUNTIME],
    ['identity not verified', { production: { ...result, product_identity: { ...result.product_identity, status: 'AMBIGUOUS' } } }, GATE_REASON.PRODUCT_IDENTITY_NOT_VERIFIED],
    ['a scene not specified', { production: { ...result, scenes: [{ ...result.scenes[0], status: 'BLOCKED' }, ...result.scenes.slice(1)] } }, GATE_REASON.PRODUCTION_NOT_SPECIFIED],
    ['production blocked', { production: { ...result, status: 'BLOCKED' } }, GATE_REASON.PRODUCTION_NOT_SPECIFIED],
    ['budget blocked', { production: { ...result, production: { ...result.production, budget: { ...result.production.budget, within_ceiling: false } } } }, GATE_REASON.BUDGET_BLOCKED],
  ];
  for (const [name, over, reason] of cases) {
    const g = open({ ...over, ownerGo: true });
    assert.equal(g.status, GATE_STATUS.NOT_READY, name); assert.ok(g.reasons.includes(reason), `${name}: ${g.reasons}`);
  }
  assert.equal(open().compositorWired, undefined);
  assert.equal(evaluateProviderGate({ production: result }).status, GATE_STATUS.NOT_READY, 'the default is closed');
  assert.match(open().gate_id, /^gat_/);
});

test('PG-2 an unverified product keeps the gate shut even with everything else in order', async () => {
  const { result } = await produced({}, { productionBrief: null });
  const { campaign, brief, request, planner } = await produced({ assets: 5 });
  const intentOnly = await planner.plan({ campaignResult: campaign, brief: { ...brief, identity_annotations: {} }, request });
  const g = evaluateProviderGate({ production: intentOnly, readiness: { ready: true, status: 'CREATIVE_PIPELINE_READY' }, ownerGo: true });
  assert.equal(g.status, 'NOT_READY'); assert.ok(g.reasons.includes('PRODUCT_IDENTITY_NOT_VERIFIED') && g.reasons.includes('PRODUCTION_NOT_SPECIFIED'));
  assert.equal(result.status, 'SPECIFIED');
});

test('LC-8 an under-the-product composition has no product and nothing at or above it', () => {
  const plate = { layer_id: 'plate', kind: 'PLATE', z: 0, png: solid(40, 40, [200, 200, 200, 255]), x: 0, y: 0 };
  const product = { layer_id: 'product', kind: 'PRODUCT', z: 30, png: solid(10, 10, [10, 20, 30, 255]), x: 5, y: 5 };
  const foreground = { layer_id: 'fg', kind: 'PROP_FOREGROUND', z: 40, png: solid(6, 6, [90, 0, 0, 255]), x: 20, y: 20 };
  const ok = composeLayers({ canvas: { width: 40, height: 40 }, layers: [plate], requireProduct: false });
  assert.equal(ok.status, 'COMPOSED'); assert.deepEqual(ok.report.problems, []);
  const withProduct = composeLayers({ canvas: { width: 40, height: 40 }, layers: [plate, product], requireProduct: false });
  assert.equal(withProduct.status, 'REFUSED'); assert.ok(withProduct.report.problems.includes('NO_PRODUCT_LAYER_IN_AN_UNDER_COMPOSITION') && withProduct.report.problems.includes('A_LAYER_AT_OR_ABOVE_THE_PRODUCT_IN_AN_UNDER_COMPOSITION'));
  const withForeground = composeLayers({ canvas: { width: 40, height: 40 }, layers: [plate, foreground], requireProduct: false });
  assert.equal(withForeground.status, 'REFUSED'); assert.deepEqual(withForeground.report.problems, ['A_LAYER_AT_OR_ABOVE_THE_PRODUCT_IN_AN_UNDER_COMPOSITION']);
  // the default still asks for exactly one product
  assert.deepEqual(composeLayers({ canvas: { width: 40, height: 40 }, layers: [plate] }).report.problems, ['EXACTLY_ONE_PRODUCT_LAYER']);
});
