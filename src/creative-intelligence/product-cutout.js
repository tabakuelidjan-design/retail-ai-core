// The real product as a transparent cut-out: the source pixels inside the local mask (product-mask.js), colour untouched, alpha = the mask's coverage. This is the
// asset a COMPOSITE product layer places: the renderer scales it uniformly, the layout engine places it, nothing in it comes from a provider.
// Pure: no I/O, no clock, no randomness, no network.

import { encodePng } from './png-encode.js';

export const CUTOUT_SOURCE = 'deterministic-product-cutout@1';

/**
 * @param {{ rgba: {width, height, pixels}, mask: {alpha: Uint8Array, bounds: {x0, y0, x1, y1}} }} input
 * @returns {{ png_bytes: Uint8Array, width: number, height: number, crop: {x0, y0, x1, y1}, source: string }}
 */
export function makeProductCutout({ rgba, mask, pad = 2 } = {}) {
  const b = mask.bounds;
  const x0 = Math.max(0, b.x0 - pad); const y0 = Math.max(0, b.y0 - pad); const x1 = Math.min(rgba.width, b.x1 + pad); const y1 = Math.min(rgba.height, b.y1 + pad);
  const width = x1 - x0; const height = y1 - y0; const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = (y0 + y) * rgba.width + (x0 + x); const p = si * 4; const q = (y * width + x) * 4;
      pixels[q] = rgba.pixels[p]; pixels[q + 1] = rgba.pixels[p + 1]; pixels[q + 2] = rgba.pixels[p + 2]; pixels[q + 3] = mask.alpha[si];
    }
  }
  return Object.freeze({ png_bytes: encodePng({ width, height, pixels }), width, height, crop: Object.freeze({ x0, y0, x1, y1 }), source: CUTOUT_SOURCE });
}
