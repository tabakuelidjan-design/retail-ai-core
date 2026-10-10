// Deterministic Creative Fidelity measurements for a PIXEL_PRESERVE composite: the five required product checks, measured on the DELIVERED PNG.
//
//   PRODUCT_IDENTITY   which bytes were drawn (provenance chain): the pinned hash, a merchant-provided origin, exactly one distinct asset
//   PRODUCT_GEOMETRY   placement: contain-fit, no crop, no rotation, inside the canvas, and the measured pixel rectangle equals the expected one
//   PIECE_COUNT        how many product instances were drawn (structural accounting)
//   PRODUCT_COLOR      the colours of the product region are unchanged (mean absolute difference and mean signed shift vs a reference rendering)
//   TEXT               text PRINTED INSIDE the photograph is pixel-exact in the owner-annotated protected regions (no OCR, no interpretation)
//
// A REFERENCE rendering is built independently of the document renderer: the verified source bytes, scaled into the expected rectangle on a blank canvas of the
// candidate's size and background by the same deterministic rasterizer. Candidate and reference are different code paths over different inputs, so a real
// mutation of the candidate (wrong asset, stretch, crop, shift, opacity, overwrite, duplicate) shows up as a difference. Declared limit: the rasterizer's own image
// decoding and resampling are shared by both sides, so a defect inside the rasterizer is not detectable here.
//
// Outcomes use the fidelity vocabulary (PASS / FAIL / NOT_MEASURABLE) and feed evaluateHardFidelityGate unchanged. Nothing is inferred: a check that cannot be
// measured says so. Tolerances are RASTERIZATION / ROUNDING tolerances, not aesthetic ones (see TOLERANCES).

import { createHash } from 'node:crypto';
import { FIDELITY_CHECK as C, FIDELITY_GATE_OUTCOME as O } from '../creative-fidelity/constants.js';
import { rasterizeToPixels } from './production-render.js';
import { decodePng } from './png-pixels.js';
import { measureIdentityPreserve } from './identity-preserve-measurements.js';

export const FIDELITY_MEASUREMENT_SOURCE = 'deterministic-composite-measurement@1';

/** Technical tolerances (approved provisionally): rounding of the rasterizer and of integer pixel rectangles. Tighten to 0 only once cross-platform equality is shown. */
export const TOLERANCES = Object.freeze({
  rectangle_px: 1,
  aspect_ratio_error: 0.005,
  color_mean_abs_diff: 0.5, // of 255
  color_mean_signed_shift: 1, // of 255
  text_region_max_diff: 2, // of 255
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const observation = (code, outcome, evidence) => Object.freeze({ code, outcome, evidence: Object.freeze(evidence), source: FIDELITY_MEASUREMENT_SOURCE });
const pass = (code, evidence) => observation(code, O.PASS, evidence);
const fail = (code, evidence) => observation(code, O.FAIL, evidence);
const unmeasurable = (code, reason, evidence = {}) => observation(code, O.NOT_MEASURABLE, { reason, ...evidence });

function mediaTypeOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  return null;
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The contain-fit ("meet", centred) rectangle of the source dimensions inside a layer box. */
export function containFit(box, width, height) {
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale;
  const h = height * scale;
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h };
}

/** The reference pixels: the verified source, scaled into `rect` on a blank canvas of the candidate's size and background. */
export function renderReference({ sourceBytes, canvas, rect }) {
  const media = mediaTypeOf(sourceBytes);
  if (!media) return null;
  const uri = `data:${media};base64,${Buffer.from(sourceBytes).toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`
    + `<rect width="${canvas.width}" height="${canvas.height}" fill="${canvas.background}"/>`
    + `<image x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" preserveAspectRatio="none" href="${uri}"/></svg>`;
  return rasterizeToPixels(svg);
}

/** The bounding box (x0, y0, x1 exclusive, y1 exclusive) of the pixels that differ from the background colour inside `within`, or null. */
function differenceBox(img, background, within) {
  const [br, bg, bb] = hexToRgb(background);
  const x0 = Math.max(0, Math.floor(within.x0)); const y0 = Math.max(0, Math.floor(within.y0));
  const x1 = Math.min(img.width, Math.ceil(within.x1)); const y1 = Math.min(img.height, Math.ceil(within.y1));
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * img.width + x) * 4;
      if (img.pixels[p] !== br || img.pixels[p + 1] !== bg || img.pixels[p + 2] !== bb) {
        if (x < minX) minX = x; if (x + 1 > maxX) maxX = x + 1; if (y < minY) minY = y; if (y + 1 > maxY) maxY = y + 1;
      }
    }
  }
  return minX === Infinity ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

