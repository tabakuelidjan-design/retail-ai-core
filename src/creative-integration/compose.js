import { createHash } from 'node:crypto';

import { encodePng } from '../creative-intelligence/png-encode.js';
import { clamp, resizeRgba } from './pixels.js';

// Geometry and compositing of the integrated scene. Pure pixel arithmetic: the product is scaled UNIFORMLY (bilinear on premultiplied alpha), never rotated, never warped; the shadow layer goes UNDER it; the
// product goes over the plate with its own alpha. The product layer and the shadow layer stay separate values until the very last step.

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The row index (inclusive) of the lowest pixel of a cut-out that is at least half opaque, and the column span of that row band. */
export function opaqueExtent(img) {
  let x0 = img.width; let y0 = img.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < img.height; y += 1) for (let x = 0; x < img.width; x += 1) if (img.pixels[(y * img.width + x) * 4 + 3] >= 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Place a cut-out. placement: { x, y, scale, anchor: 'BOTTOM_CENTER' (x = centre column, y = the contact line) | 'CENTER' (x, y = the centre of the opaque area) }.
 * @returns {{ rgba, rect: {x,y,width,height}, opaque: {x0,y0,x1,y1} (scene px), contact_y }}
 */
export function placeCutout(cutout, placement) {
  const ext = opaqueExtent(cutout); const s = placement.scale;
  const w = Math.max(1, Math.round(cutout.width * (placement.scale_x ?? s))); const h = Math.max(1, Math.round(cutout.height * (placement.scale_y ?? s)));
  const rgba = resizeRgba(cutout, w, h);
  const sx = w / cutout.width; const sy = h / cutout.height;
  const opaqueW = (ext.x1 - ext.x0 + 1) * sx; const opaqueH = (ext.y1 - ext.y0 + 1) * sy;
  let ox; let oy;
  if ((placement.anchor ?? 'BOTTOM_CENTER') === 'BOTTOM_CENTER') { ox = placement.x - opaqueW / 2 - ext.x0 * sx; oy = placement.y - (ext.y1 + 1) * sy; } else { ox = placement.x - opaqueW / 2 - ext.x0 * sx; oy = placement.y - opaqueH / 2 - ext.y0 * sy; }
  const rect = { x: Math.round(ox), y: Math.round(oy), width: w, height: h };
  const opaque = { x0: rect.x + Math.round(ext.x0 * sx), y0: rect.y + Math.round(ext.y0 * sy), x1: rect.x + Math.round((ext.x1 + 1) * sx) - 1, y1: rect.y + Math.round((ext.y1 + 1) * sy) - 1 };
  return Object.freeze({ rgba, rect: Object.freeze(rect), opaque: Object.freeze(opaque), contact_y: opaque.y1 + 1 });
}

/** The shadow layer is { x, y, width, height, pixels RGBA } in scene px (colour + alpha). Product: placed = result of placeCutout. Returns a NEW scene RGBA. */
export function compositeScene({ plate, shadows = [], placed = [] }) {
  const out = { width: plate.width, height: plate.height, pixels: Uint8Array.from(plate.pixels) };
  const over = (img, ox, oy) => {
    for (let y = 0; y < img.height; y += 1) {
      const sy = oy + y; if (sy < 0 || sy >= out.height) continue;
      for (let x = 0; x < img.width; x += 1) {
        const sx = ox + x; if (sx < 0 || sx >= out.width) continue;
        const p = (y * img.width + x) * 4; const a = img.pixels[p + 3] / 255; if (a === 0) continue;
        const q = (sy * out.width + sx) * 4;
        for (let c = 0; c < 3; c += 1) out.pixels[q + c] = clamp(Math.round(out.pixels[q + c] * (1 - a) + img.pixels[p + c] * a), 0, 255);
      }
    }
  };
  for (const sh of shadows) over(sh, sh.x, sh.y);
  for (const p of placed) over(p.rgba, p.rect.x, p.rect.y);
  return out;
}

export const pngOf = (img) => encodePng({ width: img.width, height: img.height, pixels: img.pixels });
export const sha256Of = (img) => sha(img.pixels);

/**
 * Express the integrated layers for the Phase 3 deterministic compositor (composeLayers): the shadow is a midground-band layer (z 25, under the product), the product is the PRODUCT layer (z 30). The product layer
 * is the placed, graded cut-out; the compositor then measures that its opaque pixels reach the result unchanged.
 */
export function toCompositorLayers({ placed, shadow, plate }) {
  const layers = [{ layer_id: 'plate', kind: 'PLATE', z: 0, png: pngOf(plate), x: 0, y: 0 }];
  if (shadow) layers.push({ layer_id: 'contact_shadow', kind: 'PROP_MIDGROUND', z: 25, png: pngOf(shadow), x: shadow.x, y: shadow.y });
  layers.push({ layer_id: 'product', kind: 'PRODUCT', z: 30, png: pngOf(placed.rgba), x: placed.rect.x, y: placed.rect.y });
  return layers;
}
