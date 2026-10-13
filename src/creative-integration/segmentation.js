import { createHash } from 'node:crypto';

import { PERFORMANCE, SEG_REASON, SEGMENTATION as S } from './constants.js';
import {
  boundaryOf, boundsOfPlane, clamp, dilate, erode, isRgba, labelComponents, lumaAt, nearestSource,
} from './pixels.js';

// THE GENERAL SEGMENTATION CONTRACT. Provider independent: a segmentation is a value { status, alpha, bounds, confidence, edge_quality, components, failure_reason, source }.
// It comes from the LOCAL deterministic segmenter below (a plain-ground cut-out: no model, no network, no randomness) or from an injected PORT whose answer is validated against
// the same contract. A low-confidence result is never accepted: status is LOW_CONFIDENCE and `accepted` is false. Real product pixels are never touched here: the segmentation only
// says WHICH source pixels are the product (alpha).
//
// What the local segmenter handles: single, several and touching objects (a seeded split on eroded cores), holes and handles (enclosed ground is kept transparent), accidental pinholes
// (filled), thin protrusions (kept: the foreground test is a colour distance, not a morphology), curved silhouettes and soft boundaries (a continuous alpha ramp, not a threshold), semi-
// transparent areas (partial alpha is kept and reported) and printed graphics (a printed ground-coloured motif inside a product is a pinhole and is filled).
// What it does NOT handle, and says so (BACKGROUND_NOT_PLAIN / low confidence): a cluttered or gradient ground, a product whose colour is the ground colour, a hand on the product.

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dist = (p, i, g) => Math.hypot(p[i] - g[0], p[i + 1] - g[1], p[i + 2] - g[2]);

/** Median colour of the ring of `border_px` around the image, and the share of ring pixels close to it. */
export function learnGround(rgba) {
  const { width, height, pixels } = rgba; const b = Math.min(S.border_px, Math.floor(Math.min(width, height) / 4)) || 1;
  const ring = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (x < b || y < b || x >= width - b || y >= height - b) ring.push((y * width + x) * 4);
  }
  const med = (c) => { const v = ring.map((i) => pixels[i + c]).sort((a, z) => a - z); return v[v.length >> 1]; };
  const ground = [med(0), med(1), med(2)];
  let close = 0;
  for (const i of ring) if (dist(pixels, i, ground) <= S.ground_tolerance) close += 1;
  return { ground, plain_share: close / ring.length };
}

/** Foreground evidence per pixel: a 0..1 score (0 = ground, 1 = product). A darker pixel of the ground chroma is a soft ground shadow, not the product. */
function scoreForeground(rgba, ground) {
  const { width, height, pixels } = rgba; const score = new Float32Array(width * height); const raw = new Float32Array(width * height); const shadow = new Uint8Array(width * height);
  const gl = 0.299 * ground[0] + 0.587 * ground[1] + 0.114 * ground[2]; const gc = [ground[0] - gl, ground[1] - gl, ground[2] - gl];
  for (let k = 0; k < score.length; k += 1) {
    const i = k * 4; const d = dist(pixels, i, ground);
    let eff = d;
    const l = lumaAt(pixels, i);
    if (l < gl && l >= gl * S.shadow_luma_floor) {
      const dc = Math.hypot(pixels[i] - l - gc[0], pixels[i + 1] - l - gc[1], pixels[i + 2] - l - gc[2]);
      if (dc <= S.chroma_shadow_tolerance) { eff = 0; shadow[k] = 1; }
    }
    score[k] = clamp((eff - S.t_lo) / (S.t_hi - S.t_lo), 0, 1);
    raw[k] = clamp((d - S.t_lo) / (S.t_hi - S.t_lo), 0, 1);
  }
  return { score, raw, shadow };
}

