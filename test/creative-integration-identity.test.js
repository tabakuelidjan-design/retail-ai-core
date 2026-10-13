import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { segmented } from './creative-integration-shared.js';
import * as W from './creative-integration-world.js';
import {
  STATE, boundViolations, buildCutout, checkIdentity, measureColorMatch, proposeGrade, relightProduct,
} from '../src/creative-integration/index.js';

// Product identity, bounded relighting and colour integration (`// ID-N`, `// RL-N`, `// CG-N` markers). The product pixels are authoritative: only bounded, smooth, recoverable changes of light and colour are allowed,
// and every change that moves, redraws, duplicates or recolours a feature is named.

const sha = (b) => createHash('sha256').update(b).digest('hex');
const cutOf = (name) => { const f = segmented(name); return buildCutout({ rgba: f.rgba, alpha: f.seg.alpha, bounds: f.seg.bounds }); };
const clone = (img) => ({ ...img, pixels: Uint8Array.from(img.pixels) });
const codes = (q) => q.findings.filter((f) => !f.ok).map((f) => f.code);
const paintRect = (img, x0, y0, x1, y1, rgb) => { for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const i = (y * img.width + x) * 4; if (img.pixels[i + 3] >= 250) { img.pixels[i] = rgb[0]; img.pixels[i + 1] = rgb[1]; img.pixels[i + 2] = rgb[2]; } } };

test('An untouched product is identical; a bounded relight keeps its identity and its silhouette', () => {
  for (const name of ['phoneCase', 'smallTech', 'magnet']) {
    const cut = cutOf(name);
    // ID-1 no change requested: identity transform, interior bytes identical (strict)
    const same = relightProduct({ cutout: cut, request: {} });
    assert.equal(same.state, STATE.READY_FOR_COMPOSITE); assert.equal(same.identity_transform, true);
    assert.equal(checkIdentity({ source: cut, result: same.cutout, strict: true }).valid, true, name);
    // ID-2 a bounded relight (exposure, light gradient, temperature, tint, saturation) keeps the identity
    const lit = relightProduct({ cutout: cut, request: { exposure_ev: -0.15, local_gain: 0.1, temperature: 0.03, tint: 0.02, saturation: 0.05, light_angle_deg: 120 } });
    assert.equal(lit.state, STATE.READY_FOR_COMPOSITE, name + JSON.stringify(lit.reasons));
    const id = checkIdentity({ source: cut, result: lit.cutout }); assert.equal(id.valid, true, `${name}: ${codes(id)}`);
    // ID-3 the alpha is byte for byte the cut-out's
    for (let i = 3; i < cut.pixels.length; i += 4) assert.equal(lit.cutout.pixels[i], cut.pixels[i]);
    // ID-4 the source cut-out is not overwritten
    assert.notEqual(lit.cutout.pixels, cut.pixels);
  }
});

test('A feature that moved, vanished, was redrawn or recoloured is detected', () => {
  const cut = cutOf('smallTech');
  // ID-5 the button (a grey disc) erased: painted over with the body colour
  const noButton = clone(cut); paintRect(noButton, 57, 151, 89, 183, [232, 232, 236]); // the grey button (centre (73, 167) in cut-out coordinates)
  assert.ok(!checkIdentity({ source: cut, result: noButton }).valid);
  // ID-6 the port moved: the old place repainted, a new one drawn elsewhere
  const moved = clone(cut); paintRect(moved, 55, 193, 91, 206, [232, 232, 236]); paintRect(moved, 20, 215, 56, 224, [30, 30, 34]); // the port moved from the middle to the left
  assert.ok(!checkIdentity({ source: cut, result: moved }).valid);
  // ID-7 the screen redrawn in another tone (surface redesign)
  const screen = clone(cut); paintRect(screen, 25, 25, 120, 140, [120, 60, 60]); // the screen redrawn in another tone
  assert.ok(!checkIdentity({ source: cut, result: screen }).valid);
  // ID-8 the whole product rotated in hue (colour drift beyond the grading)
  const salmon = cutOf('phoneCase'); const hue = clone(salmon); for (let i = 0; i < hue.pixels.length; i += 4) { const [r, g, b] = [hue.pixels[i], hue.pixels[i + 1], hue.pixels[i + 2]]; hue.pixels[i] = b; hue.pixels[i + 1] = r; hue.pixels[i + 2] = g; }
  const hq = checkIdentity({ source: salmon, result: hue }); assert.ok(codes(hq).includes('CHROMATICITY_SHIFT') || codes(hq).includes('HUE_SHIFT'), codes(hq).join());
  // ID-9 a duplicated object (a second blob in the result) and a changed alpha
  const dup = clone(cut); for (let y = 225; y < 237; y += 1) for (let x = 2; x < 14; x += 1) dup.pixels[(y * dup.width + x) * 4 + 3] = 255; // a second blob in an empty corner
  const dq = checkIdentity({ source: cut, result: dup }); assert.ok(codes(dq).includes('ALPHA_UNCHANGED') && codes(dq).includes('NO_DUPLICATION'), codes(dq).join());
  // ID-10 strict mode: a single changed interior byte is caught when nothing was requested
  const one = clone(cut); const c = (140 * one.width + 120) * 4; one.pixels[c] ^= 1;
  assert.equal(checkIdentity({ source: cut, result: one, strict: true }).valid, false);
  assert.equal(checkIdentity({ source: cut, result: one, strict: false }).valid, true);
  // ID-11 sizes that differ are not comparable: refused
  assert.equal(checkIdentity({ source: cut, result: { ...cut, width: cut.width + 1 } }).valid, false);
});

