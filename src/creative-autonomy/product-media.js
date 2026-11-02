// Internal Shopify source-image selection and the production entrypoint of Creative Production.
// The customer selects a product and asks for a creation; Nordla finds and verifies the photo itself. There is NO prompt asking the customer to
// select, confirm or approve a source image. No image-generation call here, no write to Shopify.
//
// Identity: the request names immutable Shopify IDs (product + variant). Titles are informational only (a renamed variant is fine,
// another variant is not).
// Evidence order for an image of the requested variant (strongest first):
//   1. the variant's OWN media in Shopify (ProductVariant.media, set by the merchant): an explicit catalog link;
//   2. a product without options (hasOnlyDefaultVariant): every product image shows that one product;
//   3. otherwise EVERY option value of the variant (colour, capacity) must be POSITIVELY evidenced in the image metadata. An option Nordla
//      cannot verify (size S/XL, "Bordeaux", "128 Go"...) means NO image, never a guess - even when the product has a single variant.
// Contradictory metadata (another colour, another capacity, another model reference) always excludes an image, even an explicitly linked one.
// Eligible images are tried in order (same variant only): a corrupt download falls back to the next one.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImageInfo } from '../asset-library/image-info.js';
import { runAutonomous } from './run.js';
import { authorizeTransmission, policyProblems, CATALOG_ORIGIN } from './media-processing-policy.js';
import { createTransmissionRecorder } from './transmission-recorder.js';

// ---- the read-only query, as a tree: the same tree renders the query string and computes its requested cost (Shopify's published rules)
const MEDIA_IMAGE = { fragment: 'MediaImage', children: [{ name: 'id' }, { name: 'alt' }, { name: 'image', object: true, children: [{ name: 'url' }, { name: 'width' }, { name: 'height' }, { name: 'altText' }] }] };
const PAGE_INFO = { name: 'pageInfo', object: true, children: [{ name: 'hasNextPage' }] };
export const PRODUCT_MEDIA_PAGE = 50;
export const VARIANT_MEDIA_PAGE = 10;
export const PRODUCT_VARIANT_PAGE = 50;
const QUERY_TREE = [
  { name: 'product', args: '(id: $productId)', object: true, children: [
    { name: 'id' }, { name: 'title' }, { name: 'status' }, { name: 'description' }, { name: 'productType' }, { name: 'tags' }, { name: 'hasOnlyDefaultVariant' },
    { name: 'variants', first: PRODUCT_VARIANT_PAGE, connection: true, node: [{ name: 'id' }, { name: 'title' }, { name: 'price' }, { name: 'inventoryQuantity' }], extra: [PAGE_INFO] },
    { name: 'media', first: PRODUCT_MEDIA_PAGE, connection: true, node: [MEDIA_IMAGE], extra: [PAGE_INFO] },
  ] },
  { name: 'productVariant', args: '(id: $variantId)', object: true, children: [
    { name: 'id' }, { name: 'title' }, { name: 'price' }, { name: 'inventoryQuantity' },
    { name: 'product', object: true, children: [{ name: 'id' }] },
    { name: 'selectedOptions', object: true, children: [{ name: 'name' }, { name: 'value' }] },
    { name: 'media', first: VARIANT_MEDIA_PAGE, connection: true, node: [MEDIA_IMAGE], extra: [PAGE_INFO] },
  ] },
];
const render = (nodes) => nodes.map((n) => {
  if (n.fragment) return `... on ${n.fragment} { ${render(n.children)} }`;
  if (n.connection) return `${n.name}(first: ${n.first}) { nodes { ${render(n.node)} } ${render(n.extra ?? [])} }`;
  if (n.object) return `${n.name}${n.args ?? ''} { ${render(n.children)} }`;
  return n.name;
}).join(' ');
/** Requested cost: scalar 0, object 1, connection 2 + first x (cost of one node), interface/union = max of selections. */
export const requestedCost = (nodes) => nodes.reduce((sum, n) => {
  if (n.fragment) return sum + requestedCost(n.children);
  if (n.connection) return sum + 2 + n.first * Math.max(1, 1 + requestedCost(n.node)) + requestedCost(n.extra ?? []);
  if (n.object) return sum + 1 + requestedCost(n.children);
  return sum;
}, 0);
export const CREATIVE_PRODUCT_MEDIA_QUERY = `query NordlaCreativeVariantMedia($productId: ID!, $variantId: ID!) { ${render(QUERY_TREE)} }`;
export const CREATIVE_PRODUCT_MEDIA_QUERY_COST = requestedCost(QUERY_TREE);
export const SHOPIFY_SINGLE_QUERY_MAX_COST = 1000;
if (CREATIVE_PRODUCT_MEDIA_QUERY_COST > SHOPIFY_SINGLE_QUERY_MAX_COST / 2) throw new Error('creative media query too expensive');

