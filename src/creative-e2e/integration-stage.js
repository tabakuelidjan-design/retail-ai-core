import { createHash } from 'node:crypto';

import { decodePng } from '../creative-intelligence/png-pixels.js';
import { encodePng } from '../creative-intelligence/png-encode.js';
import {
  STATE as IS, buildContactShadow, checkIdentity, detectArtifacts, validatePlacement,
} from '../creative-integration/index.js';
import { opaqueExtent } from '../creative-integration/compose.js';
import { resizeRgba } from '../creative-integration/pixels.js';
import { rasterizeToPixels } from '../creative-intelligence/production-render.js';
import { DEFAULT_LIGHT } from './constants.js';

// THE INTEGRATION STAGE inside the layered flow. The layered runtime composes the scene (plate, props, the real product in its layout slot, deterministic text) and the product pixels are NEVER touched by relight or
// grade here (its identity gate demands the exact colours: a bounded grade would contradict it, so the grade is not applied in this flow — recorded). What Phase 5 adds on top of the segmentation:
//   - the PLACEMENT rules on the rectangle the layout gave the product (scale, visibility, size plausibility, no rotation, no deformation),
//   - an OPT-IN CONTACT SHADOW as a separate layer under the product (only when the request declares that the product stands on a surface),
//   - the ARTIFACT detection on the delivered scene (halo, cropping, deformation, alpha noise; with a shadow also floating / detached / double shadow, wrong direction),
//   - the DELIVERED IDENTITY of the product: the delivered pixels of the product rectangle against the cut-out placed there (global and worst-tile detail correlation, chromaticity), the other layers excluded.

const DELIVERED = Object.freeze({ mean_abs_diff: 2, big_diff: 24, big_diff_share: 0.002 }); // 0..255; the same renderer draws both, so a resampling difference is a fraction of a level
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The cut-out drawn at a size by the SAME rasterizer that draws the delivered scene (a different resampling filter would differ in fine texture for reasons that have nothing to do with identity). */
export function renderCutoutAt(cutoutPng, width, height, { x = 0, y = 0, canvas = null, fit = 'none' } = {}) {
  if (canvas) { // the cut-out drawn on the canvas in the product layer's box exactly as the renderer draws it (the same fractional geometry, the same fit)
    const u = `data:image/png;base64,${Buffer.from(cutoutPng).toString('base64')}`;
    return rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="${fit}" href="${u}"/></svg>`);
  }
  const uri = `data:image/png;base64,${Buffer.from(cutoutPng).toString('base64')}`;
  return rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" preserveAspectRatio="none" href="${uri}"/></svg>`);
}

/** The `policy.contact_shadow` hook of the layered runtime, or null. `declared`: { kind, light? }. Keeps the last shadow layer so the artifact check can judge it. */
export function createShadowHook(declared) {
  if (!declared) return null;
  const state = { last: null };
  const hook = async ({ productRect, cutout_png: cutoutPng, canvas }) => {
    const cut = decodePng(cutoutPng);
    const scaled = resizeRgba(cut, productRect.width, productRect.height);
    const ext = opaqueExtent(scaled);
    const placed = { rgba: scaled, rect: { x: productRect.x, y: productRect.y, width: productRect.width, height: productRect.height }, opaque: { x0: productRect.x + ext.x0, y0: productRect.y + ext.y0, x1: productRect.x + ext.x1, y1: productRect.y + ext.y1 }, contact_y: productRect.y + ext.y1 + 1 };
    const light = declared.light ?? DEFAULT_LIGHT;
    const built = buildContactShadow({ placed, kind: declared.kind, light, support: declared.support ?? 'HORIZONTAL_PLANE' });
    if (built.state !== IS.READY_FOR_COMPOSITE) { state.invalid = built.reasons; throw Object.assign(new Error('SHADOW_INVALID'), { code: 'SHADOW_INVALID', reasons: built.reasons }); }
    state.last = { layer: built.shadow, geometry: built.geometry, placed, canvas };
    const png = encodePng({ width: built.shadow.width, height: built.shadow.height, pixels: built.shadow.pixels });
    return { png, x: built.shadow.x, y: built.shadow.y, width: built.shadow.width, height: built.shadow.height, evidence: { kind: declared.kind, light, geometry: built.geometry, png_sha256: sha(png) } };
  };
  hook.state = state;
  return hook;
}

/**
 * THE DELIVERED IDENTITY of the product. The cut-out was drawn into the scene by the renderer; the same cut-out drawn by the same renderer at the same geometry is the reference, so what is left is a measurement of what
 * ELSE touched the product pixels: the mean and the tail of the absolute difference over the opaque pixels (a changed button, a redrawn logo, a tinted area appear as a tail), the chromaticity and the hue. The detail-
 * correlation checks of `checkIdentity` are reported as ADVISORY only: on a flat area they amplify a one-level resampling difference into a low correlation.
 */
