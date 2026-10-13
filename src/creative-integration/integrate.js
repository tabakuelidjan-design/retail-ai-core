import { performance } from 'node:perf_hooks';

import { detectArtifacts } from './artifacts.js';
import { compositeScene, pngOf, placeCutout, sha256Of } from './compose.js';
import { STATE } from './constants.js';
import { buildCutout, sha256 } from './cutout.js';
import { checkIdentity } from './identity.js';
import { checkMatte } from './matte-quality.js';
import { validatePlacement } from './placement.js';
import { measureColorMatch, proposeGrade, relightProduct } from './relight.js';
import { segmentProduct } from './segmentation.js';
import { buildContactShadow } from './shadow.js';

// THE INTEGRATION PIPELINE. Source photograph -> general segmentation -> matte quality -> cut-out -> placement rules -> bounded relight / grading -> identity -> contact shadow (a separate layer) -> composite ->
// artifact detection. EVERY stop is one of the explicit states below and names its reasons; there is no fallback to a generated or redrawn product, and the real pixels are never replaced. Only
// READY_FOR_COMPOSITE carries layers. Pure and offline: no provider is called here except through an injected segmentation `port`, and then only if the cache cannot answer.

const AUTO_FRACTIONS = Object.freeze([1, 0.7, 0.5, 0.3, 0]);
const scaleRequest = (req, f, angle, auto) => {
  const out = {};
  for (const [k, v] of Object.entries(req)) out[k] = v * f;
  if (auto && angle !== undefined) out.light_angle_deg = angle;
  return out;
};

const stop = (state, stage, reasons, extra = {}) => Object.freeze({ state, stage, reasons: Object.freeze(reasons), ...extra });

/**
 * @param {object} input
 *   source: RGBA photograph; selection: segmentation selection; port?, cache?
 *   scene: { plate: RGBA, horizon_y?, support, depth_scale?, light: { angle_deg, elevation_deg, softness } }
 *   placement: { x, y, scale, anchor?, rotation_deg? }; product: { real_height_cm?, semi_transparent? }; shadow_kind: 'SOFT'|'HARD'|'DIFFUSE'|'DIRECTIONAL'
 *   grade: 'AUTO' | { exposure_ev, local_gain, temperature, tint, saturation, light_angle_deg } | null (none)
 *   neighbours/occluders/protectedRegions: see validatePlacement; z: this product's z
 */