export const MEDIA_ERROR = Object.freeze({
  CONNECTOR_NOT_VERIFIED: 'CONNECTOR_NOT_VERIFIED',
  SHOPIFY_QUERY_FAILED: 'SHOPIFY_QUERY_FAILED',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_MISMATCH: 'PRODUCT_MISMATCH',
  VARIANT_NOT_FOUND: 'VARIANT_NOT_FOUND',
  INCOMPLETE_MEDIA_LIST: 'INCOMPLETE_MEDIA_LIST',
  NO_VERIFIED_SOURCE_IMAGE: 'NO_VERIFIED_SOURCE_IMAGE',
  UNSAFE_MEDIA_URL: 'UNSAFE_MEDIA_URL',
  MEDIA_DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
  INVALID_IMAGE_BYTES: 'INVALID_IMAGE_BYTES',
  PROCESSING_NOT_AUTHORIZED: 'PROCESSING_NOT_AUTHORIZED',
  PROVIDER_BINDING_NOT_ESTABLISHED: 'PROVIDER_BINDING_NOT_ESTABLISHED',
  SPEND_NOT_RESERVED: 'SPEND_NOT_RESERVED',
  LEDGER_NOT_DURABLE: 'LEDGER_NOT_DURABLE',
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
// Colour vocabulary (FR catalog names, EN supplier file names). Language data, not a merchant rule; to be moved to configuration (P2).
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
// An underspecified photograph is NOT verified for an explicitly sized product. 25 oz = 739.34 ml, sold as 750 ml; 24 oz, 20 oz are refused.
const capacityMatches = (mediaText, ml) => ml == null || (capacityTokens(mediaText).length > 0 && capacityTokens(mediaText).every((n) => Math.abs(n - ml) <= 16));
const capacityContradicts = (mediaText, ml) => ml != null && capacityTokens(mediaText).some((n) => Math.abs(n - ml) > 16);
const modelTokens = (s) => Array.from(normalize(s).matchAll(/(?:^|\s)ts\s*(\d{3,6}[a-z]?)\b/g), (m) => m[1]);

/** What the image must show: colour, capacity, and the option values Nordla cannot verify from metadata. */
function variantRequirements(product, variant) {
  let color = null; let capacity = capacityOf(product.title); const unverifiable = [];
  const values = product.hasOnlyDefaultVariant === true ? [] : (variant.selectedOptions ?? []).map((o) => o.value).filter((v) => v && v !== 'Default Title');
  for (const value of values) {
    const c = colorFor(value); const ml = capacityOf(value);
    if (c) color = c;
    else if (ml != null) capacity = ml;
    else unverifiable.push(value);
  }
  return { color, capacity, unverifiable, option_count: values.length };
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

/**
 * Pure matching on one Shopify read: { product, productVariant } as returned by CREATIVE_PRODUCT_MEDIA_QUERY.
 * Returns every eligible image of THIS variant, best first. Throws a CreativeMediaError when none is verifiable.
 */
export function chooseVerifiedProductImages({ product, productVariant, productId, variantId }) {
  if (!product?.id) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  if (productId && product.id !== productId) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH);
  if (!productVariant?.id) throw new CreativeMediaError(MEDIA_ERROR.VARIANT_NOT_FOUND);
  if (variantId && productVariant.id !== variantId) throw new CreativeMediaError(MEDIA_ERROR.VARIANT_NOT_FOUND);
  if (productVariant.product?.id !== product.id) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH, 'the variant belongs to another product');
  if (product.status !== 'ACTIVE') throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH, 'product not active');
  // no partial gallery is ever presented as complete
  if (product.media?.pageInfo?.hasNextPage !== false) throw new CreativeMediaError(MEDIA_ERROR.INCOMPLETE_MEDIA_LIST, 'product media');
  if (productVariant.media?.pageInfo?.hasNextPage !== false) throw new CreativeMediaError(MEDIA_ERROR.INCOMPLETE_MEDIA_LIST, 'variant media');
  if (product.variants?.pageInfo?.hasNextPage !== false) throw new CreativeMediaError(MEDIA_ERROR.INCOMPLETE_MEDIA_LIST, 'variant list');
  if (!(product.variants?.nodes ?? []).some((v) => v.id === productVariant.id)) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH, 'variant absent from the product variant list');
  const req = variantRequirements(product, productVariant);
  const expectedModel = modelTokens(product.title);
  const linked = (productVariant.media?.nodes ?? []).filter((m) => m?.id);
  let basis; let pool; let explicit;
  if (linked.length) { basis = 'VARIANT_MEDIA_LINK_IN_SHOPIFY'; pool = linked; explicit = true; }
  else if (product.hasOnlyDefaultVariant === true) { basis = 'PRODUCT_WITHOUT_OPTIONS'; pool = product.media?.nodes ?? []; explicit = true; }
  else {
    if (req.unverifiable.length) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE,
      `variant option(s) ${JSON.stringify(req.unverifiable)} cannot be verified from image metadata; link the image to the variant in Shopify`);
    if (!req.option_count) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, 'no verifiable variant attribute');
    basis = 'EXPLICIT_ATTRIBUTES_IN_IMAGE_METADATA'; pool = product.media?.nodes ?? []; explicit = false;
  }
  const options = [];
  for (const media of pool) {
    const ok = eligibleImage(media, req, expectedModel, { explicit });
    if (!ok) continue;
    options.push({ media_id: ok.media_id, url: ok.url, width_px: ok.width_px, height_px: ok.height_px,
      variant_id: productVariant.id, variant_title: productVariant.title, product_id: product.id,
      evidence: { variant: basis, color: req.color ?? 'NOT_APPLICABLE', capacity: req.capacity == null ? 'NOT_APPLICABLE' : (explicit ? 'NOT_CONTRADICTED' : 'EXPLICIT_MATCHED_CAPACITY'),
        supplier_model: expectedModel.length && ok.models.length ? 'MATCHED' : 'NOT_ASSERTED' } });
  }
  // Higher source resolution first, stable on repeated runs.
  options.sort((a, b) => b.width_px * b.height_px - a.width_px * a.height_px || a.media_id.localeCompare(b.media_id));
  if (!options.length) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, 'no unambiguous image for the exact Shopify variant and capacity');
  return options;
}

