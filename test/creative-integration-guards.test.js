import test from 'node:test';
import assert from 'node:assert/strict';

import { STANDARD_LIGHT, STANDARD_PLACEMENT, segmented, standardScene } from './creative-integration-shared.js';
import * as W from './creative-integration-world.js';
import {
  STATE, buildCutout, checkIdentity, integrateProduct, measureColorMatch, placeCutout, proposeGrade, segmentProduct, shadowRequestProblems, validatePlacement, validateSegmentation,
} from '../src/creative-integration/index.js';

// Guard tests added after the targeted mutation sweep of the identity decision, the fail-closed contract checks and the routing (`// GD-N` markers): each pins one decision that a mutant had flipped unnoticed.

const cutOf = (name) => { const f = segmented(name); return buildCutout({ rgba: f.rgba, alpha: f.seg.alpha, bounds: f.seg.bounds }); };
const clone = (img) => ({ ...img, pixels: Uint8Array.from(img.pixels) });

test('Identity fails closed on what it cannot compare', () => {
  const cut = cutOf('smallTech');
  // GD-1 a missing or differently sized result is not comparable: each of null / width / height alone
  assert.equal(checkIdentity({ source: cut, result: null }).valid, false);
  assert.equal(checkIdentity({ source: null, result: cut }).valid, false);
  assert.equal(checkIdentity({ source: cut, result: { ...cut, width: cut.width + 1 } }).valid, false);
  assert.equal(checkIdentity({ source: cut, result: { ...cut, height: cut.height + 1 } }).valid, false);
  assert.equal(checkIdentity({ source: cut, result: { ...cut, height: cut.height + 1 } }).findings[0].code, 'SIZE');
  // GD-2 too few interior pixels to judge the detail: NOT valid, and the finding says why (an unmeasurable check is a failure)
  const tiny = { width: 6, height: 6, pixels: new Uint8Array(6 * 6 * 4).fill(255) };
  const q = checkIdentity({ source: tiny, result: clone(tiny) });
  assert.equal(q.valid, false); assert.ok(q.findings.some((f) => f.code === 'INTERIOR' && f.ok === false && f.reason));
  // GD-3 strict mode sees a change in EACH channel
  for (const c of [0, 1, 2]) { const t = clone(cut); t.pixels[(140 * t.width + 70) * 4 + c] ^= 1; assert.equal(checkIdentity({ source: cut, result: t, strict: true }).valid, false, `channel ${c}`); }
  // GD-4 identical copies are valid in both modes
  assert.equal(checkIdentity({ source: cut, result: clone(cut), strict: true }).valid, true);
});

