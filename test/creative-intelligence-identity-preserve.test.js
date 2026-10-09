import test from 'node:test';
import assert from 'node:assert/strict';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../src/creative-fidelity/fidelity-gates.js';
import { ANNOTATIONS, buildCandidate, measurementInput, sha, SOURCE } from './identity-preserve-world.js';

// IDENTITY_PRESERVE (`// IP-N` markers): modes, positive controls (what MAY change) and provenance / not-measurable semantics. The mutations (what may NOT change) are in
// creative-intelligence-identity-preserve-mutations.test.js. A synthetic product stands for the real case: the measurements are generic.

const REQUIRED = requiredChecksFromInvariants(['PRESERVE_PRODUCT_GEOMETRY', 'PRESERVE_PIECE_COUNT', 'PRESERVE_PRODUCT_COLOR', 'PRESERVE_TEXT_EXACTLY']);
const measure = (candidate, over) => P.measureProductFidelity(measurementInput(candidate, over));
const gate = (observations) => evaluateHardFidelityGate({ observations, requiredChecks: REQUIRED });
const byCode = (observations) => Object.fromEntries(observations.map((o) => [o.code, o]));
const subs = (o) => Object.fromEntries(o.evidence.sub_observations.map((s) => [s.id, s.outcome]));
const RELIGHT = (g) => `<feColorMatrix type="matrix" values="${g} 0 0 0 0  0 ${g} 0 0 0  0 0 ${g} 0 0  0 0 0 1 0"/>`;

test('Preservation modes: PIXEL_PRESERVE is unchanged, IDENTITY_PRESERVE is a second explicit mode', () => {
  // IP-1 the existing four modes are all still there, plus the new one
  assert.deepEqual(Object.keys(CI.PRESERVATION_MODE).sort(), ['COMPOSITE', 'CONTROLLED_EDIT', 'GENERATIVE_REFERENCE', 'IDENTITY_PRESERVE', 'PIXEL_PRESERVE']);
  assert.ok(CI.RENDERABLE_PRESERVATION_MODES.includes('IDENTITY_PRESERVE') && CI.RENDERABLE_PRESERVATION_MODES.includes('PIXEL_PRESERVE'));
  // IP-2 PIXEL_PRESERVE still refuses relighting / crop / rotation (the contract is unchanged)
  const policy = (mode, extra = {}) => CI.normalizeTransformationPolicy({ mode, ...extra });
  assert.throws(() => policy('PIXEL_PRESERVE', { allow_relight: true }), /PIXEL_PRESERVE/);
  assert.throws(() => policy('PIXEL_PRESERVE', { allow_crop: true }), /PIXEL_PRESERVE/);
  // IP-3 IDENTITY_PRESERVE allows relight and shadow, refuses crop and rotation, and needs a justification
  assert.equal(policy('IDENTITY_PRESERVE', { allow_relight: true, allow_shadow: true, justification_ref: 'decision://test/identity' }).allow_relight, true);
  assert.throws(() => policy('IDENTITY_PRESERVE', { allow_relight: true }), /justification_ref/);
  assert.throws(() => policy('IDENTITY_PRESERVE', { allow_crop: true, justification_ref: 'decision://test/identity' }), /no crop and no rotation/);
  assert.throws(() => policy('IDENTITY_PRESERVE', { allow_rotation: true, justification_ref: 'decision://test/identity' }), /no crop and no rotation/);
  // IP-4 the product-understanding contract needs protected regions in this mode
  const understanding = (regions) => CI.normalizeProductUnderstanding({
    merchant_id: '11111111-1111-4111-8111-111111111111',
    brand_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    product_ref: 'product://test/p',
    asset_refs: ['asset://test/a'],
    protected_regions: regions,
    logo_regions: [],
    packaging_text_regions: [],
    dominant_orientation: 'FRONT',
    product_bounds: null,
    created_at: '2026-10-10T10:00:00.000Z',
    transformation_policy: { mode: 'IDENTITY_PRESERVE', allow_relight: true, justification_ref: 'decision://test/identity' },
  });
  assert.throws(() => understanding([]), /needs protected regions/);
});

