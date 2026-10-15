import { createHash } from 'node:crypto';

import { encodePng } from '../creative-intelligence/png-encode.js';
import { pngDimensions, rasterizeToPixels } from '../creative-intelligence/production-render.js';
import { ANALYSIS_MAX_PX } from './constants.js';

// The REAL product asset of a run. It is decoded WITH its alpha (a pre-cut PNG keeps it) and, if its longest edge is above ANALYSIS_MAX_PX, downscaled ONCE with a recorded provenance: the downscaled file is the
// asset of the run (its hash is the product identity the production planner pins), the owner's original is named in `provenance.original_sha256`. Nothing else is ever done to the pixels here.

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const mediaOf = (bytes) => { if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'; if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'; return null; };

export function dimensionsOf(bytes) {
  const media = mediaOf(bytes);
  if (media === 'image/png') { const d = pngDimensions(bytes); return { width: d.width, height: d.height, media }; }
  if (media === 'image/jpeg') {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1]; const len = (bytes[i + 2] << 8) + bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: (bytes[i + 5] << 8) + bytes[i + 6], width: (bytes[i + 7] << 8) + bytes[i + 8], media };
      i += 2 + len;
    }
  }
  return null;
}

/**
 * @param {object} asset { ref, bytes, media_type?, origin, rights_class, privacy_class, ... } the owner's file
 * @returns {{ asset, rgba, provenance }} asset = the asset of the run (same ref, bytes possibly downscaled), rgba = its pixels with alpha
 */
export function prepareAsset(asset, { maxPx = ANALYSIS_MAX_PX } = {}) {
  const dims = dimensionsOf(asset.bytes);
  if (!dims) return { error: 'ASSET_NOT_A_PNG_OR_JPEG' };
  const longest = Math.max(dims.width, dims.height); const k = longest > maxPx ? maxPx / longest : 1;
  const w = Math.max(1, Math.round(dims.width * k)); const h = Math.max(1, Math.round(dims.height * k));
  const uri = `data:${dims.media};base64,${Buffer.from(asset.bytes).toString('base64')}`;
  const rgba = rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" preserveAspectRatio="none" href="${uri}"/></svg>`);
  const original = sha(asset.bytes);
  if (k === 1) return { asset: { ...asset, media_type: dims.media, width_px: w, height_px: h, sha256: original }, rgba, provenance: { original_sha256: original, derivation: 'NONE', scale: 1, width_px: w, height_px: h } };
  const bytes = encodePng({ width: w, height: h, pixels: rgba.pixels });
  return {
    asset: { ...asset, bytes, media_type: 'image/png', width_px: w, height_px: h, sha256: sha(bytes) },
    rgba, provenance: { original_sha256: original, original_width_px: dims.width, original_height_px: dims.height, derivation: 'DOWNSCALE_TO_ANALYSIS_SIZE', scale: k, width_px: w, height_px: h },
  };
}

/** The photograph path flattens an image onto white only when a source mode of PHOTO is forced on an image that has alpha (the flattening is recorded). */
export function flattenOnWhite(rgba) {
  const out = new Uint8Array(rgba.pixels.length);
  for (let i = 0; i < rgba.width * rgba.height; i += 1) {
    const a = rgba.pixels[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c += 1) out[i * 4 + c] = Math.round(rgba.pixels[i * 4 + c] * a + 255 * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return { width: rgba.width, height: rgba.height, pixels: out };
}

/**
 * Identity annotations when the owner gave none: the OUTLINE is derived from the matte (left and right extent of 40 sample rows), the protected ARTWORK region is the matte's box inset by 8 % (a conservative
 * claim: more is protected than less). No camera module and no lens is invented: such a product is judged by the delivered-identity gate of the run, and the case-specific gate reports NOT_APPLICABLE.
 */
export function deriveAnnotations({ alpha, width, height, bounds }) {
  const rows = 40; const left = []; const right = [];
  for (let r = 0; r < rows; r += 1) {
    const y = Math.round(bounds.y0 + ((r + 0.5) / rows) * (bounds.y1 - bounds.y0));
    let x0 = -1; let x1 = -1;
    for (let x = bounds.x0; x <= bounds.x1; x += 1) if (alpha[y * width + x] >= 128) { if (x0 < 0) x0 = x; x1 = x; }
    if (x0 >= 0) { left.push([x0 / width, y / height]); right.push([x1 / width, y / height]); }
  }
  const inset = 0.08; const bw = bounds.x1 - bounds.x0 + 1; const bh = bounds.y1 - bounds.y0 + 1;
  return {
    outline: [...left, ...right.reverse()],
    artwork_region: { x: (bounds.x0 + inset * bw) / width, y: (bounds.y0 + inset * bh) / height, width: ((1 - 2 * inset) * bw) / width, height: ((1 - 2 * inset) * bh) / height },
    text_regions: [], lenses: [], camera_module: null, derived_from: 'THE_MATTE',
  };
}
