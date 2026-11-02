// Internal Shopify source-image selection for Creative Production. No customer approval prompt,
// no image-generation call, no write to Shopify.
//
// Evidence order (strongest first):
//   1. the variant's OWN media in Shopify (ProductVariant.media, set by the merchant): an explicit catalog link;
//   2. a product with a single variant: every product image shows that variant;
//   3. otherwise every option value of the variant (colour, capacity) must be POSITIVELY evidenced in the image
//      metadata. An option Nordla cannot verify (size S/XL, "Bordeaux", "128 Go"...) means NO image, never a guess.
// Contradictory metadata (another colour, another capacity, another model reference) always excludes an image,
// even an explicitly linked one. Several eligible images are tried in order: a corrupt download falls back to the next.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImageInfo } from '../asset-library/image-info.js';
import { runAutonomous } from './run.js';

const MEDIA_FIELDS = '... on MediaImage { id alt image { url width height altText } }';
export const CREATIVE_PRODUCT_MEDIA_QUERY = [
  'query NordlaCreativeProductMedia($productId: ID!) {',
  '  product(id: $productId) {',
  '    id title status description productType tags',
  '    variants(first: 100) {',
  '      nodes { id title price inventoryQuantity selectedOptions { name value }',
  '        media(first: 20) { nodes { ' + MEDIA_FIELDS + ' } pageInfo { hasNextPage } } }',
  '      pageInfo { hasNextPage }',
  '    }',
  '    media(first: 100) {',
  '      nodes { ' + MEDIA_FIELDS + ' }',
  '      pageInfo { hasNextPage endCursor }',
  '    }',
  '  }',
  '}',
].join('\n');

export const MEDIA_ERROR = Object.freeze({
  CONNECTOR_NOT_VERIFIED: 'CONNECTOR_NOT_VERIFIED',
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
  constructor(code, reason = '', attempts = undefined) {
    super('CREATIVE_MEDIA_' + code + (reason ? ': ' + reason : ''));
    this.name = 'CreativeMediaError';
    this.code = code;
    if (attempts) this.attempts = attempts;
  }
}
const normalize = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
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
const capacityOf = (text) => {
  const ml = normalize(text).match(/(?:^|\s)(\d{2,4})\s*ml(?:\s|$)/);
  return ml ? Number(ml[1]) : null;
};
const capacityMatches = (mediaText, ml) => {
  const measurements = capacityTokens(mediaText);
  if (ml == null) return true;
  // An underspecified photograph is NOT verified for an explicitly sized product.
  // 25 oz = 739.34 ml, sold as 750 ml; reject 24 oz, 20 oz, etc.
  return measurements.length > 0 && measurements.every((n) => Math.abs(n - ml) <= 16);
};
const capacityContradicts = (mediaText, ml) => ml != null && capacityTokens(mediaText).some((n) => Math.abs(n - ml) > 16);
const modelTokens = (s) => Array.from(normalize(s).matchAll(/(?:^|\s)ts\s*(\d{3,6}[a-z]?)\b/g), (m) => m[1]);

/** The option values of a variant: Shopify selectedOptions, else the " / "-separated title. */
const optionValues = (variant) => (variant.selectedOptions?.length
  ? variant.selectedOptions.map((o) => o.value)
  : String(variant.title ?? '').split('/').map((s) => s.trim())).filter((v) => v && v !== 'Default Title');

/** What the image must show: colour key and capacity, and whether every option is verifiable from metadata. */
function variantRequirements(product, variant) {
  let color = null; let capacity = capacityOf(product.title); const unverifiable = [];
  for (const value of optionValues(variant)) {
    const c = colorFor(value); const ml = capacityOf(value);
    if (c) color = c;
    else if (ml != null) capacity = ml;
    else unverifiable.push(value);
  }
  return { color, capacity, unverifiable };
}

function eligibleImage(media, req, expectedModel, { explicit }) {
  if (!media?.id || !media.image?.url) return null;
  let url;
  try { url = new URL(media.image.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.shopify.com' || url.username || url.password || url.port) return null;
  const text = mediaDescription(media);
  if (text == null) return null;
  // contradictions exclude even an explicitly linked image
  if (req.color && wrongColor(text, req.color)) return null;
  if (capacityContradicts(text, req.capacity)) return null;
  const models = modelTokens(text);
  if (models.length && expectedModel.length && models.some((m) => !expectedModel.includes(m))) return null;
  if (!explicit) {
    // without a catalog link every attribute needs positive evidence
    if (req.color && !recognizedColor(text, req.color)) return null;
    if (req.color === 'rouge cramoisi' && !(hasTerm(text, 'crimson') || hasTerm(text, 'cramoisi'))) return null;
    if (!capacityMatches(text, req.capacity)) return null;
  }
  const w = media.image.width, h = media.image.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || Math.min(w, h) < 800 || Math.max(w, h) > 6000) return null;
  return { media_id: media.id, url: url.toString(), width_px: w, height_px: h, models };
}

/** Pure matching. Returns every eligible image, best first. Throws when none is verifiable. */
export function chooseVerifiedProductImages({ product, variantTitle }) {
  if (!product?.id) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  if (product.status !== 'ACTIVE') throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH, 'product not active');
  if (product.media?.pageInfo?.hasNextPage === true) throw new CreativeMediaError(MEDIA_ERROR.INCOMPLETE_MEDIA_LIST);
  if (product.variants?.pageInfo?.hasNextPage === true) throw new CreativeMediaError(MEDIA_ERROR.INCOMPLETE_MEDIA_LIST, 'variant list truncated');
  const variants = product.variants?.nodes ?? [];
  const variant = variants.find((v) => normalize(v.title) === normalize(variantTitle ?? 'Default Title'));
  if (!variant) throw new CreativeMediaError(MEDIA_ERROR.VARIANT_NOT_FOUND);
  const req = variantRequirements(product, variant);
  const expectedModel = modelTokens(product.title);
  const linked = (variant.media?.nodes ?? []).filter((m) => m?.id);
  let basis; let pool; let explicit;
  if (linked.length) { basis = 'VARIANT_MEDIA_LINK_IN_SHOPIFY'; pool = linked; explicit = true; }
  else if (variants.length === 1) { basis = 'SINGLE_VARIANT_PRODUCT'; pool = product.media?.nodes ?? []; explicit = true; }
  else {
    if (req.unverifiable.length) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE,
      `variant option(s) ${JSON.stringify(req.unverifiable)} cannot be verified from image metadata; link the image to the variant in Shopify`);
    if (!req.color && req.capacity == null) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, 'no verifiable variant attribute');
    basis = 'EXPLICIT_ATTRIBUTES_IN_IMAGE_METADATA'; pool = product.media?.nodes ?? []; explicit = false;
  }
  const options = [];
  for (const media of pool) {
    const ok = eligibleImage(media, req, expectedModel, { explicit });
    if (!ok) continue;
    options.push({ media_id: ok.media_id, url: ok.url, width_px: ok.width_px, height_px: ok.height_px,
      variant_id: variant.id, variant_title: variant.title, product_id: product.id,
      evidence: { variant: basis, color: req.color ?? 'NOT_APPLICABLE', capacity: req.capacity == null ? 'NOT_APPLICABLE' : (explicit ? 'NOT_CONTRADICTED' : 'EXPLICIT_MATCHED_CAPACITY'),
        supplier_model: expectedModel.length && ok.models.length ? 'MATCHED' : 'NOT_ASSERTED' } });
  }
  // Higher source resolution first, stable on repeated runs.
  options.sort((a, b) => b.width_px * b.height_px - a.width_px * a.height_px || a.media_id.localeCompare(b.media_id));
  if (!options.length) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, 'no unambiguous image for the exact Shopify variant and capacity');
  return options;
}
/** Backward-compatible single choice. */
export const chooseVerifiedProductImage = (args) => chooseVerifiedProductImages(args)[0];

