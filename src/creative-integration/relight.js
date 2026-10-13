import { createHash } from 'node:crypto';

import { GRADE, RELIGHT as R, STATE } from './constants.js';
import { clamp, erode, lumaAt } from './pixels.js';

// BOUNDED RELIGHTING AND GRADING of the product layer. A gain field only: a smooth multiplicative light (exposure + a gradient along the light axis), a colour temperature and tint, and a saturation change. No
// detail is synthesised, nothing is repainted, the alpha is copied byte for byte. A request outside the declared bounds is REFUSED (RELIGHT_OUT_OF_BOUNDS), never clamped silently; after applying, the largest
// change of any interior pixel and the newly clipped share are MEASURED against their bounds. The recipe (the numbers) is returned with a hash, and the source cut-out is never overwritten: the relit layer is a
// derived value that can be re-derived from (source, recipe), or dropped.

const sha = (s) => createHash('sha256').update(s).digest('hex');
const KEYS = ['exposure_ev', 'local_gain', 'temperature', 'tint', 'saturation', 'light_angle_deg'];

/** Which requested values are outside the bounds. */
export function boundViolations(request = {}) {
  const lim = { exposure_ev: R.exposure_ev, local_gain: R.local_gain, temperature: R.temperature, tint: R.tint, saturation: R.saturation };
  const out = [];
  for (const k of Object.keys(request)) if (!KEYS.includes(k)) out.push({ field: k, reason: 'UNKNOWN_FIELD' });
  for (const [k, max] of Object.entries(lim)) {
    const v = request[k]; if (v === undefined) continue;
    if (!Number.isFinite(v)) out.push({ field: k, reason: 'NOT_A_NUMBER' });
    else if (Math.abs(v) > max) out.push({ field: k, reason: 'BEYOND_THE_BOUND', value: v, bound: max });
  }
  if (request.light_angle_deg !== undefined && !Number.isFinite(request.light_angle_deg)) out.push({ field: 'light_angle_deg', reason: 'NOT_A_NUMBER' });
  return out;
}

/**
 * @param {object} input { cutout: RGBA, request: { exposure_ev?, local_gain?, temperature?, tint?, saturation?, light_angle_deg? } }
 *   light_angle_deg: the direction the light comes FROM in the image plane (0 = from the right, 90 = from above, 180 = from the left); the lit side gets the gain, the far side loses it.
 */