export function deliveredIdentity({ expected, region }) {
  const n = expected.width * expected.height; const diffs = []; let sum = 0; let big = 0;
  for (let i = 0; i < n; i += 1) {
    if (expected.pixels[i * 4 + 3] !== 255 || region.pixels[i * 4 + 3] !== 255) continue;
    const d = (Math.abs(expected.pixels[i * 4] - region.pixels[i * 4]) + Math.abs(expected.pixels[i * 4 + 1] - region.pixels[i * 4 + 1]) + Math.abs(expected.pixels[i * 4 + 2] - region.pixels[i * 4 + 2])) / 3;
    diffs.push(d); sum += d; if (d > DELIVERED.big_diff) big += 1;
  }
  const check = (code, value, limit, ok) => Object.freeze({ code, ok: Boolean(ok), value, limit });
  if (diffs.length < 64) return Object.freeze({ valid: false, findings: Object.freeze([Object.freeze({ code: 'DELIVERED_PIXELS', ok: false, value: diffs.length, limit: 64, reason: 'too few opaque pixels to judge' })]), advisory: [] });
  const mean = sum / diffs.length; const share = big / diffs.length;
  const base = checkIdentity({ source: expected, result: region });
  const find = (code) => base.findings.find((f) => f.code === code);
  const findings = [
    check('DELIVERED_MEAN_ABS_DIFF', mean, DELIVERED.mean_abs_diff, mean <= DELIVERED.mean_abs_diff),
    check('DELIVERED_BIG_DIFF_SHARE', share, DELIVERED.big_diff_share, share <= DELIVERED.big_diff_share),
    find('ALPHA_UNCHANGED'), find('NO_DUPLICATION'), find('CHROMATICITY_SHIFT'), find('HUE_SHIFT'),
  ].filter(Boolean);
  return Object.freeze({ valid: findings.every((f) => f.ok), findings: Object.freeze(findings), advisory: Object.freeze(['DETAIL_CORRELATION', 'TILE_CORRELATION'].map(find).filter(Boolean)) });
}

/** The placement rules on the rectangle the layout gave the product. Returns { state, reasons, measurements }. */
export function checkProductPlacement({ result, cutoutSize, canvas }) {
  const rect = result.product_rect;
  const scale = rect.width / cutoutSize.width;
  const placed = { rect, opaque: { x0: rect.x, y0: rect.y, x1: rect.x + rect.width - 1, y1: rect.y + rect.height - 1 }, contact_y: rect.y + rect.height };
  return validatePlacement({ scene: { width: canvas.width, height: canvas.height, support: { kind: 'HORIZONTAL_PLANE' } }, placed, placement: { scale, anchor: 'CENTER' }, product: { may_lie_flat: true }, z: 30 });
}

/** The artifact detection and the delivered-identity decision on the delivered PNG of a layered run. */
export function checkDelivered({
  result, plateBytes, cutout, cutoutPng, shadowHook, excludedRects = [], productShadowEffect = true,
}) {
  const delivered = decodePng(result.png_bytes);
  const rect = result.product_rect;
  const layerBox = result.document.layers.find((l) => l.type === 'PRODUCT').geometry;
  const full = renderCutoutAt(cutoutPng, layerBox.width, layerBox.height, { x: layerBox.x, y: layerBox.y, canvas: { width: delivered.width, height: delivered.height }, fit: 'xMidYMid meet' });
  const expected = { width: rect.width, height: rect.height, pixels: new Uint8Array(rect.width * rect.height * 4) };
  for (let y = 0; y < rect.height; y += 1) for (let x = 0; x < rect.width; x += 1) { const cx = rect.x + x; const cy = rect.y + y; if (cx >= 0 && cy >= 0 && cx < full.width && cy < full.height) { const si = (cy * full.width + cx) * 4; const di = (y * rect.width + x) * 4; for (let c = 0; c < 4; c += 1) expected.pixels[di + c] = full.pixels[si + c]; } }
  const region = { width: rect.width, height: rect.height, pixels: new Uint8Array(rect.width * rect.height * 4) };
  // the delivered pixels of the product rectangle; the alpha is the cut-out's (identical by construction); the area under text or a foreground prop is not judged
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const cx = rect.x + x; const cy = rect.y + y; const si = (y * rect.width + x) * 4;
      const under = excludedRects.some((r) => cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height);
      const inCanvas = cx >= 0 && cy >= 0 && cx < delivered.width && cy < delivered.height;
      const di = (cy * delivered.width + cx) * 4;
      region.pixels[si] = inCanvas ? delivered.pixels[di] : 0; region.pixels[si + 1] = inCanvas ? delivered.pixels[di + 1] : 0; region.pixels[si + 2] = inCanvas ? delivered.pixels[di + 2] : 0;
      region.pixels[si + 3] = under || !inCanvas ? 0 : expected.pixels[si + 3];
      if (under) expected.pixels[si + 3] = 0;
    }
  }
  const expected0 = { width: expected.width, height: expected.height, pixels: Uint8Array.from(expected.pixels) }; // before the excluded areas are blanked
  const identity = deliveredIdentity({ expected, region });
  const shadow = shadowHook?.state?.last ?? null;
  let artifacts = null;
  if (plateBytes) {
    const plate = decodePng(plateBytes);
    const ext = opaqueExtent(expected0);
    const placed = { rgba: expected0, rect, opaque: { x0: rect.x + ext.x0, y0: rect.y + ext.y0, x1: rect.x + ext.x1, y1: rect.y + ext.y1 }, contact_y: rect.y + ext.y1 + 1 };
    artifacts = detectArtifacts({
      plate, composite: delivered, placed, shadow: shadow?.layer ?? null, geometry: shadow?.geometry ?? null, placement: shadow ? { anchor: 'BOTTOM_CENTER' } : { anchor: 'CENTER' }, cutoutSize: { width: cutout.width, height: cutout.height }, ignoreDarkening: productShadowEffect,
    });
  }
  return { identity, artifacts, delivered_sha256: sha(result.png_bytes) };
}
