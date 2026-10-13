import { IDENTITY as I } from './constants.js';
import {
  boxBlur, erode, labelComponents, lumaPlane, pearsonPlane,
} from './pixels.js';

// PRODUCT IDENTITY. The real product pixels are authoritative. After lighting and grading, the integrated product layer must still BE the product: same silhouette (alpha byte for byte), same number of
// objects (no duplication), the same detail (logo, text, button, port, print — judged on the illumination-free detail field, so a smooth change of light does not count but a moved or redrawn feature does),
// and a colour drift inside the controlled grading. This is a DECISION function: it returns the verdict and the evidence, and a failure is PRODUCT_IDENTITY_RISK.

const check = (code, value, limit, ok) => Object.freeze({ code, ok: Boolean(ok), value, limit });
const unmeasurable = (code, reason) => Object.freeze({ code, ok: false, value: null, limit: null, reason });

function sameAlpha(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 3; i < a.pixels.length; i += 4) if (a.pixels[i] !== b.pixels[i]) return false;
  return true;
}

/** The detail field: luma divided by its own blur, so smooth illumination cancels and features remain. */
function detailField(img, radius) {
  const luma = lumaPlane(img); const blur = boxBlur(luma, img.width, img.height, radius, 2); const out = new Float32Array(luma.length);
  for (let i = 0; i < out.length; i += 1) out[i] = luma[i] / (blur[i] + 8);
  return out;
}

function hueDeg(r, g, b) {
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
  if (d < 1e-6 || d / mx < 0.12) return null; // a (nearly) neutral colour has no meaningful hue
  let h; if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

/**
 * @param {object} input { source: cut-out RGBA, result: integrated product layer RGBA (same size), strict?: boolean (no light or grade was requested: the interior must be byte-identical) }
 */
export function checkIdentity({ source, result, strict = false } = {}) {
  const findings = [];
  if (!source || !result || source.width !== result.width || source.height !== result.height) return Object.freeze({ valid: false, findings: [unmeasurable('SIZE', 'source and result differ in size')], measurements: {} });
  const { width, height } = source; const n = width * height;
  findings.push(check('ALPHA_UNCHANGED', sameAlpha(source, result) ? 1 : 0, 1, I.alpha_exact ? sameAlpha(source, result) : true));
  const hard = (img) => { const m = new Uint8Array(n); for (let i = 0; i < n; i += 1) m[i] = img.pixels[i * 4 + 3] >= 128 ? 1 : 0; return m; };
  const comps = (img) => labelComponents(hard(img), width, height).list.length;
  const cs = comps(source); const cr = comps(result);
  findings.push(check('NO_DUPLICATION', cr, cs, cr === cs));

  const interior = erode(hard(source), width, height, 2); const idx = [];
  for (let i = 0; i < n; i += 1) if (interior[i] && source.pixels[i * 4 + 3] >= 250) idx.push(i);
  if (idx.length < 64) return Object.freeze({ valid: false, findings: Object.freeze([...findings, unmeasurable('INTERIOR', 'too few interior pixels to judge the detail')]), measurements: { interior_pixels: idx.length } });

  if (strict) {
    let changed = 0;
    for (const i of idx) if (source.pixels[i * 4] !== result.pixels[i * 4] || source.pixels[i * 4 + 1] !== result.pixels[i * 4 + 1] || source.pixels[i * 4 + 2] !== result.pixels[i * 4 + 2]) changed += 1;
    findings.push(check('INTERIOR_BYTES_IDENTICAL', changed, 0, changed === 0));
  }

  const ds = detailField(source, I.detail_blur_radius); const dr = detailField(result, I.detail_blur_radius);
  const corr = pearsonPlane(ds, dr, idx);
  findings.push(corr === null ? unmeasurable('DETAIL_CORRELATION', 'no variance') : check('DETAIL_CORRELATION', corr, I.detail_correlation_min, corr >= I.detail_correlation_min));

  // the worst tile with real detail: a feature moved or redrawn in one place must not hide in a good global number
  const g = I.tile_grid; let worst = 1; let tiles = 0;
  const luma = lumaPlane(source);
  for (let ty = 0; ty < g; ty += 1) {
    for (let tx = 0; tx < g; tx += 1) {
      const xs0 = Math.floor((tx * width) / g); const xs1 = Math.floor(((tx + 1) * width) / g); const ys0 = Math.floor((ty * height) / g); const ys1 = Math.floor(((ty + 1) * height) / g);
      const tile = [];
      for (let y = ys0; y < ys1; y += 1) for (let x = xs0; x < xs1; x += 1) { const i = y * width + x; if (interior[i] && source.pixels[i * 4 + 3] >= 250) tile.push(i); }
      if (tile.length < 24) continue;
      let m = 0; for (const i of tile) m += luma[i] / 255; m /= tile.length; let v = 0; for (const i of tile) v += (luma[i] / 255 - m) ** 2; v /= tile.length;
      if (v < I.min_tile_variance) continue;
      const c = pearsonPlane(ds, dr, tile); tiles += 1; if (c !== null && c < worst) worst = c;
    }
  }
  findings.push(check('TILE_CORRELATION', worst, I.tile_correlation_min, worst >= I.tile_correlation_min));

  let sr = 0; let sg = 0; let sb = 0; let rr = 0; let rg = 0; let rb = 0;
  for (const i of idx) { const p = i * 4; sr += source.pixels[p]; sg += source.pixels[p + 1]; sb += source.pixels[p + 2]; rr += result.pixels[p]; rg += result.pixels[p + 1]; rb += result.pixels[p + 2]; }
  const chroma = (r, g, b) => { const t = Math.max(1, r + g + b); return [r / t, g / t, b / t]; };
  const cs0 = chroma(sr, sg, sb); const cr0 = chroma(rr, rg, rb);
  const drift = Math.abs(cs0[0] - cr0[0]) + Math.abs(cs0[1] - cr0[1]) + Math.abs(cs0[2] - cr0[2]);
  findings.push(check('CHROMATICITY_SHIFT', drift, I.chromaticity_shift_max, drift <= I.chromaticity_shift_max));
  const hs = hueDeg(sr, sg, sb); const hr = hueDeg(rr, rg, rb);
  const hue = hs === null || hr === null ? 0 : Math.min(Math.abs(hs - hr), 360 - Math.abs(hs - hr));
  findings.push(check('HUE_SHIFT', hue, I.hue_shift_max_deg, hue <= I.hue_shift_max_deg));

  return Object.freeze({ valid: findings.every((f) => f.ok), findings: Object.freeze(findings), measurements: Object.freeze({ interior_pixels: idx.length, detail_tiles: tiles, components: cs }) });
}