test('Positive controls: a new background, a new scale / position and relighting still PASS all five checks', () => {
  const cases = {
    'a studio background': { background: 'studio', x: 300, y: 250, sx: 1.0, sy: 1.0 },
    'a dark background': { background: 'dark', x: 400, y: 400, sx: 0.8, sy: 0.8 },
    'a smaller product moved to the corner': { background: 'white', x: 640, y: 120, sx: 0.7, sy: 0.7 },
    'a larger product': { background: 'white', x: 200, y: 100, sx: 1.6, sy: 1.6 },
    'relighting (+8 %)': { variant: { filter: RELIGHT(1.08) } },
    'relighting (-10 %)': { variant: { filter: RELIGHT(0.9) } },
  };
  for (const [name, spec] of Object.entries(cases)) {
    const observations = measure(buildCandidate(spec));
    // IP-5 every check PASS, none NOT_MEASURABLE, and the existing gate aggregates it unchanged
    assert.deepEqual(observations.map((o) => o.code), ['PRODUCT_IDENTITY', 'PRODUCT_GEOMETRY', 'PIECE_COUNT', 'PRODUCT_COLOR', 'TEXT'], name);
    const detail = JSON.stringify(observations.map((o) => [o.code, o.outcome, o.evidence.sub_observations.filter((s) => s.outcome !== 'PASS').map((s) => s.id)]));
    assert.ok(observations.every((o) => o.outcome === 'PASS'), `${name}: ${detail}`);
    assert.equal(gate(observations).outcome, 'PASS', name);
    assert.ok(observations.every((o) => o.source === P.IDENTITY_MEASUREMENT_SOURCE));
  }
});

test('Each check is made of separate evidenced sub-observations, with the registration reported', () => {
  const observations = byCode(measure(buildCandidate({})));
  // IP-8 identity: derivation chain, registration, artwork; geometry; pieces; colour; one text region
  assert.deepEqual(Object.keys(subs(observations.PRODUCT_IDENTITY)), ['DERIVATION_CHAIN', 'REGISTRATION', 'ARTWORK']);
  assert.deepEqual(Object.keys(subs(observations.PRODUCT_GEOMETRY)), ['ANISOTROPY', 'SCALE_BOUNDS', 'INSIDE_CANVAS', 'OUTLINE_EDGE', 'CAMERA_MODULE', 'LENS_PLACEMENT']);
  assert.deepEqual(Object.keys(subs(observations.PIECE_COUNT)), ['INSTANCE_COUNT', 'LENS_COUNT', 'ASSET_DRAWN_ONCE']);
  assert.deepEqual(Object.keys(subs(observations.PRODUCT_COLOR)), ['LUMINANCE_GAIN', 'CHANNEL_GAIN_SPREAD', 'CHROMA_SHIFT', 'LOCAL_CHROMA_SHIFT']);
  assert.deepEqual(Object.keys(subs(observations.TEXT)), ['PRINTED_TEXT_REGION:printed-text']);
  // IP-9 the estimated registration is evidence: scale 1.2 and the placement (330, 320) of the candidate, within a pixel or two
  const reg = observations.PRODUCT_IDENTITY.evidence.registration;
  assert.ok(Math.abs(reg.scale_x - 1.2) < 0.03 && Math.abs(reg.scale_y - 1.2) < 0.03 && reg.ncc > 0.9, JSON.stringify(reg));
  assert.ok(Math.abs(reg.x - 330) <= 3 && Math.abs(reg.y - 320) <= 3);
  // IP-10 no opaque similarity score exists: every sub-observation is a verdict with its own numbers
  assert.ok(observations.PRODUCT_IDENTITY.evidence.sub_observations.every((s) => ['PASS', 'FAIL', 'NOT_MEASURABLE'].includes(s.outcome)));
  assert.ok(!('score' in observations.PRODUCT_IDENTITY.evidence));
});

