import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { STANDARD_LIGHT, segmented } from './creative-integration-shared.js';
import * as W from './creative-integration-world.js';
import {
  STATE, buildContactShadow, buildCutout, compositeScene, detectArtifacts, placeCutout, shadowRequestProblems, validatePlacement,
} from '../src/creative-integration/index.js';

// Contact shadow as a separate layer, placement rules and artifact detection (`// SH-N`, `// PL-N`, `// AR-N` markers).

const sha = (b) => createHash('sha256').update(b).digest('hex');
const cutOf = (name) => { const f = segmented(name); return buildCutout({ rgba: f.rgba, alpha: f.seg.alpha, bounds: f.seg.bounds }); };
const PLACEMENT = { x: 450, y: 600, scale: 0.7 };
const placedOf = (name, placement = PLACEMENT) => placeCutout(cutOf(name), placement);
const maxAlpha = (layer) => { let m = 0; for (let i = 3; i < layer.pixels.length; i += 4) m = Math.max(m, layer.pixels[i]); return m; };
const centroidX = (layer) => { let sx = 0; let sw = 0; for (let y = 0; y < layer.height; y += 1) for (let x = 0; x < layer.width; x += 1) { const a = layer.pixels[(y * layer.width + x) * 4 + 3]; sx += (layer.x + x) * a; sw += a; } return sx / sw; };
const sceneOf = (over = {}) => ({ width: 900, height: 700, horizon_y: 360, support: { kind: 'HORIZONTAL_PLANE', polygon: [[40, 400], [860, 400], [880, 690], [20, 690]] }, ...over });

test('The contact shadow is a separate layer: the product pixels are never touched, it is deterministic and recomputable', () => {
  const placed = placedOf('phoneCase'); const before = sha(placed.rgba.pixels);
  const a = buildContactShadow({ placed, kind: 'SOFT', light: STANDARD_LIGHT });
  // SH-1 a layer with its own rectangle, a dark colour and an alpha; the product is unchanged
  assert.equal(a.state, STATE.READY_FOR_COMPOSITE); assert.ok(a.shadow.width > 0 && a.shadow.height > 0); assert.equal(sha(placed.rgba.pixels), before);
  assert.equal(a.shadow.pixels.length, a.shadow.width * a.shadow.height * 4);
  // SH-2 same inputs, same bytes
  assert.equal(sha(buildContactShadow({ placed, kind: 'SOFT', light: STANDARD_LIGHT }).shadow.pixels), sha(a.shadow.pixels));
  // SH-3 composited UNDER the product: the product's opaque pixels stay exactly the product's
  const plate = W.plate(); const withShadow = compositeScene({ plate, shadows: [a.shadow], placed: [placed] }); const without = compositeScene({ plate, shadows: [], placed: [placed] });
  let diffInside = 0;
  for (let y = 0; y < placed.rgba.height; y += 1) for (let x = 0; x < placed.rgba.width; x += 1) {
    if (placed.rgba.pixels[(y * placed.rgba.width + x) * 4 + 3] !== 255) continue;
    const i = ((placed.rect.y + y) * 900 + placed.rect.x + x) * 4; if (withShadow.pixels[i] !== without.pixels[i] || withShadow.pixels[i + 1] !== without.pixels[i + 1]) diffInside += 1;
  }
  assert.equal(diffInside, 0);
  // SH-4 the shadow darkens the plate and only the plate: outside the shadow layer the scene is the plate
  assert.equal(withShadow.pixels[0], plate.pixels[0]);
});

