import test from 'node:test';
import assert from 'node:assert/strict';

import * as W from './creative-integration-world.js';
import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import { createRunContext, computeProductSegmentation } from '../src/creative-e2e/index.js';
import { dilate } from '../src/creative-integration/pixels.js';
import { hasMeaningfulAlpha, segmentNativeAlpha } from '../src/creative-integration/index.js';
import { decodePng } from '../src/creative-intelligence/png-pixels.js';

// The native-alpha path (`// NA-N` markers): a pre-cut image keeps its validated alpha (a supplier alpha of 253 is opaque), and every malformed or ambiguous alpha fails closed with its reason.

const precut = (name, { opaque = 253 } = {}) => {
  const f = W[name](); const { width, height } = f.rgba; const pixels = Uint8Array.from(f.rgba.pixels);
  for (let i = 0; i < width * height; i += 1) { const a = f.truth.alpha[i]; pixels[i * 4 + 3] = a === 255 ? opaque : a; if (a === 0) { pixels[i * 4] = 0; pixels[i * 4 + 1] = 0; pixels[i * 4 + 2] = 0; } }
  return { width, height, pixels };
};
const codes = (r) => r.native.findings.filter((f) => !f.ok).map((f) => f.code);
const at = (img, x, y) => (y * img.width + x) * 4 + 3;

test('A clean pre-cut image is accepted as it is: validated, near-opaque alpha snapped, colours untouched', () => {
  for (const name of ['phoneCase', 'tumbler', 'giftBox', 'framedPrint']) {
    const img = precut(name); const r = segmentNativeAlpha(img);
    // NA-1 accepted, one object, confidence 1, the source named NATIVE_ALPHA
    assert.equal(r.status, 'OK', `${name}: ${r.failure_reason} ${r.native?.findings.filter((f) => !f.ok).map((f) => f.code)}`); assert.equal(r.accepted, true); assert.deepEqual(r.source, { kind: 'NATIVE_ALPHA', id: 'NATIVE_ALPHA:validated@1' });
    // NA-2 an alpha of 253 became 255 and the count is reported; the soft edge was kept
    assert.ok(r.native.snapped_to_opaque > 1000); assert.equal(r.alpha[at(img, 150, 220) / 4 | 0], 255);
    // NA-3 the bounds are the drawn product's
    assert.ok(W.ALL[name]().truth.alpha[(r.bounds.y0 + 1) * img.width + r.bounds.x0 + 1] >= 0);
  }
  // NA-4 a handle opening is a hole, not a defect
  assert.equal(segmentNativeAlpha(precut('tumbler')).holes.length, 1);
  // NA-5 meaningful alpha is detected, an opaque photograph has none
  assert.equal(hasMeaningfulAlpha(precut('phoneCase')), true); assert.equal(hasMeaningfulAlpha(W.phoneCase().rgba), false);
});

test('A malformed or ambiguous alpha fails closed, with the reason', () => {
  const base = () => precut('phoneCase');
  // NA-6 an opaque border (the image is not cut out)
  const border = base(); for (let x = 0; x < border.width; x += 1) for (let y = 0; y < 3; y += 1) border.pixels[at(border, x, y)] = 255;
  assert.ok(codes(segmentNativeAlpha(border)).includes('ALPHA_BORDER_TRANSPARENT'));
  // NA-7 no meaningful alpha: an all-opaque image
  const solid = W.phoneCase().rgba; const r7 = segmentNativeAlpha(solid); assert.equal(r7.failure_reason, 'ALPHA_NOT_MEANINGFUL'); assert.equal(r7.accepted, false);
  // NA-8 a baked glow: a wide semi-transparent ring around the product is NOT an edge
  const glow = base(); const core = new Uint8Array(glow.width * glow.height); for (let i = 0; i < core.length; i += 1) core[i] = glow.pixels[i * 4 + 3] >= 250 ? 1 : 0;
  const wide = dilate(core, glow.width, glow.height, 14); for (let i = 0; i < core.length; i += 1) if (wide[i] && !core[i] && glow.pixels[i * 4 + 3] === 0) { glow.pixels[i * 4 + 3] = 120; glow.pixels[i * 4] = 200; glow.pixels[i * 4 + 1] = 120; glow.pixels[i * 4 + 2] = 160; }
  assert.ok(codes(segmentNativeAlpha(glow)).some((c) => ['ALPHA_BAKED_HALO', 'ALPHA_OPAQUE_CORE'].includes(c)), codes(segmentNativeAlpha(glow)).join());
  // NA-9 two objects: AUTO is ambiguous, an explicit GROUP is accepted
  const m = precut('magnet'); const two = { width: m.width * 2, height: m.height, pixels: new Uint8Array(m.width * 2 * m.height * 4) };
  for (let y = 0; y < m.height; y += 1) for (let x = 0; x < m.width; x += 1) for (const off of [0, m.width]) for (let c = 0; c < 4; c += 1) two.pixels[(y * two.width + x + off) * 4 + c] = m.pixels[(y * m.width + x) * 4 + c];
  assert.ok(codes(segmentNativeAlpha(two)).includes('ALPHA_ONE_OBJECT')); assert.equal(segmentNativeAlpha(two, { mode: 'GROUP' }).status, 'OK');
  // NA-10 an enclosed transparent pinhole inside the product
  const pin = base(); for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pin.pixels[at(pin, 150 + dx, 220 + dy)] = 0;
  assert.ok(codes(segmentNativeAlpha(pin)).includes('ALPHA_PINHOLES'));
  // NA-11 a product cut by the border of the image
  const cut = precut('magnet'); const shifted = { ...cut, pixels: new Uint8Array(cut.pixels.length) };
  for (let y = 0; y < cut.height; y += 1) for (let x = 0; x < cut.width; x += 1) { const nx = x - 45; if (nx >= 0) for (let c = 0; c < 4; c += 1) shifted.pixels[(y * cut.width + nx) * 4 + c] = cut.pixels[(y * cut.width + x) * 4 + c]; }
  assert.ok(codes(segmentNativeAlpha(shifted)).includes('ALPHA_NOT_CUT_BY_THE_BORDER'));
  // NA-12 dust: isolated alpha far from the product
  const dust = base(); dust.pixels[at(dust, 20, 400)] = 100; dust.pixels[at(dust, 260, 30)] = 100;
  assert.ok(codes(segmentNativeAlpha(dust)).includes('ALPHA_STRAY'));
  // NA-13 a jagged alpha ramp
  const noisy = base(); let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
  const hard = new Uint8Array(noisy.width * noisy.height); for (let i = 0; i < hard.length; i += 1) hard[i] = noisy.pixels[i * 4 + 3] >= 250 ? 1 : 0;
  const ring = dilate(hard, noisy.width, noisy.height, 2); for (let i = 0; i < hard.length; i += 1) if (ring[i] && !hard[i]) noisy.pixels[i * 4 + 3] = 20 + (rnd() % 200);
  assert.ok(codes(segmentNativeAlpha(noisy)).some((c) => ['ALPHA_NOISE', 'ALPHA_EDGE_ZIGZAG', 'ALPHA_BAKED_HALO', 'ALPHA_OPAQUE_CORE'].includes(c)));
  // NA-14 every failure is a FAILED value with no mask and no confidence, never a partial acceptance
  for (const bad of [border, glow, two, pin, shifted, dust]) { const r = segmentNativeAlpha(bad); assert.equal(r.accepted, false); assert.equal(r.alpha, null); assert.equal(r.confidence, 0); }
  assert.equal(segmentNativeAlpha(null).failure_reason, 'INVALID_INPUT');
});