export function relightProduct({ cutout, request = {} }) {
  const violations = boundViolations(request);
  if (violations.length) return Object.freeze({ state: STATE.RELIGHT_OUT_OF_BOUNDS, reasons: violations });
  const { width, height, pixels } = cutout; const n = width * height;
  const ev = request.exposure_ev ?? 0; const lg = request.local_gain ?? 0; const temp = request.temperature ?? 0; const tint = request.tint ?? 0; const sat = request.saturation ?? 0;
  const ang = ((request.light_angle_deg ?? 90) * Math.PI) / 180; const lx = Math.cos(ang); const ly = -Math.sin(ang);
  const recipe = Object.freeze({ exposure_ev: ev, local_gain: lg, temperature: temp, tint, saturation: sat, light_angle_deg: request.light_angle_deg ?? 90 });
  if (!ev && !lg && !temp && !tint && !sat) return Object.freeze({ state: STATE.READY_FOR_COMPOSITE, cutout, recipe, recipe_sha256: sha(JSON.stringify(recipe)), identity_transform: true, measured: { max_luma_change: 0, new_clip_share: 0 } });
  let minP = Infinity; let maxP = -Infinity; const proj = new Float32Array(n);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const p = (x - width / 2) * lx + (y - height / 2) * ly; proj[y * width + x] = p; if (p < minP) minP = p; if (p > maxP) maxP = p; }
  const half = Math.max(1e-6, (maxP - minP) / 2);
  const out = new Uint8Array(pixels.length); const gainEv = 2 ** ev; const lost = new Uint8Array(n); // lost[i] = 1: a channel would have gone more than clip_tolerance_levels beyond 0 / 255 (information lost, not a rounding of a near-white)
  for (let i = 0; i < n; i += 1) {
    const q = i * 4; out[q + 3] = pixels[q + 3];
    if (pixels[q + 3] === 0) continue;
    const gain = gainEv * (1 + lg * clamp(proj[i] / half, -1, 1));
    let r = pixels[q] * gain * (1 + temp); let g = pixels[q + 1] * gain * (1 + tint); let b = pixels[q + 2] * gain * (1 - temp);
    if (sat) { const l = 0.299 * r + 0.587 * g + 0.114 * b; r = l + (r - l) * (1 + sat); g = l + (g - l) * (1 + sat); b = l + (b - l) * (1 + sat); }
    if (Math.max(r - 255, g - 255, b - 255, -r, -g, -b) > R.clip_tolerance_levels) lost[i] = 1;
    out[q] = clamp(Math.round(r), 0, 255); out[q + 1] = clamp(Math.round(g), 0, 255); out[q + 2] = clamp(Math.round(b), 0, 255);
  }
  // measured bounds, on the interior
  const hard = new Uint8Array(n); for (let i = 0; i < n; i += 1) hard[i] = pixels[i * 4 + 3] >= 250 ? 1 : 0;
  const core = erode(hard, width, height, 2); let maxChange = 0; let clipped = 0; let tested = 0;
  for (let i = 0; i < n; i += 1) {
    if (!core[i]) continue; tested += 1; const q = i * 4;
    maxChange = Math.max(maxChange, Math.abs(lumaAt(out, q) - lumaAt(pixels, q)) / 255);
    if (lost[i]) clipped += 1;
  }
  const measured = Object.freeze({ max_luma_change: maxChange, new_clip_share: tested ? clipped / tested : 0 });
  const bad = [];
  if (maxChange > R.max_luma_change) bad.push({ field: 'max_luma_change', reason: 'MEASURED_BEYOND_THE_BOUND', value: maxChange, bound: R.max_luma_change });
  if (measured.new_clip_share > R.clip_share_max) bad.push({ field: 'new_clip_share', reason: 'MEASURED_BEYOND_THE_BOUND', value: measured.new_clip_share, bound: R.clip_share_max });
  if (bad.length) return Object.freeze({ state: STATE.RELIGHT_OUT_OF_BOUNDS, reasons: bad, measured });
  return Object.freeze({ state: STATE.READY_FOR_COMPOSITE, cutout: Object.freeze({ ...cutout, pixels: out }), recipe, recipe_sha256: sha(JSON.stringify(recipe)), identity_transform: false, measured });
}

// ---- colour and grading integration ----------------------------------------------------------------------------------------------------------------------------------------

// What is compared is the ILLUMINATION, not the product's own colour: a blue product in a warm room is not a mismatch. So the white point (the bright end, p95 of luma) stands for exposure, the cast of the NEUTRAL
// pixels (low saturation: white, grey, black parts) stands for the colour temperature, and the fine texture (mean absolute Laplacian away from strong edges) for sharpness / grain. Saturation is reported and has
// a loose gate (it is mostly albedo). A quantity that cannot be measured on one side (no bright pixel, no neutral pixel) is SKIPPED and says so; it never passes silently as a number.
function stats(pixels, width, indices) {
  const lumas = []; let nn = 0; let tn = 0; let sat = 0; let n = 0; let tex = 0; let texN = 0;
  const L = (q) => lumaAt(pixels, q) / 255;
  for (const i of indices) {
    const q = i * 4; const r = pixels[q]; const g = pixels[q + 1]; const b = pixels[q + 2]; const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const sa = mx ? (mx - mn) / mx : 0;
    lumas.push(L(q)); sat += sa; n += 1;
    if (sa < 0.12 && mx > 24) { tn += (r - b) / Math.max(1, r + b); nn += 1; }
    const lap = Math.abs(4 * L(q) - L(q - 4) - L(q + 4) - L(q - width * 4) - L(q + width * 4));
    if (lap < 0.06) { tex += lap; texN += 1; }
  }
  if (!n) return null;
  lumas.sort((x, y) => x - y);
  return { white_point: lumas[Math.min(n - 1, Math.floor(n * 0.95))], neutral_temperature: nn >= Math.max(24, n * 0.02) ? tn / nn : null, saturation: sat / n, texture: texN >= 24 ? tex / texN : null };
}