/** Fill enclosed gaps that are too small to be a real hole (pinholes); keep real holes (a handle, a ring) transparent. Returns { filled, holes }. */
function resolveHoles(hard, width, height, raw, area) {
  const outside = new Uint8Array(hard.length); const stack = [];
  const seed = (i) => { if (!hard[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < width; x += 1) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { seed(y * width); seed(y * width + width - 1); }
  while (stack.length) {
    const i = stack.pop(); const x = i % width;
    if (x > 0) seed(i - 1); if (x < width - 1) seed(i + 1); if (i >= width) seed(i - width); if (i < hard.length - width) seed(i + width);
  }
  const gap = new Uint8Array(hard.length);
  for (let i = 0; i < hard.length; i += 1) if (!hard[i] && !outside[i]) gap[i] = 1;
  const { list, labels } = labelComponents(gap, width, height);
  const filled = Uint8Array.from(hard); const holes = [];
  { // an enclosed gap is a REAL hole only if the ground shows through it (most of its pixels are the ground colour); otherwise it is product (a shadow-like tone or a ground-coloured print inside it)
    const g0 = labelComponents(gap, width, height); const clear = g0.list.map(() => 0);
    for (let i = 0; i < gap.length; i += 1) if (gap[i] && raw[i] === 0) clear[g0.labels[i] - 1] += 1;
    for (let i = 0; i < gap.length; i += 1) if (gap[i] && clear[g0.labels[i] - 1] / g0.list[g0.labels[i] - 1].area < S.hole_ground_share) { filled[i] = 1; gap[i] = 0; }
  }
  const { list: realGaps, labels: realLabels } = labelComponents(gap, width, height);
  for (const g of realGaps) {
    if (g.area <= Math.max(S.pinhole_px, S.hole_min_share * area)) { // a speck or a small ground-coloured spot (a print dot, a specular highlight on a glossy part): never an opening that matters
      for (let i = 0; i < realLabels.length; i += 1) if (realLabels[i] === g.id) filled[i] = 1;
    } else holes.push({ area: g.area, x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 });
  }
  return { filled, holes };
}

/** A ground pixel with foreground within `r` px on BOTH sides along one axis (a sliver, not an open gap) joins the foreground. Axis-aligned on purpose: a disc closing would also widen the neck between touching objects. */
function bridgeSlivers(hard, width, height, r) {
  const out = Uint8Array.from(hard);
  const has = (x, y) => x >= 0 && y >= 0 && x < width && y < height && hard[y * width + x] === 1;
  const reach = (x, y, dx, dy) => { for (let k = 1; k <= 2 * r; k += 1) if (has(x + dx * k, y + dy * k)) return k; return Infinity; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (hard[y * width + x]) continue;
    if (reach(x, y, -1, 0) + reach(x, y, 1, 0) <= 2 * r + 1 || reach(x, y, 0, -1) + reach(x, y, 0, 1) <= 2 * r + 1) out[y * width + x] = 1;
  }
  return out;
}

/** Only a LONG, thin bridge is a sliver of the product (a mirror line, a gradient crossing the ground colour). A short wedge between two parts (a handle and a body) is an open crevice and stays open. */
function keepLongSlivers(hard, bridged, width, height) {
  const only = new Uint8Array(hard.length);
  for (let i = 0; i < only.length; i += 1) only[i] = bridged[i] && !hard[i] ? 1 : 0;
  const { list, labels } = labelComponents(only, width, height); const keepId = new Set();
  for (const c of list) { const w = c.x1 - c.x0 + 1; const h = c.y1 - c.y0 + 1; if (Math.max(w, h) >= S.sliver_min_length_px && Math.max(w, h) / Math.min(w, h) >= S.sliver_min_elongation) keepId.add(c.id); }
  const out = Uint8Array.from(hard);
  for (let i = 0; i < only.length; i += 1) if (only[i] && keepId.has(labels[i])) out[i] = 1;
  return out;
}

/** Every ground gap not connected to the image border is filled (the silhouette). */
function fillEnclosed(hard, width, height) {
  const outside = new Uint8Array(hard.length); const stack = [];
  const seed = (i) => { if (!hard[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < width; x += 1) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { seed(y * width); seed(y * width + width - 1); }
  while (stack.length) { const i = stack.pop(); const x = i % width; if (x > 0) seed(i - 1); if (x < width - 1) seed(i + 1); if (i >= width) seed(i - width); if (i < hard.length - width) seed(i + width); }
  const out = new Uint8Array(hard.length);
  for (let i = 0; i < out.length; i += 1) out[i] = hard[i] || !outside[i] ? 1 : 0;
  return out;
}

/** Split touching objects: erode the foreground until it breaks into several cores, then grow each core back inside the foreground (seeded, nearest core wins). */
function splitTouching(hardIn, width, height) {
  const hard = fillEnclosed(hardIn, width, height); // the silhouette: a printed ring whose middle resembles the ground must not fall apart
  const total = hard.reduce((n, v) => n + v, 0);
  let best = null;
  for (let r = 1; r <= S.max_split_erosion_px; r += 1) { // the radius that gives the most significant cores (the smallest one on a tie)
    const eroded = erode(hard, width, height, r); const { list, labels } = labelComponents(eroded, width, height);
    if (!list.length) break; // nothing is left to erode
    const cores = list.filter((c) => c.area >= S.min_core_share * total);
    if (cores.length >= 2 && (!best || cores.length > best.cores.length)) best = { cores, labels };
  }
  if (!best) return null;
  const owner = new Int32Array(hard.length); const queue = [];
  for (let i = 0; i < best.labels.length; i += 1) { const c = best.cores.findIndex((k) => k.id === best.labels[i]); if (c >= 0) { owner[i] = c + 1; queue.push(i); } }
  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head]; const x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i >= width ? i - width : -1, i < hard.length - width ? i + width : -1]) {
      if (j >= 0 && hardIn[j] && !owner[j]) { owner[j] = owner[i]; queue.push(j); } // grow inside the REAL foreground, not the filled silhouette
    }
  }
  return { owner, count: best.cores.length };
}

