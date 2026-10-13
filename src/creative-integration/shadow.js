import { SHADOW as SH, STATE } from './constants.js';
import { boxBlur, clamp } from './pixels.js';

// THE CONTACT SHADOW is a SEPARATE LAYER: an RGBA image (a dark colour with an alpha) with its own position, derived from the product matte, the contact region and the scene light. It is composited UNDER the
// product and is never painted into the product pixels. It can be recomputed, restyled, or dropped without touching the product. Four kinds:
//   SOFT        a short, soft, low-contrast shadow (overcast / large source)       HARD         a crisp shadow close to the product (small, bright source)
//   DIFFUSE     no direction: a soft pool of darkness under the product            DIRECTIONAL  a long, cast shadow along the light direction
// The shadow is the product silhouette projected onto the support plane: every opaque row at height h above the contact line is shifted along the light direction (shear) and squashed in depth, weighted by
// exp(-h / L) so it is darkest at the contact, then blurred; a tight ambient-occlusion core is added along the contact region. On a vertical plane (a wall) it is a soft offset silhouette instead.

const KIND = {
  SOFT: { blur: 0.035, opacity: 0.4, length: 1.1, direction: 0.6 },
  HARD: { blur: 0.004, opacity: 0.55, length: 1.8, direction: 1 },
  DIFFUSE: { blur: 0.07, opacity: 0.32, length: 0.9, direction: 0 },
  DIRECTIONAL: { blur: 0.015, opacity: 0.48, length: 2.2, direction: 1.3 },
};

/** Why a shadow request is not acceptable (empty = acceptable). */
export function shadowRequestProblems({ kind, light }) {
  const out = [];
  if (!SH.kinds.includes(kind)) out.push('KIND_UNKNOWN');
  if (!light || !Number.isFinite(light.angle_deg)) out.push('LIGHT_ANGLE_MISSING');
  if (!light || !Number.isFinite(light.elevation_deg) || light.elevation_deg < 5 || light.elevation_deg > 89) out.push('LIGHT_ELEVATION_OUT_OF_5_89');
  if (!light || !Number.isFinite(light.softness) || light.softness < 0 || light.softness > 1) out.push('LIGHT_SOFTNESS_OUT_OF_0_1');
  return out;
}

/**
 * @param {object} input { placed (placeCutout result), kind, light: { angle_deg (the direction the light comes FROM: 0 right, 90 above), elevation_deg, softness 0..1 }, support: 'HORIZONTAL_PLANE' | 'VERTICAL_PLANE', color? }
 * @returns {{ state, shadow?: { x, y, width, height, pixels }, geometry }} (state SHADOW_INVALID when the request is not acceptable)
 */