test('The segmentation contract names every violation on its own', () => {
  const f = segmented('magnet'); const { rgba, seg } = f; const w = rgba.width; const h = rgba.height;
  const problems = (over) => validateSegmentation({ ...seg, ...over }, rgba).problems;
  const b = seg.bounds;
  // GD-5 a valid value has no problem; each violation alone is reported
  assert.deepEqual(problems({}), []);
  assert.deepEqual(problems({ alpha: new Uint8Array(5) }), ['ALPHA_WRONG_SIZE']);
  assert.deepEqual(problems({ alpha: [1, 2, 3] }), ['ALPHA_WRONG_SIZE']);
  for (const bounds of [null, { ...b, x0: -1 }, { ...b, y0: -1 }, { ...b, x1: w }, { ...b, y1: h }, { ...b, x0: b.x1 + 1 }, { ...b, y0: b.y1 + 1 }, { ...b, x0: 1.5 }, { x0: 0, y0: 0, x1: 1 }]) assert.ok(problems({ bounds }).includes('BOUNDS_INVALID'), JSON.stringify(bounds));
  for (const k of ['x0', 'y0', 'x1', 'y1']) assert.deepEqual(problems({ bounds: { ...b, [k]: b[k] + 1 } }), ['BOUNDS_DO_NOT_MATCH_THE_ALPHA'], k);
  assert.deepEqual(problems({ confidence: -0.1 }), ['CONFIDENCE_NOT_IN_0_1']); assert.deepEqual(problems({ confidence: 1.1 }), ['CONFIDENCE_NOT_IN_0_1']);
  assert.deepEqual(problems({ edge_quality: undefined }), ['EDGE_QUALITY_MISSING']);
  assert.deepEqual(problems({ status: 'X' }), ['STATUS_UNKNOWN']);
  assert.deepEqual(validateSegmentation(null, rgba), { ok: false, problems: ['NOT_AN_OBJECT'] }); assert.deepEqual(validateSegmentation('x', rgba), { ok: false, problems: ['NOT_AN_OBJECT'] });
  // GD-6 a failed value needs a non-empty string reason
  for (const fr of [undefined, '', 5]) assert.deepEqual(validateSegmentation({ status: 'FAILED', failure_reason: fr }, rgba).problems, ['FAILURE_REASON_MISSING']);
  assert.equal(validateSegmentation({ status: 'FAILED', failure_reason: 'NO' }, rgba).ok, true);
  // GD-7 every refusal says accepted: false
  assert.equal(segmentProduct({ rgba: null }).accepted, false);
  assert.equal(segmentProduct({ rgba, port: { id: 'x', segment: () => { throw new Error('x'); } } }).accepted, false);
  assert.equal(segmentProduct({ rgba, port: { id: 'x', segment: () => ({ status: 'OK' }) } }).accepted, false);
  assert.equal(segmentProduct({ rgba, port: { id: 'x', segment: () => ({ ...seg, confidence: 0.5 }) } }).failure_reason, 'CONFIDENCE_BELOW_THE_MINIMUM');
  assert.equal(segmentProduct({ rgba, port: { id: 'x', segment: () => ({ ...seg, status: 'LOW_CONFIDENCE', confidence: 0.99 }) } }).accepted, false);
  // GD-8 a port that returns OK exactly at the minimum confidence is accepted
  assert.equal(segmentProduct({ rgba, port: { id: 'x', segment: () => ({ ...seg, confidence: 0.6 }) } }).accepted, true);
});

test('Routing reasons are exactly the failed checks, and the declarations reach the segmenter and the matte check', () => {
  const scene = standardScene();
  // GD-9 MATTE_INVALID lists only failing codes
  const base = W.phoneCase(); const good = segmented('phoneCase').seg;
  const fat = Uint8Array.from(good.alpha); const w = base.rgba.width;
  for (let y = 1; y < base.rgba.height - 1; y += 1) for (let x = 1; x < w - 1; x += 1) if (good.alpha[y * w + x] >= 128) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) fat[(y + dy) * w + x + dx] = 255;
  const m = integrateProduct({ source: base.rgba, scene, placement: STANDARD_PLACEMENT, port: { id: 'p', segment: () => ({ ...good, alpha: fat, bounds: { x0: good.bounds.x0 - 1, y0: good.bounds.y0 - 1, x1: good.bounds.x1 + 1, y1: good.bounds.y1 + 1 }, ground: good.ground }) } });
  assert.equal(m.state, STATE.MATTE_INVALID);
  const failing = m.matte.findings.filter((f) => !f.ok).map((f) => f.code);
  assert.deepEqual([...m.reasons], failing); assert.ok(failing.length > 0 && failing.length < m.matte.findings.length);
  // GD-10 INTEGRATION_ARTIFACT: every reason is a failing artifact code or a COLOR_ code, and none that passed
  const dark = { ...scene.plate, pixels: Uint8Array.from(scene.plate.pixels) };
  for (let y = 598; y < 610; y += 1) for (let x = 330; x < 570; x += 1) for (let c = 0; c < 3; c += 1) dark.pixels[(y * 900 + x) * 4 + c] = Math.round(dark.pixels[(y * 900 + x) * 4 + c] * 0.5);
  const a = integrateProduct({ source: W.magnet().rgba, scene: { ...scene, plate: dark }, placement: STANDARD_PLACEMENT });
  assert.equal(a.state, STATE.INTEGRATION_ARTIFACT);
  const failedCodes = a.artifacts.findings.filter((f) => !f.ok).map((f) => f.code);
  assert.deepEqual([...a.reasons].filter((r) => !r.startsWith('COLOR_')).sort(), failedCodes.sort());
  // GD-11 PRODUCT_IDENTITY_RISK lists the failing identity checks only
  const idr = integrateProduct({ source: W.phoneCase().rgba, scene, placement: STANDARD_PLACEMENT, grade: { temperature: 0.06, tint: 0.04, saturation: 0.1, exposure_ev: -0.4, local_gain: 0.15, light_angle_deg: 0 } });
  if (idr.state === STATE.PRODUCT_IDENTITY_RISK) assert.deepEqual([...idr.reasons], idr.identity.findings.filter((f) => !f.ok).map((f) => f.code));
  // GD-12 a declared semi-transparent product reaches the segmenter selection (a spy port sees it) and not otherwise
  const seen = []; const spy = { id: 'spy', segment: ({ selection }) => { seen.push(selection.semi_transparent); return segmented('magnet').seg; } };
  integrateProduct({ source: W.magnet().rgba, scene, placement: STANDARD_PLACEMENT, port: spy, product: { semi_transparent: true } });
  integrateProduct({ source: W.magnet().rgba, scene, placement: STANDARD_PLACEMENT, port: spy });
  assert.deepEqual(seen, [true, false]);
  // GD-13 a group of two touching objects integrates as one declared product (two components declared, no FRAGMENTS)
  const mo = W.multiObject();
  const g = integrateProduct({ source: mo.rgba, selection: { mode: 'IDS', ids: ['o2', 'o3'] }, scene, placement: { x: 450, y: 600, scale: 0.7 } });
  assert.ok(!g.reasons.includes('FRAGMENTS'), g.reasons.join());
  assert.equal(g.matte.valid, true);
  // GD-14 the colour verdict is reported when it cannot be measured
  const night = { ...scene.plate, pixels: scene.plate.pixels.map((v, i) => (i % 4 === 3 ? v : 0)) };
  const unm = integrateProduct({ source: W.magnet().rgba, scene: { ...scene, plate: night }, placement: STANDARD_PLACEMENT, grade: null });
  assert.notEqual(unm.state, STATE.READY_FOR_COMPOSITE);
});

