import { NATIVE_ALPHA as N, SEG_REASON } from './constants.js';
import {
  alphaExtremaShare, boundsOfPlane, dilate, isRgba, labelComponents,
} from './pixels.js';

// THE NATIVE-ALPHA PATH. A product delivered as a PRE-CUT image (a PNG whose alpha already is the matte: a catalogue cut-out, a supplier render) must not be flattened and segmented again by colour (that throws the
// good matte away and applies photograph checks to something that is not a photograph). Its alpha is VALIDATED and then kept:
//   - the border of the image is transparent, and the alpha is meaningful (neither all opaque nor almost empty);
//   - the product is opaque: pixels at or above `opaque_floor` are the product and are snapped to 255 (a supplier alpha of 253 is opaque; the number of snapped pixels is reported), the rest of the alpha is soft edge;
//   - there is no baked glow or halo: the partially transparent mass must hug the opaque core (a soft pink glow around a tumbler is NOT a soft edge);
//   - one object (several are an ambiguous selection), no enclosed transparent pinholes, no stray alpha dust, not cut by the image border, an alpha ramp that is not noisy.
// A malformed or ambiguous alpha FAILS CLOSED with the reason. Nothing is repainted: the colours are the source's; only the colour of partially transparent edge pixels is decontaminated later by the cut-out, as for a photograph.

const check = (code, value, limit, ok, where) => Object.freeze({ code, ok: Boolean(ok), value, limit, ...(where ? { where } : {}) });

/** Does this image carry an alpha that is worth validating (some pixels are transparent, some opaque)? Pure measurement, no decision on quality. */
export function hasMeaningfulAlpha(rgba) {
  if (!isRgba(rgba)) return false;
  let transparent = 0; let opaque = 0; const n = rgba.width * rgba.height;
  for (let i = 3; i < rgba.pixels.length; i += 4) { const a = rgba.pixels[i]; if (a <= N.transparent_max) transparent += 1; else if (a >= N.opaque_floor) opaque += 1; }
  return transparent / n >= N.min_transparent_share && opaque / n >= N.min_opaque_share;
}

/**
 * @param {{width,height,pixels}} rgba the source WITH its alpha channel (never flattened)
 * @param {object} selection { mode: 'AUTO' | 'GROUP' } (several objects need GROUP)
 * @returns the segmentation value of the general contract, plus `native` (the evidence)
 */
