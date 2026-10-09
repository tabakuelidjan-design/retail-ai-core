// Small, deterministic image-matching primitives used by the IDENTITY_PRESERVE fidelity measurements. Pure functions over typed arrays: no I/O, no clock,
// no randomness, no network. Luma planes are Float32Array in the 0..255 range.

export const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** The luma plane of RGBA pixels. */
export function grayOf({ width, height, pixels }) {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) out[i] = lumaOf(pixels[p], pixels[p + 1], pixels[p + 2]);
  return { width, height, data: out };
}

/** Halves a plane by 2x2 box averaging (odd trailing row / column is folded into the last cell). */
export function halve({ width, height, data }) {
  const w = Math.max(1, width >> 1); const h = Math.max(1, height >> 1);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const x0 = x * 2; const y0 = y * 2; const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1);
      out[y * w + x] = (data[y0 * width + x0] + data[y0 * width + x1] + data[y1 * width + x0] + data[y1 * width + x1]) / 4;
    }
  }
  return { width: w, height: h, data: out };
}

/** [level0, level1, ...]: each level is the previous one halved. */
export function pyramidOf(plane, levels = 6) {
  const out = [plane];
  for (let i = 1; i < levels; i += 1) out.push(halve(out[i - 1]));
  return out;
}

/** Bilinear sample of a plane at pixel-centre coordinates (x, y); coordinates are clamped to the plane. */
export function sample({ width, height, data }, x, y) {
  const fx = Math.min(Math.max(x - 0.5, 0), width - 1); const fy = Math.min(Math.max(y - 0.5, 0), height - 1);
  const x0 = Math.floor(fx); const y0 = Math.floor(fy); const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1);
  const ax = fx - x0; const ay = fy - y0;
  const top = data[y0 * width + x0] * (1 - ax) + data[y0 * width + x1] * ax;
  const bottom = data[y1 * width + x0] * (1 - ax) + data[y1 * width + x1] * ax;
  return top * (1 - ay) + bottom * ay;
}

/** The pyramid sample of a source position for a given sampling step (source pixels per output pixel): the coarsest level that is not coarser than the step. */
export function sampleAtStep(pyramid, x, y, step) {
  const level = Math.min(pyramid.length - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, step)))));
  const scale = 2 ** level;
  return sample(pyramid[level], x / scale, y / scale);
}

/** Even-odd point-in-polygon test; `polygon` is [[x, y], ...]. */
export function inPolygon(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const boundsOf = (polygon) => {
  const xs = polygon.map((p) => p[0]); const ys = polygon.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

/** Pearson correlation of two equal-length arrays; null when either has no variance. */
export function pearson(a, b) {
  const n = a.length;
  if (n < 8) return null;
  let sa = 0; let sb = 0;
  for (let i = 0; i < n; i += 1) { sa += a[i]; sb += b[i]; }
  const ma = sa / n; const mb = sb / n;
  let saa = 0; let sbb = 0; let sab = 0;
  for (let i = 0; i < n; i += 1) { const da = a[i] - ma; const db = b[i] - mb; saa += da * da; sbb += db * db; sab += da * db; }
  if (saa < 1e-6 || sbb < 1e-6) return null;
  return sab / Math.sqrt(saa * sbb);
}

/** Connected components (4-neighbourhood) of a boolean grid: [{ area, cx, cy, x0, y0, x1, y1 }]. */
export function components(mask, width, height) {
  const seen = new Uint8Array(mask.length); const out = [];
  const stack = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let area = 0; let sx = 0; let sy = 0; let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop(); const x = i % width; const y = (i - x) / width;
      area += 1; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    out.push({ area, cx: sx / area, cy: sy / area, x0, y0, x1, y1 });
  }
  return out;
}

/** Otsu's threshold of a list of 0..255 values. */
export function otsu(values) {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.min(255, Math.max(0, Math.round(v)))] += 1;
  const total = values.length; let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let wB = 0; let sumB = 0; let best = 0; let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB; const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}
