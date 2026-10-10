// A deterministic LOCAL product mask for a merchant photograph: no provider, no model, no randomness. The merchant (or an annotator) gives an INNER outline of the
// product (for a printed case: the edge of the printed artwork); the real outer silhouette (the case rim) lies a few pixels outside it. The outer boundary is found
// by edge snapping: for samples along the outline, the offset along the outward normal where the luma steps from the dark rim to the surroundings, chosen by dynamic
// programming (smoothness + a rim-width prior) in two passes (a loose one, then one tied to the median rim width). The boundary is then rasterized with
// anti-aliased coverage. The result carries its own quality evidence (how many samples found a real edge); a low-confidence mask is flagged, never hidden.
//
// The mask only says WHICH source pixels are the product. The composite (product-composite.js) copies those source pixels; no pixel of any provider is ever inside it.

import { grayOf, sample } from './image-matching.js';

export const MASK_DEFAULTS = Object.freeze({
  step_px: 6, // spacing of the boundary samples along the outline
  rim_min_px: -24, // negative: an annotated outline may already lie outside part of the true silhouette
  rim_max_px: 34,
  rim_prior_px: 8,
  band_px: 3, // width of the inside / outside luma bands
  smoothness: 1.2,
  round_corners: 2, // Chaikin corner-cutting passes on the annotated outline (annotations often chamfer the corners of a rounded product) // penalty per pixel of offset change between neighbouring samples
  prior_weight: 0.3, // penalty per pixel away from the prior (pass 1) / from the median rim width (pass 2): where the edge is weak the rim width wins
  refine_window_px: 8, // pass 2 searches the median offset +- this (an annotated outline may have chamfered corners)
  median_window: 41, // odd: a wide median filter of the offsets (the rim width changes slowly along the outline) removes spikes caused by the texture of the surroundings
  bias_px: -1, // negative: the boundary is placed this far INSIDE the detected edge, so no surrounding pixel leaks into the product
  fit_rounded_quad: true, // fit the rounded-quadrilateral model of a flat case to the edge points (falls back to the free-form boundary)
  line_inlier_px: 3,
  min_confident_share: 0.7, // share of samples with a positive edge step below which the mask is flagged LOW_CONFIDENCE
});

const signedArea = (poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) { const [x0, y0] = poly[i]; const [x1, y1] = poly[(i + 1) % poly.length]; a += x0 * y1 - x1 * y0; }
  return a / 2;
};

/** Chaikin corner cutting: each pass replaces every vertex by the points at 1/4 and 3/4 of its two edges. */
function roundCorners(poly, passes) {
  let out = poly;
  for (let k = 0; k < passes; k += 1) {
    const next = [];
    for (let i = 0; i < out.length; i += 1) {
      const [x0, y0] = out[i]; const [x1, y1] = out[(i + 1) % out.length];
      next.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25], [x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    out = next;
  }
  return out;
}

/** Points every `step` px of arc length along a closed polygon, each with its outward unit normal. */
function resampleOutline(poly, step) {
  const clockwise = signedArea(poly) > 0; // image coordinates (y down)
  const segments = []; let total = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [x0, y0] = poly[i]; const [x1, y1] = poly[(i + 1) % poly.length];
    const length = Math.hypot(x1 - x0, y1 - y0);
    segments.push({ x0, y0, x1, y1, length, start: total }); total += length;
  }
  const n = Math.max(24, Math.round(total / step));
  const points = [];
  for (let k = 0; k < n; k += 1) {
    const at = (k + 0.5) * (total / n);
    const seg = segments.find((s) => at >= s.start && at < s.start + s.length) ?? segments[segments.length - 1];
    const t = (at - seg.start) / (seg.length || 1);
    points.push({ x: seg.x0 + (seg.x1 - seg.x0) * t, y: seg.y0 + (seg.y1 - seg.y0) * t });
  }
  // outward normal from the local tangent (neighbours), so corners are smooth
  return points.map((p, i) => {
    const a = points[(i + n - 2) % n]; const b = points[(i + 2) % n];
    const tx = b.x - a.x; const ty = b.y - a.y; const len = Math.hypot(tx, ty) || 1;
    const nx = (clockwise ? ty : -ty) / len; const ny = (clockwise ? -tx : tx) / len;
    return { ...p, nx, ny };
  });
}

function bandMean(plane, p, from, to) {
  let sum = 0; let count = 0;
  for (let d = from; d <= to; d += 1) { sum += sample(plane, p.x + p.nx * d + 0.5, p.y + p.ny * d + 0.5); count += 1; }
  return sum / count;
}

