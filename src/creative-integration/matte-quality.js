import { MATTE as M, SEGMENTATION as S } from './constants.js';
import { learnGround } from './segmentation.js';
import {
  alphaExtremaShare, boundaryOf, dilate, erode, isRgba, labelComponents, lumaAt, nearestSource,
} from './pixels.js';

// DETERMINISTIC MATTE QUALITY. A matte (alpha plane) is judged against the SOURCE pixels it was cut from, never against itself. Every check returns { code, ok, value, limit }; a check that cannot be
// measured is NOT ok (fail closed). `valid` is true only if every check is ok. Nothing here edits the matte or the pixels.
//
// Codes: EDGE_SUPPORT (the boundary lies on a real image edge: no cut through flat colour), FRINGE (opaque boundary pixels that are the ground colour or a ground shadow: halo / fringe), PINHOLES,
// ACCIDENTAL_HOLES (enclosed transparent areas where the source is product, not ground), GROUND_LEAK (ground colour kept as opaque product), FRAGMENTS (disconnected pieces beyond the declared ones), MISSING_THIN_PARTS (product evidence the matte dropped,
// next to it), BOUNDARY_OFFSET (erosion < 0 / dilation > 0 against the image evidence), STRAY_ALPHA (alpha dust away from the product), INTERIOR_ALPHA (a non-opaque interior), STAIRSTEP (an edge that does not reproduce the source: a thresholded soft edge, a halo),
// ALPHA_NOISE (a jagged alpha ramp).

const dist = (p, i, g) => Math.hypot(p[i] - g[0], p[i + 1] - g[1], p[i + 2] - g[2]);
const check = (code, value, limit, ok) => Object.freeze({ code, ok: Boolean(ok), value, limit });
const unmeasurable = (code, reason) => Object.freeze({ code, ok: false, value: null, limit: null, reason });

/**
 * @param {object} input { rgba, alpha: Uint8Array, ground?: [r,g,b], declared?: { components?: number, semi_transparent?: boolean }, ignore?: Uint8Array (0/1: pixels of OTHER objects, not judged) }
 */
