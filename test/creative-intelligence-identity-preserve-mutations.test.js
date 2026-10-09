import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/creative-intelligence/production.js';
import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../src/creative-fidelity/fidelity-gates.js';
import { buildCandidate, measurementInput } from './identity-preserve-world.js';

// IDENTITY_PRESERVE mutations (`// IM-N` markers): what may NOT change. Each mutation models a real regression of a provider edit and must fail the check that owns it.

const REQUIRED = requiredChecksFromInvariants(['PRESERVE_PRODUCT_GEOMETRY', 'PRESERVE_PIECE_COUNT', 'PRESERVE_PRODUCT_COLOR', 'PRESERVE_TEXT_EXACTLY']);
const measure = (candidate, over) => P.measureProductFidelity(measurementInput(candidate, over));
const gate = (observations) => evaluateHardFidelityGate({ observations, requiredChecks: REQUIRED });
const byCode = (observations) => Object.fromEntries(observations.map((o) => [o.code, o]));
const sub = (o, id) => o.evidence.sub_observations.find((s) => s.id === id);
const outcomes = (observations) => Object.fromEntries(observations.map((o) => [o.code, o.outcome]));

test('Altered camera-module geometry fails the camera and lens-placement observations, and only the geometry-owned checks', () => {
  const o = byCode(measure(buildCandidate({ variant: { moduleShift: 8 } })));
  // IM-1 the module moved by about 2 % of the case height: CAMERA_MODULE and LENS_PLACEMENT fail, the identity of the case itself does not
  assert.equal(sub(o.PRODUCT_GEOMETRY, 'CAMERA_MODULE').outcome, 'FAIL');
  assert.equal(sub(o.PRODUCT_GEOMETRY, 'LENS_PLACEMENT').outcome, 'FAIL');
  assert.equal(o.PRODUCT_GEOMETRY.outcome, 'FAIL');
  assert.equal(o.PRODUCT_IDENTITY.outcome, 'PASS');
  assert.equal(o.TEXT.outcome, 'PASS');
});

test('A missing lens and an extra lens fail the lens count', () => {
  // IM-2 a lens removed: the count (2 of 3) fails, and so does the placement of the missing one
  const missing = byCode(measure(buildCandidate({ variant: { lensCount: 2 } })));
  assert.equal(sub(missing.PIECE_COUNT, 'LENS_COUNT').outcome, 'FAIL');
  assert.equal(sub(missing.PIECE_COUNT, 'LENS_COUNT').evidence.detected, 2);
  assert.equal(sub(missing.PRODUCT_GEOMETRY, 'LENS_PLACEMENT').outcome, 'FAIL');
  // IM-3 a lens added (4 of 3)
  const extraObservations = measure(buildCandidate({ variant: { extraLens: true } }));
  const extra = byCode(extraObservations);
  assert.equal(sub(extra.PIECE_COUNT, 'LENS_COUNT').outcome, 'FAIL');
  assert.equal(sub(extra.PIECE_COUNT, 'LENS_COUNT').evidence.detected, 4);
  assert.equal(extra.PIECE_COUNT.outcome, 'FAIL');
  assert.equal(gate(extraObservations).outcome, 'FAIL');
});

test('A stretched case fails (anisotropy for a moderate stretch, any observation for an extreme one)', () => {
  // IM-4 +12 % in height only: the registered scales differ by more than the 3 % tolerance
  const stretched = byCode(measure(buildCandidate({ sy: 1.2 * 1.12 })));
  assert.equal(sub(stretched.PRODUCT_GEOMETRY, 'ANISOTROPY').outcome, 'FAIL');
  assert.equal(stretched.PRODUCT_GEOMETRY.outcome, 'FAIL');
  assert.ok(sub(stretched.PRODUCT_GEOMETRY, 'ANISOTROPY').evidence.anisotropy > 0.03);
  // IM-5 an extreme stretch is never accepted either (whichever observation catches it first)
  assert.equal(gate(measure(buildCandidate({ sy: 1.2 * 1.4 }))).outcome, 'FAIL');
});