/** Viterbi over a closed loop (the sequence is doubled and the second half is kept). */
function snap(points, plane, lo, hi, prior, options) {
  const offsets = []; for (let d = lo; d <= hi; d += 1) offsets.push(d);
  const n = points.length; const m = offsets.length; const band = options.band_px;
  const score = points.map((p) => offsets.map((d) => bandMean(plane, p, d + 1, d + band) - bandMean(plane, p, d - band, d - 1)));
  const cost = (i, j) => -score[i % n][j] + options.prior_weight * Math.abs(offsets[j] - prior);
  const total = n * 2;
  let prev = offsets.map((_, j) => cost(0, j)); const back = [];
  for (let i = 1; i < total; i += 1) {
    const row = new Float64Array(m); const from = new Int32Array(m);
    for (let j = 0; j < m; j += 1) {
      let best = Infinity; let arg = 0;
      for (let k = 0; k < m; k += 1) { const c = prev[k] + options.smoothness * Math.abs(offsets[j] - offsets[k]); if (c < best) { best = c; arg = k; } }
      row[j] = best + cost(i, j); from[j] = arg;
    }
    back.push(from); prev = row;
  }
  let j = 0; for (let k = 1; k < m; k += 1) if (prev[k] < prev[j]) j = k;
  const path = new Array(total); path[total - 1] = j;
  for (let i = total - 1; i > 0; i -= 1) { j = back[i - 1][j]; path[i - 1] = j; }
  return { offsets: path.slice(n).map((k) => offsets[k]), scores: path.slice(n).map((k, i) => score[i][k]) };
}

// ---- rounded-quadrilateral model: a case is a flat, convex, rounded quadrilateral, so its four sides are straight lines and its corners are circular arcs.
// The snapped edge points are only the MEASUREMENTS; the mask follows the robustly fitted model (RANSAC over deterministic point pairs, then a total-least-squares
// refinement on the inliers). Where a side cannot be fitted the mask falls back to the free-form boundary and says so.

function fitLine(points, inlierPx) {
  const n = points.length; if (n < 8) return null;
  const sub = points.filter((_, i) => i % Math.max(1, Math.floor(n / 40)) === 0);
  let best = null;
  for (let i = 0; i < sub.length; i += 1) {
    for (let j = i + 1; j < sub.length; j += 1) {
      const [x0, y0] = sub[i]; const [x1, y1] = sub[j]; const len = Math.hypot(x1 - x0, y1 - y0); if (len < 40) continue;
      const nx = (y1 - y0) / len; const ny = -(x1 - x0) / len;
      let count = 0; for (const [x, y] of points) if (Math.abs((x - x0) * nx + (y - y0) * ny) <= inlierPx) count += 1;
      if (!best || count > best.count) best = { x0, y0, nx, ny, count };
    }
  }
  if (!best || best.count < 8) return null;
  const inliers = points.filter(([x, y]) => Math.abs((x - best.x0) * best.nx + (y - best.y0) * best.ny) <= inlierPx);
  let mx = 0; let my = 0; for (const [x, y] of inliers) { mx += x; my += y; } mx /= inliers.length; my /= inliers.length;
  let sxx = 0; let sxy = 0; let syy = 0; for (const [x, y] of inliers) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy); // principal direction of the points
  const dx = Math.cos(angle); const dy = Math.sin(angle);
  let rms = 0; for (const [x, y] of inliers) rms += ((x - mx) * -dy + (y - my) * dx) ** 2;
  return { px: mx, py: my, dx, dy, inliers: inliers.length, total: n, rms: Math.sqrt(rms / inliers.length) };
}

function intersect(a, b) {
  const det = a.dx * -b.dy - a.dy * -b.dx; if (Math.abs(det) < 1e-9) return null;
  const rx = b.px - a.px; const ry = b.py - a.py;
  const t = (rx * -b.dy - ry * -b.dx) / det;
  return [a.px + a.dx * t, a.py + a.dy * t];
}