/** A transparent speck enclosed by the product whose source is not the ground (an anti-aliasing accident) becomes product. Same criterion as the matte-quality PINHOLES check. */
function healPinholes(alpha, raw, width, height) {
  const hard = new Uint8Array(alpha.length); let area = 0;
  for (let i = 0; i < alpha.length; i += 1) if (alpha[i] >= 128) { hard[i] = 1; area += 1; }
  const outside = new Uint8Array(alpha.length); const st = [];
  const seed = (i) => { if (!hard[i] && !outside[i]) { outside[i] = 1; st.push(i); } };
  for (let x = 0; x < width; x += 1) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { seed(y * width); seed(y * width + width - 1); }
  while (st.length) { const i = st.pop(); const x = i % width; if (x > 0) seed(i - 1); if (x < width - 1) seed(i + 1); if (i >= width) seed(i - width); if (i < alpha.length - width) seed(i + width); }
  const gap = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) if (!hard[i] && !outside[i]) gap[i] = 1;
  const { list, labels } = labelComponents(gap, width, height); const limit = Math.max(4, 0.0005 * area);
  const product = list.map(() => 0);
  for (let i = 0; i < gap.length; i += 1) if (gap[i] && raw[i] > 0) product[labels[i] - 1] += 1;
  for (let i = 0; i < gap.length; i += 1) if (gap[i]) { const c = list[labels[i] - 1]; if (c.area <= limit && product[labels[i] - 1] / c.area > S.hole_ground_share) alpha[i] = 255; }
}

function describe(plane, width, height, id, hard) {
  const b = boundsOfPlane(plane, width, height, 1); let area = 0; let sx = 0; let sy = 0;
  for (let y = b.y0; y <= b.y1; y += 1) for (let x = b.x0; x <= b.x1; x += 1) if (plane[y * width + x]) { area += 1; sx += x; sy += y; }
  return { id, bounds: b, area, centroid: [sx / area, sy / area], touches_border: b.x0 === 0 || b.y0 === 0 || b.x1 === width - 1 || b.y1 === height - 1, hard };
}