export function integrateProduct({
  source, selection = { mode: 'AUTO' }, port = null, cache = null, scene, placement, product = {}, shadow_kind: shadowKind = 'SOFT', grade = 'AUTO',
  neighbours = [], occluders = [], protectedRegions = [], z = 30, segmentation = null,
}) {
  const timings = {}; const trace = []; let t = performance.now();
  const lap = (name) => { const n = performance.now(); timings[name] = n - t; t = n; };
  const note = (stage, rule, outcome) => trace.push(Object.freeze({ stage, rule, outcome }));

  // 1. segmentation
  const seg = segmentation ?? segmentProduct({ rgba: source, selection: { ...selection, semi_transparent: product.semi_transparent === true }, port, cache });
  lap('segmentation');
  if (seg.status === 'FAILED') return stop(STATE.SEGMENTATION_FAILED, 'SEGMENTATION', [seg.failure_reason], { segmentation: seg, trace, timings_ms: timings });
  if (!seg.accepted) return stop(STATE.SEGMENTATION_LOW_CONFIDENCE, 'SEGMENTATION', [seg.failure_reason ?? 'CONFIDENCE_BELOW_THE_MINIMUM'], { segmentation: seg, trace, timings_ms: timings });
  note('SEGMENTATION', 'ACCEPTED', { confidence: seg.confidence, source: seg.source });

  // 2. matte quality
  const selected = seg.components.filter((c) => c.selected).length || 1;
  const matte = checkMatte({ rgba: source, alpha: seg.alpha, ground: seg.ground ?? null, declared: { components: selected, semi_transparent: product.semi_transparent === true }, ignore: seg.excluded ?? null });
  lap('matte_quality');
  if (!matte.valid) return stop(STATE.MATTE_INVALID, 'MATTE_QUALITY', matte.findings.filter((f) => !f.ok).map((f) => f.code), { segmentation: seg, matte, trace, timings_ms: timings });
  note('MATTE_QUALITY', 'VALID', { checks: matte.findings.length });

  // 3. the cut-out, and where it would land (geometry only)
  const cutout = buildCutout({ rgba: source, alpha: seg.alpha, bounds: seg.bounds });
  const placed0 = placeCutout(cutout, placement);
  lap('cutout');

  // 4. placement rules
  const verdict = validatePlacement({ scene, placed: placed0, placement, product, neighbours, z, occluders, protectedRegions });
  lap('placement');
  if (verdict.state !== STATE.READY_FOR_COMPOSITE) return stop(STATE.PLACEMENT_INVALID, 'PLACEMENT', verdict.reasons, { placement: verdict, trace, timings_ms: timings });
  note('PLACEMENT', 'VALID', verdict.measurements);

  // 5-6. bounded relight and grading (a derived layer: the cut-out is kept), then product identity. An AUTOMATIC grade is only a proposal: it is applied at the largest fraction that keeps the relight inside its bounds AND
  // the product inside its identity tolerances (down to none). An EXPLICIT grade request is tried once and refused if it breaks either.
  let request = {}; const auto = grade === 'AUTO';
  if (auto) {
    const match = measureColorMatch({ cutout, scene: scene.plate, rect: placed0.rect });
    request = { ...proposeGrade(match).request };
  } else if (grade) request = grade;
  const fractions = auto ? AUTO_FRACTIONS : [1];
  let relit = null; let identity = null; let fractionUsed = null; let lastStop = null;
  for (const f of fractions) {
    const scaled = scaleRequest(request, f, scene.light?.angle_deg, auto);
    const r = relightProduct({ cutout, request: scaled });
    if (r.state !== STATE.READY_FOR_COMPOSITE) { lastStop = stop(STATE.RELIGHT_OUT_OF_BOUNDS, 'RELIGHT', r.reasons.map((x) => `${x.field}:${x.reason}`), { relight: r, trace }); continue; }
    const id = checkIdentity({ source: cutout, result: r.cutout, strict: r.identity_transform });
    if (!id.valid) { lastStop = stop(STATE.PRODUCT_IDENTITY_RISK, 'IDENTITY', id.findings.filter((x) => !x.ok).map((x) => x.code), { identity: id, trace }); continue; }
    relit = r; identity = id; fractionUsed = f; break;
  }
  lap('relight_identity');
  if (!relit) return Object.freeze({ ...lastStop, timings_ms: timings });
  note('RELIGHT', relit.identity_transform ? 'NONE_REQUESTED' : 'APPLIED', { recipe: relit.recipe, measured: relit.measured, auto_fraction: auto ? fractionUsed : null });
  note('IDENTITY', 'PRESERVED', identity.measurements);

  // 7. the contact shadow, a separate layer
  const placed = placeCutout(relit.cutout, placement);
  const cast = buildContactShadow({ placed, kind: shadowKind, light: scene.light, support: scene.support?.kind ?? 'HORIZONTAL_PLANE' });
  lap('shadow');
  if (cast.state !== STATE.READY_FOR_COMPOSITE) return stop(STATE.SHADOW_INVALID, 'SHADOW', cast.reasons, { trace, timings_ms: timings });

  // 8. composite and artifact detection
  const composite = compositeScene({ plate: scene.plate, shadows: [cast.shadow], placed: [placed] });
  lap('composite');
  const artifacts = detectArtifacts({ plate: scene.plate, composite, placed, shadow: cast.shadow, geometry: cast.geometry, relightMeasured: relit.measured, placement, cutoutSize: { width: cutout.width, height: cutout.height } });
  lap('artifacts');
  const colour = measureColorMatch({ cutout: relit.cutout, scene: scene.plate, rect: placed.rect });
  const colourBad = colour.measurable && !colour.matched ? Object.entries(colour.within).filter(([, ok]) => !ok).map(([k]) => `COLOR_${k.toUpperCase()}`) : (colour.measurable ? [] : ['COLOR_NOT_MEASURABLE']);
  if (!artifacts.clean || colourBad.length) {
    const shadowCodes = artifacts.findings.filter((f) => !f.ok && ['FLOATING_OBJECT', 'DETACHED_SHADOW', 'DOUBLE_SHADOW_LOBES', 'PLATE_SHADOW_AT_CONTACT', 'SHADOW_DIRECTION'].includes(f.code)).map((f) => f.code);
    const other = artifacts.findings.filter((f) => !f.ok && !shadowCodes.includes(f.code)).map((f) => f.code);
    return stop(STATE.INTEGRATION_ARTIFACT, 'ARTIFACTS', [...shadowCodes, ...other, ...colourBad], { artifacts, colour, composite, trace, timings_ms: timings });
  }
  note('ARTIFACTS', 'CLEAN', { checks: artifacts.findings.length });

  return Object.freeze({
    state: STATE.READY_FOR_COMPOSITE, stage: 'DONE', reasons: Object.freeze([]),
    segmentation: seg, matte, identity, placement: verdict, relight: relit, artifacts, colour,
    layers: Object.freeze({ product: placed, shadow: cast.shadow, shadow_geometry: cast.geometry, cutout, graded_cutout: relit.cutout }),
    composite,
    hashes: Object.freeze({
      source: sha256(source.pixels), mask: sha256(seg.alpha), cutout: sha256Of(cutout), graded_product: sha256Of(placed.rgba), shadow: sha256Of(cast.shadow), composite: sha256Of(composite), recipe: relit.recipe_sha256,
    }),
    png: pngOf(composite), trace: Object.freeze(trace), timings_ms: Object.freeze(timings),
  });
}

/**
 * Several products from ONE photograph (or several): the source is analysed once, each product has its own explicit selection and placement; products are ordered by depth (the nearer one is drawn later) and
 * each is integrated against the scene so far. Any product that stops stops the scene: the result names which one and why (no partial scene is delivered as ready).
 */
export function integrateScene({ source, products, scene, port = null, cache = null }) {
  const placedSoFar = []; const results = []; let plate = scene.plate; const t0 = performance.now();
  const ordered = [...products].sort((a, b) => a.placement.y - b.placement.y);
  for (let k = 0; k < ordered.length; k += 1) {
    const p = ordered[k];
    const r = integrateProduct({
      source, selection: p.selection, port, cache, scene: { ...scene, plate }, placement: p.placement, product: p.product, shadow_kind: p.shadow_kind, grade: p.grade ?? 'AUTO',
      neighbours: placedSoFar, z: 30 + k * 2, protectedRegions: p.protectedRegions ?? [],
    });
    results.push({ id: p.id, result: r });
    if (r.state !== STATE.READY_FOR_COMPOSITE) return Object.freeze({ state: r.state, failed_product: p.id, reasons: r.reasons, results: Object.freeze(results), total_ms: performance.now() - t0 });
    placedSoFar.push({ opaque: r.layers.product.opaque, contact_y: r.layers.product.contact_y, z: 30 + k * 2 });
    plate = r.composite; // the next product is placed over the scene so far
  }
  return Object.freeze({ state: STATE.READY_FOR_COMPOSITE, composite: plate, results: Object.freeze(results), total_ms: performance.now() - t0, png: pngOf(plate) });
}