/** The fillet (circular arc) at vertex V between the edges toward `prev` and `next`, radius R: the arc points, or null if R does not fit. */
function fillet(prev, v, next, R, steps = 24) {
  const ux = prev[0] - v[0]; const uy = prev[1] - v[1]; const wx = next[0] - v[0]; const wy = next[1] - v[1];
  const lu = Math.hypot(ux, uy); const lw = Math.hypot(wx, wy); if (lu < 1 || lw < 1) return null;
  const u = [ux / lu, uy / lu]; const w = [wx / lw, wy / lw];
  const cos = Math.max(-1, Math.min(1, u[0] * w[0] + u[1] * w[1])); const theta = Math.acos(cos); // angle between the two edges at V
  const tangent = R / Math.tan(theta / 2); if (tangent > lu * 0.9 || tangent > lw * 0.9) return null;
  const bx = u[0] + w[0]; const by = u[1] + w[1]; const bl = Math.hypot(bx, by) || 1;
  const c = [v[0] + (bx / bl) * (R / Math.sin(theta / 2)), v[1] + (by / bl) * (R / Math.sin(theta / 2))];
  const a0 = Math.atan2(v[1] + u[1] * tangent - c[1], v[0] + u[0] * tangent - c[0]); const a1 = Math.atan2(v[1] + w[1] * tangent - c[1], v[0] + w[0] * tangent - c[0]);
  let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  const out = []; for (let k = 0; k <= steps; k += 1) { const a = a0 + (d * k) / steps; out.push([c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)]); }
  return out;
}

const distToPolyline = (p, poly) => {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i += 1) {
    const [ax, ay] = poly[i]; const [bx, by] = poly[i + 1]; const vx = bx - ax; const vy = by - ay; const l2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - ay) * vy) / l2));
    best = Math.min(best, Math.hypot(p[0] - (ax + vx * t), p[1] - (ay + vy * t)));
  }
  return best;
};

/** Fits the rounded quadrilateral to edge points that carry outward normals. Returns { polygon, evidence } or null. */
function fitRoundedQuad(samples, inlierPx) {
  const sideOf = (s) => (s.ny < -0.7 ? 'top' : (s.ny > 0.7 ? 'bottom' : (s.nx < -0.7 ? 'left' : (s.nx > 0.7 ? 'right' : null))));
  const groups = { top: [], right: [], bottom: [], left: [] };
  for (const s of samples) { const side = sideOf(s); if (side) groups[side].push([s.x, s.y]); }
  const lines = {}; for (const side of Object.keys(groups)) { lines[side] = fitLine(groups[side], inlierPx); if (!lines[side]) return null; }
  const v = { tr: intersect(lines.top, lines.right), br: intersect(lines.right, lines.bottom), bl: intersect(lines.bottom, lines.left), tl: intersect(lines.left, lines.top) };
  if (Object.values(v).some((q) => !q)) return null;
  const corners = [['tl', 'tr', 'bl'], ['tr', 'br', 'tl'], ['br', 'bl', 'tr'], ['bl', 'tl', 'br']]; // [vertex, next, previous] in clockwise order
  const polygon = []; const radii = {};
  for (const [name, next, prev] of corners) {
    const near = samples.filter((q) => Math.hypot(q.x - v[name][0], q.y - v[name][1]) < 150).map((q) => [q.x, q.y]);
    let best = null;
    for (let R = 16; R <= 140; R += 4) {
      const arc = fillet(v[prev], v[name], v[next], R); if (!arc) continue;
      const poly = [v[prev], ...arc, v[next]];
      const err = near.length ? near.reduce((sum, q) => sum + Math.min(distToPolyline(q, poly), 12), 0) / near.length : 0;
      if (!best || err < best.err) best = { R, err, arc };
    }
    if (!best) return null;
    radii[name] = best.R; polygon.push(...best.arc);
  }
  const resid = samples.map((q) => distToPolyline([q.x, q.y], [...polygon, polygon[0]]));
  const med = [...resid].sort((a, b) => a - b)[Math.floor(resid.length / 2)];
  return {
    polygon,
    evidence: {
      model: 'ROUNDED_QUAD', corner_radius_px: radii, median_residual_px: med,
      side_inliers: Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, `${l.inliers}/${l.total}`])),
      side_rms_px: Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, l.rms])),
    },
  };
}

/** The polygon moved `d` px toward its inside (every vertex along the inward normal of its neighbours: for a convex outline). */
function insetPolygon(poly, d) {
  const n = poly.length; const cw = signedArea(poly) > 0;
  return poly.map((q, i) => {
    const a = poly[(i + n - 1) % n]; const b = poly[(i + 1) % n]; const tx = b[0] - a[0]; const ty = b[1] - a[1]; const len = Math.hypot(tx, ty) || 1;
    const nx = (cw ? ty : -ty) / len; const ny = (cw ? -tx : tx) / len; // outward
    return [q[0] - nx * d, q[1] - ny * d];
  });
}