/** The connector must be the one of src/connectors/shopify.js, verified NOW for THIS tenant. */
async function assertVerifiedConnector(shopify, merchantId) {
  if (shopify?.kind !== 'shopify' || typeof shopify.graphql !== 'function' || typeof shopify.state !== 'function')
    throw new CreativeMediaError(MEDIA_ERROR.CONNECTOR_NOT_VERIFIED, 'not a Nordla Shopify connector');
  if (typeof merchantId !== 'string' || !merchantId || shopify.merchantId !== merchantId)
    throw new CreativeMediaError(MEDIA_ERROR.CONNECTOR_NOT_VERIFIED, 'connector of another tenant');
  const state = await shopify.state();
  if (state !== 'CONFIGURED') throw new CreativeMediaError(MEDIA_ERROR.CONNECTOR_NOT_VERIFIED, `connector state ${state}`);
}

/**
 * Reads product, variant, media and commercial facts NOW, in ONE bounded read-only query, by immutable IDs.
 * request: { merchantId, productId, variantId, expectedVariantTitle? }. Returns { candidates, snapshot (fresh), identity }.
 */
export async function resolveVerifiedShopifyMedia({ shopify, request, now = () => new Date() }) {
  const { merchantId, productId, variantId } = request ?? {};
  await assertVerifiedConnector(shopify, merchantId);
  if (typeof productId !== 'string' || !productId.startsWith('gid://shopify/Product/')) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  if (typeof variantId !== 'string' || !variantId.startsWith('gid://shopify/ProductVariant/')) throw new CreativeMediaError(MEDIA_ERROR.VARIANT_NOT_FOUND);
  let data;
  try { data = await shopify.graphql(CREATIVE_PRODUCT_MEDIA_QUERY, { productId, variantId }); }
  catch (e) { throw new CreativeMediaError(MEDIA_ERROR.SHOPIFY_QUERY_FAILED, String(e?.message ?? e).slice(0, 200)); }
  const p = data?.product; const v = data?.productVariant;
  if (!p) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_NOT_FOUND);
  const candidates = chooseVerifiedProductImages({ product: p, productVariant: v, productId, variantId });
  const fresh = { read_at: now().toISOString(), product: { id: p.id, title: p.title, status: p.status, description: p.description, productType: p.productType, tags: p.tags,
    variants: { nodes: (p.variants?.nodes ?? []).map(({ id, title, price, inventoryQuantity }) => ({ id, title, price, inventoryQuantity })) } } };
  const identity = { merchant_id: merchantId, product_id: p.id, variant_id: v.id, variant_title: v.title,
    variant_title_changed: Boolean(request.expectedVariantTitle) && normalize(request.expectedVariantTitle) !== normalize(v.title) };
  return { candidates, snapshot: fresh, identity };
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

