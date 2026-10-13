import { createHash } from 'node:crypto';

import { erode, nearestSource } from './pixels.js';

// The product cut-out: the SOURCE pixels inside the matte, alpha = the matte. Inside the opaque core the bytes are the source bytes. The only pixels whose colour is not a source byte are partially transparent
// boundary pixels: their colour is the colour of the nearest opaque core pixel (a standard edge decontamination — it removes the ground colour that bled into the soft edge, so the product does not carry a
// halo onto a new scene). The count of such pixels is reported; nothing is invented (every colour comes from the product itself).

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {object} input { rgba, alpha, bounds: { x0, y0, x1, y1 }, decontaminate?: boolean }
 * @returns {{ width, height, pixels, crop, decontaminated_pixels, source_sha256, alpha_sha256 }}
 */
export function buildCutout({ rgba, alpha, bounds, decontaminate = true }) {
  const { width: W, height: H } = rgba; const pad = 1;
  const x0 = Math.max(0, bounds.x0 - pad); const y0 = Math.max(0, bounds.y0 - pad); const x1 = Math.min(W - 1, bounds.x1 + pad); const y1 = Math.min(H - 1, bounds.y1 + pad);
  const w = x1 - x0 + 1; const h = y1 - y0 + 1; const pixels = new Uint8Array(w * h * 4);
  const a = new Uint8Array(w * h); const rgb = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = (y0 + y) * W + x0 + x; const q = y * w + x;
      a[q] = alpha[si]; rgb[q * 4] = rgba.pixels[si * 4]; rgb[q * 4 + 1] = rgba.pixels[si * 4 + 1]; rgb[q * 4 + 2] = rgba.pixels[si * 4 + 2]; rgb[q * 4 + 3] = 255;
    }
  }
  const hard = new Uint8Array(w * h); const region = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i += 1) { if (a[i] >= 128) hard[i] = 1; if (a[i] > 0) region[i] = 1; }
  const core = erode(hard, w, h, 2); const near = decontaminate ? nearestSource(core, region, w, h, 4) : null; let changed = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === 0) continue;
    let src = i;
    if (decontaminate && a[i] < 250 && near[i] >= 0 && near[i] !== i) { src = near[i]; changed += 1; }
    pixels[i * 4] = rgb[src * 4]; pixels[i * 4 + 1] = rgb[src * 4 + 1]; pixels[i * 4 + 2] = rgb[src * 4 + 2]; pixels[i * 4 + 3] = a[i];
  }
  return Object.freeze({ width: w, height: h, pixels, crop: Object.freeze({ x0, y0, x1, y1 }), decontaminated_pixels: changed, source_sha256: sha256(rgb), alpha_sha256: sha256(a) });
}