export function checkMatte({ rgba, alpha, ground = null, declared = {}, ignore = null } = {}) {
  if (!isRgba(rgba) || !(alpha instanceof Uint8Array) || alpha.length !== rgba.width * rgba.height) return Object.freeze({ valid: false, findings: [unmeasurable('INPUT', 'rgba / alpha missing or of different sizes')], measurements: {} });
  const { width, height, pixels } = rgba; const n = width * height;
  const g = ground ?? learnGround(rgba).ground;
  const plain = ground ? 1 : learnGround(rgba).plain_share;
  const hard = new Uint8Array(n); let area = 0;
  for (let i = 0; i < n; i += 1) if (alpha[i] >= 128) { hard[i] = 1; area += 1; }
  if (!area) return Object.freeze({ valid: false, findings: [unmeasurable('MATTE_EMPTY', 'the matte has no opaque pixel')], measurements: { area } });
  const findings = [];
  const ign = ignore ?? new Uint8Array(n);
  const ignNear = dilate(ign, width, height, 2); // the seam with another object: a pixel there is mixed with that object, not with the ground

  // ground distance of every source pixel
  const d = new Float32Array(n);
  for (let i = 0; i < n; i += 1) d[i] = dist(pixels, i * 4, g);
  const groundKnown = plain >= S.border_homogeneous_share;

  const edge = boundaryOf(hard, width, height); let edgeN = 0;
  for (let i = 0; i < n; i += 1) if (edge[i]) edgeN += 1;

  // EDGE_SUPPORT
  {
    let supported = 0;
    for (let i = 0; i < n; i += 1) {
      if (!edge[i]) continue; const x = i % width; const y = (i - x) / width; let best = 0; const l0 = lumaAt(pixels, i * 4);
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const nx = x + dx; const ny = y + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const v = Math.abs(lumaAt(pixels, (ny * width + nx) * 4) - l0); if (v > best) best = v;
      }
      if (best >= M.edge_support_gradient) supported += 1;
    }
    const share = edgeN ? supported / edgeN : 0;
    findings.push(check('EDGE_SUPPORT', share, M.edge_support_min_share, share >= M.edge_support_min_share));
  }

  // FRINGE / halo: nearly opaque boundary-layer pixels that are the ground colour, or a ground-chroma shadow
  if (!groundKnown) findings.push(unmeasurable('FRINGE', 'the ground is not plain: the fringe cannot be measured'));
  else {
    const gl = 0.299 * g[0] + 0.587 * g[1] + 0.114 * g[2]; let bad = 0; let tested = 0; const badMask = new Uint8Array(n);
    const band = dilate(edge, width, height, 1);
    for (let i = 0; i < n; i += 1) {
      if (!band[i] || !hard[i] || alpha[i] < 200 || ignNear[i]) continue; tested += 1;
      const l = lumaAt(pixels, i * 4);
      const shadowLike = l < gl && l >= gl * S.shadow_luma_floor && Math.hypot(pixels[i * 4] - l - (g[0] - gl), pixels[i * 4 + 1] - l - (g[1] - gl), pixels[i * 4 + 2] - l - (g[2] - gl)) <= S.chroma_shadow_tolerance;
      if (d[i] <= S.t_lo || shadowLike) { bad += 1; badMask[i] = 1; }
    }
    const share = tested ? bad / tested : 0; const run = Math.max(0, ...labelComponents(badMask, width, height).list.map((c) => c.area));
    findings.push(check('FRINGE', share, M.fringe_max_share, share <= M.fringe_max_share));
    findings.push(check('FRINGE_RUN', run, M.cluster_max_px, run < M.cluster_max_px));
  }

  // enclosed transparent regions: pinholes and accidental holes
  {
    const outside = new Uint8Array(n); const st = [];
    const seed = (i) => { if (!hard[i] && !outside[i]) { outside[i] = 1; st.push(i); } };
    for (let x = 0; x < width; x += 1) { seed(x); seed((height - 1) * width + x); }
    for (let y = 0; y < height; y += 1) { seed(y * width); seed(y * width + width - 1); }
    while (st.length) { const i = st.pop(); const x = i % width; if (x > 0) seed(i - 1); if (x < width - 1) seed(i + 1); if (i >= width) seed(i - width); if (i < n - width) seed(i + width); }
    const gap = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) if (!hard[i] && !outside[i] && !ign[i]) gap[i] = 1;
    const { list, labels } = labelComponents(gap, width, height); const pin = Math.max(4, 0.0005 * area);
    const productShare = list.map(() => 0);
    for (let i = 0; i < n; i += 1) if (gap[i] && d[i] > S.t_lo) productShare[labels[i] - 1] += 1;
    let pinholes = 0; let accidental = 0;
    list.forEach((c, k) => {
      const looksProduct = productShare[k] / c.area > S.hole_ground_share;
      if (looksProduct) { if (c.area <= pin) pinholes += 1; else accidental += c.area; }
    });
    findings.push(check('PINHOLES', pinholes, M.pinhole_max_pixels, pinholes <= M.pinhole_max_pixels));
    findings.push(check('ACCIDENTAL_HOLES', accidental / area, M.accidental_hole_max_share, accidental / area <= M.accidental_hole_max_share));
  }

  // GROUND_LEAK: opaque pixels that are the ground colour, in blobs (ground that was kept inside the product, e.g. a notch between a handle and the body)
  if (!groundKnown) findings.push(unmeasurable('GROUND_LEAK', 'the ground is not plain'));
  else {
    const leak = new Uint8Array(n); for (let i = 0; i < n; i += 1) if (alpha[i] >= 250 && d[i] <= S.t_lo && !ign[i]) leak[i] = 1;
    const blobs = labelComponents(leak, width, height).list.filter((c) => c.area >= M.ground_blob_min_px); const px = blobs.reduce((t, c) => t + c.area, 0);
    findings.push(check('GROUND_LEAK', px / area, M.ground_blob_max_share, px / area <= M.ground_blob_max_share));
  }

  // FRAGMENTS
  {
    const { list } = labelComponents(hard, width, height); const declaredN = declared.components ?? 1;
    const extra = Math.max(0, list.filter((c) => c.area >= M.fragment_min_pixels).length - declaredN);
    findings.push(check('FRAGMENTS', extra, M.fragment_max_count, extra <= M.fragment_max_count));
  }

  // evidence of the product in the source, near the matte
  const near = dilate(hard, width, height, 8);
  if (!groundKnown) {
    findings.push(unmeasurable('MISSING_THIN_PARTS', 'the ground is not plain'));
    findings.push(unmeasurable('BOUNDARY_OFFSET', 'the ground is not plain'));
  } else {
    const evidence = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) if (near[i] && !ign[i] && d[i] >= (S.t_lo + S.t_hi) / 2) evidence[i] = 1;
    // MISSING_THIN_PARTS: product evidence the matte dropped (alpha ~ 0, clearly not the ground) and that is connected to the matte: the WHOLE dropped structure counts, not only the pixels beside the matte
    const reach = dilate(hard, width, height, 3); const dropped = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) if (!hard[i] && alpha[i] < 16 && d[i] >= S.t_hi && !ignNear[i]) dropped[i] = 1;
    const parts = labelComponents(dropped, width, height); const touching = new Set();
    for (let i = 0; i < n; i += 1) if (dropped[i] && reach[i]) touching.add(parts.labels[i]);
    const missing = parts.list.filter((c) => touching.has(c.id)).reduce((t, c) => t + c.area, 0);
    findings.push(check('MISSING_THIN_PARTS', missing / area, M.missing_thin_max_share, missing / area <= M.missing_thin_max_share));
    // BOUNDARY_OFFSET: matte beyond the evidence (+) minus evidence beyond the matte (-), in a band around the boundary, per boundary pixel
    const inner = erode(hard, width, height, 8); let plus = 0; let minus = 0;
    for (let i = 0; i < n; i += 1) {
      if (!near[i] || inner[i] || ign[i]) continue;
      if (hard[i] && !evidence[i]) plus += 1; else if (!hard[i] && evidence[i]) minus += 1;
    }
    const offset = edgeN ? (plus - minus) / edgeN : 0;
    findings.push(check('BOUNDARY_OFFSET', offset, M.offset_max_px, Math.abs(offset) <= M.offset_max_px));
  }

  // STRAY_ALPHA and INTERIOR_ALPHA
  {
    const reach = dilate(hard, width, height, 3); let stray = 0;
    for (let i = 0; i < n; i += 1) if (alpha[i] > 2 && !reach[i]) stray += 1;
    findings.push(check('STRAY_ALPHA', stray, M.stray_alpha_max_pixels, stray <= M.stray_alpha_max_pixels));
    const inner = erode(hard, width, height, 3); let interior = 0; let soft = 0;
    for (let i = 0; i < n; i += 1) if (inner[i]) { interior += 1; if (alpha[i] < 250) soft += 1; }
    const share = interior ? soft / interior : 0;
    findings.push(check('INTERIOR_ALPHA', share, M.interior_alpha_max_share, declared.semi_transparent === true || share <= M.interior_alpha_max_share));
  }

  // EDGE_RECONSTRUCTION: on the boundary band the source pixel must equal  alpha * product + (1 - alpha) * ground  (the product colour from the nearest interior pixel). A thresholded soft edge, a halo or a
  // stair-stepped edge cannot reproduce the source there. ALPHA_NOISE: the alpha ramp itself must be smooth.
  if (!groundKnown) findings.push(unmeasurable('EDGE_RECONSTRUCTION', 'the ground is not plain'));
  else {
    const core = erode(hard, width, height, 2); const band = new Uint8Array(n); const reach = dilate(hard, width, height, 3);
    for (let i = 0; i < n; i += 1) if (reach[i] && !core[i] && !ignNear[i]) band[i] = 1;
    const near = nearestSource(core, band, width, height, 4); let bad = 0; let tested = 0; const badMask = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      if (!band[i] || near[i] < 0) continue; const j = near[i] * 4; const a = alpha[i] / 255; tested += 1;
      let r = 0;
      for (let c = 0; c < 3; c += 1) { const predicted = a * pixels[j + c] + (1 - a) * g[c]; r += (pixels[i * 4 + c] - predicted) ** 2; }
      // the product colour changes along the edge (a mirror finish, a gradient print): the tolerance grows with the local colour gradient at the interior sample
      const k = near[i]; let grad = 0;
      for (const q of [k - 1, k + 1, k - width, k + width]) if (q >= 0 && q < n) grad = Math.max(grad, Math.hypot(pixels[q * 4] - pixels[j], pixels[q * 4 + 1] - pixels[j + 1], pixels[q * 4 + 2] - pixels[j + 2]));
      if (Math.sqrt(r) > M.reconstruction_residual + M.reconstruction_gradient_gain * grad) { bad += 1; badMask[i] = 1; }
    }
    const share = tested ? bad / tested : 0; const run = Math.max(0, ...labelComponents(badMask, width, height).list.map((c) => c.area));
    findings.push(check('EDGE_RECONSTRUCTION', share, M.reconstruction_max_share, share <= M.reconstruction_max_share));
    findings.push(check('EDGE_RECONSTRUCTION_RUN', run, M.cluster_max_px, run < M.cluster_max_px));
  }
  {
    const noise = alphaExtremaShare(alpha, width, height);
    findings.push(check('ALPHA_NOISE', noise, M.alpha_noise_max, noise <= M.alpha_noise_max));
  }

  return Object.freeze({ valid: findings.every((f) => f.ok), findings: Object.freeze(findings), measurements: Object.freeze({ area, boundary_pixels: edgeN, ground: g }) });
}
