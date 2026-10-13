// Small deterministic pixel helpers shared by the integration modules. RGBA = { width, height, pixels: Uint8Array(w*h*4) }; a plane = Uint8Array / Float32Array (w*h).

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lumaAt = (p, i) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];

export function isRgba(img) {
  return Boolean(img) && Number.isInteger(img.width) && Number.isInteger(img.height) && img.width > 0 && img.height > 0
    && img.pixels instanceof Uint8Array && img.pixels.length === img.width * img.height * 4;
}

export function lumaPlane(img) {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0; i < out.length; i += 1) out[i] = lumaAt(img.pixels, i * 4);
  return out;
}

/** Separable box blur with an edge clamp, `passes` times (3 passes ~ a gaussian). Float32 in, Float32 out. */
export function boxBlur(plane, width, height, radius, passes = 3) {
  if (radius < 1) return Float32Array.from(plane);
  let src = Float32Array.from(plane); let tmp = new Float32Array(plane.length);
  const r = Math.round(radius); const n = 2 * r + 1;
  for (let p = 0; p < passes; p += 1) {
    for (let y = 0; y < height; y += 1) {
      let acc = 0; const row = y * width;
      for (let k = -r; k <= r; k += 1) acc += src[row + clamp(k, 0, width - 1)];
      for (let x = 0; x < width; x += 1) {
        tmp[row + x] = acc / n;
        acc += src[row + clamp(x + r + 1, 0, width - 1)] - src[row + clamp(x - r, 0, width - 1)];
      }
    }
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let k = -r; k <= r; k += 1) acc += tmp[clamp(k, 0, height - 1) * width + x];
      for (let y = 0; y < height; y += 1) {
        src[y * width + x] = acc / n;
        acc += tmp[clamp(y + r + 1, 0, height - 1) * width + x] - tmp[clamp(y - r, 0, height - 1) * width + x];
      }
    }
  }
  return src;
}

/** L1 (4-neighbour) distance of every mask pixel to the nearest non-mask pixel, the image border counting as non-mask (so a pixel on the border has distance 1). Two passes, O(N). */
export function distanceInside(mask, width, height) {
  const dt = new Uint16Array(mask.length); const BIG = 65000;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = y * width + x; if (!mask[i]) continue;
    const up = y > 0 ? dt[i - width] : 0; const left = x > 0 ? dt[i - 1] : 0;
    dt[i] = Math.min(up, left, BIG) + 1;
  }
  for (let y = height - 1; y >= 0; y -= 1) for (let x = width - 1; x >= 0; x -= 1) {
    const i = y * width + x; if (!mask[i]) continue;
    const down = y < height - 1 ? dt[i + width] : 0; const right = x < width - 1 ? dt[i + 1] : 0;
    dt[i] = Math.min(dt[i], down + 1, right + 1);
  }
  return dt;
}

/** Binary erosion (4-neighbourhood), `radius` steps; the image border counts as outside. Exactly the iterated erosion, computed from one distance transform. */
export function erode(mask, width, height, radius) {
  const dt = distanceInside(mask, width, height); const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i += 1) out[i] = dt[i] > radius ? 1 : 0;
  return out;
}

export function dilate(mask, width, height, radius) {
  let cur = Uint8Array.from(mask);
  for (let k = 0; k < radius; k += 1) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < width - 1 && cur[i + 1]) || (y > 0 && cur[i - width]) || (y < height - 1 && cur[i + width])) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/** Label the 4-connected components of a 0/1 plane. Returns { labels: Int32Array (0 = none, 1..n), list: [{ id, area, x0, y0, x1, y1 }] } */
export function labelComponents(mask, width, height) {
  const labels = new Int32Array(mask.length); const list = []; const stack = [];
  for (let s = 0; s < mask.length; s += 1) {
    if (!mask[s] || labels[s]) continue;
    const id = list.length + 1; let area = 0; let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
    stack.push(s); labels[s] = id;
    while (stack.length) {
      const i = stack.pop(); const x = i % width; const y = (i - x) / width;
      area += 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack.push(i - 1); }
      if (x < width - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && mask[i - width] && !labels[i - width]) { labels[i - width] = id; stack.push(i - width); }
      if (y < height - 1 && mask[i + width] && !labels[i + width]) { labels[i + width] = id; stack.push(i + width); }
    }
    list.push({ id, area, x0, y0, x1, y1 });
  }
  return { labels, list };
}

