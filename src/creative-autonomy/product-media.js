// Internal Shopify source-image selection for Creative Production. No customer approval prompt,
// no image-generation call, no write to Shopify. The caller supplies the already VERIFIED tenant Shopify connector.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImageInfo } from '../asset-library/image-info.js';
import { runAutonomous } from './run.js';

export const CREATIVE_PRODUCT_MEDIA_QUERY = [
  'query NordlaCreativeProductMedia($productId: ID!) {',
  '  product(id: $productId) {',
  '    id title status',
  '    variants(first: 100) { nodes { id title } }',
  '    media(first: 100) {',
  '      nodes { ... on MediaImage { id alt image { url width height altText } } }',
  '      pageInfo { hasNextPage endCursor }',
  '    }',
  '  }',
  '}',
].join('\n');

export const MEDIA_ERROR = Object.freeze({
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_MISMATCH: 'PRODUCT_MISMATCH',
  VARIANT_NOT_FOUND: 'VARIANT_NOT_FOUND',
  INCOMPLETE_MEDIA_LIST: 'INCOMPLETE_MEDIA_LIST',
  NO_VERIFIED_SOURCE_IMAGE: 'NO_VERIFIED_SOURCE_IMAGE',
  UNSAFE_MEDIA_URL: 'UNSAFE_MEDIA_URL',
  MEDIA_DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
  INVALID_IMAGE_BYTES: 'INVALID_IMAGE_BYTES',
});
export class CreativeMediaError extends Error {
  constructor(code, reason = '') {
    super('CREATIVE_MEDIA_' + code + (reason ? ': ' + reason : ''));
    this.name = 'CreativeMediaError';
    this.code = code;
  }
}
const normalize = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const hasTerm = (text, term) => (' ' + text + ' ').includes(' ' + normalize(term) + ' ');
// The brand's French variant names in Shopify and their English labels in supplier image filenames.
const COLORS = Object.freeze({
  noir: ['noir', 'black'], gris: ['gris', 'gray', 'grey'], blanc: ['blanc', 'white'],
  bleu: ['bleu', 'blue'], rose: ['rose', 'pink'], vert: ['vert', 'green'],
  jaune: ['jaune', 'yellow'], rouge: ['rouge', 'red'],
  'rouge cramoisi': ['crimson', 'cramoisi', 'rouge cramoisi'],
});
const colorFor = (name) => {
  const n = normalize(name);
  if (COLORS[n]) return n;
  return Object.keys(COLORS).find((key) => COLORS[key].includes(n)) ?? null;
};
const recognizedColor = (text, color) => COLORS[color]?.some((word) => hasTerm(text, word)) ?? false;
const wrongColor = (text, expected) => Object.keys(COLORS).some((key) => {
  if (key === expected) return false;
  // "red" is part of "rose red" and "crimson red" naming; never guess these ambiguous files.
  return recognizedColor(text, key) && !(expected === 'rouge cramoisi' && key === 'rouge');
});
const mediaDescription = (item) => {
  let basename = '';
  try { basename = decodeURIComponent(new URL(item?.image?.url).pathname.split('/').at(-1) ?? ''); } catch { return null; }
  return normalize([basename, item?.alt, item?.image?.altText].filter(Boolean).join(' '));
};
const capacityTokens = (s) => {
  const text = normalize(s);
  const matches = [];
  for (const m of text.matchAll(/(?:^|\s)(\d{2,4})\s*ml(?:\s|$)/g)) matches.push(Number(m[1]));
  for (const m of text.matchAll(/(?:^|\s)(\d{1,2})\s*oz(?:\s|$)/g)) matches.push(Number(m[1]) * 29.5735295625);
  return matches;
};
const expectedCapacity = (title) => {
  const ml = normalize(title).match(/(?:^|\s)(\d{2,4})\s*ml(?:\s|$)/);
  return ml ? Number(ml[1]) : null;
};
const capacityMatches = (mediaText, ml) => {
  if (ml == null) return true;
  const measurements = capacityTokens(mediaText);
  // An underspecified photograph is NOT verified for an explicitly sized product.
  // 25 oz = 739.34 ml, sold as 750 ml; reject 24 oz, 20 oz, etc.
  return measurements.length > 0 && measurements.every((n) => Math.abs(n - ml) <= 16);
};
const modelTokens = (s) => Array.from(normalize(s).matchAll(/(?:^|\s)ts\s*(\d{3,6}[a-z]?)\b/g), (m) => m[1]);

