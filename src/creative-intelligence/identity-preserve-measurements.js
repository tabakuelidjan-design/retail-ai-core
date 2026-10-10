// Deterministic Creative Fidelity measurements for IDENTITY_PRESERVE: a provider-edited / composited product image whose background, placement, scale and
// surrounding light may change, while the IDENTITY of the real product must stay intact. The five existing required checks keep their codes; each one is made of
// separately evidenced SUB-OBSERVATIONS (PASS / FAIL / NOT_MEASURABLE) and there is no single similarity score:
//
//   PRODUCT_IDENTITY   DERIVATION_CHAIN (the edited asset is derived from the pinned real asset, with provider provenance, consumed once)
//                      REGISTRATION (the real product is found in the delivered PNG: masked correlation under scale + translation, no rotation)
//                      ARTWORK (the printed artwork keeps its structure)
//   PRODUCT_GEOMETRY   ANISOTROPY (no stretch), SCALE_BOUNDS, INSIDE_CANVAS, OUTLINE_EDGE (the case outline is still drawn there),
//                      CAMERA_MODULE (local registration of the module), LENS_PLACEMENT (the lens openings sit where they must)
//   PIECE_COUNT        INSTANCE_COUNT (one product, no duplicate), LENS_COUNT (the visible lens openings: none added, none removed), ASSET_DRAWN_ONCE
//   PRODUCT_COLOR      LUMINANCE_GAIN (relighting within bounds), CHANNEL_GAIN_SPREAD, CHROMA_SHIFT, LOCAL_CHROMA_SHIFT (no tint / hue change, global or local)
//   TEXT               one PRINTED_TEXT_REGION sub-observation per protected region (local structure of the printed text)
//
// Everything is measured on the DELIVERED PNG against the verified source pixels through ONE estimated registration (scale x, scale y, translation); the
// estimate is itself reported as evidence. A measurement that cannot be made says NOT_MEASURABLE and is never promoted. A failed registration makes the
// dependent checks NOT_MEASURABLE (their evidence would be meaningless) while the identity check fails.
//
// A VLM may be consulted for attributes that cannot be measured deterministically; such observations are accepted only as ADVISORY evidence: they are
// recorded, never counted, and can never turn a deterministic FAIL into anything else.
//
// The tolerances are PROVISIONAL technical ones and are not calibrated on real provider output yet (the first live outputs must calibrate them, openly).

import { createHash } from 'node:crypto';
import { FIDELITY_CHECK as C, FIDELITY_GATE_OUTCOME as O } from '../creative-fidelity/constants.js';
import { rasterizeToPixels } from './production-render.js';
import { decodePng } from './png-pixels.js';
import {
  boundsOf, components, grayOf, inPolygon, otsu, pearson, pyramidOf, sample, sampleAtStep,
} from './image-matching.js';

export const IDENTITY_MEASUREMENT_SOURCE = 'deterministic-identity-measurement@1';