function edgeQualityOf(alpha, width, height) {
  const hard = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) hard[i] = alpha[i] >= 128 ? 1 : 0;
  const edge = boundaryOf(hard, width, height); let n = 0; let partial = 0; let decisive = 0;
  for (let i = 0; i < edge.length; i += 1) {
    if (!edge[i]) continue; n += 1;
    const x = i % width; const y = (i - x) / width; let anyPartial = false;
    for (let dy = -1; dy <= 1 && !anyPartial; dy += 1) for (let dx = -1; dx <= 1; dx += 1) { const nx = x + dx; const ny = y + dy; if (nx >= 0 && ny >= 0 && nx < width && ny < height) { const a = alpha[ny * width + nx]; if (a > 8 && a < 247) { anyPartial = true; break; } } }
    if (anyPartial) partial += 1; else decisive += 1;
  }
  return { boundary_pixels: n, partial_share: n ? partial / n : 0, hard_share: n ? decisive / n : 0 };
}

const failResult = (reason, extra = {}) => Object.freeze({ status: 'FAILED', accepted: false, failure_reason: reason, confidence: 0, alpha: null, bounds: null, components: [], edge_quality: null, ...extra });

/**
 * The LOCAL deterministic ANALYSIS of a photograph on a plain ground: the ground, the foreground evidence and the OBJECTS (components, with touching objects split). It does not depend on the selection, so it is
 * computed once per source and reused for every selection (the multi-product path and the mask cache).
 */
export function analyseLocal(rgba) {
  const { width, height } = rgba;
  const { ground, plain_share: plain } = learnGround(rgba);
  const fail = (reason, extra) => ({ failure: failResult(reason, extra) });
  if (plain < S.border_homogeneous_share) return fail(SEG_REASON.BACKGROUND_NOT_PLAIN, { evidence: { plain_share: plain } });

  const { score, raw, shadow } = scoreForeground(rgba, ground);
  const hard00 = new Uint8Array(score.length);
  for (let i = 0; i < score.length; i += 1) hard00[i] = score[i] >= 0.5 ? 1 : 0;
  // a sliver of the ground colour inside a product (a gradient crossing the ground luma, a thin mirror line) is bridged: gaps narrower than 2 x bridge_px between foreground on both sides
  const closed = keepLongSlivers(hard00, bridgeSlivers(hard00, width, height, S.bridge_px), width, height);
  const hard0 = new Uint8Array(score.length);
  for (let i = 0; i < score.length; i += 1) hard0[i] = hard00[i] || closed[i] ? 1 : 0;
  const first = labelComponents(hard0, width, height);
  const minArea = Math.max(2, S.min_component_share * width * height);
  const kept = first.list.filter((c) => c.area >= minArea);
  const fragments = first.list.length - kept.length; const fragmentArea = first.list.filter((c) => c.area < minArea).reduce((t, c) => t + c.area, 0);
  if (!kept.length) return fail(SEG_REASON.NO_FOREGROUND, { evidence: { plain_share: plain, fragments } });

  // 1. objects: the connected components (an object lying wholly inside another object's silhouette is part of it: a print inside a frame), with touching objects split into their own labels
  const keep = new Uint8Array(hard0.length);
  for (const c of kept) for (let y = c.y0; y <= c.y1; y += 1) for (let x = c.x0; x <= c.x1; x += 1) if (first.labels[y * width + x] === c.id) keep[y * width + x] = 1;
  { // a ground-coloured gap that has another object inside it is the interior of ONE product (a mat around a print); a gap with nothing inside is a real hole (a handle)
    const gaps = fillEnclosed(keep, width, height); for (let i = 0; i < gaps.length; i += 1) if (keep[i]) gaps[i] = 0;
    const g = labelComponents(gaps, width, height); const seen = g.list.map(() => new Set());
    for (let i = 0; i < gaps.length; i += 1) {
      if (!gaps[i]) continue; const x = i % width;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i >= width ? i - width : -1, i < gaps.length - width ? i + width : -1]) if (j >= 0 && keep[j]) seen[g.labels[i] - 1].add(first.labels[j]);
    }
    for (let i = 0; i < gaps.length; i += 1) if (gaps[i] && seen[g.labels[i] - 1].size >= 2) keep[i] = 1;
  }
  const split = splitTouching(keep, width, height);
  const objects = []; // each: a 0/1 plane
  const merged = split ? null : labelComponents(keep, width, height);
  if (split) {
    for (let k = 1; k <= split.count; k += 1) { const p = new Uint8Array(keep.length); for (let i = 0; i < p.length; i += 1) if (split.owner[i] === k) p[i] = 1; objects.push(p); }
  } else {
    for (const c of merged.list) { const p = new Uint8Array(keep.length); for (let y = c.y0; y <= c.y1; y += 1) for (let x = c.x0; x <= c.x1; x += 1) if (merged.labels[y * width + x] === c.id) p[y * width + x] = 1; objects.push(p); }
  }
  const largest = Math.max(...objects.map((p) => p.reduce((n, v) => n + v, 0)));
  const described = objects.map((p, i) => ({ ...describe(p, width, height, `o${i + 1}`), plane: p }))
    .sort((a, b) => b.area - a.area).map((o, i) => ({ ...o, id: `o${i + 1}` }));
  const significant = described.filter((o) => o.area >= S.significant_share * largest);

  return Object.freeze({ width, height, ground, plain, score, raw, shadow, hard00, hard0, keep, described, significant, fragments, fragmentArea, split: Boolean(split) });
}