/** Pure matching: positive evidence for the exact variant and size; contradictory source metadata always wins. */
export function chooseVerifiedProductImage({ product, variantTitle }) {
  if (!product?.id) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  if (product.status !== 'ACTIVE') throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH, 'product not active');
  if (product.media?.pageInfo?.hasNextPage === true) throw new CreativeMediaError(MEDIA_ERROR.INCOMPLETE_MEDIA_LIST);
  const variants = product.variants?.nodes ?? [];
  const variant = variants.find((v) => normalize(v.title) === normalize(variantTitle ?? 'Default Title'));
  if (!variant) throw new CreativeMediaError(MEDIA_ERROR.VARIANT_NOT_FOUND);
  const key = colorFor(variant.title);
  const capacity = expectedCapacity(product.title);
  const expectedModel = modelTokens(product.title);
  const options = [];
  for (const media of product.media?.nodes ?? []) {
    if (!media?.id || !media.image?.url) continue;
    let url;
    try { url = new URL(media.image.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.shopify.com' || url.username || url.password) continue;
    const text = mediaDescription(media);
    if (!text) continue;
    if (key && (!recognizedColor(text, key) || wrongColor(text, key))) continue;
    if (key === 'rouge cramoisi' && !(hasTerm(text, 'crimson') || hasTerm(text, 'cramoisi'))) continue;
    if (!capacityMatches(text, capacity)) continue;
    const models = modelTokens(text);
    if (models.length && expectedModel.length && models.some((m) => !expectedModel.includes(m))) continue;
    const w = media.image.width, h = media.image.height;
    if (!Number.isInteger(w) || !Number.isInteger(h) || Math.min(w, h) < 800 || Math.max(w, h) > 6000) continue;
    options.push({ media_id: media.id, url: url.toString(), width_px: w, height_px: h,
      variant_id: variant.id, variant_title: variant.title, product_id: product.id,
      evidence: { variant: key ? 'EXPLICIT_COLOR_IN_IMAGE_METADATA' : 'DEFAULT_VARIANT', capacity: capacity == null ? 'NOT_APPLICABLE' : 'EXPLICIT_MATCHED_CAPACITY', supplier_model: expectedModel.length && models.length ? 'MATCHED' : 'NOT_ASSERTED' } });
  }
  // Higher source resolution first, stable on repeated runs.
  options.sort((a, b) => b.width_px * b.height_px - a.width_px * a.height_px || a.media_id.localeCompare(b.media_id));
  if (!options.length) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, 'no unambiguous image for the exact Shopify variant and capacity');
  return options[0];
}