export function segmentNativeAlpha(rgba, selection = { mode: 'AUTO' }) {
  const fail = (reason, findings = [], extra = {}) => Object.freeze({
    status: 'FAILED', accepted: false, failure_reason: reason, confidence: 0, alpha: null, bounds: null, components: [], edge_quality: null, source: Object.freeze({ kind: 'NATIVE_ALPHA', id: 'NATIVE_ALPHA:validated@1' }), native: Object.freeze({ findings: Object.freeze(findings) }), ...extra,
  });
  if (!isRgba(rgba)) return fail(SEG_REASON.INVALID_INPUT);
  const { width, height, pixels } = rgba; const n = width * height;
  const findings = [];
  // 1. the border is transparent
  const b = Math.min(N.border_px, Math.floor(Math.min(width, height) / 4)) || 1; let ring = 0; let ringClear = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (x < b || y < b || x >= width - b || y >= height - b) { ring += 1; if (pixels[(y * width + x) * 4 + 3] <= N.transparent_max) ringClear += 1; }
  findings.push(check('ALPHA_BORDER_TRANSPARENT', ringClear / ring, N.border_clear_share, ringClear / ring >= N.border_clear_share));
  // 2. meaningful
  if (!hasMeaningfulAlpha(rgba)) { findings.push(check('ALPHA_MEANINGFUL', 0, 1, false)); return fail(SEG_REASON.ALPHA_NOT_MEANINGFUL, findings); }
  // 3. snap the opaque floor, measure the soft part
  const alpha = new Uint8Array(n); let snapped = 0; let soft = 0; let present = 0;
  for (let i = 0; i < n; i += 1) {
    const a = pixels[i * 4 + 3];
    if (a <= N.transparent_max) continue;
    present += 1;
    if (a >= N.opaque_floor) { alpha[i] = 255; if (a < 255) snapped += 1; } else { alpha[i] = a; soft += 1; }
  }
  findings.push(check('ALPHA_OPAQUE_CORE', 1 - soft / present, 1 - N.max_soft_share, soft / present <= N.max_soft_share));
  // 4. no baked glow: the soft pixels must lie within halo_px of the opaque core
  const core = new Uint8Array(n); for (let i = 0; i < n; i += 1) core[i] = alpha[i] === 255 ? 1 : 0;
  const near = dilate(core, width, height, N.halo_px); let farSoft = 0;
  for (let i = 0; i < n; i += 1) if (alpha[i] > 0 && alpha[i] < 255 && !near[i]) farSoft += 1;
  findings.push(check('ALPHA_BAKED_HALO', farSoft / present, N.max_far_soft_share, farSoft / present <= N.max_far_soft_share));
  // 5. objects: one (several need an explicit group), none cut by the border
  const hard = new Uint8Array(n); for (let i = 0; i < n; i += 1) hard[i] = alpha[i] >= 128 ? 1 : 0;
  const { list, labels } = labelComponents(hard, width, height);
  const minArea = Math.max(4, N.min_object_share * n);
  const objects = list.filter((c) => c.area >= minArea); const dust = list.length - objects.length;
  if (!objects.length) { findings.push(check('ALPHA_OBJECTS', 0, 1, false)); return fail(SEG_REASON.NO_FOREGROUND, findings); }
  const largest = Math.max(...objects.map((c) => c.area)); const significant = objects.filter((c) => c.area >= 0.12 * largest);
  const group = selection?.mode === 'GROUP';
  findings.push(check('ALPHA_ONE_OBJECT', significant.length, 1, significant.length === 1 || group));
  const chosen = group ? significant : [significant.sort((a, c) => c.area - a.area)[0]];
  const keep = new Set(chosen.map((c) => c.id));
  const touches = chosen.some((c) => c.x0 === 0 || c.y0 === 0 || c.x1 === width - 1 || c.y1 === height - 1);
  findings.push(check('ALPHA_NOT_CUT_BY_THE_BORDER', touches ? 1 : 0, 0, !touches));
  // 6. dust: opaque-ish alpha outside the chosen objects
  let stray = 0; for (let i = 0; i < n; i += 1) if (alpha[i] > N.transparent_max && !(labels[i] && keep.has(labels[i])) && !near[i]) stray += 1;
  for (let i = 0; i < n; i += 1) if (!(labels[i] && keep.has(labels[i])) && alpha[i] > 0 && !near[i]) alpha[i] = 0;
  findings.push(check('ALPHA_STRAY', stray, N.max_stray_pixels, stray <= N.max_stray_pixels));
  // pixels of the other (non-chosen) objects are removed from the matte
  for (let i = 0; i < n; i += 1) if (labels[i] && !keep.has(labels[i])) alpha[i] = 0;
  // 7. enclosed transparent pinholes inside the chosen objects
  const outside = new Uint8Array(n); const st = [];
  const seed = (i) => { if (alpha[i] < 128 && !outside[i]) { outside[i] = 1; st.push(i); } };
  for (let x = 0; x < width; x += 1) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { seed(y * width); seed(y * width + width - 1); }
  while (st.length) { const i = st.pop(); const x = i % width; if (x > 0) seed(i - 1); if (x < width - 1) seed(i + 1); if (i >= width) seed(i - width); if (i < n - width) seed(i + width); }
  const gap = new Uint8Array(n); for (let i = 0; i < n; i += 1) if (alpha[i] < 128 && !outside[i]) gap[i] = 1;
  const holes = labelComponents(gap, width, height).list; const pinholes = holes.filter((h) => h.area <= N.pinhole_px).length;
  findings.push(check('ALPHA_PINHOLES', pinholes, 0, pinholes === 0));
  // 8. the alpha ramp is not noisy
  const noise = alphaExtremaShare(alpha, width, height);
  findings.push(check('ALPHA_NOISE', noise, N.max_noise, noise <= N.max_noise));
  // 9. a soft edge is MONOTONIC: among three consecutive partially transparent pixels on a row or a column the middle one lies between its neighbours (a random ramp zigzags)
  let runs = 0; let zig = 0; const slack = N.zigzag_slack;
  const partial = (v) => v > 8 && v < 247;
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const b0 = alpha[y * width + x]; if (!partial(b0)) continue;
    for (const [dx, dy] of [[1, 0], [0, 1]]) { const p0 = alpha[(y - dy) * width + x - dx]; const p1 = alpha[(y + dy) * width + x + dx]; if (!partial(p0) || !partial(p1)) continue; runs += 1; if (b0 < Math.min(p0, p1) - slack || b0 > Math.max(p0, p1) + slack) zig += 1; }
  }
  const zigzag = runs >= N.min_runs ? zig / runs : 0;
  findings.push(check('ALPHA_EDGE_ZIGZAG', zigzag, N.max_zigzag, zigzag <= N.max_zigzag));

  if (!findings.every((f) => f.ok)) return fail(SEG_REASON.ALPHA_INVALID, findings, { holes: holes.filter((h) => h.area > N.pinhole_px) });
  const bounds = boundsOfPlane(alpha, width, height, 1);
  const hardEdge = (() => { let e = 0; let p = 0; for (let i = 0; i < n; i += 1) if (alpha[i] > 8 && alpha[i] < 247) p += 1; for (let i = 0; i < n; i += 1) if (alpha[i] === 255) e += 1; return { boundary_pixels: p + e, partial_share: p / Math.max(1, p + e), hard_share: 1 - p / Math.max(1, p + e) }; })();
  return Object.freeze({
    status: 'OK', accepted: true, failure_reason: null, alpha, bounds, confidence: 1, factors: Object.freeze({ native_alpha: 1 }), edge_quality: hardEdge,
    holes: holes.filter((h) => h.area > N.pinhole_px).map((h) => ({ area: h.area, x0: h.x0, y0: h.y0, x1: h.x1, y1: h.y1 })), fragments: dust, semi_transparent_share: soft / present, ground: null,
    components: Object.freeze(objects.map((c, i) => ({ id: `o${i + 1}`, bounds: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, area: c.area, selected: keep.has(c.id) }))),
    excluded: null, source: Object.freeze({ kind: 'NATIVE_ALPHA', id: 'NATIVE_ALPHA:validated@1' }),
    native: Object.freeze({ findings: Object.freeze(findings), snapped_to_opaque: snapped, soft_pixels: soft, objects: significant.length }),
  });
}