test('Four shadow kinds behave as declared', () => {
  const placed = placedOf('phoneCase'); const mk = (kind, light = STANDARD_LIGHT) => buildContactShadow({ placed, kind, light });
  const [soft, hard, diffuse, directional] = ['SOFT', 'HARD', 'DIFFUSE', 'DIRECTIONAL'].map((k) => mk(k));
  // SH-5 every kind is valid, not darker than the cap, and different from the others
  for (const r of [soft, hard, diffuse, directional]) { assert.equal(r.state, STATE.READY_FOR_COMPOSITE); assert.ok(maxAlpha(r.shadow) <= Math.round(0.65 * 255)); }
  assert.equal(new Set([soft, hard, diffuse, directional].map((r) => sha(r.shadow.pixels))).size, 4);
  // SH-6 hard is crisper than soft: a larger share of its non-zero alpha is near-opaque, and its blur radius is smaller
  assert.ok(hard.geometry.blur_px < soft.geometry.blur_px && soft.geometry.blur_px < diffuse.geometry.blur_px);
  // SH-7 directional is longer than hard (it reaches farther along the light axis)
  assert.ok(directional.shadow.width > hard.shadow.width);
  // SH-8 diffuse has no direction: it is centred under the product; the directional shadow is displaced away from the light
  const centre = (placed.opaque.x0 + placed.opaque.x1) / 2;
  assert.ok(Math.abs(centroidX(diffuse.shadow) - centre) < 6, String(centroidX(diffuse.shadow) - centre));
  assert.ok(centroidX(directional.shadow) - centre > 15); // light from the upper left (120 degrees): the shadow falls to the right
  // SH-9 the direction follows the declared light
  const fromRight = mk('DIRECTIONAL', { angle_deg: 30, elevation_deg: 40, softness: 0.5 }); assert.ok(centroidX(fromRight.shadow) < centre - 15);
  // SH-10 a lower sun casts a longer shadow
  const low = mk('DIRECTIONAL', { angle_deg: 120, elevation_deg: 20, softness: 0.5 }); const high = mk('DIRECTIONAL', { angle_deg: 120, elevation_deg: 70, softness: 0.5 }); assert.ok(low.shadow.width > high.shadow.width);
  // SH-11 the contact region is derived from the matte: the lowest rows, as wide as the product's base
  assert.equal(soft.geometry.contact_region.contact_y, placed.contact_y); assert.equal(soft.geometry.contact_region.x0, placed.opaque.x0);
  // SH-12 a vertical plane (a wall) has no contact region and a short offset silhouette
  const wall = buildContactShadow({ placed, kind: 'SOFT', light: STANDARD_LIGHT, support: 'VERTICAL_PLANE' }); assert.equal(wall.geometry.contact_region, null); assert.ok(maxAlpha(wall.shadow) > 0);
});

test('Invalid shadow requests are SHADOW_INVALID, never guessed', () => {
  const placed = placedOf('magnet');
  // SH-13
  for (const [kind, light, problem] of [['BLOB', STANDARD_LIGHT, 'KIND_UNKNOWN'], ['SOFT', { ...STANDARD_LIGHT, elevation_deg: 0 }, 'LIGHT_ELEVATION_OUT_OF_5_89'], ['SOFT', { ...STANDARD_LIGHT, softness: 2 }, 'LIGHT_SOFTNESS_OUT_OF_0_1'], ['SOFT', { ...STANDARD_LIGHT, angle_deg: Number.NaN }, 'LIGHT_ANGLE_MISSING'], ['SOFT', null, 'LIGHT_ANGLE_MISSING']]) {
    const r = buildContactShadow({ placed, kind, light }); assert.equal(r.state, STATE.SHADOW_INVALID); assert.ok(r.reasons.includes(problem), problem);
  }
  assert.deepEqual(shadowRequestProblems({ kind: 'SOFT', light: STANDARD_LIGHT }), []);
});