/** The connector must be the tenant-verified one from src/connectors/shopify.js, verified NOW. */
async function assertVerifiedConnector(shopify) {
  if (shopify?.kind !== 'shopify' || typeof shopify.graphql !== 'function' || typeof shopify.state !== 'function')
    throw new CreativeMediaError(MEDIA_ERROR.CONNECTOR_NOT_VERIFIED, 'not a Nordla Shopify connector');
  const state = await shopify.state();
  if (state !== 'CONFIGURED') throw new CreativeMediaError(MEDIA_ERROR.CONNECTOR_NOT_VERIFIED, `connector state ${state}`);
}

/**
 * Reads the product NOW (facts and media in one read-only query) and returns the candidates plus a FRESH snapshot:
 * price, stock and description used by the creative engine come from this read, never from an older snapshot.
 */
export async function resolveVerifiedShopifyMedia({ shopify, snapshot, variantTitle, now = () => new Date() }) {
  await assertVerifiedConnector(shopify);
  const id = snapshot?.product?.id;
  if (typeof id !== 'string' || !id.startsWith('gid://shopify/Product/')) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  const data = await shopify.graphql(CREATIVE_PRODUCT_MEDIA_QUERY, { productId: id });
  const p = data?.product;
  if (!p) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  if (p.id !== id) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH);
  const candidates = chooseVerifiedProductImages({ product: p, variantTitle });
  const requested = (snapshot.product.variants?.nodes ?? []).find((v) => normalize(v.title) === normalize(candidates[0].variant_title));
  if (requested && requested.id !== candidates[0].variant_id) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH, 'variant identifier changed since the request');
  const fresh = { read_at: now().toISOString(), product: { id: p.id, title: p.title, status: p.status, description: p.description, productType: p.productType, tags: p.tags,
    variants: { nodes: (p.variants?.nodes ?? []).map(({ id: vid, title, price, inventoryQuantity }) => ({ id: vid, title, price, inventoryQuantity })) } } };
  return { candidates, snapshot: fresh };
}

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/** Full decode with Pillow (the engines' own dependency), bounded in pixels: a header alone is not an image. */
export function imageDecodes(bytes, { python = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') } = {}) {
  const r = spawnSync(python, ['-c', 'import sys,io\nfrom PIL import Image\nImage.MAX_IMAGE_PIXELS=36000000\nim=Image.open(io.BytesIO(sys.stdin.buffer.read()))\nim.load()\nprint(im.size[0],im.size[1])'],
    { input: bytes, timeout: 30_000 });
  if (r.status !== 0) return null;
  const [w, h] = String(r.stdout).trim().split(' ').map(Number);
  return { width_px: w, height_px: h };
}

/** HTTPS Shopify-CDN only, no redirects, size bounded while streaming. Reject bad or mismatched media bytes. */
export async function fetchVerifiedProductImage(candidate, { fetchImpl = fetch, decode = imageDecodes } = {}) {
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
  const decoded = decode(bytes);
  if (!decoded || decoded.width_px !== info.width_px || decoded.height_px !== info.height_px)
    throw new CreativeMediaError(MEDIA_ERROR.INVALID_IMAGE_BYTES, 'image bytes do not decode completely');
  return { bytes, info, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Stages a source locally, trying each eligible image in order; never pushes to a provider, never mutates Shopify. */
export async function stageVerifiedShopifyMedia({ shopify, snapshot, variantTitle, workdir, fetchImpl = fetch, decode = imageDecodes, now }) {
  const { candidates, snapshot: fresh } = await resolveVerifiedShopifyMedia({ shopify, snapshot, variantTitle, now });
  const attempts = [];
  let candidate = null; let photo = null;
  for (const c of candidates) {
    try { photo = await fetchVerifiedProductImage(c, { fetchImpl, decode }); candidate = c; break; }
    catch (e) { if (!(e instanceof CreativeMediaError)) throw e; attempts.push({ media_id: c.media_id, code: e.code }); }
  }
  if (!photo) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, 'every eligible image failed validation', attempts);
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[photo.info.media_type];
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
  const path = join(workdir, 'source-' + photo.sha256.slice(0, 16) + '.' + ext);
  if (!existsSync(path)) writeFileSync(path, photo.bytes, { flag: 'wx', mode: 0o600 });
  else if (!readFileSync(path).equals(photo.bytes)) throw new CreativeMediaError(MEDIA_ERROR.INVALID_IMAGE_BYTES, 'source on disk has changed');
  const record = { media_id: candidate.media_id, product_id: candidate.product_id, variant_id: candidate.variant_id,
    variant_title: candidate.variant_title, sha256: photo.sha256, width_px: photo.info.width_px, height_px: photo.info.height_px,
    media_type: photo.info.media_type, evidence: candidate.evidence, rejected_before: attempts, facts_read_at: fresh.read_at };
  writeFileSync(join(workdir, 'source-media-selection-' + photo.sha256.slice(0, 16) + '.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  return { photoPath: path, photoBytes: photo.bytes, sha256: photo.sha256, snapshot: fresh,
    photoMeta: { media_type: photo.info.media_type, width_px: photo.info.width_px, height_px: photo.info.height_px,
      origin: 'SHOPIFY_CATALOG_VERIFIED_METADATA', rights_class: 'UNKNOWN' }, record };
}

/**
 * Real creative entrypoint: NO request to the customer to confirm the photo. Ports and engines that transmit the photo
 * (visual critic, scene edit) are bound to the exact bytes, so they are BUILT AFTER the selection by the caller's
 * factories `portsFor` / `enginesFor({ photoBytes, sha256, record })`. Prebuilt `ports` / `engines` remain for doubles.
 */
export async function runAutonomousWithShopifyMedia({
  shopify, snapshot, variantTitle, objective, brand, format, workdir, ports, portsFor, engines, enginesFor,
  fetchImpl = fetch, decode = imageDecodes, run = runAutonomous, now,
}) {
  const staged = await stageVerifiedShopifyMedia({ shopify, snapshot, variantTitle, workdir, fetchImpl, decode, now });
  const bound = { photoBytes: staged.photoBytes, sha256: staged.sha256, record: staged.record };
  const result = await run({ input: { product: staged.snapshot.product, variantTitle, readAt: staged.snapshot.read_at,
    objective, brand, format, photoPath: staged.photoPath, photoMeta: staged.photoMeta },
    ports: portsFor ? await portsFor(bound) : ports, engines: enginesFor ? await enginesFor(bound) : engines, workdir,
    produce: 'SELECTED' });
  return { ...result, media_selection: staged.record };
}