test('A change confined to one place cannot hide in a good global number: the tile check', () => {
  // ID-12 the phone case's logo bar removed: small area, high global correlation, but a tile with real detail breaks
  const cut = cutOf('phoneCase'); const edit = clone(cut);
  paintRect(edit, 100, 138, 200, 160, [236, 140, 120]);
  const q = checkIdentity({ source: cut, result: edit }); assert.equal(q.valid, false, codes(q).join());
});

test('Relighting is bounded and refuses what is out of bounds instead of clamping it', () => {
  const cut = cutOf('phoneCase');
  // RL-1 every bound is checked, an unknown field and a non-number are refused
  for (const [req, field] of [[{ exposure_ev: 1 }, 'exposure_ev'], [{ local_gain: 0.5 }, 'local_gain'], [{ temperature: -0.3 }, 'temperature'], [{ tint: 0.2 }, 'tint'], [{ saturation: 0.6 }, 'saturation'], [{ exposure_ev: Number.NaN }, 'exposure_ev'], [{ gloss: 1 }, 'gloss']]) {
    const r = relightProduct({ cutout: cut, request: req }); assert.equal(r.state, STATE.RELIGHT_OUT_OF_BOUNDS); assert.equal(r.reasons[0].field, field);
  }
  assert.deepEqual(boundViolations({ exposure_ev: 0.4, local_gain: 0.15, temperature: 0.06, tint: 0.04, saturation: 0.1 }), []);
  // RL-2 the bound itself is allowed; a value just beyond is not
  assert.deepEqual(boundViolations({ exposure_ev: 0.4001 }).map((v) => v.field), ['exposure_ev']);
  // RL-3 a request inside the numeric bounds that would clip highlights is refused by the MEASUREMENT (bright cream logo bar + exposure up)
  const bright = relightProduct({ cutout: cut, request: { exposure_ev: 0.4, saturation: 0.1, temperature: 0.06 } });
  assert.equal(bright.state, STATE.RELIGHT_OUT_OF_BOUNDS); assert.ok(bright.reasons.some((r) => r.reason === 'MEASURED_BEYOND_THE_BOUND'));
  assert.ok(bright.measured.new_clip_share > 0.005 || bright.measured.max_luma_change > 0.22);
  // RL-4 the lit side of the product is brighter than the far side (a directional approximation), and only smooth gain was applied
  const lit = relightProduct({ cutout: cut, request: { local_gain: 0.12, light_angle_deg: 0 } }); assert.equal(lit.state, STATE.READY_FOR_COMPOSITE);
  const lum = (img, x, y) => { const i = (y * img.width + x) * 4; return 0.299 * img.pixels[i] + 0.587 * img.pixels[i + 1] + 0.114 * img.pixels[i + 2]; };
  const y = Math.floor(cut.height * 0.62); const xl = Math.floor(cut.width * 0.3); const xr = Math.floor(cut.width * 0.7);
  assert.ok(lum(lit.cutout, xr, y) - lum(cut, xr, y) > lum(lit.cutout, xl, y) - lum(cut, xl, y));
  // RL-5 the relight is deterministic and its recipe is recoverable: the same source and recipe give the same pixels, the source is untouched
  const again = relightProduct({ cutout: cut, request: lit.recipe }); assert.equal(sha(again.cutout.pixels), sha(lit.cutout.pixels)); assert.equal(again.recipe_sha256, lit.recipe_sha256);
  assert.equal(sha(cut.pixels), sha(cutOf('phoneCase').pixels));
  // RL-6 a "relight" cannot add detail: the detail field of the result correlates with the source
  assert.ok(checkIdentity({ source: cut, result: lit.cutout }).valid);
});

test('Colour integration compares the illumination, not the product\'s own colour, and corrects within bounds only', () => {
  const cut = cutOf('smallTech'); const plate = W.plate(); const rect = { x: 380, y: 380, width: 140, height: 220 };
  // CG-1 measurable, with the quantities named
  const m = measureColorMatch({ cutout: cut, scene: plate, rect }); assert.equal(m.measurable, true); assert.ok('luminance' in m.delta);
  // CG-2 the proposal is bounded and never touches saturation or texture
  const g = proposeGrade(m); for (const [k, v] of Object.entries(g.request)) assert.ok(['exposure_ev', 'temperature'].includes(k) && Math.abs(v) <= 0.4, k);
  // CG-3 a quantity that cannot be measured is skipped and says so (the blue-on-blue case: no neutral pixels in a saturated product)
  const magnet = measureColorMatch({ cutout: cutOf('magnet'), scene: plate, rect }); assert.ok(Array.isArray(magnet.skipped));
  // CG-4 a scene that is far too dark for the product is NOT matched by an unbounded correction
  const dark = { ...plate, pixels: plate.pixels.map((v, i) => (i % 4 === 3 ? v : Math.round(v * 0.25))) };
  const dm = measureColorMatch({ cutout: cut, scene: dark, rect }); assert.equal(dm.matched, false);
  const corr = proposeGrade(dm); assert.ok(Math.abs(corr.request.exposure_ev) <= 0.4);
  const after = relightProduct({ cutout: cut, request: corr.request });
  if (after.state === STATE.READY_FOR_COMPOSITE) assert.equal(measureColorMatch({ cutout: after.cutout, scene: dark, rect }).matched, false);
  // CG-5 no pixels at all: not measurable (fail closed)
  assert.equal(measureColorMatch({ cutout: { width: 4, height: 4, pixels: new Uint8Array(64) }, scene: plate, rect }).measurable, false);
});