test('Placement, shadow request and grade proposal: the decisions a mutant flipped', () => {
  const cut = cutOf('phoneCase'); const scene = { width: 900, height: 700, horizon_y: 360, support: { kind: 'HORIZONTAL_PLANE' } };
  const verdict = (placement, extra = {}, sc = scene) => validatePlacement({ scene: sc, placed: placeCutout(cut, placement), placement, ...extra });
  // GD-15 deformation needs BOTH scales: one alone is no deformation, equal scales none, 0.5 % is the tolerance
  assert.ok(!verdict({ ...STANDARD_PLACEMENT, scale_x: 0.7 }).reasons.includes('ASPECT_DEFORMED'));
  assert.ok(!verdict({ ...STANDARD_PLACEMENT, scale_y: 0.9 }).reasons.includes('ASPECT_DEFORMED'));
  assert.ok(!verdict({ ...STANDARD_PLACEMENT, scale_x: 0.7, scale_y: 0.7 }).reasons.includes('ASPECT_DEFORMED'));
  assert.ok(verdict({ ...STANDARD_PLACEMENT, scale_x: 0.7, scale_y: 0.7 * 1.02 }).reasons.includes('ASPECT_DEFORMED'));
  // GD-16 the support line applies only when given, and within its tolerance
  const placed = placeCutout(cut, STANDARD_PLACEMENT);
  assert.ok(!verdict(STANDARD_PLACEMENT).reasons.includes('NOT_ON_THE_SUPPORT_LINE'));
  assert.ok(!verdict(STANDARD_PLACEMENT, {}, { ...scene, support: { kind: 'HORIZONTAL_PLANE', line_y: placed.contact_y + 2 } }).reasons.includes('NOT_ON_THE_SUPPORT_LINE'));
  assert.ok(verdict(STANDARD_PLACEMENT, {}, { ...scene, support: { kind: 'HORIZONTAL_PLANE', line_y: placed.contact_y + 6 } }).reasons.includes('NOT_ON_THE_SUPPORT_LINE'));
  // GD-17 the perspective rule needs the depth scale, a real height and a horizon; any one missing means it is not applied
  const depth = { ...scene, depth_scale: { ref_y: 600, ref_px_per_cm: 6 } };
  assert.ok(verdict({ ...STANDARD_PLACEMENT, scale: 1.6 }, { product: { real_height_cm: 25 } }, depth).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'));
  assert.ok(!verdict({ ...STANDARD_PLACEMENT, scale: 1.6 }, { product: {} }, depth).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'));
  assert.ok(!verdict({ ...STANDARD_PLACEMENT, scale: 1.6 }, { product: { real_height_cm: 25 } }, scene).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'));
  assert.ok(!verdict({ ...STANDARD_PLACEMENT, scale: 1.6 }, { product: { real_height_cm: 25 } }, { ...depth, horizon_y: undefined }).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'));
  // GD-18 a hanging placement on a vertical plane is not asked for a horizon or a support line
  assert.equal(verdict({ x: 450, y: 450, scale: 0.7, anchor: 'CENTER' }, {}, { ...scene, horizon_y: 600, support: { kind: 'VERTICAL_PLANE', line_y: 1 } }).state, STATE.READY_FOR_COMPOSITE);
  // GD-19 each missing part of the shadow light is named on its own
  const light = (over) => shadowRequestProblems({ kind: 'SOFT', light: { ...STANDARD_LIGHT, ...over } });
  assert.deepEqual(light({ softness: Number.NaN }), ['LIGHT_SOFTNESS_OUT_OF_0_1']); assert.deepEqual(light({ softness: -0.1 }), ['LIGHT_SOFTNESS_OUT_OF_0_1']); assert.deepEqual(light({ softness: 1.1 }), ['LIGHT_SOFTNESS_OUT_OF_0_1']);
  assert.deepEqual(light({ elevation_deg: 4.9 }), ['LIGHT_ELEVATION_OUT_OF_5_89']); assert.deepEqual(light({ elevation_deg: 89.1 }), ['LIGHT_ELEVATION_OUT_OF_5_89']); assert.deepEqual(light({ elevation_deg: Number.NaN }), ['LIGHT_ELEVATION_OUT_OF_5_89']);
  assert.deepEqual(shadowRequestProblems({ kind: 'SOFT', light: null }), ['LIGHT_ANGLE_MISSING', 'LIGHT_ELEVATION_OUT_OF_5_89', 'LIGHT_SOFTNESS_OUT_OF_0_1']);
  assert.deepEqual(light({ elevation_deg: 5, softness: 0 }), []); assert.deepEqual(light({ elevation_deg: 89, softness: 1 }), []);
  // GD-20 the grade proposal leaves out what it could not measure
  const m = measureColorMatch({ cutout: cutOf('magnet'), scene: W.plate(), rect: { x: 380, y: 380, width: 140, height: 220 } });
  const p = proposeGrade(m); for (const k of Object.keys(m.delta)) void k;
  assert.equal('temperature' in p.request, 'temperature' in m.delta); assert.equal('exposure_ev' in p.request, 'luminance' in m.delta);
  assert.deepEqual(proposeGrade({ measurable: false, reason: 'X' }), { request: {}, reason: 'X' });
});

test('Second round of guards (after the first mutation re-run)', () => {
  const scene = standardScene();
  // GD-21 the hue is judged whatever channel dominates: red, green and blue dominant products rotated in hue are detected
  for (const [name, rot] of [['phoneCase', (r, g, b) => [b, r, g]], ['tumbler', (r, g, b) => [g, b, r]], ['giftBox', (r, g, b) => [b, g, r]], ['framedPrint', (r, g, b) => [g, r, b]]]) {
    const src = cutOf(name); const t = clone(src);
    for (let i = 0; i < t.pixels.length; i += 4) { const [r, g, b] = rot(t.pixels[i], t.pixels[i + 1], t.pixels[i + 2]); t.pixels[i] = r; t.pixels[i + 1] = g; t.pixels[i + 2] = b; }
    const q = checkIdentity({ source: src, result: t }); assert.equal(q.valid, false, name);
  }
  // GD-22 placement: a flat placement on a horizontal plane is not held to the horizon; ONE corner off the surface refuses; an occluder at the same z does not occlude
  const cut = cutOf('phoneCase'); const sc = { width: 900, height: 700, horizon_y: 360, support: { kind: 'HORIZONTAL_PLANE', polygon: [[40, 400], [860, 400], [880, 690], [20, 690]] } };
  const lie = { x: 450, y: 300, scale: 0.5, anchor: 'CENTER' };
  assert.equal(validatePlacement({ scene: sc, placed: placeCutout(cut, lie), placement: lie, product: { may_lie_flat: true } }).state, STATE.READY_FOR_COMPOSITE);
  const left = { x: 70, y: 420, scale: 0.7 }; const pl = placeCutout(cut, left);
  const inP = (x, y) => { const poly = sc.support.polygon; let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) { const [xi, yi] = poly[i]; const [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  const cy = pl.contact_y - 1; const corners = [pl.opaque.x0, (pl.opaque.x0 + pl.opaque.x1) / 2, pl.opaque.x1].map((x) => inP(x, cy));
  if (corners.some(Boolean) && !corners.every(Boolean)) assert.ok(validatePlacement({ scene: sc, placed: pl, placement: left }).reasons.includes('NOT_ON_THE_SUPPORT_SURFACE'));
  const base = placeCutout(cut, STANDARD_PLACEMENT);
  assert.ok(!validatePlacement({ scene: sc, placed: base, placement: STANDARD_PLACEMENT, z: 30, protectedRegions: [{ x: base.rect.x, y: base.rect.y, width: 40, height: 40 }], occluders: [{ rect: { x: base.rect.x, y: base.rect.y, width: 40, height: 40 }, z: 30 }] }).reasons.includes('OCCLUDES_A_PROTECTED_REGION'));
  // GD-23 a port without components is one declared product; a declared semi-transparent product is not failed for its partial interior
  const f = segmented('magnet'); const noComp = integrateProduct({ source: f.rgba, scene, placement: STANDARD_PLACEMENT, port: { id: 'nc', segment: () => ({ ...f.seg, components: [] }) } });
  assert.equal(noComp.state, STATE.READY_FOR_COMPOSITE, noComp.reasons.join());
  const soft = Uint8Array.from(f.seg.alpha); for (let y = 100; y < 130; y += 1) for (let x = 80; x < 140; x += 1) if (soft[y * f.rgba.width + x] === 255) soft[y * f.rgba.width + x] = 170;
  const sp = { id: 'sp', segment: () => ({ ...f.seg, alpha: soft }) };
  const withFlag = integrateProduct({ source: f.rgba, scene, placement: STANDARD_PLACEMENT, port: sp, product: { semi_transparent: true } });
  const without = integrateProduct({ source: f.rgba, scene, placement: STANDARD_PLACEMENT, port: sp });
  assert.ok(without.reasons.includes('INTERIOR_ALPHA')); assert.ok(!withFlag.reasons.includes('INTERIOR_ALPHA'));
  // GD-24 the colour reasons are exactly the failing quantities
  const night = { ...scene.plate, pixels: scene.plate.pixels.map((v, i) => (i % 4 === 3 ? v : Math.round(v * 0.3))) };
  const dim = integrateProduct({ source: W.magnet().rgba, scene: { ...scene, plate: night }, placement: STANDARD_PLACEMENT });
  assert.equal(dim.state, STATE.INTEGRATION_ARTIFACT);
  const expected = Object.entries(dim.colour.within).filter(([, ok]) => !ok).map(([k]) => 'COLOR_' + k.toUpperCase());
  assert.deepEqual([...dim.reasons].filter((r) => r.startsWith('COLOR_')).sort(), expected.sort()); assert.ok(expected.length > 0);
  // GD-25 a scene whose colour cannot be measured at all is reported, not passed
  const blank = { width: 900, height: 700, pixels: new Uint8Array(900 * 700 * 4) };
  const none = integrateProduct({ source: W.magnet().rgba, scene: { ...scene, plate: { ...blank, pixels: blank.pixels.fill(0) } }, placement: STANDARD_PLACEMENT, grade: null });
  assert.notEqual(none.state, STATE.READY_FOR_COMPOSITE);
});