/** The Shopify connection MUST already be tenant-verified by src/connectors/shopify.js. No credentials here. */
export async function resolveVerifiedShopifyMedia({ shopify, snapshot, variantTitle }) {
  if (typeof shopify?.graphql !== 'function') throw new TypeError('a verified Shopify connector is required');
  const id = snapshot?.product?.id;
  if (typeof id !== 'string' || !id.startsWith('gid://shopify/Product/')) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  const data = await shopify.graphql(CREATIVE_PRODUCT_MEDIA_QUERY, { productId: id });
  const p = data?.product;
  if (!p) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  if (p.id !== id || p.title !== snapshot.product.title) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH);
  const selected = chooseVerifiedProductImage({ product: p, variantTitle });
  const oldVariant = (snapshot.product.variants?.nodes ?? []).find(v => normalize(v.title) === normalize(selected.variant_title));
  if (!oldVariant || oldVariant.id !== selected.variant_id) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH, 'variant identifier changed since snapshot');
  return selected;
}

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/** HTTPS Shopify-CDN only, no redirects, size bounded while streaming. Reject bad or mismatched media bytes. */
export async function fetchVerifiedProductImage(candidate, { fetchImpl = fetch } = {}) {
  let url;
  try { url = new URL(candidate?.url); } catch { throw new CreativeMediaError(MEDIA_ERROR.UNSAFE_MEDIA_URL); }
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.shopify.com' || url.username || url.password || url.port)
    throw new CreativeMediaError(MEDIA_ERROR.UNSAFE_MEDIA_URL);
  let res;
  try { res = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new CreativeMediaError(MEDIA_ERROR.MEDIA_DOWNLOAD_FAILED); }
  if (!res?.ok || !res.body?.getReader) throw new CreativeMediaError(MEDIA_ERROR.MEDIA_DOWNLOAD_FAILED);
  const length = Number(res.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_MEDIA_BYTES) throw new CreativeMediaError(MEDIA_ERROR.INVALID_IMAGE_BYTES, 'file exceeds byte limit');
  const reader = res.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MEDIA_BYTES) throw new CreativeMediaError(MEDIA_ERROR.INVALID_IMAGE_BYTES, 'file exceeds byte limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks, size);
  const info = readImageInfo(bytes);
  if (!info || !['image/png', 'image/jpeg', 'image/webp'].includes(info.media_type) ||
      info.width_px !== candidate.width_px || info.height_px !== candidate.height_px ||
      Math.min(info.width_px, info.height_px) < 800 || Math.max(info.width_px, info.height_px) > 6000)
    throw new CreativeMediaError(MEDIA_ERROR.INVALID_IMAGE_BYTES, 'image type or measured dimensions do not match Shopify');
  return { bytes, info, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Stages a source locally; never pushes the photo to a provider, and never mutates Shopify. */
export async function stageVerifiedShopifyMedia({ shopify, snapshot, variantTitle, workdir, fetchImpl = fetch }) {
  const candidate = await resolveVerifiedShopifyMedia({ shopify, snapshot, variantTitle });
  const photo = await fetchVerifiedProductImage(candidate, { fetchImpl });
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[photo.info.media_type];
  const path = join(workdir, 'source-' + photo.sha256.slice(0, 16) + '.' + ext);
  mkdirSync(workdir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, photo.bytes, { flag: 'wx' });
  else if (!readFileSync(path).equals(photo.bytes)) throw new CreativeMediaError(MEDIA_ERROR.INVALID_IMAGE_BYTES, 'source on disk has changed');
  const record = { media_id: candidate.media_id, product_id: candidate.product_id, variant_id: candidate.variant_id,
    variant_title: candidate.variant_title, sha256: photo.sha256, width_px: photo.info.width_px, height_px: photo.info.height_px,
    media_type: photo.info.media_type, evidence: candidate.evidence };
  writeFileSync(join(workdir, 'source-media-selection.json'), JSON.stringify(record, null, 2));
  return { photoPath: path, photoMeta: { media_type: photo.info.media_type, width_px: photo.info.width_px,
    height_px: photo.info.height_px, origin: 'SHOPIFY_CATALOG_VERIFIED_METADATA', rights_class: 'UNKNOWN' }, record };
}

/** Real creative entrypoint for a pre-verified Shopify connector: NO request to the customer to confirm the original photo. */
export async function runAutonomousWithShopifyMedia({
  shopify, snapshot, variantTitle, objective, brand, format, workdir, ports, engines, fetchImpl = fetch, run = runAutonomous,
}) {
  const staged = await stageVerifiedShopifyMedia({ shopify, snapshot, variantTitle, workdir, fetchImpl });
  const result = await run({ input: { product: snapshot.product, variantTitle, readAt: snapshot.read_at,
    objective, brand, format, photoPath: staged.photoPath, photoMeta: staged.photoMeta }, ports, engines, workdir,
    produce: 'SELECTED' });
  return { ...result, media_selection: staged.record };
}
