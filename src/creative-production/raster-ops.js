import { encodePng } from '../creative-intelligence/png-encode.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { rasterizeToPixels } from '../creative-intelligence/production-render.js';

// The two raster operations the layered runtime needs, both deterministic and offline: resample a PNG to a target size (resvg, the renderer the whole pipeline uses) and read the opaque bounds of a PNG.

/** @returns {{ png: Uint8Array, width, height }} the PNG resampled to exactly width x height (the transparent pixels stay transparent). */
export function resizePng({ png, width, height }) {
  const w = Math.max(1, Math.round(width)); const h = Math.max(1, Math.round(height));
  const source = decodePng(png);
  if (source.width === w && source.height === h) return { png, width: w, height: h };
  const uri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  const out = rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" preserveAspectRatio="none" href="${uri}"/></svg>`);
  return { png: encodePng({ width: w, height: h, pixels: out.pixels }), width: w, height: h };
}

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