export function buildContactShadow({ placed, kind, light, support = 'HORIZONTAL_PLANE', color = [22, 18, 16] }) {
  const problems = shadowRequestProblems({ kind, light });
  if (problems.length) return Object.freeze({ state: STATE.SHADOW_INVALID, reasons: problems });
  const { rgba, rect, opaque, contact_y: contactY } = placed; const spec = KIND[kind];
  const H = opaque.y1 - opaque.y0 + 1; const a = (light.angle_deg * Math.PI) / 180; const cot = 1 / Math.tan((light.elevation_deg * Math.PI) / 180);
  const blur = Math.max(1, Math.round(H * spec.blur * (0.6 + 0.8 * light.softness)));
  const vertical = support === 'VERTICAL_PLANE';
  const k = cot * spec.direction;
  const kx = vertical ? -Math.cos(a) * 0.05 * H / Math.max(1, rect.width) * 0 : -Math.cos(a) * k;
  const kyRaw = Math.sin(a) * k * 0.3; const ky = (kyRaw >= 0 ? 1 : -1) * Math.max(0.12, Math.abs(kyRaw));
  const reachX = Math.abs(kx) * H; const reachY = Math.abs(ky) * H;
  const pad = blur * 3 + 2;
  let bx0 = Math.floor(rect.x - reachX - pad); let bx1 = Math.ceil(rect.x + rect.width + reachX + pad);
  let by0 = Math.floor((vertical ? rect.y : contactY - reachY * (ky < 0 ? 1 : 0)) - pad); let by1 = Math.ceil((vertical ? rect.y + rect.height : contactY + reachY * (ky > 0 ? 1 : 0)) + pad);
  if (vertical) { const off = Math.max(2, Math.round(H * 0.025)); bx0 -= off; bx1 += off; by1 += off; }
  const w = bx1 - bx0; const h = by1 - by0; const acc = new Float32Array(w * h); const core = new Float32Array(w * h);

  if (!vertical) {
    const band = Math.max(2, Math.round(H * SH.contact_band_share)); const length = spec.length * H; const comp = Math.min(1, Math.abs(ky));
    for (let y = 0; y < rgba.height; y += 1) {
      const sy = rect.y + y; const height = contactY - sy; if (height <= 0 || sy < opaque.y0) continue;
      const fall = Math.exp(-height / length);
      for (let x = 0; x < rgba.width; x += 1) {
        const al = rgba.pixels[(y * rgba.width + x) * 4 + 3]; if (al < 8) continue;
        const tx = Math.round(rect.x + x + height * kx) - bx0; const ty = Math.round(contactY + height * ky) - by0;
        if (tx >= 0 && ty >= 0 && tx < w && ty < h) acc[ty * w + tx] += (al / 255) * fall * comp;
        if (height <= band) { const cx = rect.x + x - bx0; for (let t = 0; t < 2; t += 1) { const cy = contactY - by0 + t; if (cx >= 0 && cy >= 0 && cx < w && cy < h) core[cy * w + cx] = Math.max(core[cy * w + cx], (1 - height / band) * (al / 255)); } }
      }
    }
  } else {
    const off = Math.max(2, Math.round(H * 0.025));
    for (let y = 0; y < rgba.height; y += 1) for (let x = 0; x < rgba.width; x += 1) {
      const al = rgba.pixels[(y * rgba.width + x) * 4 + 3]; if (al < 8) continue;
      const tx = rect.x + x - bx0 + Math.round(-Math.cos(a) * off); const ty = rect.y + y - by0 + Math.round(Math.max(0.3, Math.sin(a)) * off);
      if (tx >= 0 && ty >= 0 && tx < w && ty < h) acc[ty * w + tx] = Math.max(acc[ty * w + tx], al / 255);
    }
  }
  const soft = boxBlur(acc, w, h, blur, 3); const tight = boxBlur(core, w, h, Math.max(1, Math.round(H * 0.006)), 2);
  const pixels = new Uint8Array(w * h * 4); let maxA = 0; let sx = 0; let sw = 0;
  for (let i = 0; i < w * h; i += 1) {
    const al = Math.min(SH.max_opacity, clamp(soft[i] * spec.opacity, 0, 1) + (vertical ? 0 : tight[i] * 0.55));
    pixels[i * 4] = color[0]; pixels[i * 4 + 1] = color[1]; pixels[i * 4 + 2] = color[2]; pixels[i * 4 + 3] = Math.round(al * 255);
    if (al > maxA) maxA = al; sx += (i % w) * al; sw += al;
  }
  const contact = vertical ? null : Object.freeze({ x0: opaque.x0, x1: opaque.x1, y0: contactY - Math.max(2, Math.round(H * SH.contact_band_share)), y1: contactY - 1, contact_y: contactY });
  return Object.freeze({
    state: STATE.READY_FOR_COMPOSITE,
    shadow: Object.freeze({ x: bx0, y: by0, width: w, height: h, pixels }),
    geometry: Object.freeze({ kind, kx, ky, blur_px: blur, max_alpha: maxA, centroid_x: sw ? bx0 + sx / sw : null, contact_region: contact, support }),
  });
}