/**
 * Select from an analysis and cut the matte.
 * @param {object} selection { mode: 'AUTO' (default) | 'IDS' ({ ids }) | 'POINT' ({ point: [x, y] }) | 'BOX' ({ box: {x0,y0,x1,y1}, allow_cut? }) | 'GROUP' (every object, explicit), semi_transparent?: boolean }
 */
export function segmentFromAnalysis(rgba, an, selection = { mode: 'AUTO' }) {
  const { width, height, ground, plain, score, raw, shadow, hard00, hard0, keep, described, significant, fragments, fragmentArea } = an;
  const split = an.split ? {} : null;
  const fail = failResult;
  // 2. the selection: explicit, or refused when ambiguous
  let chosen;
  const mode = selection?.mode ?? 'AUTO';
  if (mode === 'AUTO') {
    if (significant.length > 1) return fail(SEG_REASON.AMBIGUOUS_SELECTION, { components: described.map(({ plane, ...o }) => o), evidence: { objects: significant.length } });
    chosen = [significant[0]];
  } else if (mode === 'GROUP') chosen = significant;
  else if (mode === 'IDS') chosen = described.filter((o) => (selection.ids ?? []).includes(o.id));
  else if (mode === 'POINT') {
    const [px, py] = selection.point ?? [-1, -1]; const hit = described.find((o) => o.plane[Math.round(py) * width + Math.round(px)]);
    chosen = hit ? [hit] : [];
  } else if (mode === 'BOX') {
    // the box CLIPS: only what lies inside it is selected. If the foreground goes on across a box edge, the box has cut an object (a hand, a table, a neighbour): refused unless allow_cut.
    const b = selection.box; const inBox = (x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1; let cut = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = y * width + x; if (!keep[i] || !inBox(x, y)) continue;
      if ((x > 0 && keep[i - 1] && !inBox(x - 1, y)) || (x < width - 1 && keep[i + 1] && !inBox(x + 1, y)) || (y > 0 && keep[i - width] && !inBox(x, y - 1)) || (y < height - 1 && keep[i + width] && !inBox(x, y + 1))) cut += 1;
    }
    if (cut > 0 && selection.allow_cut !== true) return fail(SEG_REASON.SELECTION_TOUCHES_OTHER_OBJECT, { evidence: { cut_pixels: cut }, components: described.map(({ plane, ...o }) => ({ ...o })) });
    chosen = described.filter((o) => o.plane.some((v, i) => v && inBox(i % width, (i - (i % width)) / width))).map((o) => { const plane = o.plane.map((v, i) => (v && inBox(i % width, (i - (i % width)) / width) ? 1 : 0)); return { ...describe(plane, width, height, o.id), plane }; });
  } else return fail(SEG_REASON.INVALID_INPUT, { evidence: { mode } });
  if (!chosen.length || (mode === 'IDS' && chosen.length !== (selection.ids ?? []).length)) return fail(SEG_REASON.SELECTION_NOT_FOUND, { components: described.map(({ plane, ...o }) => o) });

  // 3. the matte of the selection: soft alpha from the score inside a slightly grown selection, never including a non-selected object
  const sel = new Uint8Array(keep.length);
  for (const o of chosen) for (let i = 0; i < sel.length; i += 1) if (o.plane[i]) sel[i] = 1;
  const others = new Uint8Array(keep.length);
  for (const o of described) if (!chosen.includes(o)) for (let i = 0; i < others.length; i += 1) if (o.plane[i]) others[i] = 1;
  const selArea = sel.reduce((n, v) => n + v, 0);
  const { filled, holes } = resolveHoles(sel, width, height, raw, selArea);
  const grown = dilate(filled, width, height, 2);
  const nearOthers = dilate(others, width, height, S.seam_px); // the seam with a non-selected object: its colour bleeds into the first pixels of the selected edge, so they are not taken
  // The alpha: inside the product (eroded core) it is opaque unless semi-transparency is declared; on the boundary band it is UNMIXED (the pixel is c * product + (1 - c) * ground, with the product colour
  // taken from the nearest core pixel), so a soft edge keeps its real coverage instead of being thresholded. A boundary pixel that is not such a mixture falls back to the colour-distance ramp.
  const semiDeclared = selection?.semi_transparent === true;
  const core = erode(filled, width, height, 3);
  const nearest = nearestSource(core, grown, width, height, 6);
  const alpha = new Uint8Array(sel.length); let semi = 0; let interior = 0; const px = rgba.pixels;
  for (let i = 0; i < alpha.length; i += 1) {
    if (!grown[i] || (nearOthers[i] && !core[i])) continue;
    if (core[i]) { alpha[i] = semiDeclared ? Math.round(255 * Math.max(score[i], hard00[i] ? 0.5 : 1)) : 255; continue; }
    if (filled[i] && hard00[i] === 0 && score[i] < 0.5) { alpha[i] = 255; continue; } // a bridged sliver or an enclosed pinhole
    const j = nearest[i]; let a = filled[i] ? Math.max(score[i], 0.5) : score[i];
    if (j >= 0 && !shadow[i]) {
      const fx = px[j * 4] - ground[0]; const fy = px[j * 4 + 1] - ground[1]; const fz = px[j * 4 + 2] - ground[2]; const den = fx * fx + fy * fy + fz * fz;
      if (den >= S.t_hi * S.t_hi) {
        const dx = px[i * 4] - ground[0]; const dy = px[i * 4 + 1] - ground[1]; const dz = px[i * 4 + 2] - ground[2];
        const u = clamp((dx * fx + dy * fy + dz * fz) / den, 0, 1);
        if (Math.hypot(dx - u * fx, dy - u * fy, dz - u * fz) <= S.unmix_residual) a = u;
      }
    }
    alpha[i] = a < S.alpha_dust ? 0 : Math.round(255 * (a >= 0.999 ? 1 : a));
  }
  healPinholes(alpha, raw, width, height);
  for (let i = 0; i < core.length; i += 1) if (core[i]) { interior += 1; if (alpha[i] < 250) semi += 1; }

  // 4. the evidence: confidence is the WEAKEST link (a single poor factor must not be averaged away)
  const eq = edgeQualityOf(alpha, width, height);
  const deep = erode(filled, width, height, 5); const rim = new Uint8Array(sel.length); // the contrast that matters is at the EDGE: the outer rim of the product, not a ground-coloured mat inside it
  for (let i = 0; i < rim.length; i += 1) rim[i] = filled[i] && !deep[i] && hard0[i] ? 1 : 0;
  const contrast = clamp(medianContrast(rgba, rim, ground) / S.t_hi, 0, 1);
  const factors = {
    ground_plain: clamp((plain - 0.6) / 0.4, 0, 1),
    contrast,
    edge_definition: clamp(eq.partial_share * 2 + eq.hard_share * 1.2, 0, 1),
    fragments: clamp(1 - (fragmentArea / Math.max(1, selArea)) / S.fragment_area_share_max, 0, 1), // the AREA of the dropped specks against the product's, not their count (a photograph has dust)
    not_cropped: chosen.some((o) => o.touches_border) ? 0.5 : 1,
  };
  const confidence = Math.min(...Object.values(factors));
  const accepted = confidence >= S.min_confidence;
  return Object.freeze({
    status: accepted ? 'OK' : 'LOW_CONFIDENCE', accepted, failure_reason: accepted ? null : 'CONFIDENCE_BELOW_THE_MINIMUM',
    alpha, bounds: boundsOfPlane(alpha, width, height, 1), confidence, factors,
    edge_quality: eq, holes, fragments, semi_transparent_share: interior ? semi / interior : 0, ground,
    components: described.map(({ plane, ...o }) => ({ ...o, selected: chosen.some((c) => c.id === o.id) })),
    component_masks: Object.freeze(Object.fromEntries(chosen.map((o) => [o.id, o.plane]))),
    split_touching: Boolean(split), excluded: others,
  });
}