test('The segmentation stage chooses the path from the image and keeps the validated alpha', async () => {
  const ctx = () => createRunContext({ run_id: 'run-na-1', ceiling_eur: 1, ledger: createDecisionLedger(), at: 'x' });
  const img = precut('phoneCase');
  // NA-15 AUTO on a pre-cut image uses the native path: the interior bytes of the cut-out are the source bytes, the mask is the validated alpha
  const r = await computeProductSegmentation({ ctx: ctx(), rgba: img });
  assert.equal(r.state, 'READY_FOR_COMPOSITE'); assert.equal(r.source_kind, 'NATIVE_ALPHA'); assert.equal(r.stage_evidence.native.snapped_to_opaque > 0, true);
  const cut = decodePng(r.layered.cutout_png); let same = 0; let n = 0;
  for (let y = 0; y < cut.height; y += 1) for (let x = 0; x < cut.width; x += 1) { const q = (y * cut.width + x) * 4; if (cut.pixels[q + 3] !== 255) continue; const si = ((r.cutout.crop.y0 + y) * img.width + r.cutout.crop.x0 + x) * 4; n += 1; if (cut.pixels[q] === img.pixels[si] && cut.pixels[q + 1] === img.pixels[si + 1] && cut.pixels[q + 2] === img.pixels[si + 2]) same += 1; }
  assert.ok(n > 10000 && same === n, `${same}/${n}`);
  // NA-16 AUTO on a photograph uses the photograph path; a forced NATIVE_ALPHA on a photograph fails closed
  const photo = await computeProductSegmentation({ ctx: ctx(), rgba: W.phoneCase().rgba }); assert.equal(photo.source_kind, 'PHOTO'); assert.equal(photo.state, 'READY_FOR_COMPOSITE');
  const forced = await computeProductSegmentation({ ctx: ctx(), rgba: W.phoneCase().rgba, mode: 'NATIVE_ALPHA' }); assert.equal(forced.state, 'SEGMENTATION_FAILED'); assert.deepEqual(forced.reasons, ['THE_IMAGE_HAS_NO_MEANINGFUL_ALPHA']);
  // NA-17 a malformed alpha is a SEGMENTATION_FAILED with the findings as reasons
  const pin = precut('phoneCase'); for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pin.pixels[at(pin, 150 + dx, 220 + dy)] = 0;
  const bad = await computeProductSegmentation({ ctx: ctx(), rgba: pin }); assert.equal(bad.state, 'SEGMENTATION_FAILED'); assert.ok(bad.reasons.includes('ALPHA_PINHOLES')); assert.equal(bad.layered, undefined);
  // NA-18 the stage is a traced local operation of the run, and it costs nothing
  const c = ctx(); await computeProductSegmentation({ ctx: c, rgba: img }); assert.equal(c.operations.list().length, 1); assert.equal(c.operations.list()[0].kind, 'LOCAL'); assert.equal(c.budget.snapshot().spent_eur, 0);
});