/** Stages a source locally, trying each eligible image OF THE SAME VARIANT in order; never sends it anywhere, never mutates Shopify. */
export async function stageVerifiedShopifyMedia({ shopify, request, workdir, fetchImpl = fetch, decode = imageDecodes, now }) {
  const { candidates, snapshot: fresh, identity } = await resolveVerifiedShopifyMedia({ shopify, request, now });
  const attempts = [];
  let candidate = null; let photo = null;
  for (const c of candidates) {
    if (c.variant_id !== identity.variant_id) throw new CreativeMediaError(MEDIA_ERROR.PRODUCT_MISMATCH, 'fallback crossed a variant boundary');
    try { photo = await fetchVerifiedProductImage(c, { fetchImpl, decode }); candidate = c; break; }
    catch (e) { if (!(e instanceof CreativeMediaError)) throw e; attempts.push({ media_id: c.media_id, code: e.code }); }
  }
  if (!photo) throw new CreativeMediaError(MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, 'every eligible image failed validation', attempts);
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[photo.info.media_type];
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
  const path = join(workdir, 'source-' + photo.sha256.slice(0, 16) + '.' + ext);
  if (!existsSync(path)) writeFileSync(path, photo.bytes, { flag: 'wx', mode: 0o600 });
  else if (!readFileSync(path).equals(photo.bytes)) throw new CreativeMediaError(MEDIA_ERROR.INVALID_IMAGE_BYTES, 'source on disk has changed');
  const record = { ...identity, media_id: candidate.media_id, sha256: photo.sha256, width_px: photo.info.width_px, height_px: photo.info.height_px,
    media_type: photo.info.media_type, evidence: candidate.evidence, rejected_before: attempts, facts_read_at: fresh.read_at };
  writeFileSync(join(workdir, 'source-media-selection-' + photo.sha256.slice(0, 16) + '.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  return { photoPath: path, photoBytes: photo.bytes, sha256: photo.sha256, snapshot: fresh, identity,
    asset_ref: `asset://shopify/${identity.product_id.split('/').pop()}/${identity.variant_id.split('/').pop()}/${photo.sha256.slice(0, 16)}`,
    photoMeta: { media_type: photo.info.media_type, width_px: photo.info.width_px, height_px: photo.info.height_px,
      origin: CATALOG_ORIGIN, rights_class: 'UNKNOWN' }, record };
}

/** A service that may transmit the photo must declare it is bound to THIS source; anything undeclared fails closed. */
function assertBinding(service, label, { sha256, mustTransmit, authorizationId = null, journalId = null }) {
  const b = service?.binding;
  if (!b || typeof b.transmits_source_media !== 'boolean') throw new CreativeMediaError(MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED, `${label}: no binding declared`);
  if (mustTransmit && !b.transmits_source_media) throw new CreativeMediaError(MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED, `${label}: not connected to the selected source`);
  if (b.transmits_source_media && b.source_sha256 !== sha256) throw new CreativeMediaError(MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED, `${label}: bound to another source`);
  // a service that can send media must write into THIS run's transmission recorder, otherwise nothing proves what it sent
  if (b.transmits_source_media && journalId && b.journal_id !== journalId) throw new CreativeMediaError(MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED, `${label}: not wired to the run's transmission audit`);
  if (authorizationId && b.authorization_id !== undefined && b.authorization_id !== authorizationId) throw new CreativeMediaError(MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED, `${label}: another authorization`);
}

export const CRITIC_PROCESSING = Object.freeze({ operation: 'VISION_CRITIQUE', purpose: 'NORDLA_CREATIVE_CRITIQUE' });
export const SCENE_PROCESSING = Object.freeze({ operation: 'IMAGE_EDIT', purpose: 'NORDLA_SCENE_PRODUCTION' });

/**
 * The production entrypoint. Order, every step fail-closed:
 *   1 select + fully validate the source photo (same variant only), 2 SHA-256,
 *   3 the tenant's ACCEPTED standing policy, read from the durable ledger (never from the caller) -> per-photo authorizations, AUTHORIZED events,
 *   4 ATOMIC reservation of the whole run ceiling in the ledger (per-run and monthly limits, idempotent per run id), RESERVED events,
 *   5 the critic and 6 the scene engine built FROM THOSE BYTES with this run's transmission recorder as their journal,
 *   7 both must declare a binding to that SHA and to that recorder, their spend guard may not exceed the reservation, 8 run,
 *   9 settle the reservation with the application's measured amount, or release it when no media was ever attempted.
 * Preconstructed `ports` / `engines` are refused. A non-durable ledger (memory) is refused unless `nonProduction: true` is declared.
 * providers: { portsFor({ photoBytes, sha256, authorization, journal }), enginesFor({ photoBytes, sha256, authorization, journal }), critic: {provider_id, region}, scene?: {provider_id, region} }
 */
export async function runAutonomousWithShopifyMedia({
  shopify, request, objective, brand, format, workdir, ledger, policyId, providers, runCeilingEur, runId,
  fetchImpl = fetch, decode = imageDecodes, run = runAutonomous, now = () => new Date(), mirror = null, nonProduction = false, ports, engines,
}) {
  if (ports !== undefined || engines !== undefined) throw new TypeError('preconstructed ports/engines are refused: pass providers.portsFor / providers.enginesFor');
  if (typeof providers?.portsFor !== 'function' || typeof providers?.enginesFor !== 'function') throw new TypeError('providers.portsFor and providers.enginesFor are required');
  if (!ledger?.reserve || !ledger?.record || !ledger?.currentPolicy) throw new TypeError('a Creative ledger is required');
  if (ledger.durable !== true && nonProduction !== true) throw new CreativeMediaError(MEDIA_ERROR.LEDGER_NOT_DURABLE, 'a non-durable ledger can only serve a declared non-production run');
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(runId)) throw new TypeError('a stable runId is required (idempotency key of the reservation)');
  if (!(runCeilingEur > 0)) throw new TypeError('runCeilingEur must be > 0');
  const staged = await stageVerifiedShopifyMedia({ shopify, request, workdir, fetchImpl, decode, now });
  const at = now();
  // 3 the policy IN FORCE for this tenant, as accepted in the durable ledger
  const accepted = await ledger.currentPolicy({ merchantId: request.merchantId, policyId });
  if (!accepted?.content || !Number.isInteger(accepted.version)) throw new CreativeMediaError(MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED, 'NO_ACCEPTED_POLICY');
  const problems = policyProblems(accepted.content);
  if (problems.length) throw new CreativeMediaError(MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED, `POLICY_INVALID ${JSON.stringify(problems)}`);
  const authorize = (processing, target) => {
    const a = authorizeTransmission({ policy: accepted.content, request: { merchantId: request.merchantId, shopId: request.shopId, now: at, runId, runCeilingEur, acceptedVersion: accepted.version,
      source: { sha256: staged.sha256, asset_ref: staged.asset_ref, origin: staged.photoMeta.origin, media_id: staged.record.media_id },
      provider_id: target?.provider_id, region: target?.region, purpose: processing.purpose, operation: processing.operation } });
    if (!a.allowed) throw new CreativeMediaError(MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED, `${processing.operation}: ${a.reason}${a.detail ? ' ' + JSON.stringify(a.detail) : ''}`);
    return a;
  };
  const critic = authorize(CRITIC_PROCESSING, providers.critic);
  const scene = providers.scene ? authorize(SCENE_PROCESSING, providers.scene) : null;
  const ctx = { merchantId: request.merchantId, runId, policyId, policyVersion: accepted.version, sourceSha256: staged.sha256, now };
  const targets = { VISION_CRITIQUE: { authorizationId: critic.authorization.authorization_id, providerId: providers.critic.provider_id, region: providers.critic.region },
    ...(scene ? { IMAGE_EDIT: { authorizationId: scene.authorization.authorization_id, providerId: providers.scene.provider_id, region: providers.scene.region } } : {}) };
  const recorder = createTransmissionRecorder({ ledger, ctx, targets, mirror });
  // 4 atomic reservation of the WHOLE ceiling, before any provider exists
  const reservation = await ledger.reserve({ merchantId: request.merchantId, runId, policyId, policyVersion: accepted.version, ceilingEur: runCeilingEur, now: at });
  if (!['RESERVED', 'ALREADY_RESERVED'].includes(reservation?.status) || (reservation.status === 'ALREADY_RESERVED' && reservation.run_status !== 'RESERVED'))
    throw new CreativeMediaError(MEDIA_ERROR.SPEND_NOT_RESERVED, reservation?.reason ?? reservation?.run_status ?? 'REFUSED');
  await recorder.authorized(); await recorder.reserved();
  let result; let failure = null; let guard = null;
  try {
    const journal = recorder.providerJournal(null);
    const bound = { photoBytes: staged.photoBytes, sha256: staged.sha256, asset_ref: staged.asset_ref, journal };
    const runPorts = await providers.portsFor({ ...bound, authorization: critic.authorization });
    assertBinding(runPorts, 'visual critic', { sha256: staged.sha256, mustTransmit: true, journalId: recorder.id });
    const runEngines = await providers.enginesFor({ ...bound, authorization: scene?.authorization ?? null });
    assertBinding(runEngines, 'scene engine', { sha256: staged.sha256, mustTransmit: Boolean(scene), authorizationId: scene?.authorization.authorization_id ?? null, journalId: recorder.id });
    guard = runPorts.budget;
    if (!guard?.snapshot || !(guard.maxSpendEur <= runCeilingEur)) throw new CreativeMediaError(MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED, 'the run spend guard must exist and not exceed the reserved ceiling');
    if (scene && runEngines.spendGuard !== guard) throw new CreativeMediaError(MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED, 'the scene engine must spend through the same guard as the critic');
    result = await run({ input: { product: staged.snapshot.product, variantTitle: staged.identity.variant_title, readAt: staged.snapshot.read_at,
      objective, brand, format, photoPath: staged.photoPath, photoMeta: staged.photoMeta },
      ports: runPorts, engines: runEngines, workdir, produce: 'SELECTED' });
  } catch (e) { failure = e; }
  const spent = guard?.snapshot ? guard.snapshot() : null;
  // 9 close the reservation: settle what may have been spent, release what never was (attempt evidence comes from the ledger itself)
  let closing;
  if (recorder.attemptedAny()) {
    // settled + still-held reservations of the application spend guard (a failed call keeps its reservation: its cost is unknown, counted)
    closing = await ledger.settle({ merchantId: request.merchantId, runId, settledEur: spent ? Math.round((spent.settled_eur + spent.reserved_eur) * 10000) / 10000 : runCeilingEur,
      basis: spent ? 'APPLICATION_SPEND_GUARD' : 'CEILING_OUTCOME_UNKNOWN', now: now() });
  } else {
    await recorder.cancelled(failure ? String(failure.code ?? 'RUN_FAILED') : 'NO_MEDIA_ATTEMPT');
    closing = await ledger.release({ merchantId: request.merchantId, runId, reason: failure ? 'RUN_FAILED_BEFORE_ATTEMPT' : 'NO_MEDIA_ATTEMPT', now: now() });
  }
  if (failure) throw Object.assign(failure, { reservation_closing: closing });
  return { ...result, published: false, customer_review: 'PENDING', media_selection: staged.record, run_id: runId,
    policy: { policy_id: policyId, version: accepted.version }, reservation: { status: reservation.status, ceiling_eur: runCeilingEur, closing } };
}