test('Provenance: the edited asset must be derived from the pinned real asset, with provider provenance, drawn once', () => {
  const candidate = buildCandidate({});
  const identity = (over) => subs(byCode(measure(candidate, over)).PRODUCT_IDENTITY).DERIVATION_CHAIN;
  assert.equal(identity({}), 'PASS');
  const base = measurementInput(candidate);
  // IP-11 a derivation from another source hash / asset ref FAILS
  assert.equal(identity({ derivation: { ...base.derivation, source_sha256: sha(new Uint8Array([1, 2, 3])) } }), 'FAIL');
  assert.equal(identity({ derivation: { ...base.derivation, source_asset_ref: 'asset://test/other' } }), 'FAIL');
  // IP-12 a derived asset identical to the source is not a derivation
  assert.equal(identity({
    derivation: { ...base.derivation, derived_sha256: sha(SOURCE) },
    render_log: { resolutions: [{ ref: base.derivation.derived_asset_ref, sha256: sha(SOURCE) }], image_draws: 1 },
  }), 'FAIL');
  // IP-13 missing provider provenance, a hash that was not the consumed one, a derived asset consumed twice, or never consumed
  assert.equal(identity({ derivation: { ...base.derivation, producer: { ...base.derivation.producer, request_id: '' } } }), 'FAIL');
  assert.equal(identity({ derivation: { ...base.derivation, producer: { provider_id: 'x' } } }), 'FAIL');
  assert.equal(identity({ render_log: { resolutions: [{ ref: base.derivation.derived_asset_ref, sha256: sha(new Uint8Array([9])) }], image_draws: 1 } }), 'FAIL');
  assert.equal(identity({ render_log: { resolutions: [base.render_log.resolutions[0], base.render_log.resolutions[0]], image_draws: 1 } }), 'FAIL');
  assert.equal(identity({ render_log: { resolutions: [], image_draws: 0 } }), 'FAIL');
  // IP-14 a source that is not merchant-provided
  assert.equal(identity({ source: { ...base.source, origin: 'GENERATED' } }), 'FAIL');
});

test('NOT_MEASURABLE: nothing is invented when the evidence is missing or the input is wrong', () => {
  const candidate = buildCandidate({});
  const allNM = (observations) => observations.every((o) => o.outcome === 'NOT_MEASURABLE');
  // IP-15 no annotations / no derivation / wrong layer mode / not exactly one product layer / wrong canvas / source bytes that do not match their hash
  assert.ok(allNM(measure(candidate, { annotations: null })));
  assert.ok(allNM(measure(candidate, { annotations: { ...ANNOTATIONS, outline: [] } })));
  assert.ok(allNM(measure(candidate, { derivation: null })));
  const direct = (over) => P.measureIdentityPreserve({ ...measurementInput(candidate), ...over });
  assert.ok(allNM(direct({ product_layers: [] })));
  assert.ok(allNM(direct({ product_layers: [{ preservation_mode: 'IDENTITY_PRESERVE' }, { preservation_mode: 'IDENTITY_PRESERVE' }] })));
  assert.ok(allNM(P.measureIdentityPreserve({ ...measurementInput(candidate), product_layers: [{ preservation_mode: 'PIXEL_PRESERVE' }] })));
  assert.ok(allNM(measure(candidate, { canvas: { width: 1000, height: 1350 } })));
  assert.ok(allNM(measure(candidate, { source: { ...measurementInput(candidate).source, sha256: sha(new Uint8Array([1])) } })));
  assert.ok(allNM(measure(candidate, { candidate: { png_bytes: new Uint8Array([1, 2, 3]) } })));
  // IP-16 an unmeasurable result never passes the gate (it is NOT_MEASURABLE)
  assert.equal(gate(measure(candidate, { annotations: null })).outcome, 'NOT_MEASURABLE');
});

test('A VLM observation is advisory only: recorded, never counted, never overriding a deterministic result', () => {
  const candidate = buildCandidate({});
  const advisory = [{ id: 'VLM_PRODUCT_LOOKS_THE_SAME', outcome: 'FAIL', evidence: { note: 'looks different' } }];
  // IP-17 an advisory FAIL does not change a deterministic PASS, and is marked as not counted
  const passing = measure(candidate, { advisory_observations: advisory });
  assert.ok(passing.every((o) => o.outcome === 'PASS'));
  assert.deepEqual(passing[0].evidence.advisory_observations.map((a) => a.counted), [false]);
  // IP-18 an advisory PASS cannot rescue a deterministic FAIL
  const failing = measure(buildCandidate({ variant: { moduleShift: 8 } }), { advisory_observations: [{ id: 'VLM_OK', outcome: 'PASS', evidence: {} }] });
  assert.equal(gate(failing).outcome, 'FAIL');
});

test('The pixel-preserve measurement path is untouched', () => {
  // IP-19 a PIXEL_PRESERVE product is still routed to the original measurement (not to the identity one)
  const observations = P.measureProductFidelity({
    product_layers: [{ preservation_mode: 'PIXEL_PRESERVE' }],
    source: null,
    candidate: null,
    canvas: null,
    expected: { asset_ref: 'x', pinned_sha256: 'y', piece_count: 1 },
    render_log: { resolutions: [], image_draws: 0 },
  });
  assert.ok(observations.every((o) => o.source === P.FIDELITY_MEASUREMENT_SOURCE));
});
