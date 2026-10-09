// A synthetic, generic world for the deterministic Creative Fidelity measurements and the Guardian rules: a synthetic "photograph" (never a merchant asset), a document that
// places it PIXEL_PRESERVE, the real renderer and the real rasterizer. CI-safe: nothing here is private.

import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const MERCHANT = '11111111-1111-4111-8111-111111111111';
export const BRAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ASSET = 'asset://test/synthetic-photo';
export const OTHER_ASSET = 'asset://test/another-photo';
export const PRODUCT = 'product://test/synthetic-product';
export const AT = '2026-10-10T10:00:00.000Z';
export const CANVAS = { width: 1080, height: 1350, background: '#FFFFFF' };
export const SRC = { width: 300, height: 400 };

/** A deterministic synthetic image with a distinct dark border (so its rectangle is measurable), colour blocks and a fine-detail patch (a stand-in for printed text). */
function scene(seed) {
  let blocks = '';
  for (let i = 0; i < 12; i += 1) {
    const r = (i * 53 + seed * 31) % 220 + 20; const g = (i * 97 + seed * 17) % 200 + 30; const b = (i * 29 + seed * 71) % 210 + 25;
    blocks += `<rect x="${20 + (i % 4) * 65}" y="${20 + Math.floor(i / 4) * 80}" width="60" height="75" fill="rgb(${r},${g},${b})"/>`;
  }
  let lines = '';
  for (let i = 0; i < 40; i += 1) lines += `<rect x="${60 + (i % 5) * 3}" y="${262 + i * 2}" width="${100 + ((i * 7 + seed) % 40)}" height="1" fill="rgb(${(i * 11) % 255},60,${(i * 5 + seed) % 255})"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SRC.width}" height="${SRC.height}"><rect width="${SRC.width}" height="${SRC.height}" fill="rgb(24,24,24)"/>`
    + `<rect x="10" y="10" width="${SRC.width - 20}" height="${SRC.height - 20}" fill="rgb(235,228,216)"/>${blocks}${lines}</svg>`;
}
export const sourceBytes = (seed = 1) => new Uint8Array(new Resvg(scene(seed)).render().asPng());
export const SOURCE = sourceBytes(1);
export const OTHER_SOURCE = sourceBytes(7);
/** The owner-annotated protected region, normalized in the source (the fine-detail patch). */
export const TEXT_REGION = { region_id: 'printed-text', x: 55 / 300, y: 255 / 400, width: 150 / 300, height: 90 / 400 };

export const EMPTY_FONTS = { get: () => null, has: () => false };
const geo = (x, y, width, height) => ({ x, y, width, height, rotation_deg: 0 });
const common = (id, type, z, geometry, origin) => ({
  id, type, z_index: z, geometry, visibility: 'VISIBLE', locked: false, source_ref: null, constraints: [], effects: [], provenance: { origin, producer_ref: null, evidence_refs: [] },
});

export const productLayer = (over = {}) => ({
  ...common('product', 'PRODUCT', 10, geo(190, 300, 700, 800), 'PROVIDED_ASSET'),
  product_ref: PRODUCT,
  asset_ref: ASSET,
  preservation_mode: 'PIXEL_PRESERVE',
  protected_regions: [TEXT_REGION],
  allow_crop: false,
  allow_relight: false,
  allow_shadow: false,
  allow_rotation: false,
  ...over,
});
export const backgroundLayer = (fill = CANVAS.background) => ({ ...common('bg', 'BACKGROUND', 0, geo(0, 0, CANVAS.width, CANVAS.height), 'ENGINE'), fill });

export function buildDocument({ layers = [backgroundLayer(), productLayer()], claimRefs = [], assetRefs = [ASSET] } = {}) {
  return CI.buildDesignDocument({
    version: 1,
    merchant_id: MERCHANT,
    brand_id: BRAND,
    brief_ref: 'brief:test',
    direction_ref: 'direction:test',
    output_context: {
      content_kind: 'IMAGE', channel: 'SOCIAL_FEED', placement: 'FEED_POST', format_ref: 'format://test/feed-4x5', canvas: { width: CANVAS.width, height: CANVAS.height }, aspect_ratio: '4:5',
      physical_or_digital: 'DIGITAL', viewing_distance_m: null, expected_dwell_time_s: 2, safe_zones: [], forbidden_zones: [], locale: 'fr-BE', direction: 'LTR', production_constraints: [],
    },
    canvas: { width: CANVAS.width, height: CANVAS.height, background_color: CANVAS.background },
    layers,
    constraints: [],
    asset_refs: assetRefs,
    claim_refs: claimRefs,
    provenance: { schema_version: CI.CI_VERSION, derivation: 'CREATE', parent_document_ref: null, created_by: 'ENGINE', producer_refs: ['engine:test'], evidence_refs: [] },
    created_at: AT,
  });
}

/** The real renderer + the real rasterizer. `mutateSvg` models a regression AFTER the document (a renderer / pipeline defect); `bytes` is what the renderer is handed for the asset. */
export function renderCandidate({ document = buildDocument(), fonts = EMPTY_FONTS, bytes = SOURCE, mutateSvg = null } = {}) {
  const log = P.createRenderLog((ref) => (ref === ASSET ? bytes : null));
  const rendered = CI.renderDesignDocument({ document, fonts, assetResolver: log.resolver });
  const svg = mutateSvg ? mutateSvg(rendered.svg) : rendered.svg;
  const png = new Uint8Array(new Resvg(svg).render().asPng());
  return { document, rendered, svg, png, log: log.finish(svg) };
}

/** The measurement inputs for a candidate (the verified source stays the ORIGINAL bytes, whatever the renderer was handed). */
export function measurementInput(candidate, over = {}) {
  const layers = candidate.document.layers.filter((l) => l.type === 'PRODUCT');
  return {
    source: {
      bytes: SOURCE, sha256: sha(SOURCE), origin: 'MERCHANT_PROVIDED', width_px: SRC.width, height_px: SRC.height, has_alpha: false,
    },
    candidate: { png_bytes: candidate.png },
    canvas: { width: CANVAS.width, height: CANVAS.height, background: candidate.document.canvas.background_color },
    product_layers: layers,
    raster_layer_count: candidate.document.layers.filter((l) => l.type === 'IMAGE' || l.type === 'LOGO').length,
    render_log: candidate.log,
    expected: { asset_ref: ASSET, pinned_sha256: sha(SOURCE), piece_count: 1 },
    text_regions: layers.flatMap((l) => l.protected_regions),
    ...over,
  };
}

export const outcomes = (observations) => Object.fromEntries(observations.map((o) => [o.code, o.outcome]));