/** The LOCAL deterministic segmenter (analysis + selection). */
export function segmentLocal(rgba, selection = { mode: 'AUTO' }, analysis = null) {
  const an = analysis ?? analyseLocal(rgba);
  return an.failure ?? segmentFromAnalysis(rgba, an, selection);
}

function medianContrast(rgba, core, ground) {
  const v = [];
  for (let i = 0; i < core.length; i += 1) if (core[i]) v.push(dist(rgba.pixels, i * 4, ground));
  v.sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
}

// ---- the provider-independent contract ------------------------------------------------------------------------------------------------------------------------------------

/** Validate any segmentation (local or from a port). Returns { ok, problems }. */
export function validateSegmentation(seg, { width, height }) {
  const problems = [];
  if (!seg || typeof seg !== 'object') return { ok: false, problems: ['NOT_AN_OBJECT'] };
  if (!['OK', 'LOW_CONFIDENCE', 'FAILED'].includes(seg.status)) problems.push('STATUS_UNKNOWN');
  if (seg.status !== 'FAILED') {
    if (!(seg.alpha instanceof Uint8Array) || seg.alpha.length !== width * height) problems.push('ALPHA_WRONG_SIZE');
    if (!(Number.isFinite(seg.confidence) && seg.confidence >= 0 && seg.confidence <= 1)) problems.push('CONFIDENCE_NOT_IN_0_1');
    const b = seg.bounds;
    if (!b || !['x0', 'y0', 'x1', 'y1'].every((k) => Number.isInteger(b[k])) || b.x0 < 0 || b.y0 < 0 || b.x1 >= width || b.y1 >= height || b.x1 < b.x0 || b.y1 < b.y0) problems.push('BOUNDS_INVALID');
    if (!seg.edge_quality || typeof seg.edge_quality !== 'object') problems.push('EDGE_QUALITY_MISSING');
  } else if (typeof seg.failure_reason !== 'string' || !seg.failure_reason) problems.push('FAILURE_REASON_MISSING');
  if (problems.length === 0 && seg.alpha && seg.bounds) {
    const real = boundsOfPlane(seg.alpha, width, height, 1);
    if (!real) problems.push('ALPHA_EMPTY');
    else if (real.x0 !== seg.bounds.x0 || real.y0 !== seg.bounds.y0 || real.x1 !== seg.bounds.x1 || real.y1 !== seg.bounds.y1) problems.push('BOUNDS_DO_NOT_MATCH_THE_ALPHA');
  }
  return { ok: problems.length === 0, problems };
}

