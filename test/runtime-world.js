// A synthetic product-preserving creative run: a synthetic case on a brighter table (so its rim can be detected), approved copy and claims, the real HABB expression system,
// the DejaVu fixture font for every typography role, a FAKE Creative Director model and a FAKE environment provider. No network, no credential, no private media.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

import * as P from '../src/creative-intelligence/production.js';
import { productSvg, PRODUCT, PLACE_IN_SOURCE, ANNOTATIONS as BASE } from './identity-preserve-world.js';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const png = (svg) => new Uint8Array(new Resvg(svg).render().asPng());
const uri = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

export const IDS = {
  merchant_id: '11111111-1111-4111-8111-111111111111',
  brand_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  brief_ref: 'brief:test-runtime-001',
  product_ref: 'product://test/runtime-case',
};
export const SOURCE_REF = 'asset://test/runtime/real-case';

// the source photograph: the synthetic case on a mid-tone speckled table (the rim is darker than the table, as on a real photo)
function sourcePhoto() {
  let s = 5; const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const speck = []; for (let i = 0; i < 500; i += 1) speck.push(`<rect x="${(r() * 600).toFixed(0)}" y="${(r() * 800).toFixed(0)}" width="${(2 + r() * 14).toFixed(0)}" height="2" fill="${r() > 0.5 ? '#6b5f55' : '#4a4038'}"/>`);
  return png(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" fill="#5a5148"/>${speck.join('')}<image x="${PLACE_IN_SOURCE.x}" y="${PLACE_IN_SOURCE.y}" width="300" height="500" href="${uri(png(productSvg()))}"/></svg>`);
}
export const SOURCE = sourcePhoto();

// the owner-style annotation: an INNER outline (the edge of the printed artwork, 8 px inside the rim), regions and lenses as in the identity world
const P8 = (x, y) => [(PLACE_IN_SOURCE.x + x) / 600, (PLACE_IN_SOURCE.y + y) / 800];
export const ANNOTATIONS = Object.freeze({
  ...BASE,
  outline: [[30, 8], [270, 8], [284, 12], [292, 30], [292, 470], [288, 484], [270, 492], [30, 492], [12, 484], [8, 470], [8, 30], [12, 12]].map(([x, y]) => P8(x, y)),
});

// the brand: the REAL HABB expression system, brand tokens, one fixture font for every role
const expression = JSON.parse(readFileSync(new URL('../benchmarks/creative-intelligence/habb-expression-system-benchmark-001.json', import.meta.url), 'utf8')).expression_system;
const FONT = 'font:runtime-fixture-sans';
const fontBytes = new Uint8Array(readFileSync(new URL('./fixtures/fonts/DejaVuSans.ttf', import.meta.url)));
export const fonts = P.createRealFontRegistry([P.createRealFont({
  font_ref: FONT, bytes: fontBytes, metadata: { family: 'DejaVu Sans', style: 'normal', weight: 400, version: '1.0', format: 'ttf', content_hash: sha(fontBytes), license_ref: 'license://fixture-font' },
})]);
export const BRAND = {
  expression,
  colors: { navy: '#183247', terracotta: '#C56E54', cream: '#FBF8F3', white: '#FFFFFF', navyDeep: '#0F2A52', red: '#C0392B' },
  typography_roles: Object.fromEntries(['headline', 'price', 'speed_claim', 'supporting'].map((r) => [r, { instance_ref: FONT }])),
};

export function buildBrief(over = {}) {
  return {
    ids: IDS,
    public_facts: { product: 'Coque personnalisée pour téléphone, imprimée avec la photo du client', merchant: 'HABB, Namur' },
    approved_copy: [{ ref: 'copy://test/headline', role: 'HEADLINE', content: 'Vos souvenirs. Votre création.' }],
    claims: [
      { ref: 'claim://test/promise', role: 'SUBHEADLINE', wording: 'Coque personnalisée en 5 minutes' },
      { ref: 'claim://test/price', role: 'PRICE', wording: '25 €' },
    ],
    format: { ref: 'format://test/feed-1080x1350', canvas: { width: 1080, height: 1350 }, medium: 'DIGITAL', aspect_ratio: '4:5', safe_zones: [], forbidden_zones: [], locale: 'fr-BE' },
    brand: BRAND,
    asset: { ref: SOURCE_REF, bytes: SOURCE, media_type: 'image/png', width_px: 600, height_px: 800, origin: 'MERCHANT_PROVIDED', sha256: sha(SOURCE), rights_class: 'OWNED', privacy_class: 'BUSINESS' },
    identity_annotations: ANNOTATIONS,
    ...over,
  };
}

/** What a model might answer as the Creative Director: ONLY the creative fields, as JSON text. */
export const directorAnswer = (over = {}) => JSON.stringify({
  concept: 'A single real case, clearly the hero, in a calm studio.',
  copy_intent: 'Show the personalised case and the approved message.',
  visual_intent: 'a clean, bright, seamless studio surface with soft directional daylight and a quiet, pale background',
  product_role: 'HERO',
  spatial_intent: 'PRODUCT_CENTER_TEXT_ABOVE',
  negative_space_intent: 'TOP',
  hierarchy: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE'],
  ...over,
});

/** A fake environment provider: a pale studio gradient of the requested size, with provenance. It records the request it was given. */
export function fakeEnvironmentPort({ pixelsOf = null } = {}) {
  const calls = [];
  return {
    calls,
    async generate({ request, expected_size: size }) {
      calls.push(request);
      const bytes = pixelsOf ? pixelsOf(size) : png(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef0f2"/><stop offset="1" stop-color="#d4d9de"/></linearGradient></defs><rect width="${size.width}" height="${size.height}" fill="url(#g)"/></svg>`);
      return { output_bytes: bytes, provenance: { provider_id: 'fake-environment-provider', model: 'fake', region: 'test', request_id: 'env-req-1', lane: 'ENVIRONMENT', carries_input_asset: false, sha256: sha(bytes) } };
    },
  };
}
