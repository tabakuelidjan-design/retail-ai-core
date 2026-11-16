
// The two raster operations the layered runtime needs, both deterministic and offline: resample a PNG to a target size (resvg, the renderer the whole pipeline uses) and read the opaque bounds of a PNG.

/** @returns {{ png: Uint8Array, width, height }} the PNG resampled to exactly width x height (the transparent pixels stay transparent). */
export { resizePng } from '../creative-intelligence/png-resize.js';

/** The bounds {x0, y0, x1, y1} (x1, y1 exclusive) of the pixels with alpha > 0, or null when nothing is visible. */
export function alphaBounds({ width, height, pixels }) {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}