export const IDENTITY_TOLERANCES = Object.freeze({
  registration_ncc_min: 0.8,
  artwork_ncc_min: 0.85,
  text_ncc_min: 0.8,
  text_shift_max_px: 4,
  contrast_ratio: Object.freeze([0.5, 2.0]), // candidate / source standard deviation inside the artwork and the printed text (a faint overlay keeps the correlation, not the contrast)
  anisotropy_max: 0.03, // |sx / sy - 1|
  scale_range: Object.freeze([0.2, 2.5]), // candidate pixels per source pixel
  camera_residual_max: 0.015, // of the case height
  camera_ncc_min: 0.75,
  lens_center_max: 0.02, // of the case height
  lens_area_ratio: Object.freeze([0.4, 2.0]),
  lens_class_separation_min: 12, // luma levels between the lens class and the body class
  outline_supported_min: 0.8,
  outline_edge_ratio_min: 0.25,
  outline_edge_abs_min: 6,
  outline_low_contrast_share: 0.5,
  duplicate_ncc_max: 0.6,
  luminance_gain: Object.freeze([0.8, 1.25]),
  channel_gain_spread_max: 1.15,
  chroma_shift_max: 0.025,
  local_chroma_shift_max: 0.03, // mean over 8 x 8 px cells of the largest chroma-share difference
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sub = (id, outcome, evidence = {}) => Object.freeze({ id, outcome, evidence: Object.freeze(evidence) });
const PASS = (id, e) => sub(id, O.PASS, e);
const FAIL = (id, e) => sub(id, O.FAIL, e);
const NM = (id, reason, e = {}) => sub(id, O.NOT_MEASURABLE, { reason, ...e });
const isOk = (s) => s.outcome === O.PASS;

function mediaTypeOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  return null;
}

/** The check outcome of its sub-observations: FAIL dominates, then NOT_MEASURABLE, then PASS (an empty list is NOT_MEASURABLE). */
function aggregate(code, subs, extra = {}) {
  const outcome = subs.some((s) => s.outcome === O.FAIL) ? O.FAIL
    : (subs.length === 0 || subs.some((s) => s.outcome === O.NOT_MEASURABLE) ? O.NOT_MEASURABLE : O.PASS);
  return Object.freeze({ code, outcome, evidence: Object.freeze({ sub_observations: subs, ...extra }), source: IDENTITY_MEASUREMENT_SOURCE });
}

function blocked(reason, evidence = {}) {
  const subs = [NM('INPUT', reason, evidence)];
  return [C.PRODUCT_IDENTITY, C.PRODUCT_GEOMETRY, C.PIECE_COUNT, C.PRODUCT_COLOR, C.TEXT].map((code) => aggregate(code, subs));
}

// ---- registration -----------------------------------------------------------------------------------------------------------------------------------

function buildTemplate({ pyramid, mask, bx, by, bw, bh }, sx, sy, k) {
  const tw = Math.ceil((bw * sx) / k); const th = Math.ceil((bh * sy) / k);
  const stepX = k / sx; const stepY = k / sy; const step = Math.max(stepX, stepY);
  const us = []; const vs = []; const vals = [];
  for (let v = 0; v < th; v += 1) {
    const ys = by + (v + 0.5) * stepY;
    for (let u = 0; u < tw; u += 1) {
      const xs = bx + (u + 0.5) * stepX;
      if (!mask(xs, ys)) continue;
      us.push(u); vs.push(v); vals.push(sampleAtStep(pyramid, xs, ys, step));
    }
  }
  return { tw, th, us: Int32Array.from(us), vs: Int32Array.from(vs), vals: Float32Array.from(vals), k, n: vals.length };
}

function stdOf(v) {
  if (!v.length) return 0;
  let s = 0; for (const x of v) s += x;
  const mean = s / v.length; let q = 0;
  for (const x of v) q += (x - mean) ** 2;
  return Math.sqrt(q / v.length);
}

/** Pearson correlation of the template with the candidate at the (sub-pixel) candidate position (px, py) of the template's top-left corner. */
function nccAt(T, plane, level, px, py) {
  const scale = 2 ** level; const a = new Float32Array(T.n); const b = new Float32Array(T.n);
  let m = 0;
  for (let i = 0; i < T.n; i += 1) {
    const cx = (px + (T.us[i] + 0.5) * T.k) / scale; const cy = (py + (T.vs[i] + 0.5) * T.k) / scale;
    if (cx < 0 || cy < 0 || cx > plane.width || cy > plane.height) continue;
    a[m] = T.vals[i]; b[m] = sample(plane, cx, cy); m += 1;
  }
  const A = a.subarray(0, m); const B = b.subarray(0, m);
  return { ncc: pearson(A, B), coverage: m / T.n, std_ratio: stdOf(B) / Math.max(1e-6, stdOf(A)) };
}

function coarseSearch(T, plane) {
  const { width: W, height: H, data } = plane;
  let best = { ncc: -2, ox: 0, oy: 0 };
  const maxOx = W - T.tw; const maxOy = H - T.th;
  if (maxOx < 0 || maxOy < 0) return best;
  let ta = 0; let taa = 0;
  for (let i = 0; i < T.n; i += 1) { ta += T.vals[i]; taa += T.vals[i] * T.vals[i]; }
  const varT = taa - (ta * ta) / T.n;
  if (varT < 1e-6) return best;
  const offs = new Int32Array(T.n);
  for (let i = 0; i < T.n; i += 1) offs[i] = T.vs[i] * W + T.us[i];
  for (let oy = 0; oy <= maxOy; oy += 1) {
    for (let ox = 0; ox <= maxOx; ox += 1) {
      const base = oy * W + ox; let sc = 0; let scc = 0; let stc = 0;
      for (let i = 0; i < T.n; i += 1) { const c = data[base + offs[i]]; sc += c; scc += c * c; stc += T.vals[i] * c; }
      const varC = scc - (sc * sc) / T.n;
      if (varC < 1e-6) continue;
      const ncc = (stc - (ta * sc) / T.n) / Math.sqrt(varT * varC);
      if (ncc > best.ncc) best = { ncc, ox, oy };
    }
  }
  return best;
}

const MIN_COARSE_SAMPLES = 300;

function refine(ctx, candPyr, start) {
  // coordinate hill-climb on (sx, sy, px, py) at 1/4 resolution with sub-pixel positions. Every scale move keeps the CENTRE of the template fixed (so scale and position do
  // not fight each other), and a joint isotropic move (sx and sy together) is part of the neighbourhood.
  const evalAt = (p) => {
    const T = buildTemplate(ctx.src, p.sx, p.sy, 4);
    if (T.n < 40) return -2;
    const r = nccAt(T, candPyr[2], 2, p.px, p.py);
    return r.ncc == null || r.coverage < 0.9 ? -2 : r.ncc;
  };
  const { bw, bh } = ctx.src;
  const rescale = (p, fx, fy) => {
    const sx = p.sx * fx; const sy = p.sy * fy;
    return { sx, sy, px: p.px + (bw * p.sx - bw * sx) / 2, py: p.py + (bh * p.sy - bh * sy) / 2 };
  };
  let cur = { ...start }; let score = evalAt(cur);
  let ds = 0.05; let dp = 8;
  while (ds > 0.003 || dp > 0.5) {
    let improved = false;
    // each move is derived from the CURRENT parameters, so an accepted move is the base of the next one. Two families: scale moves anchored at the top-left corner
    // (a product that grows from where it was placed) and scale moves about the template centre (a product that grows in place); both, plus plain translations.
    const anchored = (c, fx, fy) => ({ ...c, sx: c.sx * fx, sy: c.sy * fy });
    const moves = [
      (c) => anchored(c, 1 + ds, 1 + ds), (c) => anchored(c, 1 - ds, 1 - ds), (c) => anchored(c, 1 + ds, 1), (c) => anchored(c, 1 - ds, 1), (c) => anchored(c, 1, 1 + ds), (c) => anchored(c, 1, 1 - ds),
      (c) => rescale(c, 1 + ds, 1 + ds), (c) => rescale(c, 1 - ds, 1 - ds), (c) => rescale(c, 1 + ds, 1), (c) => rescale(c, 1 - ds, 1), (c) => rescale(c, 1, 1 + ds), (c) => rescale(c, 1, 1 - ds),
      (c) => ({ ...c, px: c.px + dp }), (c) => ({ ...c, px: c.px - dp }), (c) => ({ ...c, py: c.py + dp }), (c) => ({ ...c, py: c.py - dp }),
    ];
    for (const move of moves) {
      const next = move(cur);
      const sc = evalAt(next);
      if (sc > score + 1e-6) { cur = next; score = sc; improved = true; }
    }
    if (!improved) { ds /= 2; dp /= 2; }
  }
  return cur;
}

/** Coarse search over isotropic scales and positions, then a refinement of the best few: the winner is the best correlation at 1/2 resolution (a tiny template can match a random patch at 1/8 resolution, not at 1/2). */
function estimateRegistration(ctx, candPyr, tol) {
  const [smin, smax] = tol.scale_range;
  const K = 8; const plane = candPyr[3]; const found = [];
  for (let s = smin; s <= smax * 1.0001; s *= 1.1) {
    const T = buildTemplate(ctx.src, s, s, K);
    if (T.n < MIN_COARSE_SAMPLES) continue; // a smaller template correlates with random patches
    const r = coarseSearch(T, plane);
    if (r.ncc > -1) found.push({ ncc: r.ncc, sx: s, sy: s, px: r.ox * K, py: r.oy * K });
  }
  if (!found.length) return null;
  found.sort((x, y) => y.ncc - x.ncc);
  let best = null;
  for (const start of found.slice(0, 5)) {
    const cur = refine(ctx, candPyr, start);
    const T = buildTemplate(ctx.src, cur.sx, cur.sy, 2);
    const r = nccAt(T, candPyr[1], 1, cur.px, cur.py);
    const score = r.ncc == null || r.coverage < 0.9 ? -2 : r.ncc;
    if (!best || score > best.score) best = { ...cur, score, coarse_ncc: start.ncc };
  }
  return best;
}

// ---- the measurement ----------------------------------------------------------------------------------------------------------------------------------

/**
 * @param {object} input
 *  source       { bytes, sha256, origin, width_px, height_px }            the verified real asset (the pinned bytes)
 *  derivation   { source_asset_ref, source_sha256, derived_asset_ref, derived_sha256, producer: { provider_id, model, region, request_id } }
 *  candidate    { png_bytes }                                             the delivered PNG
 *  canvas       { width, height }
 *  product_layers [{ preservation_mode }]                                 exactly one, IDENTITY_PRESERVE
 *  render_log   { resolutions: [{ ref, sha256 }], image_draws }           what the renderer actually consumed
 *  expected     { source_asset_ref, pinned_sha256, derived_asset_ref, piece_count }
 *  annotations  { outline: [[x, y]], camera_module: { x, y_top, y_bottom, radius }, lenses: [{ x, y, r }], artwork_region: { x, y, width, height },
 *                 text_regions: [{ region_id, x, y, width, height }] }    normalized to the source (x, y, width by the source width, y, height by the source height; r by the source width)
 *  advisory_observations [{ id, outcome, evidence }]                      optional VLM observations: recorded, never counted
 *  tolerances   optional overrides of IDENTITY_TOLERANCES
 */
export function measureIdentityPreserve(input) {
  const {
    source, derivation, candidate, canvas, product_layers: layers = [], render_log: log, expected, annotations: ann, advisory_observations: advisory = [],
  } = input;
  const tol = { ...IDENTITY_TOLERANCES, ...(input.tolerances ?? {}) };

  if (layers.length !== 1) return blocked('EXACTLY_ONE_PRODUCT_LAYER_REQUIRED', { product_layers: layers.length });
  // IDENTITY_PRESERVE (a provider-edited product) and COMPOSITE (a cut-out of the real pixels on a new environment) are both proven by registering the real product
  if (!['IDENTITY_PRESERVE', 'COMPOSITE'].includes(layers[0].preservation_mode)) return blocked('MEASUREMENT_DEFINED_FOR_IDENTITY_AND_COMPOSITE_ONLY', { preservation_mode: layers[0].preservation_mode });
  if (!source || !candidate || !canvas || !expected || !ann || !derivation || !log) return blocked('INPUT_MISSING');
  if (sha256(source.bytes) !== source.sha256) return blocked('SOURCE_BYTES_DO_NOT_MATCH_THEIR_HASH');
  const mediaType = mediaTypeOf(source.bytes);
  if (!mediaType) return blocked('SOURCE_MEDIA_TYPE_UNSUPPORTED');
  let img;
  try { img = decodePng(candidate.png_bytes); } catch (error) { return blocked('CANDIDATE_PNG_NOT_DECODABLE', { code: error.code }); }
  if (img.width !== canvas.width || img.height !== canvas.height) return blocked('CANDIDATE_SIZE_DIFFERS_FROM_CANVAS', { candidate: [img.width, img.height] });
  if (!Array.isArray(ann.outline) || ann.outline.length < 3 || !ann.camera_module || !Array.isArray(ann.lenses) || !ann.artwork_region) return blocked('IDENTITY_ANNOTATIONS_MISSING');

  const SW = source.width_px; const SH = source.height_px;
  const srcPx = rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}" viewBox="0 0 ${SW} ${SH}"><image width="${SW}" height="${SH}" preserveAspectRatio="none" href="data:${mediaType};base64,${Buffer.from(source.bytes).toString('base64')}"/></svg>`);
  const srcGray = grayOf(srcPx); const srcPyr = pyramidOf(srcGray, 7);
  const candGray = grayOf(img); const candPyr = pyramidOf(candGray, 5);
  const polygon = ann.outline.map(([x, y]) => [x * SW, y * SH]);
  const bb = boundsOf(polygon);
  const bw = bb.x1 - bb.x0; const bh = bb.y1 - bb.y0;
  // the case mask on a 1/2-resolution source grid (nearest lookup)
  const mw = Math.ceil(SW / 2); const mh = Math.ceil(SH / 2); const maskGrid = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y += 1) for (let x = 0; x < mw; x += 1) maskGrid[y * mw + x] = inPolygon(polygon, x * 2 + 1, y * 2 + 1) ? 1 : 0;
  const caseMask = (x, y) => { const ix = Math.floor(x / 2); const iy = Math.floor(y / 2); return ix >= 0 && iy >= 0 && ix < mw && iy < mh && maskGrid[iy * mw + ix] === 1; };
  const ctx = { src: { pyramid: srcPyr, mask: caseMask, bx: bb.x0, by: bb.y0, bw, bh } };

  // ---- derivation chain (provenance, no pixels)
  const resolved = (log.resolutions ?? []).filter((r) => r.ref === expected.derived_asset_ref);
  const producer = derivation.producer ?? {};
  const chainOk = source.sha256 === expected.pinned_sha256 && derivation.source_sha256 === expected.pinned_sha256
    && derivation.source_asset_ref === expected.source_asset_ref && source.origin === 'MERCHANT_PROVIDED'
    && derivation.derived_asset_ref === expected.derived_asset_ref && derivation.derived_sha256 !== expected.pinned_sha256
    && resolved.length === 1 && resolved[0].sha256 === derivation.derived_sha256
    && ['provider_id', 'model', 'region', 'request_id'].every((k) => typeof producer[k] === 'string' && producer[k].length > 0);
  const derivationSub = (chainOk ? PASS : FAIL)('DERIVATION_CHAIN', {
    source_hash_is_pinned: derivation.source_sha256 === expected.pinned_sha256, derived_asset_consumed_times: resolved.length,
    derived_hash_matches_consumed: resolved.length === 1 && resolved[0].sha256 === derivation.derived_sha256,
    producer_provenance_complete: ['provider_id', 'model', 'region', 'request_id'].every((k) => typeof producer[k] === 'string' && producer[k].length > 0),
  });
  // the product asset is drawn once; a composite may also draw the environment images it declares (expected.allowed_other_image_draws, default 0)
  const drawnOnce = log.image_draws === expected.piece_count + (expected.allowed_other_image_draws ?? 0) && resolved.length === 1;

  // ---- registration
  const reg = estimateRegistration(ctx, candPyr, tol);
  if (!reg) {
    const subs = [derivationSub, NM('REGISTRATION', 'NO_REGISTRATION_ESTIMATE')];
    return [aggregate(C.PRODUCT_IDENTITY, subs), ...[C.PRODUCT_GEOMETRY, C.PIECE_COUNT, C.PRODUCT_COLOR, C.TEXT].map((code) => aggregate(code, [NM('REGISTRATION', 'NO_REGISTRATION_ESTIMATE')]))];
  }
  const fine = buildTemplate(ctx.src, reg.sx, reg.sy, 2);
  const fineScore = nccAt(fine, candPyr[1], 1, reg.px, reg.py);
  const registered = fineScore.ncc != null && fineScore.ncc >= tol.registration_ncc_min && fineScore.coverage >= 0.98;
  const registration = {
    scale_x: reg.sx, scale_y: reg.sy, x: reg.px, y: reg.py, ncc: fineScore.ncc, coverage: fineScore.coverage, ncc_min: tol.registration_ncc_min,
  };
  const registrationSub = (registered ? PASS : FAIL)('REGISTRATION', registration);
  const toCand = ([x, y]) => [reg.px + (x - bb.x0) * reg.sx, reg.py + (y - bb.y0) * reg.sy];
  const caseHeight = bh * reg.sy;

  // ---- ARTWORK (structure of the printed artwork; local search of +-3 px)
  const a = ann.artwork_region; const artRect = { x0: a.x * SW, y0: a.y * SH, x1: (a.x + a.width) * SW, y1: (a.y + a.height) * SH };
  const artMask = (x, y) => x >= artRect.x0 && x <= artRect.x1 && y >= artRect.y0 && y <= artRect.y1 && caseMask(x, y);
  const artT = buildTemplate({ ...ctx.src, mask: artMask }, reg.sx, reg.sy, 2);
  let artBest = { ncc: null };
  for (const dy of [-3, 0, 3]) for (const dx of [-3, 0, 3]) {
    const r = nccAt(artT, candPyr[1], 1, reg.px + dx, reg.py + dy);
    if (r.ncc != null && (artBest.ncc == null || r.ncc > artBest.ncc)) artBest = { ncc: r.ncc, dx, dy, coverage: r.coverage, std_ratio: r.std_ratio };
  }
  const artworkSub = artBest.ncc == null ? NM('ARTWORK', 'NO_VARIANCE')
    : (artBest.ncc >= tol.artwork_ncc_min && artBest.std_ratio >= tol.contrast_ratio[0] && artBest.std_ratio <= tol.contrast_ratio[1] ? PASS : FAIL)('ARTWORK', {
      ncc: artBest.ncc, ncc_min: tol.artwork_ncc_min, contrast_ratio: artBest.std_ratio, contrast_ratio_allowed: tol.contrast_ratio, search_offset_px: [artBest.dx, artBest.dy],
    });

  const identity = aggregate(C.PRODUCT_IDENTITY, [derivationSub, registrationSub, artworkSub], { registration });
  if (!registered) {
    const dependent = [NM('REGISTRATION_FAILED', 'THE_REAL_PRODUCT_COULD_NOT_BE_REGISTERED_ON_THE_DELIVERED_PNG', { ncc: fineScore.ncc })];
    return [identity, ...[C.PRODUCT_GEOMETRY, C.PIECE_COUNT, C.PRODUCT_COLOR, C.TEXT].map((code) => aggregate(code, dependent))];
  }

  // ---- PRODUCT_GEOMETRY
  const geo = [];
  const anisotropy = Math.abs(reg.sx / reg.sy - 1);
  geo.push((anisotropy <= tol.anisotropy_max ? PASS : FAIL)('ANISOTROPY', { scale_x: reg.sx, scale_y: reg.sy, anisotropy, anisotropy_max: tol.anisotropy_max }));
  const meanScale = Math.sqrt(reg.sx * reg.sy);
  geo.push((meanScale >= tol.scale_range[0] && meanScale <= tol.scale_range[1] ? PASS : FAIL)('SCALE_BOUNDS', { scale: meanScale, range: tol.scale_range }));
  const mapped = polygon.map(toCand);
  const inside = mapped.every(([x, y]) => x >= -1 && y >= -1 && x <= canvas.width + 1 && y <= canvas.height + 1);
  geo.push((inside ? PASS : FAIL)('INSIDE_CANVAS', { canvas: [canvas.width, canvas.height] }));

  // the outline is still drawn where it must be: edge strength across the outline, relative to the source
  {
    const edge = (plane, x, y, nx, ny) => { let m = 0; for (let t = -3; t <= 2; t += 1) { const g = Math.abs(sample(plane, x + (t + 1) * nx, y + (t + 1) * ny) - sample(plane, x + t * nx, y + t * ny)); if (g > m) m = g; } return m; };
    const L = polygon.length; let supported = 0; let low = 0; let total = 0;
    for (let i = 0; i < L; i += 1) {
      const [x0, y0] = polygon[i]; const [x1, y1] = polygon[(i + 1) % L];
      const len = Math.hypot(x1 - x0, y1 - y0); const nSamples = Math.max(1, Math.round(len / 25));
      const nx = (y1 - y0) / (len || 1); const ny = -(x1 - x0) / (len || 1);
      for (let s = 0; s < nSamples; s += 1) {
        const t = (s + 0.5) / nSamples; const sx0 = x0 + (x1 - x0) * t; const sy0 = y0 + (y1 - y0) * t;
        const [cx, cy] = toCand([sx0, sy0]);
        const eSrc = edge(srcGray, sx0, sy0, nx, ny); const eCand = edge(candGray, cx, cy, nx, ny);
        total += 1;
        if (eCand < tol.outline_edge_abs_min && eSrc < tol.outline_edge_abs_min) { low += 1; continue; }
        if (eCand >= Math.max(tol.outline_edge_abs_min, tol.outline_edge_ratio_min * eSrc)) supported += 1;
      }
    }
    const measurable = total - low;
    if (low / total > tol.outline_low_contrast_share || measurable < 6) geo.push(NM('OUTLINE_EDGE', 'OUTLINE_LOW_CONTRAST', { low_contrast_share: low / total }));
    else geo.push((supported / measurable >= tol.outline_supported_min ? PASS : FAIL)('OUTLINE_EDGE', { supported_share: supported / measurable, supported_min: tol.outline_supported_min, points: measurable }));
  }

  // the camera module: local registration holding the global scale, search +-4% of the case height
  const cm = ann.camera_module; const modRect = {
    x0: (cm.x - cm.radius) * SW, x1: (cm.x + cm.radius) * SW, y0: (cm.y_top - cm.radius * SW / SH) * SH, y1: (cm.y_bottom + cm.radius * SW / SH) * SH,
  };
  {
    const modMask = (x, y) => x >= modRect.x0 && x <= modRect.x1 && y >= modRect.y0 && y <= modRect.y1;
    const T = buildTemplate({ ...ctx.src, mask: modMask }, reg.sx, reg.sy, 2);
    const reach = Math.max(2, Math.round((0.04 * caseHeight) / 2)); let best = { ncc: null, dx: 0, dy: 0 }; let zero = null;
    for (let dy = -reach; dy <= reach; dy += 1) for (let dx = -reach; dx <= reach; dx += 1) {
      const r = nccAt(T, candPyr[1], 1, reg.px + dx * 2, reg.py + dy * 2);
      if (dx === 0 && dy === 0) zero = r.ncc;
      if (r.ncc != null && (best.ncc == null || r.ncc > best.ncc)) best = { ncc: r.ncc, dx, dy };
    }
    if (best.ncc == null) geo.push(NM('CAMERA_MODULE', 'NO_VARIANCE'));
    else {
      const residual = Math.hypot(best.dx * 2, best.dy * 2) / caseHeight;
      geo.push((best.ncc >= tol.camera_ncc_min && residual <= tol.camera_residual_max ? PASS : FAIL)('CAMERA_MODULE', {
        ncc: best.ncc, ncc_at_predicted_position: zero, ncc_min: tol.camera_ncc_min, residual_of_case_height: residual, residual_max: tol.camera_residual_max,
      }));
    }
  }

  // the lens openings: dark blobs inside the module capsule of the delivered PNG
  const lensSubs = (() => {
    const r = cm.radius * SW * 0.92; const cxs = cm.x * SW;
    const segTop = cm.y_top * SH; const segBottom = cm.y_bottom * SH;
    const [capLeft, capTop] = toCand([cxs - r, segTop - r]); const [capRight, capBottom] = toCand([cxs + r, segBottom + r]);
    const x0 = Math.max(0, Math.floor(capLeft)); const y0 = Math.max(0, Math.floor(capTop));
    const x1 = Math.min(img.width, Math.ceil(capRight)); const y1 = Math.min(img.height, Math.ceil(capBottom));
    const w = x1 - x0; const h = y1 - y0;
    if (w < 8 || h < 8) return [NM('LENS_COUNT', 'MODULE_REGION_OUTSIDE_CANVAS'), NM('LENS_PLACEMENT', 'MODULE_REGION_OUTSIDE_CANVAS')];
    const vals = []; const idx = [];
    const rr = r * reg.sx; const segA = [(cxs - bb.x0) * reg.sx + reg.px, (segTop - bb.y0) * reg.sy + reg.py]; const segB = [segA[0], (segBottom - bb.y0) * reg.sy + reg.py];
    const inCapsule = (x, y) => { const yy = Math.min(Math.max(y, segA[1]), segB[1]); return Math.hypot(x - segA[0], y - yy) <= rr; };
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) if (inCapsule(x + 0.5, y + 0.5)) { vals.push(candGray.data[y * img.width + x]); idx.push((y - y0) * w + (x - x0)); }
    const thr = otsu(vals);
    let sLo = 0; let nLo = 0; let sHi = 0; let nHi = 0;
    for (const v of vals) { if (v <= thr) { sLo += v; nLo += 1; } else { sHi += v; nHi += 1; } }
    if (nLo === 0 || nHi === 0 || sHi / nHi - sLo / nLo < tol.lens_class_separation_min) {
      return [NM('LENS_COUNT', 'LENS_LOW_CONTRAST', { separation: nLo && nHi ? sHi / nHi - sLo / nLo : 0 }), NM('LENS_PLACEMENT', 'LENS_LOW_CONTRAST')];
    }
    const dark = new Uint8Array(w * h);
    vals.forEach((v, i) => { if (v <= thr) dark[idx[i]] = 1; });
    const lensArea = ann.lenses.reduce((s, l) => s + Math.PI * (l.r * SW) ** 2, 0) / ann.lenses.length * reg.sx * reg.sy;
    const blobs = components(dark, w, h).filter((b) => b.area >= tol.lens_area_ratio[0] * lensArea).map((b) => ({ ...b, cx: b.cx + x0, cy: b.cy + y0 }));
    const countSub = (blobs.length === ann.lenses.length ? PASS : FAIL)('LENS_COUNT', { detected: blobs.length, expected: ann.lenses.length, threshold: thr });
    const expectedCenters = ann.lenses.map((l) => toCand([l.x * SW, l.y * SH]));
    const tolPx = tol.lens_center_max * caseHeight; const used = new Set(); let worst = 0; let matched = 0;
    for (const [ex, ey] of expectedCenters) {
      let bestI = -1; let bestD = Infinity;
      blobs.forEach((b, i) => { const d = Math.hypot(b.cx - ex, b.cy - ey); if (!used.has(i) && d < bestD) { bestD = d; bestI = i; } });
      if (bestI >= 0) { used.add(bestI); matched += 1; worst = Math.max(worst, bestD); }
    }
    const placed = matched === ann.lenses.length && worst <= tolPx;
    return [countSub, (placed ? PASS : FAIL)('LENS_PLACEMENT', { worst_distance_px: matched ? worst : null, tolerance_px: tolPx, matched, expected: ann.lenses.length })];
  })();
  const lensCount = lensSubs[0]; geo.push(lensSubs[1]);
  const geometry = aggregate(C.PRODUCT_GEOMETRY, geo, { registration });

  // ---- PIECE_COUNT: no second instance of the product (same scale, outside the first one), the lens count, the asset drawn once
  const pieces = [];
  {
    const T = buildTemplate(ctx.src, reg.sx, reg.sy, 8);
    const plane = candPyr[3]; let second = { ncc: null };
    if (T.n >= 40 && plane.width >= T.tw && plane.height >= T.th) {
      const px0 = reg.px / 8; const py0 = reg.py / 8;
      const ta = T.vals.reduce((s, v) => s + v, 0); const taa = T.vals.reduce((s, v) => s + v * v, 0); const varT = taa - (ta * ta) / T.n;
      for (let oy = 0; oy <= plane.height - T.th; oy += 1) for (let ox = 0; ox <= plane.width - T.tw; ox += 1) {
        const overlapX = Math.max(0, Math.min(ox + T.tw, px0 + T.tw) - Math.max(ox, px0)); const overlapY = Math.max(0, Math.min(oy + T.th, py0 + T.th) - Math.max(oy, py0));
        if ((overlapX * overlapY) / (T.tw * T.th) > 0.3) continue;
        let sc = 0; let scc = 0; let stc = 0;
        for (let i = 0; i < T.n; i += 1) { const c = plane.data[(oy + T.vs[i]) * plane.width + ox + T.us[i]]; sc += c; scc += c * c; stc += T.vals[i] * c; }
        const varC = scc - (sc * sc) / T.n; if (varC < 1e-6 || varT < 1e-6) continue;
        const ncc = (stc - (ta * sc) / T.n) / Math.sqrt(varT * varC);
        if (second.ncc == null || ncc > second.ncc) second = { ncc, ox, oy };
      }
    }
    pieces.push((second.ncc == null || second.ncc < tol.duplicate_ncc_max ? PASS : FAIL)('INSTANCE_COUNT', { second_instance_ncc: second.ncc, duplicate_ncc_max: tol.duplicate_ncc_max }));
  }
  pieces.push(lensCount);
  pieces.push((drawnOnce ? PASS : FAIL)('ASSET_DRAWN_ONCE', { image_draws: log.image_draws, expected: expected.piece_count + (expected.allowed_other_image_draws ?? 0), derived_asset_consumed: resolved.length }));
  const pieceCount = aggregate(C.PIECE_COUNT, pieces);

  // ---- PRODUCT_COLOR: gain, channel spread, chroma over the whole registered case mask (nearest samples at 1/2 resolution)
  const colorSubs = (() => {
    const s = [0, 0, 0]; const c = [0, 0, 0]; let n = 0;
    const stepX = 2 / reg.sx; const stepY = 2 / reg.sy; const tw = Math.ceil((bw * reg.sx) / 2); const th = Math.ceil((bh * reg.sy) / 2);
    const cells = new Map(); // 8 x 8 candidate-pixel cells: local colour, so that a hue change is seen even when the global mean is unchanged
    for (let v = 0; v < th; v += 1) for (let u = 0; u < tw; u += 1) {
      const xs = bb.x0 + (u + 0.5) * stepX; const ys = bb.y0 + (v + 0.5) * stepY;
      if (!caseMask(xs, ys)) continue;
      const cx = Math.floor(reg.px + (u + 0.5) * 2); const cy = Math.floor(reg.py + (v + 0.5) * 2);
      if (cx < 0 || cy < 0 || cx >= img.width || cy >= img.height) continue;
      const si = (Math.min(SH - 1, Math.floor(ys)) * SW + Math.min(SW - 1, Math.floor(xs))) * 4; const ci = (cy * img.width + cx) * 4;
      const key = `${u >> 2},${v >> 2}`; const cell = cells.get(key) ?? { s: [0, 0, 0], c: [0, 0, 0], n: 0 };
      for (let k = 0; k < 3; k += 1) { s[k] += srcPx.pixels[si + k]; c[k] += img.pixels[ci + k]; cell.s[k] += srcPx.pixels[si + k]; cell.c[k] += img.pixels[ci + k]; }
      cell.n += 1; cells.set(key, cell); n += 1;
    }
    if (n < 100) return [NM('LUMINANCE_GAIN', 'TOO_FEW_PRODUCT_PIXELS')];
    const gains = c.map((v, k) => v / Math.max(1, s[k]));
    const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / Math.max(1, 0.299 * s[0] + 0.587 * s[1] + 0.114 * s[2]);
    const spread = Math.max(...gains) / Math.max(1e-6, Math.min(...gains));
    const share = (v) => v.map((x) => x / Math.max(1, v[0] + v[1] + v[2]));
    const chroma = Math.max(...share(c).map((x, k) => Math.abs(x - share(s)[k])));
    let local = 0; let counted = 0;
    for (const cell of cells.values()) {
      if (cell.n < 8) continue;
      const a = share(cell.s); const b = share(cell.c);
      local += Math.max(...a.map((x, k) => Math.abs(x - b[k]))); counted += 1;
    }
    const localShift = counted ? local / counted : null;
    return [
      (lum >= tol.luminance_gain[0] && lum <= tol.luminance_gain[1] ? PASS : FAIL)('LUMINANCE_GAIN', { gain: lum, allowed: tol.luminance_gain, pixels: n }),
      (spread <= tol.channel_gain_spread_max ? PASS : FAIL)('CHANNEL_GAIN_SPREAD', { channel_gains: gains, spread, spread_max: tol.channel_gain_spread_max }),
      (chroma <= tol.chroma_shift_max ? PASS : FAIL)('CHROMA_SHIFT', { chroma_shift: chroma, chroma_shift_max: tol.chroma_shift_max }),
      localShift == null ? NM('LOCAL_CHROMA_SHIFT', 'TOO_FEW_CELLS')
        : (localShift <= tol.local_chroma_shift_max ? PASS : FAIL)('LOCAL_CHROMA_SHIFT', { local_chroma_shift: localShift, local_chroma_shift_max: tol.local_chroma_shift_max, cells: counted }),
    ];
  })();
  const color = aggregate(C.PRODUCT_COLOR, colorSubs);

  // ---- TEXT: the printed-text regions keep their local structure (search +-4 px at full resolution)
  const textSubs = (ann.text_regions ?? []).map((r) => {
    const rect = { x0: r.x * SW, y0: r.y * SH, x1: (r.x + r.width) * SW, y1: (r.y + r.height) * SH };
    const T = buildTemplate({ ...ctx.src, mask: (x, y) => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1 }, reg.sx, reg.sy, 1);
    if (T.n < 64) return NM(`PRINTED_TEXT_REGION:${r.region_id}`, 'REGION_TOO_SMALL_AFTER_SCALING', { pixels: T.n });
    let best = { ncc: null, dx: 0, dy: 0 };
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
      const m = nccAt(T, candPyr[0], 0, reg.px + dx, reg.py + dy);
      if (m.ncc != null && (best.ncc == null || m.ncc > best.ncc)) best = { ncc: m.ncc, dx, dy, std_ratio: m.std_ratio };
    }
    if (best.ncc == null) return NM(`PRINTED_TEXT_REGION:${r.region_id}`, 'NO_VARIANCE');
    const contrastOk = best.std_ratio >= tol.contrast_ratio[0] && best.std_ratio <= tol.contrast_ratio[1];
    return (best.ncc >= tol.text_ncc_min && contrastOk && Math.hypot(best.dx, best.dy) <= tol.text_shift_max_px ? PASS : FAIL)(`PRINTED_TEXT_REGION:${r.region_id}`, {
      ncc: best.ncc, ncc_min: tol.text_ncc_min, contrast_ratio: best.std_ratio, contrast_ratio_allowed: tol.contrast_ratio, shift_px: [best.dx, best.dy],
    });
  });
  const text = aggregate(C.TEXT, textSubs);

  const observations = [identity, geometry, pieceCount, color, text];
  if (advisory.length) {
    return observations.map((o, i) => (i === 0 ? Object.freeze({ ...o, evidence: Object.freeze({ ...o.evidence, advisory_observations: Object.freeze(advisory.map((x) => Object.freeze({ ...x, counted: false }))) }) }) : o));
  }
  return observations;
}
