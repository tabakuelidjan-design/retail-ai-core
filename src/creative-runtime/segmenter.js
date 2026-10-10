import { createHash } from 'node:crypto';

import { rasterizeToPixels } from '../creative-intelligence/production-render.js';
import { buildProductMask } from '../creative-intelligence/product-mask.js';
import { makeProductCutout } from '../creative-intelligence/product-cutout.js';
import { COMPONENT, DECISION } from './ledger.js';

// The LOCAL product segmenter: no provider, no model, no network, no randomness. It cuts the REAL product out of the merchant photograph with the deterministic
// mask (product-mask.js) and hands back a transparent cut-out whose pixels are the source pixels. A mask it cannot trust is reported, never hidden.

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createLocalProductSegmenter({ ledger, options = {} } = {}) {
  return Object.freeze({
    component: COMPONENT.LOCAL_PRODUCT_SEGMENTER,
    /**
     * @param {object} input { asset: { ref, bytes, media_type, width_px, height_px }, annotations: { outline: [[x, y]] normalized } }
     */
    async segment({ asset, annotations }) {
      const uri = `data:${asset.media_type};base64,${Buffer.from(asset.bytes).toString('base64')}`;
      const rgba = rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width_px}" height="${asset.height_px}" viewBox="0 0 ${asset.width_px} ${asset.height_px}"><image width="${asset.width_px}" height="${asset.height_px}" preserveAspectRatio="none" href="${uri}"/></svg>`);
      const mask = buildProductMask({ rgba, inner_outline: annotations.outline.map(([x, y]) => [x * asset.width_px, y * asset.height_px]), options });
      const cutout = makeProductCutout({ rgba, mask });
      const cutoutSha = sha256(cutout.png_bytes);
      ledger?.record({
        decision: DECISION.SEGMENTATION, decided_by: COMPONENT.LOCAL_PRODUCT_SEGMENTER, rule: 'LOCAL_DETERMINISTIC_MASK_FROM_THE_ANNOTATED_OUTLINE',
        basis: [asset.ref],
        outcome: {
          where: 'LOCAL', provider: null, confident: mask.quality.confident, edge_step_positive_share: mask.quality.edge_step_positive_share, shape_model: mask.quality.shape.model,
          median_residual_px: mask.quality.shape.median_residual_px ?? null, cutout_width_px: cutout.width, cutout_height_px: cutout.height, cutout_sha256_prefix: cutoutSha.slice(0, 16),
        },
      });
      return Object.freeze({
        component: COMPONENT.LOCAL_PRODUCT_SEGMENTER, cutout_png: cutout.png_bytes, cutout_sha256: cutoutSha, width_px: cutout.width, height_px: cutout.height, crop: cutout.crop, quality: mask.quality,
      });
    },
  });
}