/** Bounds { x0, y0, x1, y1 } (inclusive) of the pixels where plane[i] >= threshold, or null. */
export function boundsOfPlane(plane, width, height, threshold = 1) {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (plane[y * width + x] >= threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** The boundary pixels of a 0/1 plane: inside pixels with at least one outside 4-neighbour (the border of the image counts as outside). */
export function boundaryOf(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width]) out[i] = 1;
    }
  }
  return out;
}

/** Bilinear resample of an RGBA image to (w, h); alpha is interpolated premultiplied so a transparent edge does not bleed its hidden colour. */
export function resizeRgba(img, w, h) {
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w; const sy = img.height / h;
  for (let y = 0; y < h; y += 1) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, img.height - 1); const y0 = Math.floor(fy); const y1 = Math.min(img.height - 1, y0 + 1); const ty = fy - y0;
    for (let x = 0; x < w; x += 1) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, img.width - 1); const x0 = Math.floor(fx); const x1 = Math.min(img.width - 1, x0 + 1); const tx = fx - x0;
      const taps = [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]];
      let a = 0; let r = 0; let g = 0; let b = 0;
      for (const [px, py, wt] of taps) {
        const p = (py * img.width + px) * 4; const al = img.pixels[p + 3] * wt;
        a += al; r += img.pixels[p] * al; g += img.pixels[p + 1] * al; b += img.pixels[p + 2] * al;
      }
      const q = (y * w + x) * 4;
      out[q + 3] = Math.round(a);
      if (a > 0) { out[q] = Math.round(r / a); out[q + 1] = Math.round(g / a); out[q + 2] = Math.round(b / a); }
    }
  }
  return { width: w, height: h, pixels: out };
}

export const alphaOf = (img) => {
  const a = new Uint8Array(img.width * img.height);
  for (let i = 0; i < a.length; i += 1) a[i] = img.pixels[i * 4 + 3];
  return a;
};

export function pearsonPlane(a, b, idx) {
  let n = 0; let sa = 0; let sb = 0;
  for (const i of idx) { sa += a[i]; sb += b[i]; n += 1; }
  if (n < 16) return null;
  const ma = sa / n; const mb = sb / n; let saa = 0; let sbb = 0; let sab = 0;
  for (const i of idx) { const da = a[i] - ma; const db = b[i] - mb; saa += da * da; sbb += db * db; sab += da * db; }
  if (saa < 1e-9 || sbb < 1e-9) return saa < 1e-9 && sbb < 1e-9 ? 1 : 0;
  return sab / Math.sqrt(saa * sbb);
}

/** For every pixel of `region` within `maxDepth` (4-neighbour steps) of a `sources` pixel: the index of the nearest source pixel; -1 elsewhere. */
export function nearestSource(sources, region, width, height, maxDepth) {
  const n = width * height; const near = new Int32Array(n).fill(-1); const depth = new Uint8Array(n); const queue = [];
  for (let i = 0; i < n; i += 1) if (sources[i]) { near[i] = i; queue.push(i); }
  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head]; if (depth[i] >= maxDepth) continue; const x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i >= width ? i - width : -1, i < n - width ? i + width : -1]) {
      if (j >= 0 && region[j] && near[j] < 0) { near[j] = near[i]; depth[j] = depth[i] + 1; queue.push(j); }
    }
  }
  return near;
}

/** The share of partially transparent pixels (8..247) that are strict local extrema of alpha against all four neighbours (by at least 24): a clean anti-aliased edge is monotonic across the boundary, a jagged one is not. */
export function alphaExtremaShare(alpha, width, height, stride = 1, offset = 0) {
  let partial = 0; let extrema = 0; const at = (x, y) => alpha[(y * width + x) * stride + offset];
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const a = at(x, y); if (a <= 8 || a >= 247) continue; partial += 1;
    const nb = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
    if (nb.every((v) => a >= v + 24) || nb.every((v) => a <= v - 24)) extrema += 1;
  }
  return partial ? extrema / partial : 0;
}