test('Substituted artwork fails the identity (artwork) while the structure that did not change stays measured', () => {
  // IM-6 the same case with another printed picture
  const observations = measure(buildCandidate({ variant: { artworkSeed: 7 } }));
  const o = byCode(observations);
  assert.equal(o.PRODUCT_IDENTITY.outcome, 'FAIL');
  assert.equal(sub(o.PRODUCT_IDENTITY, 'ARTWORK').outcome, 'FAIL');
  assert.equal(gate(observations).outcome, 'FAIL');
  // the case, the camera module and the lenses are the real ones: they are still measured and still PASS; the identity check alone owns the substitution
  assert.equal(o.PRODUCT_GEOMETRY.outcome, 'PASS');
  assert.equal(o.PIECE_COUNT.outcome, 'PASS');
  // the printed text is part of the substituted picture's neighbourhood: it is measured too, and a substituted picture does not hide behind it
  assert.notEqual(o.TEXT.outcome, 'NOT_MEASURABLE');
});

test('A damaged printed-text region fails the text check and nothing else', () => {
  // IM-7 the printed text is rewritten (other strokes): the text region fails, the case, the camera and the colours are intact
  const o = outcomes(measure(buildCandidate({ variant: { textDamage: true } })));
  assert.deepEqual(o, { PRODUCT_IDENTITY: 'PASS', PRODUCT_GEOMETRY: 'PASS', PIECE_COUNT: 'PASS', PRODUCT_COLOR: 'PASS', TEXT: 'FAIL' });
});

test('A faded printed text fails the text check even though its structure still correlates', () => {
  // IM-7b a 90 % overlay keeps the correlation of the strokes (a pure gain) but destroys their contrast: the contrast criterion catches it
  const faded = byCode(measure(buildCandidate({ variant: { textFade: true } })));
  assert.equal(faded.TEXT.outcome, 'FAIL');
  const region = sub(faded.TEXT, 'PRINTED_TEXT_REGION:printed-text');
  assert.ok(region.evidence.ncc >= 0.8 && region.evidence.contrast_ratio < 0.5, JSON.stringify(region.evidence));
});

test('A large colour shift fails the colour check', () => {
  // IM-8 a hue rotation: the global mean barely moves, the local chroma does
  const hue = byCode(measure(buildCandidate({ variant: { filter: '<feColorMatrix type="hueRotate" values="90"/>' } })));
  assert.equal(hue.PRODUCT_COLOR.outcome, 'FAIL');
  assert.equal(sub(hue.PRODUCT_COLOR, 'LOCAL_CHROMA_SHIFT').outcome, 'FAIL');
  // IM-9 a strong tint (the whole case turned red) and a strong darkening
  const tint = byCode(measure(buildCandidate({ variant: { filter: '<feColorMatrix type="matrix" values="1.6 0 0 0 0  0 0.7 0 0 0  0 0 0.5 0 0  0 0 0 1 0"/>' } })));
  assert.equal(tint.PRODUCT_COLOR.outcome, 'FAIL');
  const dark = byCode(measure(buildCandidate({ variant: { filter: '<feColorMatrix type="matrix" values="0.5 0 0 0 0  0 0.5 0 0 0  0 0 0.5 0 0  0 0 0 1 0"/>' } })));
  assert.equal(sub(dark.PRODUCT_COLOR, 'LUMINANCE_GAIN').outcome, 'FAIL');
});

test('A duplicated product fails the piece count', () => {
  // IM-10 a second instance of the product (and a second draw)
  const candidate = buildCandidate({ x: 650, y: 60, sx: 0.55, sy: 0.55, duplicateAt: [20, 700] });
  const logged = byCode(measure(candidate, { render_log: { resolutions: [{ ref: 'asset://test/identity/edited-case', sha256: candidate.product_sha }], image_draws: 2 } }));
  assert.equal(sub(logged.PIECE_COUNT, 'INSTANCE_COUNT').outcome, 'FAIL');
  assert.equal(sub(logged.PIECE_COUNT, 'ASSET_DRAWN_ONCE').outcome, 'FAIL');
  // IM-11 a duplicate drawn without a second logged draw is still seen in the pixels
  const silent = byCode(measure(candidate));
  assert.equal(sub(silent.PIECE_COUNT, 'INSTANCE_COUNT').outcome, 'FAIL');
});

test('A redrawn case outline never passes', () => {
  // IM-12 the corners of the case are rounded far beyond the real ones: some observation fails (the registration, the artwork or the outline)
  const observations = measure(buildCandidate({ variant: { cornerRadius: 150 } }));
  assert.equal(gate(observations).outcome, 'FAIL');
});
