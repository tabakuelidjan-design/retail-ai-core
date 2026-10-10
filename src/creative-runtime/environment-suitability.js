// Is a generated ENVIRONMENT really an environment? The request asks for an empty scene, but a provider may draw an object anyway (the first real run returned a phone
// standing on a stone slab). The real product is composited over this image, so structure belongs to the real product and to the text, never to the environment: where the
// product will be placed the environment must be a CALM surface. Calm is measured, not judged: the share of strong luma edges (Sobel, level >= STRONG_EDGE_LEVEL) in the
// product zone (the placed box plus a margin). Evidence behind the provisional limit (first real environment, 1080 x 1350): empty backdrop regions 0 % strong edges and a mean
// gradient of 0.6-1.2; the zone holding the provider's phone 7 % and a mean gradient of 3.9. The gate is deterministic and says why it refuses.

export const SUITABILITY = Object.freeze({
  rule: 'THE_ENVIRONMENT_IS_A_CALM_SURFACE_WHERE_THE_PRODUCT_IS_PLACED',
  zone_margin: 0.08, // of the placed box, on every side
  strong_edge_level: 12, // luma levels per pixel (Sobel magnitude / 2)
  max_strong_edge_share: 0.02,
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

/** @returns {{ suitable, rule, zone, measured, limit }}; an unmeasurable zone is not suitable. */
export function assessEnvironment({ environment, productBox }) {
  const m = SUITABILITY.zone_margin;
  const zone = { x: productBox.x - productBox.width * m, y: productBox.y - productBox.height * m, width: productBox.width * (1 + 2 * m), height: productBox.height * (1 + 2 * m) };
  const measured = zoneStructure(environment, zone);
  const suitable = measured.samples > 0 && measured.strong_edge_share <= SUITABILITY.max_strong_edge_share;
  return Object.freeze({ suitable, rule: SUITABILITY.rule, zone, measured, limit: { max_strong_edge_share: SUITABILITY.max_strong_edge_share, strong_edge_level: SUITABILITY.strong_edge_level } });
}
