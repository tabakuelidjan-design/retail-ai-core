import { decodePng } from '../creative-intelligence/png-pixels.js';
import { createResvgRasterizer, rasterizeToPixels } from '../creative-intelligence/production-render.js';
import { deepFreeze } from '../creative-brain/validation.js';
import {
  LAYER_KIND, LAYER_Z, OVERLAP_LIMIT, OVERLAP_POLICY,
} from './constants.js';

// THE LAYER COMPOSITOR: a deterministic, pixel-exact composition of the RASTER layers of a scene (the plate, the props, the real product, a bounded foreground), in the explicit z-order of the scene specification.
// Pure and offline: the same layers give the same bytes. It draws every layer at its native size (nothing is scaled, cropped, rotated or relit) and it MEASURES what it composed:
//   - a foreground layer may cover the product only within its overlap policy, and never a protected region of the product;
//   - the opaque pixels of the real product that nothing covers are identical in the result to the source pixels.
// A composition that breaks a rule is REFUSED with the measurement; it is never adjusted to pass. Text is not drawn here: it is drawn last by the deterministic typography from the planned pieces.

const B64 = (bytes) => Buffer.from(bytes).toString('base64');
const inside = (x, y, r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/**
 * @param {object} input { canvas: { width, height }, layers: [{ layer_id, kind, z, png, x, y, overlap? }], protectedRegions: [{ x, y, width, height }] (in canvas pixels), rasterize? (the rasterizer; tests inject a faulty one) }
 * @returns {{ status: 'COMPOSED'|'REFUSED', png, report }}
 */
export function composeLayers({
  canvas, layers, protectedRegions = [], rasterize = rasterizeToPixels,
}) {
  const problems = [];
  const sorted = [...layers].sort((a, b) => a.z - b.z);
  const products = sorted.filter((l) => l.kind === LAYER_KIND.PRODUCT);
  if (products.length !== 1) problems.push('EXACTLY_ONE_PRODUCT_LAYER');
  sorted.forEach((l, i) => {
    if (l.kind === LAYER_KIND.TEXT) problems.push('TEXT_IS_NOT_DRAWN_HERE');
    if (Math.floor(l.z / 10) * 10 !== LAYER_Z[l.kind]) problems.push(`Z_NOT_IN_THE_BAND:${l.layer_id}`);
    if (i > 0 && l.z === sorted[i - 1].z) problems.push(`Z_NOT_UNIQUE:${l.layer_id}`);
  });
  const decoded = sorted.map((l) => ({ layer: l, image: decodePng(l.png) }));
  const product = decoded.find((d) => d.layer.kind === LAYER_KIND.PRODUCT);
  const alphaAt = (d, x, y) => {
    const lx = x - d.layer.x; const ly = y - d.layer.y;
    if (lx < 0 || ly < 0 || lx >= d.image.width || ly >= d.image.height) return 0;
    return d.image.pixels[(ly * d.image.width + lx) * 4 + 3];
  };
  const report = { layer_order: sorted.map((l) => l.layer_id), foreground: [], product_pixels_checked: 0, product_pixels_changed: 0, problems };
  if (product) {
    const productArea = product.image.pixels.reduce((n, v, i) => (i % 4 === 3 && v > 0 ? n + 1 : n), 0);
    for (const d of decoded.filter((x) => x.layer.kind === LAYER_KIND.PROP_FOREGROUND)) {
      let covered = 0; let onProtected = 0;
      for (let y = 0; y < product.image.height; y += 1) {
        for (let x = 0; x < product.image.width; x += 1) {
          const cx = product.layer.x + x; const cy = product.layer.y + y;
          if (product.image.pixels[(y * product.image.width + x) * 4 + 3] > 0 && alphaAt(d, cx, cy) > 0) { covered += 1; if (protectedRegions.some((r) => inside(cx, cy, r))) onProtected += 1; }
        }
      }
      const share = productArea ? covered / productArea : 0;
      const policy = d.layer.overlap?.policy ?? OVERLAP_POLICY.NONE;
      const limit = OVERLAP_LIMIT[policy] ?? 0;
      report.foreground.push({ layer_id: d.layer.layer_id, covered_pixels: covered, share_of_product: share, policy, limit, covered_protected_pixels: onProtected });
      if (share > limit) problems.push(`OVERLAP_EXCEEDS_ITS_POLICY:${d.layer.layer_id}`);
      if (onProtected > 0) problems.push(`COVERS_A_PROTECTED_REGION:${d.layer.layer_id}`);
    }
  }
  const images = decoded.map((d) => `<image x="${d.layer.x}" y="${d.layer.y}" width="${d.image.width}" height="${d.image.height}" href="data:image/png;base64,${B64(d.layer.png)}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${images}</svg>`;
  const pixels = rasterize(svg);
  if (product) {
    for (let y = 0; y < product.image.height; y += 1) {
      for (let x = 0; x < product.image.width; x += 1) {
        const cx = product.layer.x + x; const cy = product.layer.y + y;
        if (cx < 0 || cy < 0 || cx >= canvas.width || cy >= canvas.height) continue;
        const sp = (y * product.image.width + x) * 4;
        if (product.image.pixels[sp + 3] !== 255) continue;
        const covered = decoded.some((d) => LAYER_Z[d.layer.kind] > LAYER_Z[LAYER_KIND.PRODUCT] && alphaAt(d, cx, cy) > 0);
        if (covered) continue;
        report.product_pixels_checked += 1;
        const dp = (cy * canvas.width + cx) * 4;
        if (pixels.pixels[dp] !== product.image.pixels[sp] || pixels.pixels[dp + 1] !== product.image.pixels[sp + 1] || pixels.pixels[dp + 2] !== product.image.pixels[sp + 2]) report.product_pixels_changed += 1;
      }
    }
    if (report.product_pixels_changed > 0) problems.push('THE_PRODUCT_PIXELS_CHANGED');
  }
  const png = problems.length ? null : createResvgRasterizer()(svg, { width: canvas.width, height: canvas.height });
  return Object.freeze({ status: problems.length ? 'REFUSED' : 'COMPOSED', png, report: deepFreeze(report) });
}
