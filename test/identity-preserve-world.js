// A synthetic "personalised phone case" for the IDENTITY_PRESERVE measurements: a source photograph (the product on a speckled dark table) and candidates in which
// the same product is edited / composited (new background, new scale and position, relighting) or mutated (camera geometry, lenses, stretch, artwork, printed text,
// colour, duplicate, outline). Everything is drawn by the real rasterizer from deterministic SVG: no network, no randomness (a seeded generator).

import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export const PRODUCT = { width: 300, height: 500 };
export const SOURCE_SIZE = { width: 600, height: 800 };
export const PLACE_IN_SOURCE = { x: 150, y: 120 };
export const SOURCE_ASSET = 'asset://test/identity/real-case';
export const DERIVED_ASSET = 'asset://test/identity/edited-case';

/** The product alone (transparent around it). */
export function productSvg({
  artworkSeed = 1, lensCount = 3, moduleShift = 0, extraLens = false, textDamage = false, textFade = false, cornerRadius = 30, filter = null,
} = {}) {
  const r = rng(artworkSeed); const art = [];
  const palette = ['#e9a15b', '#f2c48d', '#6fa3d8', '#c46f4d', '#f6e3c8', '#3c6e9e', '#d98a52'];
  for (let i = 0; i < 160; i += 1) {
    const x = 8 + r() * 280; const y = 190 + r() * 300; const c = palette[Math.floor(r() * palette.length)];
    art.push(r() > 0.5 ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(3 + r() * 14).toFixed(1)}" fill="${c}"/>` : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(4 + r() * 26).toFixed(1)}" height="${(4 + r() * 20).toFixed(1)}" fill="${c}"/>`);
  }
  const sky = [];
  for (let i = 0; i < 60; i += 1) sky.push(`<circle cx="${(8 + r() * 284).toFixed(1)}" cy="${(8 + r() * 180).toFixed(1)}" r="${(4 + r() * 12).toFixed(1)}" fill="${['#9cc4ea', '#f7d9b0', '#fff3e0'][Math.floor(r() * 3)]}"/>`);
  const strokes = [];
  const t = rng(textDamage ? 123 : 99);
  for (let line = 0; line < 8; line += 1) for (let seg = 0; seg < 7; seg += 1) strokes.push(`<rect x="${(58 + seg * 26 + t() * 6).toFixed(1)}" y="${(392 + line * 8).toFixed(1)}" width="${(10 + t() * 14).toFixed(1)}" height="2.5" fill="#2a2a30"/>`);
  const lensY = [58, 92, 126].slice(0, lensCount).map((y) => y + moduleShift);
  const lenses = lensY.map((y) => `<circle cx="${59 + moduleShift}" cy="${y}" r="12" fill="#0b0c0e"/>`);
  if (extraLens) lenses.push(`<circle cx="${59 + moduleShift}" cy="${160 + moduleShift}" r="12" fill="#0b0c0e"/>`);
  const body = `<rect width="300" height="500" rx="${cornerRadius}" fill="#15191d"/>`
    + `<clipPath id="a"><rect x="8" y="8" width="284" height="484" rx="${Math.max(6, cornerRadius - 6)}"/></clipPath>`
    + `<g clip-path="url(#a)"><rect x="8" y="8" width="284" height="484" fill="#d9e6f3"/>${sky.join('')}${art.join('')}`
    + `<rect x="46" y="384" width="208" height="76" fill="#f4efe8"/>${strokes.join('')}${textFade ? '<rect x="46" y="384" width="208" height="76" fill="#f4efe8" opacity="0.9"/>' : ''}</g>`
    + `<rect x="${24 + moduleShift}" y="${24 + moduleShift}" width="70" height="150" rx="35" fill="#3a3d42"/>${lenses.join('')}<circle cx="${116 + moduleShift}" cy="${40 + moduleShift}" r="8" fill="#55585c"/>`;
  const defs = filter ? `<defs><filter id="f">${filter}</filter></defs>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500" viewBox="0 0 300 500">${defs}<g${filter ? ' filter="url(#f)"' : ''}>${body}</g></svg>`;
}

const png = (svg) => new Uint8Array(new Resvg(svg).render().asPng());
const dataUri = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

/** The source photograph: the real (default) product on a speckled dark table. */
export function sourcePhoto() {
  const r = rng(5); const speck = [];
  for (let i = 0; i < 500; i += 1) speck.push(`<rect x="${(r() * 600).toFixed(0)}" y="${(r() * 800).toFixed(0)}" width="${(2 + r() * 14).toFixed(0)}" height="2" fill="${r() > 0.5 ? '#2b2724' : '#0d0c0b'}"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" fill="#1a1715"/>${speck.join('')}`
    + `<image x="${PLACE_IN_SOURCE.x}" y="${PLACE_IN_SOURCE.y}" width="300" height="500" href="${dataUri(png(productSvg()))}"/></svg>`;
  return png(svg);
}
export const SOURCE = sourcePhoto();

const P = (x, y) => [PLACE_IN_SOURCE.x + x, PLACE_IN_SOURCE.y + y];
const rounded = [[30, 0], [270, 0], [292, 8], [300, 30], [300, 470], [292, 492], [270, 500], [30, 500], [8, 492], [0, 470], [0, 30], [8, 8]];
/** The identity annotations of the real case, normalized to the source. */
export const ANNOTATIONS = Object.freeze({
  outline: rounded.map(([x, y]) => { const [px, py] = P(x, y); return [px / 600, py / 800]; }),
  camera_module: { x: P(59, 0)[0] / 600, y_top: P(0, 59)[1] / 800, y_bottom: P(0, 139)[1] / 800, radius: 35 / 600 },
  lenses: [58, 92, 126].map((y) => ({ x: P(59, 0)[0] / 600, y: P(0, y)[1] / 800, r: 12 / 600 })),
  artwork_region: { x: P(10, 0)[0] / 600, y: P(0, 240)[1] / 800, width: 280 / 600, height: 250 / 800 },
  text_regions: [{ region_id: 'printed-text', x: P(46, 0)[0] / 600, y: P(0, 384)[1] / 800, width: 208 / 600, height: 76 / 800 }],
});

export const CANVAS = { width: 1080, height: 1350 };
export const PROVIDER = { provider_id: 'alibaba-cloud-model-studio', model: 'qwen-image-3.0-pro', region: 'eu-central-1', request_id: 'req-test-0001' };

export const BACKGROUNDS = {
  white: '<rect width="1080" height="1350" fill="#ffffff"/>',
  studio: '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8edf2"/><stop offset="1" stop-color="#b9c4cf"/></linearGradient></defs><rect width="1080" height="1350" fill="url(#g)"/><ellipse cx="540" cy="1180" rx="380" ry="40" fill="#9aa6b2"/>',
  dark: '<rect width="1080" height="1350" fill="#2a2f35"/>',
};

/**
 * One candidate: the (possibly mutated) product placed on a background at (x, y) with scales (sx, sy), optionally twice.
 * `variant` mutates the product itself; `filter` relights / tints it.
 */
export function buildCandidate({
  background = 'white', x = 330, y = 320, sx = 1.2, sy = 1.2, variant = {}, duplicateAt = null, scaleX = null,
} = {}) {
  const product = png(productSvg(variant));
  const place = (px, py) => `<image x="${px}" y="${py}" width="${PRODUCT.width * (scaleX ?? sx)}" height="${PRODUCT.height * sy}" preserveAspectRatio="none" href="${dataUri(product)}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">${BACKGROUNDS[background]}${place(x, y)}${duplicateAt ? place(duplicateAt[0], duplicateAt[1]) : ''}</svg>`;
  return { png: png(svg), product_sha: sha(product), draws: duplicateAt ? 2 : 1 };
}

export function measurementInput(candidate, over = {}) {
  return {
    source: { bytes: SOURCE, sha256: sha(SOURCE), origin: 'MERCHANT_PROVIDED', width_px: SOURCE_SIZE.width, height_px: SOURCE_SIZE.height },
    derivation: {
      source_asset_ref: SOURCE_ASSET, source_sha256: sha(SOURCE), derived_asset_ref: DERIVED_ASSET, derived_sha256: candidate.product_sha, producer: PROVIDER,
    },
    candidate: { png_bytes: candidate.png },
    canvas: CANVAS,
    product_layers: [{ preservation_mode: 'IDENTITY_PRESERVE' }],
    render_log: { resolutions: [{ ref: DERIVED_ASSET, sha256: candidate.product_sha }], image_draws: 1 },
    expected: { source_asset_ref: SOURCE_ASSET, pinned_sha256: sha(SOURCE), derived_asset_ref: DERIVED_ASSET, piece_count: 1 },
    annotations: ANNOTATIONS,
    ...over,
  };
}