/**
 * Compare the product with the scene AROUND its placement (a ring of the plate).
 * @param {object} input { cutout, scene: RGBA (the plate), rect: { x, y, width, height } (where the cut-out lands), ring_px? }
 */
export function measureColorMatch({ cutout, scene, rect, ring_px = 48 }) {
  const prod = []; const inner = (img, i) => { const x = i % img.width; const y = (i - x) / img.width; return x > 1 && y > 1 && x < img.width - 2 && y < img.height - 2; };
  for (let i = 0; i < cutout.width * cutout.height; i += 1) if (cutout.pixels[i * 4 + 3] >= 250 && inner(cutout, i)) prod.push(i);
  const ring = [];
  const x0 = Math.max(2, Math.floor(rect.x - ring_px)); const y0 = Math.max(2, Math.floor(rect.y - ring_px)); const x1 = Math.min(scene.width - 2, Math.ceil(rect.x + rect.width + ring_px)); const y1 = Math.min(scene.height - 2, Math.ceil(rect.y + rect.height + ring_px));
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height; if (!inside) ring.push(y * scene.width + x); }
  const p = stats(cutout.pixels, cutout.width, prod); const s = stats(scene.pixels, scene.width, ring);
  if (!p || !s) return Object.freeze({ measurable: false, reason: 'NO_PRODUCT_OR_NO_SCENE_PIXELS' });
  const skipped = []; const delta = {}; const within = {};
  if (p.white_point >= GRADE.min_white_point) { delta.luminance = p.white_point - s.white_point; within.luminance = Math.abs(delta.luminance) <= GRADE.luminance_delta_max; } else skipped.push('luminance: the product has no bright part to judge the exposure by');
  if (p.neutral_temperature !== null && s.neutral_temperature !== null) { delta.temperature = p.neutral_temperature - s.neutral_temperature; within.temperature = Math.abs(delta.temperature) <= GRADE.temperature_delta_max; } else skipped.push('temperature: no neutral pixels on one side');
  delta.saturation = p.saturation - s.saturation; within.saturation = Math.abs(delta.saturation) <= GRADE.saturation_delta_max;
  if (p.texture !== null && s.texture !== null && Math.max(p.texture, s.texture) >= GRADE.texture_floor) { delta.contrast = Math.log2(Math.max(p.texture, 1e-4) / Math.max(s.texture, 1e-4)); within.contrast = Math.abs(delta.contrast) <= GRADE.texture_log2_max; } else skipped.push('contrast: no measurable fine texture');
  return Object.freeze({ measurable: true, product: p, scene: s, delta: Object.freeze(delta), within: Object.freeze(within), skipped: Object.freeze(skipped), matched: Object.values(within).every(Boolean) });
}

/**
 * The BOUNDED correction toward the scene: the exposure follows the white points, the temperature the neutral cast, each `correction_share` of the way and never beyond the relight bounds. Saturation and texture are
 * not corrected automatically (albedo and detail).
 */
export function proposeGrade(match) {
  if (!match.measurable) return Object.freeze({ request: {}, reason: match.reason });
  const share = GRADE.correction_share; const request = {};
  if (match.delta.luminance !== undefined) request.exposure_ev = Math.round(clamp(Math.log2(Math.max(0.05, match.scene.white_point) / Math.max(0.05, match.product.white_point)) * share, -R.exposure_ev, R.exposure_ev) * 1000) / 1000;
  if (match.delta.temperature !== undefined) request.temperature = Math.round(clamp(-match.delta.temperature * share, -R.temperature, R.temperature) * 1000) / 1000;
  return Object.freeze({ request: Object.freeze(request) });
}
