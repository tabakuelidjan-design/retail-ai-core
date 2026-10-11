// Is a generated ENVIRONMENT usable? The real product is composited over this image, so where it will be placed the scene must offer a SAFE INTEGRATION ZONE: no OBJECT and no strong
// STRUCTURE (a phone on a stone slab, a prop, a hand, a logo). The scene around and under that zone may be as rich as the concept needs: a material (wood grain, stone, fabric) is TEXTURE, not an
// object. The two are told apart by SCALE, measured, not judged: luma is averaged over blocks of about 1.5 % of the canvas width, and a block that differs from its neighbour by more than
// STRUCTURE_LEVEL is a structure. Grain averages out inside a block; an object, a hand or a logo survives it. The share of structure blocks in the product zone (the placed box plus a margin) must
// stay under MAX_STRUCTURE_SHARE. The fine-scale edge share of the first gate (Sobel at pixel scale) is still measured and reported as evidence, but it no longer decides: it counted a worn wooden
// counter as a failure (the first Creative Brain benchmark: pure wood bands measured 9-27 % fine edges and 0-1 % structure).
// Evidence behind the limits (real provider environments, 1080 x 1350, product zone): the phone on a stone slab 10.9 % structure, the first non-empty environment 15.2 %, a stone block on a
// stone counter 4.9 %, a scene with two hands inside the zone 20.3 %; the accepted environments of the first benchmark 0.0-2.0 %, a pure wood counter 1.9 % (and 12.4 % fine edges).

export const SUITABILITY = Object.freeze({
  rule: 'THE_ENVIRONMENT_IS_A_CALM_SURFACE_WHERE_THE_PRODUCT_IS_PLACED',
  zone_margin: 0.08, // of the placed box, on every side
  strong_edge_level: 12, // luma levels per pixel (Sobel magnitude / 2)
  max_strong_edge_share: 0.02, // fine-scale evidence only (no longer decides)
  structure_block_ratio: 0.015, // block size, of the canvas width
  structure_level: 16, // luma levels between neighbouring blocks
  max_structure_share: 0.025,
});

const lumaAt = (pixels, i) => 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];

/** { mean_gradient, strong_edge_share, samples } of a pixel zone (every second pixel). */
export function zoneStructure({ width, height, pixels }, box) {
  const x0 = Math.max(1, Math.floor(box.x)); const y0 = Math.max(1, Math.floor(box.y));
  const x1 = Math.min(width - 1, Math.ceil(box.x + box.width)); const y1 = Math.min(height - 1, Math.ceil(box.y + box.height));
  let sum = 0; let strong = 0; let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const gx = lumaAt(pixels, (y * width + x + 1) * 4) - lumaAt(pixels, (y * width + x - 1) * 4);
      const gy = lumaAt(pixels, ((y + 1) * width + x) * 4) - lumaAt(pixels, ((y - 1) * width + x) * 4);
      const magnitude = Math.hypot(gx, gy) / 2;
      sum += magnitude; if (magnitude > SUITABILITY.strong_edge_level) strong += 1; n += 1;
    }
  }
  return n ? { mean_gradient: sum / n, strong_edge_share: strong / n, samples: n } : { mean_gradient: null, strong_edge_share: null, samples: 0 };
}

/** { structure_share, structure_blocks } of a pixel zone: the share of blocks whose mean luma differs from a neighbouring block by more than the structure level. */
export function zoneObjectStructure({ width, height, pixels }, box) {
  const B = Math.max(8, Math.round(width * SUITABILITY.structure_block_ratio));
  const bx0 = Math.max(0, Math.floor(box.x / B)); const by0 = Math.max(0, Math.floor(box.y / B));
  const bx1 = Math.min(Math.floor(width / B) - 1, Math.ceil((box.x + box.width) / B)); const by1 = Math.min(Math.floor(height / B) - 1, Math.ceil((box.y + box.height) / B));
  const cache = new Map();
  const mean = (bx, by) => {
    const key = (bx * 100003) + by;
    if (!cache.has(key)) { let sum = 0; for (let y = by * B; y < (by + 1) * B; y += 1) for (let x = bx * B; x < (bx + 1) * B; x += 1) sum += lumaAt(pixels, (y * width + x) * 4); cache.set(key, sum / (B * B)); }
    return cache.get(key);
  };
  let strong = 0; let n = 0;
  for (let by = by0; by < by1; by += 1) {
    for (let bx = bx0; bx < bx1; bx += 1) {
      const step = Math.max(Math.abs(mean(bx + 1, by) - mean(bx, by)), Math.abs(mean(bx, by + 1) - mean(bx, by)));
      if (step > SUITABILITY.structure_level) strong += 1;
      n += 1;
    }
  }
  return n ? { structure_share: strong / n, structure_blocks: n } : { structure_share: null, structure_blocks: 0 };
}

/** @returns {{ suitable, rule, zone, measured, limit }}; an unmeasurable zone is not suitable. */
export function assessEnvironment({ environment, productBox }) {
  const m = SUITABILITY.zone_margin;
  const zone = { x: productBox.x - productBox.width * m, y: productBox.y - productBox.height * m, width: productBox.width * (1 + 2 * m), height: productBox.height * (1 + 2 * m) };
  const measured = { ...zoneStructure(environment, zone), ...zoneObjectStructure(environment, zone) };
  const suitable = measured.structure_blocks > 0 && measured.structure_share <= SUITABILITY.max_structure_share;
  return Object.freeze({ suitable, rule: SUITABILITY.rule, zone, measured, limit: { max_structure_share: SUITABILITY.max_structure_share, structure_level: SUITABILITY.structure_level, block_ratio: SUITABILITY.structure_block_ratio, max_strong_edge_share: SUITABILITY.max_strong_edge_share, strong_edge_level: SUITABILITY.strong_edge_level } });
}