const inward = (r) => ({
  x0: Math.ceil(r.x), y0: Math.ceil(r.y), x1: Math.floor(r.x + r.width), y1: Math.floor(r.y + r.height),
});

/**
 * @param {object} input
 *  source        { bytes, sha256, origin, width_px, height_px, has_alpha, alpha_bbox? }   the verified real asset
 *  candidate     { png_bytes }                                                          the delivered PNG
 *  canvas        { width, height, background }                                          background is a #RRGGBB colour
 *  product_layers [{ id, asset_ref, geometry:{x,y,width,height,rotation_deg}, preservation_mode, allow_crop, allow_rotation }]
 *  raster_layer_count  number of other raster layers (IMAGE / LOGO) in the document
 *  render_log    { resolutions:[{ ref, sha256 }], image_draws }                         what the renderer actually asked for and drew
 *  expected      { asset_ref, pinned_sha256, piece_count }
 *  text_regions  [{ region_id, x, y, width, height }]                                   normalized (0..1) in the SOURCE, owner-approved
 */
/**
 * The measurements of a product by its preservation mode: PIXEL_PRESERVE (placement of the untouched real pixels, below, unchanged) or IDENTITY_PRESERVE
 * (a provider-edited product whose identity must survive, `identity-preserve-measurements.js`). Any other mode is not measurable here.
 */
export function measureProductFidelity(input = {}) {
  const layers = input.product_layers ?? [];
  if (layers.length === 1 && ['IDENTITY_PRESERVE', 'COMPOSITE'].includes(layers[0].preservation_mode)) return measureIdentityPreserve(input);
  return measurePixelPreserve(input);
}