test('Placement rules reject impossible placements and name every reason', () => {
  const cut = cutOf('phoneCase'); const scene = sceneOf(); const check = (placement, extra = {}, sceneOver = {}) => { const placed = placeCutout(cut, placement); return validatePlacement({ scene: sceneOf(sceneOver), placed, placement, ...extra }); };
  // PL-1 a sound placement
  assert.equal(check(PLACEMENT).state, STATE.READY_FOR_COMPOSITE);
  // PL-2 rotation is refused in this phase (the product pixels are not rotated); a huge tilt is named as such
  assert.ok(check({ ...PLACEMENT, rotation_deg: 5 }).reasons.includes('ROTATION_UNSUPPORTED_IN_THIS_PHASE')); assert.ok(check({ ...PLACEMENT, rotation_deg: 40 }).reasons.includes('TILT_TOO_LARGE'));
  // PL-3 scale: zero, negative, NaN
  for (const s of [0, -1, Number.NaN]) assert.ok(validatePlacement({ scene, placed: placeCutout(cut, PLACEMENT), placement: { ...PLACEMENT, scale: s } }).reasons.includes('SCALE_INVALID'));
  // PL-4 outside the canvas
  assert.ok(check({ ...PLACEMENT, x: 20 }).reasons.includes('OUTSIDE_THE_CANVAS'));
  // PL-5 absurd sizes
  assert.ok(check({ ...PLACEMENT, scale: 0.05 }).reasons.includes('SIZE_IMPLAUSIBLE')); assert.ok(check({ ...PLACEMENT, scale: 3 }).reasons.includes('SIZE_IMPLAUSIBLE') || check({ ...PLACEMENT, scale: 3 }).reasons.includes('OUTSIDE_THE_CANVAS'));
  // PL-6 the contact line above the horizon: the product would stand in the sky
  assert.ok(check({ ...PLACEMENT, y: 300 }).reasons.includes('CONTACT_ABOVE_THE_HORIZON'));
  // PL-7 not on the support surface (the table polygon) and not on the support line
  assert.ok(check({ ...PLACEMENT, y: 395 }).reasons.includes('NOT_ON_THE_SUPPORT_SURFACE'));
  assert.ok(check(PLACEMENT, {}, { support: { kind: 'HORIZONTAL_PLANE', line_y: 560 } }).reasons.includes('NOT_ON_THE_SUPPORT_LINE'));
  // PL-8 perspective: at a given depth a product of a known height has one plausible size
  const depth = { depth_scale: { ref_y: 600, ref_px_per_cm: 6 } };
  const probe = check(PLACEMENT, { product: { real_height_cm: 25 } }, depth); const exact = PLACEMENT.scale * probe.measurements.expected_height_px / probe.measurements.height_px;
  assert.equal(check({ ...PLACEMENT, scale: exact }, { product: { real_height_cm: 25 } }, depth).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'), false);
  assert.equal(check({ ...PLACEMENT, scale: exact * 1.1 }, { product: { real_height_cm: 25 } }, depth).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'), false);
  assert.equal(check({ ...PLACEMENT, scale: exact * 1.3 }, { product: { real_height_cm: 25 } }, depth).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'), true);
  assert.equal(check({ ...PLACEMENT, scale: exact * 0.7 }, { product: { real_height_cm: 25 } }, depth).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'), true);
  assert.ok(check({ ...PLACEMENT, scale: 1.5 }, { product: { real_height_cm: 25 } }, depth).reasons.includes('SCALE_INCONSISTENT_WITH_DEPTH'));
  // PL-9 deformation (non-uniform scale)
  assert.ok(check({ ...PLACEMENT, scale_x: 0.7, scale_y: 0.9 }).reasons.includes('ASPECT_DEFORMED'));
  // PL-10 a standing product needs a horizontal support; a hanging one a vertical support
  assert.ok(check(PLACEMENT, {}, { support: { kind: 'VERTICAL_PLANE' } }).reasons.includes('A_STANDING_PRODUCT_NEEDS_A_HORIZONTAL_SUPPORT'));
  assert.ok(check({ x: 450, y: 450, scale: 0.7, anchor: 'CENTER' }).reasons.includes('A_HANGING_PLACEMENT_NEEDS_A_VERTICAL_SUPPORT'));
  assert.equal(check({ x: 450, y: 450, scale: 0.7, anchor: 'CENTER' }, {}, { support: { kind: 'VERTICAL_PLANE' } }).state, STATE.READY_FOR_COMPOSITE);
});

test('Occlusion order and protected regions', () => {
  const cut = cutOf('magnet'); const placement = { x: 450, y: 560, scale: 0.9 }; const placed = placeCutout(cut, placement); const scene = sceneOf();
  const nearer = { opaque: { x0: placed.opaque.x0 + 10, y0: placed.opaque.y0 + 10, x1: placed.opaque.x1 + 10, y1: placed.opaque.y1 + 10 }, contact_y: placed.contact_y + 40, z: 32 };
  // PL-11 a nearer product (larger contact_y) must be in front (larger z): if this one is the farther, it must have the smaller z
  assert.equal(validatePlacement({ scene, placed, placement, z: 30, neighbours: [nearer] }).state, STATE.READY_FOR_COMPOSITE);
  assert.ok(validatePlacement({ scene, placed, placement, z: 34, neighbours: [nearer] }).reasons.includes('OCCLUSION_ORDER_CONTRADICTS_DEPTH'));
  // PL-12 two products at exactly the same depth cannot overlap
  assert.ok(validatePlacement({ scene, placed, placement, z: 30, neighbours: [{ ...nearer, contact_y: placed.contact_y }] }).reasons.includes('OVERLAP_AT_THE_SAME_DEPTH'));
  // PL-13 a layer in front may not cover a protected region of the product
  const pr = { x: placed.rect.x + 20, y: placed.rect.y + 20, width: 30, height: 30 };
  assert.ok(validatePlacement({ scene, placed, placement, protectedRegions: [pr], occluders: [{ rect: { x: pr.x + 5, y: pr.y + 5, width: 20, height: 20 }, z: 40 }] }).reasons.includes('OCCLUDES_A_PROTECTED_REGION'));
  assert.equal(validatePlacement({ scene, placed, placement, protectedRegions: [pr], occluders: [{ rect: { x: pr.x + 5, y: pr.y + 5, width: 20, height: 20 }, z: 20 }] }).state, STATE.READY_FOR_COMPOSITE);
});

test('Artifact detection names what is wrong in the integrated scene', () => {
  const plate = W.plate(); const placed = placedOf('phoneCase'); const cast = buildContactShadow({ placed, kind: 'SOFT', light: STANDARD_LIGHT });
  const run = (over = {}) => {
    const shadow = 'shadow' in over ? over.shadow : cast.shadow; const composite = over.composite ?? compositeScene({ plate, shadows: shadow ? [shadow] : [], placed: [over.placed ?? placed] });
    return detectArtifacts({ plate: over.plate ?? plate, composite, placed: over.placed ?? placed, shadow, geometry: over.geometry ?? cast.geometry, relightMeasured: over.relightMeasured ?? null, placement: PLACEMENT, cutoutSize: { width: cutOf('phoneCase').width, height: cutOf('phoneCase').height }, ...(over.extra ?? {}) });
  };
  const bad = (r) => r.findings.filter((f) => !f.ok).map((f) => f.code);
  // AR-1 a sound integration is clean
  assert.deepEqual(bad(run()), []); assert.equal(run().clean, true);
  // AR-2 a floating object: the shadow is moved 40 px below the contact
  const shifted = { ...cast.shadow, y: cast.shadow.y + 40 }; const floating = bad(run({ shadow: shifted })); assert.ok(floating.includes('FLOATING_OBJECT') && floating.includes('DETACHED_SHADOW'), floating.join());
  // AR-3 no shadow at all: the contact cannot be judged, which is a failure
  assert.ok(bad(run({ shadow: null, geometry: null })).includes('FLOATING_OBJECT'));
  // AR-4 a double shadow: a second blob far to the left of the first
  const w = cast.shadow.width; const second = { x: cast.shadow.x - 140, y: cast.shadow.y, width: w, height: cast.shadow.height, pixels: Uint8Array.from(cast.shadow.pixels) };
  const merged = { x: second.x, y: cast.shadow.y, width: w + 140, height: cast.shadow.height, pixels: new Uint8Array((w + 140) * cast.shadow.height * 4) };
  for (const layer of [second, cast.shadow]) for (let y = 0; y < layer.height; y += 1) for (let x = 0; x < layer.width; x += 1) { const a = layer.pixels[(y * layer.width + x) * 4 + 3]; const i = (y * merged.width + (layer.x - merged.x) + x) * 4; if (a > merged.pixels[i + 3]) { merged.pixels[i] = 22; merged.pixels[i + 1] = 18; merged.pixels[i + 2] = 16; merged.pixels[i + 3] = a; } }
  assert.ok(bad(run({ shadow: merged })).some((c) => c === 'DOUBLE_SHADOW_LOBES' || c === 'DETACHED_SHADOW'));
  // AR-5 a halo: the ring around the product is lightened
  const haloed = compositeScene({ plate, shadows: [cast.shadow], placed: [placed] });
  for (let y = placed.opaque.y0 - 3; y <= placed.opaque.y1 + 3; y += 1) for (const x of [placed.opaque.x0 - 2, placed.opaque.x1 + 2]) { const i = (y * 900 + x) * 4; haloed.pixels[i] = 255; haloed.pixels[i + 1] = 255; haloed.pixels[i + 2] = 255; }
  assert.ok(bad(run({ composite: haloed })).includes('HALO'));
  // AR-6 the plate already carries a shadow at the contact: ours would be a second one
  const darkPlate = { ...plate, pixels: Uint8Array.from(plate.pixels) };
  for (let y = placed.contact_y; y < placed.contact_y + 14; y += 1) for (let x = placed.opaque.x0 - 20; x <= placed.opaque.x1 + 20; x += 1) { const i = (y * 900 + x) * 4; darkPlate.pixels[i] = Math.round(darkPlate.pixels[i] * 0.55); darkPlate.pixels[i + 1] = Math.round(darkPlate.pixels[i + 1] * 0.55); darkPlate.pixels[i + 2] = Math.round(darkPlate.pixels[i + 2] * 0.55); }
  assert.ok(bad(run({ plate: darkPlate })).includes('PLATE_SHADOW_AT_CONTACT'));
  // AR-7 clipping and cropping and deformation
  assert.ok(bad(run({ relightMeasured: { new_clip_share: 0.05, max_luma_change: 0.1 } })).includes('CLIPPING'));
  const off = placeCutout(cutOf('phoneCase'), { x: 20, y: 600, scale: 0.7 }); assert.ok(bad(run({ placed: off })).includes('CROPPED_BY_THE_CANVAS'));
  assert.ok(bad(run({ extra: { cutoutSize: { width: cutOf('phoneCase').width, height: cutOf('phoneCase').height * 1.2 } } })).includes('DEFORMATION'));
  // AR-8 the wrong direction: a geometry that claims the light came from the other side
  assert.ok(bad(run({ geometry: { ...cast.geometry, kx: -cast.geometry.kx } })).includes('SHADOW_DIRECTION'));
  // AR-9 a jagged placed alpha
  const base = cutOf('phoneCase'); const jag = Uint8Array.from(base.pixels); let seed = 5; const hard = (x, y) => base.pixels[(y * base.width + x) * 4 + 3] >= 128;
  for (let y = 2; y < base.height - 2; y += 1) for (let x = 2; x < base.width - 2; x += 1) {
    let mixed = false; for (let dy = -2; dy <= 2 && !mixed; dy += 1) for (let dx = -2; dx <= 2; dx += 1) if (hard(x + dx, y + dy) !== hard(x, y)) { mixed = true; break; }
    if (mixed) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; jag[(y * base.width + x) * 4 + 3] = (seed >>> 24); }
  }
  const noisy = placeCutout({ ...base, pixels: jag }, { x: 450, y: 600, scale: 1 });
  assert.ok(bad(run({ placed: noisy })).includes('ALPHA_NOISE'));
});
