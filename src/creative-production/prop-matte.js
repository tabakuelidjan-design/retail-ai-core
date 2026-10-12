import { encodePng } from '../creative-intelligence/png-encode.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { MATTE_POLICY } from './constants.js';
import { alphaBounds } from './raster-ops.js';

// THE PLAIN-GROUND MATTE (tool `cutout/plain-ground-matte`, LOCAL). A generated prop is untrusted output: one object photographed alone on a plain ground. This module either cuts that object out, deterministically,
// or REFUSES it with the measurement that failed. Nothing is relaxed to pass:
//   the ground      the ring of pixels along the frame is one plain colour (a scene, a gradient or a second object in the ring is not a plain ground)
//   the object      the pixels that differ from the ground form ONE connected object (stray specks up to a declared share are dropped, more is a second object), that does not touch the frame, of a plausible size
// The result is the object trimmed to its bounds, with an alpha taken from the distance to the ground colour.

const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * @param {object} input { png: Uint8Array, policy? }
 * @returns {{ ok, reasons: string[], cutout_png: Uint8Array|null, width, height, measured }}
 */
export function matteProp({ png, policy = MATTE_POLICY }) {
  let image;
  try { image = decodePng(png); } catch { return { ok: false, reasons: ['THE_PROP_IS_NOT_A_DECODABLE_PNG'], cutout_png: null, width: 0, height: 0, measured: {} }; }
  const { width, height, pixels } = image;
  const reasons = [];
  const at = (x, y) => { const p = (y * width + x) * 4; return [pixels[p], pixels[p + 1], pixels[p + 2]]; };
  const ring = Math.max(2, Math.round(Math.min(width, height) * policy.ring_of_min_side));
  const ringPixels = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (x < ring || y < ring || x >= width - ring || y >= height - ring) ringPixels.push(at(x, y));
  const mean = [0, 1, 2].map((c) => ringPixels.reduce((n, p) => n + p[c], 0) / ringPixels.length);
  const plainShare = ringPixels.filter((p) => dist(p, mean) <= policy.ring_tolerance).length / ringPixels.length;
  const measured = { ground: mean.map(Math.round), ring_plain_share: plainShare };
  if (plainShare < policy.ring_min_share) reasons.push('THE_GROUND_IS_NOT_PLAIN');
  // alpha from the distance to the ground
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const d = Math.max(Math.abs(pixels[i * 4] - mean[0]), Math.abs(pixels[i * 4 + 1] - mean[1]), Math.abs(pixels[i * 4 + 2] - mean[2]));
    alpha[i] = d <= policy.ground_low ? 0 : (d >= policy.ground_high ? 255 : Math.round(((d - policy.ground_low) / (policy.ground_high - policy.ground_low)) * 255));
  }
  // connected components of the visible pixels (4-neighbourhood, iterative)
  const label = new Int32Array(width * height); const sizes = [0];
  const stack = [];
  for (let start = 0; start < width * height; start += 1) {
    if (alpha[start] === 0 || label[start] !== 0) continue;
    const id = sizes.length; sizes.push(0); stack.push(start); label[start] = id;
    while (stack.length) {
      const i = stack.pop(); sizes[id] += 1;
      const x = i % width; const y = (i - x) / width;
      if (x > 0 && alpha[i - 1] && !label[i - 1]) { label[i - 1] = id; stack.push(i - 1); }
      if (x < width - 1 && alpha[i + 1] && !label[i + 1]) { label[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && alpha[i - width] && !label[i - width]) { label[i - width] = id; stack.push(i - width); }
      if (y < height - 1 && alpha[i + width] && !label[i + width]) { label[i + width] = id; stack.push(i + width); }
    }
  }
  const total = sizes.reduce((n, s) => n + s, 0);
  const main = sizes.reduce((best, s, id) => (id > 0 && s > (sizes[best] ?? 0) ? id : best), 0);
  const kept = main ? sizes[main] : 0;
  const stray = total ? (total - kept) / total : 0;
  const areaShare = kept / (width * height);
  Object.assign(measured, { objects: sizes.length - 1, stray_share: stray, area_share: areaShare });
  if (!main) reasons.push('NO_OBJECT_ON_THE_GROUND');
  else {
    if (stray > policy.max_stray_share) reasons.push('MORE_THAN_ONE_OBJECT');
    if (areaShare < policy.min_area_share) reasons.push('THE_OBJECT_IS_TOO_SMALL');
    if (areaShare > policy.max_area_share) reasons.push('THE_OBJECT_IS_TOO_LARGE');
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    if (label[i] !== main || !main) continue;
    out[i * 4] = pixels[i * 4]; out[i * 4 + 1] = pixels[i * 4 + 1]; out[i * 4 + 2] = pixels[i * 4 + 2]; out[i * 4 + 3] = alpha[i];
  }
  const bounds = main ? alphaBounds({ width, height, pixels: out }) : null;
  if (bounds && (bounds.x0 === 0 || bounds.y0 === 0 || bounds.x1 === width || bounds.y1 === height)) reasons.push('THE_OBJECT_TOUCHES_THE_FRAME');
  if (reasons.length || !bounds) return { ok: false, reasons, cutout_png: null, width: 0, height: 0, measured };
  const w = bounds.x1 - bounds.x0; const h = bounds.y1 - bounds.y0; const trimmed = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const s = ((bounds.y0 + y) * width + bounds.x0 + x) * 4; const d = (y * w + x) * 4;
    trimmed[d] = out[s]; trimmed[d + 1] = out[s + 1]; trimmed[d + 2] = out[s + 2]; trimmed[d + 3] = out[s + 3];
  }
  return { ok: true, reasons: [], cutout_png: encodePng({ width: w, height: h, pixels: trimmed }), width: w, height: h, measured: { ...measured, bounds } };
}