function measurePixelPreserve({
  source, candidate, canvas, product_layers: layers = [], raster_layer_count: rasterLayers = 0, render_log: log, expected, text_regions: textRegions = [], tolerances = TOLERANCES,
} = {}) {
  const observations = [];
  const layer = layers.length === 1 ? layers[0] : null;

  // ---- PRODUCT_IDENTITY: the provenance chain of the bytes actually drawn
  if (!log || !Array.isArray(log.resolutions) || !source) {
    observations.push(unmeasurable(C.PRODUCT_IDENTITY, 'RENDER_LOG_OR_SOURCE_MISSING'));
  } else {
    const distinct = [...new Set(log.resolutions.map((r) => r.ref))];
    const consumed = [...new Set(log.resolutions.map((r) => r.sha256))];
    const conditions = {
      consumed_hash_equals_pinned: consumed.length === 1 && consumed[0] === expected.pinned_sha256,
      source_hash_equals_pinned: source.sha256 === expected.pinned_sha256,
      origin_is_merchant_provided: source.origin === 'MERCHANT_PROVIDED',
      exactly_one_distinct_asset: distinct.length === 1 && distinct[0] === expected.asset_ref,
      product_layer_uses_expected_asset: layers.length > 0 && layers.every((l) => l.asset_ref === expected.asset_ref),
    };
    const evidence = { consumed_sha256: consumed, pinned_sha256: expected.pinned_sha256, resolved_refs: distinct, conditions };
    if (log.resolutions.length === 0) observations.push(unmeasurable(C.PRODUCT_IDENTITY, 'NO_PAYLOAD_CONSUMED_OBSERVED', evidence));
    else observations.push(Object.values(conditions).every(Boolean) ? pass(C.PRODUCT_IDENTITY, evidence) : fail(C.PRODUCT_IDENTITY, evidence));
  }

  // ---- PIECE_COUNT: structural accounting
  if (!log || !Number.isInteger(expected?.piece_count)) {
    observations.push(unmeasurable(C.PIECE_COUNT, 'EXPECTED_COUNT_OR_RENDER_LOG_MISSING'));
  } else {
    const draws = log.resolutions.filter((r) => r.ref === expected.asset_ref).length;
    const evidence = {
      expected: expected.piece_count, product_layers: layers.length, product_asset_draws: draws, total_image_draws: log.image_draws, other_raster_layers: rasterLayers,
    };
    const ok = layers.length === expected.piece_count && draws === expected.piece_count && log.image_draws === expected.piece_count && rasterLayers === 0;
    observations.push(ok ? pass(C.PIECE_COUNT, evidence) : fail(C.PIECE_COUNT, evidence));
  }

  // ---- the pixel-based checks need the verified source, exactly one product layer, a decodable PNG and a PIXEL_PRESERVE placement
  const pixelBlock = (reason, evidence = {}) => [C.PRODUCT_GEOMETRY, C.PRODUCT_COLOR, C.TEXT].forEach((code) => observations.push(unmeasurable(code, reason, evidence)));
  if (!source || !candidate || !canvas || !layer) { pixelBlock(layers.length === 1 ? 'INPUT_MISSING' : 'EXACTLY_ONE_PRODUCT_LAYER_REQUIRED', { product_layers: layers.length }); return finish(observations); }
  if (layer.preservation_mode !== 'PIXEL_PRESERVE') { pixelBlock('MEASUREMENT_DEFINED_FOR_PIXEL_PRESERVE_ONLY', { preservation_mode: layer.preservation_mode }); return finish(observations); }
  if (sha256(source.bytes) !== source.sha256) { pixelBlock('SOURCE_BYTES_DO_NOT_MATCH_THEIR_HASH'); return finish(observations); }
  let img;
  try { img = decodePng(candidate.png_bytes); } catch (error) { pixelBlock('CANDIDATE_PNG_NOT_DECODABLE', { code: error.code }); return finish(observations); }
  if (img.width !== canvas.width || img.height !== canvas.height) { pixelBlock('CANDIDATE_SIZE_DIFFERS_FROM_CANVAS', { candidate: [img.width, img.height] }); return finish(observations); }
  if (source.has_alpha && !source.alpha_bbox) { pixelBlock('SOURCE_ALPHA_BBOX_UNAVAILABLE'); return finish(observations); }

  const rect = containFit(layer.geometry, source.width_px, source.height_px);
  const reference = renderReference({ sourceBytes: source.bytes, canvas, rect });
  if (!reference) { pixelBlock('SOURCE_MEDIA_TYPE_UNSUPPORTED'); return finish(observations); }

  // ---- PRODUCT_GEOMETRY
  {
    const g = layer.geometry;
    const structural = {
      no_rotation: g.rotation_deg === 0 && layer.allow_rotation !== true,
      no_crop: layer.allow_crop !== true,
      box_inside_canvas: g.x >= 0 && g.y >= 0 && g.x + g.width <= canvas.width && g.y + g.height <= canvas.height,
      rectangle_inside_canvas: rect.x >= -1e-9 && rect.y >= -1e-9 && rect.x + rect.width <= canvas.width + 1e-9 && rect.y + rect.height <= canvas.height + 1e-9,
    };
    const within = { x0: g.x - 2, y0: g.y - 2, x1: g.x + g.width + 2, y1: g.y + g.height + 2 };
    const refBox = differenceBox(reference, canvas.background, within);
    const candBox = differenceBox(img, canvas.background, within);
    const expectedBox = { x0: Math.round(rect.x), y0: Math.round(rect.y), x1: Math.round(rect.x + rect.width), y1: Math.round(rect.y + rect.height) };
    const near = (a, b) => ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(a[k] - b[k]) <= tolerances.rectangle_px);
    if (!refBox || !near(refBox, expectedBox)) {
      // the edge of the photograph is not distinguishable from the background: the rectangle method does not apply to this pair
      observations.push(unmeasurable(C.PRODUCT_GEOMETRY, 'PHOTO_EDGE_NOT_DISTINCT_FROM_BACKGROUND', { reference_box: refBox, expected_box: expectedBox }));
    } else if (!candBox) {
      observations.push(fail(C.PRODUCT_GEOMETRY, { structural, candidate_box: null, expected_box: expectedBox, reason: 'NO_PRODUCT_PIXELS_FOUND' }));
    } else {
      const cw = candBox.x1 - candBox.x0; const ch = candBox.y1 - candBox.y0;
      const aspectError = Math.abs((cw / ch) / (source.width_px / source.height_px) - 1);
      const evidence = {
        structural, expected_box: expectedBox, reference_box: refBox, candidate_box: candBox, aspect_error: aspectError, tolerance_px: tolerances.rectangle_px, tolerance_aspect: tolerances.aspect_ratio_error,
      };
      const ok = Object.values(structural).every(Boolean) && near(candBox, refBox) && aspectError <= tolerances.aspect_ratio_error;
      observations.push(ok ? pass(C.PRODUCT_GEOMETRY, evidence) : fail(C.PRODUCT_GEOMETRY, evidence));
    }
  }

  // ---- PRODUCT_COLOR
  const region = inward(rect);
  {
    let sumAbs = 0; const sumSigned = [0, 0, 0]; let n = 0;
    for (let y = region.y0; y < region.y1; y += 1) {
      for (let x = region.x0; x < region.x1; x += 1) {
        const p = (y * img.width + x) * 4;
        for (let k = 0; k < 3; k += 1) { const d = img.pixels[p + k] - reference.pixels[p + k]; sumAbs += Math.abs(d); sumSigned[k] += d; }
        n += 1;
      }
    }
    if (n === 0) observations.push(unmeasurable(C.PRODUCT_COLOR, 'EMPTY_PRODUCT_REGION'));
    else {
      const meanAbs = sumAbs / (n * 3);
      const shift = sumSigned.map((s) => s / n);
      const evidence = {
        region, pixels: n, mean_abs_diff: meanAbs, mean_signed_shift: shift, tolerance_mean_abs: tolerances.color_mean_abs_diff, tolerance_shift: tolerances.color_mean_signed_shift,
      };
      observations.push(meanAbs <= tolerances.color_mean_abs_diff && shift.every((s) => Math.abs(s) <= tolerances.color_mean_signed_shift) ? pass(C.PRODUCT_COLOR, evidence) : fail(C.PRODUCT_COLOR, evidence));
    }
  }

  // ---- TEXT (printed inside the photograph): pixel-exact within a rounding tolerance in each owner-approved protected region
  {
    if (!textRegions.length) observations.push(unmeasurable(C.TEXT, 'NO_PROTECTED_TEXT_REGION'));
    else {
      const results = []; let invalid = false;
      for (const r of textRegions) {
        const box = inward({ x: rect.x + r.x * rect.width, y: rect.y + r.y * rect.height, width: r.width * rect.width, height: r.height * rect.height });
        if (box.x1 <= box.x0 || box.y1 <= box.y0 || box.x0 < region.x0 - 1 || box.x1 > region.x1 + 1) { invalid = true; break; }
        let max = 0;
        for (let y = box.y0; y < box.y1; y += 1) {
          for (let x = box.x0; x < box.x1; x += 1) {
            const p = (y * img.width + x) * 4;
            for (let k = 0; k < 3; k += 1) max = Math.max(max, Math.abs(img.pixels[p + k] - reference.pixels[p + k]));
          }
        }
        results.push({ region_id: r.region_id, box, max_channel_diff: max });
      }
      if (invalid) observations.push(unmeasurable(C.TEXT, 'PROTECTED_REGION_OUTSIDE_THE_PLACED_PRODUCT'));
      else {
        const evidence = { regions: results, tolerance_max_diff: tolerances.text_region_max_diff };
        observations.push(results.every((r) => r.max_channel_diff <= tolerances.text_region_max_diff) ? pass(C.TEXT, evidence) : fail(C.TEXT, evidence));
      }
    }
  }
  return finish(observations);
}

// the order is fixed so that evidence is stable
const ORDER = [C.PRODUCT_IDENTITY, C.PRODUCT_GEOMETRY, C.PIECE_COUNT, C.PRODUCT_COLOR, C.TEXT];
function finish(observations) {
  return Object.freeze([...observations].sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code)));
}

/** Counts of what the renderer asked for: a resolver wrapper that logs the SHA-256 of the exact bytes it hands out. */
export function createRenderLog(bytesFor) {
  const resolutions = [];
  return {
    resolver: (ref) => {
      const bytes = bytesFor(ref);
      if (!bytes) return null;
      resolutions.push({ ref, sha256: sha256(bytes) });
      return `data:${mediaTypeOf(bytes) ?? 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`;
    },
    finish: (svg) => ({ resolutions: [...resolutions], image_draws: (svg.match(/<image\b/g) ?? []).length }),
  };
}