/** Anti-aliased even-odd coverage (4 sub-rows, exact horizontal overlap) of a polygon, as a Uint8 alpha plane. */
function rasterize(poly, width, height) {
  const alpha = new Uint8Array(width * height); const cover = new Float32Array(width);
  const ys = poly.map((p) => p[1]); const y0 = Math.max(0, Math.floor(Math.min(...ys))); const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  const SUB = 4;
  for (let y = y0; y <= y1; y += 1) {
    cover.fill(0);
    for (let s = 0; s < SUB; s += 1) {
      const yy = y + (s + 0.5) / SUB; const xs = [];
      for (let i = 0; i < poly.length; i += 1) {
        const [ax, ay] = poly[i]; const [bx, by] = poly[(i + 1) % poly.length];
        if ((ay > yy) !== (by > yy)) xs.push(ax + ((yy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, xs[k]); const xb = Math.min(width, xs[k + 1]);
        for (let x = Math.floor(xa); x < Math.ceil(xb); x += 1) cover[x] += (Math.min(x + 1, xb) - Math.max(x, xa)) / SUB;
      }
    }
    for (let x = 0; x < width; x += 1) if (cover[x] > 0) alpha[y * width + x] = Math.min(255, Math.round(cover[x] * 255));
  }
  return alpha;
}

/**
 * @param {object} input
 *  rgba           { width, height, pixels }   the real photograph (RGBA)
 *  inner_outline  [[x, y], ...]               pixels; a closed outline just INSIDE the true silhouette (e.g. the printed-artwork edge)
 *  options        overrides of MASK_DEFAULTS
 * @returns {{ alpha: Uint8Array, width, height, bounds, boundary: number[][], quality: object }}
 */
export function buildProductMask({ rgba, inner_outline: outline, options = {} } = {}) {
  const o = { ...MASK_DEFAULTS, ...options };
  const plane = grayOf(rgba);
  const points = resampleOutline(roundCorners(outline, o.round_corners), o.step_px);
  const loose = snap(points, plane, o.rim_min_px, o.rim_max_px, o.rim_prior_px, o);
  const sorted = [...loose.offsets].sort((a, b) => a - b); const median = sorted[Math.floor(sorted.length / 2)];
  const tight = snap(points, plane, Math.max(o.rim_min_px, median - o.refine_window_px), Math.min(o.rim_max_px, median + o.refine_window_px), median, { ...o });
  const n = points.length;
  // a short circular smoothing of the offsets, then the boundary (biased slightly inward)
  const half = (o.median_window - 1) / 2;
  const filtered = tight.offsets.map((_, i) => { const w = []; for (let k = -half; k <= half; k += 1) w.push(tight.offsets[(i + k + n) % n]); w.sort((x, y) => x - y); return w[half]; });
  const smooth = filtered.map((_, i) => { let s = 0; for (let k = -2; k <= 2; k += 1) s += filtered[(i + k + n) % n]; return s / 5; });
  const measured = points.map((p, i) => ({ x: p.x + p.nx * smooth[i], y: p.y + p.ny * smooth[i], nx: p.nx, ny: p.ny }));
  const fitted = o.fit_rounded_quad ? fitRoundedQuad(measured, o.line_inlier_px) : null;
  // the model outline, pulled `bias_px` toward the inside (a negative bias): no surrounding pixel leaks into the product
  const model = fitted ? insetPolygon(fitted.polygon, -o.bias_px) : null;
  const boundary = model ?? measured.map((m) => [m.x + m.nx * o.bias_px, m.y + m.ny * o.bias_px]);
  const alpha = rasterize(boundary, rgba.width, rgba.height);
  const xs = boundary.map((p) => p[0]); const ys = boundary.map((p) => p[1]);
  const bounds = { x0: Math.max(0, Math.floor(Math.min(...xs))), y0: Math.max(0, Math.floor(Math.min(...ys))), x1: Math.min(rgba.width, Math.ceil(Math.max(...xs))), y1: Math.min(rgba.height, Math.ceil(Math.max(...ys))) };
  const positive = tight.scores.filter((s) => s > 0).length / n;
  return {
    alpha, width: rgba.width, height: rgba.height, bounds, boundary,
    quality: {
      samples: n, median_rim_px: median, rim_px_range: [Math.min(...tight.offsets), Math.max(...tight.offsets)], edge_step_positive_share: positive,
      mean_edge_step: tight.scores.reduce((s, v) => s + v, 0) / n, confident: positive >= o.min_confident_share, min_confident_share: o.min_confident_share,
      shape: fitted ? fitted.evidence : { model: 'FREEFORM', reason: 'THE_ROUNDED_QUAD_COULD_NOT_BE_FITTED' },
    },
  };
}