/** Cache of segmentations: the same source + selection + options + segmenter gives the same mask, reused instead of recomputed (and, for a port, without a second provider call). */
export function createSegmentationCache() {
  const map = new Map(); const stats = { hits: 0, misses: 0 };
  return Object.freeze({
    stats,
    key: (rgba, selection, id) => sha(Buffer.concat([Buffer.from(JSON.stringify([rgba.width, rgba.height, selection ?? null, id])), Buffer.from(rgba.pixels)])),
    get(k) { if (map.has(k)) { stats.hits += 1; return map.get(k); } stats.misses += 1; return undefined; },
    set(k, v) { if (map.size >= PERFORMANCE.cache_max_entries) map.delete(map.keys().next().value); map.set(k, v); },
  });
}

/**
 * THE ENTRY POINT. A port (`{ id, segment({ rgba, selection }) }`) may replace the local segmenter; its answer is validated by the same contract and a violation is a failure.
 * Never throws for an input problem: it returns a FAILED result with the reason. A result with status LOW_CONFIDENCE has `accepted: false`.
 */
export function segmentProduct({ rgba, selection = { mode: 'AUTO' }, port = null, cache = null }) {
  if (!isRgba(rgba)) return Object.freeze({ status: 'FAILED', accepted: false, failure_reason: SEG_REASON.INVALID_INPUT, confidence: 0, alpha: null, bounds: null, components: [], edge_quality: null, source: { kind: 'NONE' } });
  const id = port ? `PORT:${port.id ?? 'unnamed'}` : 'LOCAL:plain-ground@1';
  const k = cache ? cache.key(rgba, selection, id) : null;
  if (cache) { const hit = cache.get(k); if (hit) return hit; }
  let seg;
  if (port) {
    let raw;
    try { raw = port.segment({ rgba, selection }); } catch (e) { raw = null; seg = Object.freeze({ status: 'FAILED', accepted: false, failure_reason: SEG_REASON.PORT_FAILED, confidence: 0, alpha: null, bounds: null, components: [], edge_quality: null, evidence: { message: String(e?.message ?? e).slice(0, 120) } }); }
    if (raw !== null) {
      const v = validateSegmentation(raw, rgba);
      if (!v.ok) seg = Object.freeze({ status: 'FAILED', accepted: false, failure_reason: SEG_REASON.PORT_CONTRACT_VIOLATION, confidence: 0, alpha: null, bounds: null, components: [], edge_quality: null, evidence: { problems: v.problems } });
      else {
        const accepted = raw.status === 'OK' && raw.confidence >= S.min_confidence;
        seg = Object.freeze({ components: [], ...raw, status: raw.status === 'OK' && !accepted ? 'LOW_CONFIDENCE' : raw.status, accepted, failure_reason: accepted ? null : (raw.failure_reason ?? 'CONFIDENCE_BELOW_THE_MINIMUM') });
      }
    }
  } else {
    const ak = cache ? cache.key(rgba, null, `${id}:analysis`) : null; let an = cache ? cache.get(ak) : undefined;
    if (!an) { an = analyseLocal(rgba); if (cache) cache.set(ak, an); }
    seg = an.failure ?? segmentFromAnalysis(rgba, an, selection);
  }
  const out = Object.freeze({ ...seg, source: Object.freeze({ kind: port ? 'PORT' : 'LOCAL', id }) });
  if (cache) cache.set(k, out);
  return out;
}
