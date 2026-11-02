import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseVerifiedProductImage, resolveVerifiedShopifyMedia, fetchVerifiedProductImage,
  stageVerifiedShopifyMedia, runAutonomousWithShopifyMedia,
  CREATIVE_PRODUCT_MEDIA_QUERY, CREATIVE_PRODUCT_MEDIA_QUERY as QUERY, MEDIA_ERROR, CreativeMediaError,
} from '../src/creative-autonomy/product-media.js';

const PID = 'gid://shopify/Product/15514012254556';
const BLACK = 'gid://shopify/ProductVariant/57246326784348';
const PINK = 'gid://shopify/ProductVariant/57246326620508';
const CDN = 'https://cdn.shopify.com/s/files/1/abcd/files/';
const image = (id, file, alt = 'TYESO 750ml', width = 2000, height = 2000) => ({
  id: 'gid://shopify/MediaImage/' + id,
  alt, image: { url: CDN + file + '?v=1', width, height, altText: alt },
});
const base = (items) => ({
  id: PID, status: 'ACTIVE', title: 'Gourde Tyeso TS-8771C à paille – 750 ml',
  variants: { nodes: [{ id: BLACK, title: 'Noir' }, { id: PINK, title: 'Rose' }] },
  media: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } },
});
const bad = image(1, 'TYESO_Wander_With_Straw_Black_20oz.webp', 'Tyeso 318 Straw Bottle 750ml');
const good = image(2, 'TYESO_Wander_With_Straw_Black_25oz.jpg', 'TYESO black 750ml');
const goodSmall = image(3, 'TYESO_Wander_Black_25oz.jpg', 'TYESO black 750ml', 1000, 1000);
const pink = image(4, 'TYESO_Wander_Pink_25oz.jpg', 'TYESO pink 750ml');
const snapshot = (p = base([bad, good, pink])) => ({
  read_at: '2026-11-02', product: { id: p.id, title: p.title,
    variants: { nodes: p.variants.nodes.map(({ id, title }) => ({ id, title, price: '29.90', inventoryQuantity: 7 })) },
  },
});
const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pngCache = new Map();
// a REAL, fully decodable PNG (a 44-byte header is not an image)
function png(width = 2000, height = 2000) {
  const k = width + 'x' + height;
  if (!pngCache.has(k)) pngCache.set(k, execFileSync(PY, ['-c', `import sys,io\nfrom PIL import Image\nb=io.BytesIO();Image.new('RGB',(${width},${height}),(20,20,20)).save(b,'PNG');sys.stdout.buffer.write(b.getvalue())`]));
  return pngCache.get(k);
}
// the tenant-verified connector shape of src/connectors/shopify.js
const source = (product, state = 'CONFIGURED') => ({ kind: 'shopify', calls: [], async state() { return state; }, async graphql(q, vars) {
  this.calls.push({ q, vars });
  return { product };
} });

test('Shopify read-only media query asks for all variant and image evidence, with pagination', () => {
  assert.match(CREATIVE_PRODUCT_MEDIA_QUERY, /media\(first: 100\)/);
  assert.match(CREATIVE_PRODUCT_MEDIA_QUERY, /hasNextPage endCursor/);
  assert.match(QUERY, /variants\(first: 100\)/);
  assert.doesNotMatch(QUERY, /mutation\s/);
});

test('reject HABB Black_20oz despite misleading 750ml alt: no pre-client approval and no accidental small bottle', () => {
  assert.throws(() => chooseVerifiedProductImage({ product: base([bad, pink]), variantTitle: 'Noir' }),
    (e) => e instanceof CreativeMediaError && e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
});

test('automatically select Black_25oz over Black_20oz and any other color; prefer larger verified source', () => {
  const choice = chooseVerifiedProductImage({ product: base([bad, goodSmall, pink, good]), variantTitle: 'Noir' });
  assert.equal(choice.media_id, good.id);
  assert.equal(choice.variant_id, BLACK);
  assert.equal(choice.evidence.capacity, 'EXPLICIT_MATCHED_CAPACITY');
  assert.equal(choice.evidence.variant, 'EXPLICIT_ATTRIBUTES_IN_IMAGE_METADATA'); assert.equal(choice.evidence.color, 'noir');
  assert.equal(choice.width_px, 2000);
});

test('fail closed on ambiguous metadata, absent variant, unsafe URL, incomplete list or unverified model', () => {
  const samples = [
    image(7, 'TYESO_Wander_Black_25oz.jpg', 'TYESO 20oz black 750ml'),
    image(8, 'TYESO_Wander_Black_25oz.jpg', 'TYESO TS-8772C black 750ml'),
    image(9, 'unlabeled.webp', 'Tyeso 750ml'),
    image(10, 'TYESO_Wander_Black_25oz.jpg', 'Tyeso black 750ml', 600, 600),
    { ...good, image: { ...good.image, url: 'http://evil.example/black_25oz.jpg' } },
    { ...good, image: { ...good.image, url: 'https://tyeso.com/black_25oz.jpg' } },
  ];
  for (const sample of samples) assert.throws(() => chooseVerifiedProductImage({ product: base([sample]), variantTitle: 'Noir' }),
    (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, JSON.stringify(sample));
  assert.throws(() => chooseVerifiedProductImage({ product: base([good]), variantTitle: 'Rose' }), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
  assert.throws(() => chooseVerifiedProductImage({ product: base([good]), variantTitle: 'Rouge' }), (e) => e.code === MEDIA_ERROR.VARIANT_NOT_FOUND);
  assert.throws(() => chooseVerifiedProductImage({ product: { ...base([good]), media: { nodes: [good], pageInfo: { hasNextPage: true } } }, variantTitle: 'Noir' }),
    (e) => e.code === MEDIA_ERROR.INCOMPLETE_MEDIA_LIST);
});

test('verified tenant Shopify connector is invoked only for the specified product ID and same variant ID', async () => {
  const shopify = source(base([bad, good]));
  const { candidates } = await resolveVerifiedShopifyMedia({ shopify, snapshot: snapshot(), variantTitle: 'Noir' });
  assert.equal(candidates[0].media_id, good.id);
  assert.deepEqual(shopify.calls[0].vars, { productId: PID });
  const swapped = source({ ...base([good]), variants: { nodes: [{ id: 'gid://shopify/ProductVariant/DIFFERENT', title: 'Noir' }] } });
  await assert.rejects(() => resolveVerifiedShopifyMedia({ shopify: swapped, snapshot: snapshot(), variantTitle: 'Noir' }),
    (e) => e.code === MEDIA_ERROR.PRODUCT_MISMATCH);
});

test('download validates the CDN host, blocks redirects and checks actual type and dimensions', async () => {
  const c = chooseVerifiedProductImage({ product: base([good]), variantTitle: 'Noir' });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(png(), { status: 200, headers: { 'content-type': 'image/png' } }); };
  const got = await fetchVerifiedProductImage(c, { fetchImpl });
  assert.equal(got.info.media_type, 'image/png');
  assert.equal(got.info.width_px, 2000);
  assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(() => fetchVerifiedProductImage({ ...c, url: 'https://evil.example/black_25oz.jpg' }, { fetchImpl }),
    (e) => e.code === MEDIA_ERROR.UNSAFE_MEDIA_URL);
  await assert.rejects(() => fetchVerifiedProductImage(c, { fetchImpl: async () => new Response(png(1000,1000)) }),
    (e) => e.code === MEDIA_ERROR.INVALID_IMAGE_BYTES);
});

test('runAutonomousWithShopifyMedia stages the exact validated image without customer source-photo approval', async () => {
  const shopify = source(base([bad, good]));
  const workdir = mkdtempSync(join(tmpdir(), 'nordla-shopify-image-'));
  const calls = [];
  const result = await runAutonomousWithShopifyMedia({
    shopify, snapshot: snapshot(), variantTitle: 'Noir', objective: 'Communiquer sur la gourde TYESO',
    brand: { merchant_id: 'fixture' }, format: 'INSTAGRAM_FEED_4_5', workdir,
    ports: { text: null }, engines: {},
    fetchImpl: async () => new Response(png()),
    run: async (args) => { calls.push(args); return { status: 'TEST_DOUBLE_DONE', published: false, human_interventions: [{ when: 'après le passage', who: 'client', what: 'évaluer le rendu fini', creative: true }] }; },
  });
  assert.equal(result.status, 'TEST_DOUBLE_DONE');
  assert.equal(result.media_selection.media_id, good.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].produce, 'SELECTED');
  assert.equal(calls[0].input.variantTitle, 'Noir');
  assert.equal(calls[0].input.photoMeta.media_type, 'image/png');
  assert.deepEqual(readFileSync(calls[0].input.photoPath), png());
  const selection = JSON.parse(readFileSync(join(workdir, readdirSync(workdir).find((f) => f.startsWith('source-media-selection-'))), 'utf8'));
  assert.equal(selection.variant_id, BLACK);
  assert.equal(selection.sha256, result.media_selection.sha256);
  assert.ok(!JSON.stringify(result).includes('confirmer la photo'));
});

test('when only mislabeled 20oz images are available, no download, generation or customer confirmation is attempted', async () => {
  let touched = 0;
  await assert.rejects(() => runAutonomousWithShopifyMedia({
    shopify: source(base([bad, pink])), snapshot: snapshot(), variantTitle: 'Noir', objective: 'Test',
    brand: {}, format: 'INSTAGRAM_FEED_4_5', workdir: mkdtempSync(join(tmpdir(), 'nordla-unsafe-media-')),
    fetchImpl: async () => { touched++; throw Error('must not call'); },
    run: async () => { touched++; throw Error('must not call'); },
  }), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
  assert.equal(touched, 0);
});

// ---- audit 2026-11-02: defects reproduced on PR #37 head 2bcd3f5, now refused or handled ----
const img = (id, file, alt, w = 2000, h = 2000) => ({ id: 'gid://shopify/MediaImage/' + id, alt, image: { url: CDN + file, width: w, height: h, altText: alt } });
const prod = (title, variants, media) => ({ id: PID, status: 'ACTIVE', title,
  variants: { nodes: variants.map((v, i) => typeof v === 'string' ? { id: 'gid://shopify/ProductVariant/' + i, title: v } : { id: 'gid://shopify/ProductVariant/' + i, ...v }) },
  media: { nodes: media, pageInfo: { hasNextPage: false } } });

test('a multi-option variant "Noir / 500 ml" never takes the pink 1000 ml photograph', () => {
  const p = prod('Gourde isotherme', ['Noir / 500 ml', 'Rose / 1000 ml'], [img(1, 'gourde_rose_1000ml.jpg', 'gourde rose 1000ml')]);
  assert.throws(() => chooseVerifiedProductImage({ product: p, variantTitle: 'Noir / 500 ml' }), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
  const ok = prod('Gourde isotherme', ['Noir / 500 ml', 'Rose / 1000 ml'], [img(1, 'gourde_rose_1000ml.jpg', 'gourde rose 1000ml'), img(2, 'gourde_black_500ml.jpg', 'gourde noire 500ml')]);
  assert.equal(chooseVerifiedProductImage({ product: ok, variantTitle: 'Noir / 500 ml' }).media_id, 'gid://shopify/MediaImage/2');
});

test('options Nordla cannot read from metadata (size XL, colour "Bordeaux") are refused, never guessed', () => {
  assert.throws(() => chooseVerifiedProductImage({ product: prod('T-shirt', ['S', 'XL'], [img(3, 'tshirt_S.jpg', 'T-shirt S')]), variantTitle: 'XL' }),
    (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE && /XL/.test(e.message));
  assert.throws(() => chooseVerifiedProductImage({ product: prod('Coque', ['Noir', 'Bordeaux'], [img(4, 'coque_black.jpg', 'coque noire')]), variantTitle: 'Bordeaux' }),
    (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
});

test('the variant media link set in Shopify is the strongest evidence, but a contradiction still excludes it', () => {
  const linked = img(5, 'IMG_0042.jpg', '');
  const p = prod('T-shirt', [{ title: 'S' }, { title: 'XL', media: { nodes: [linked] } }], [img(3, 'tshirt_S.jpg', 'T-shirt S'), linked]);
  const c = chooseVerifiedProductImage({ product: p, variantTitle: 'XL' });
  assert.equal(c.media_id, linked.id); assert.equal(c.evidence.variant, 'VARIANT_MEDIA_LINK_IN_SHOPIFY');
  const wrong = img(6, 'Black_20oz.webp', 'TYESO 750ml');
  const t = { ...base([wrong]), variants: { nodes: [{ id: BLACK, title: 'Noir', media: { nodes: [wrong] } }, { id: PINK, title: 'Rose' }] } };
  assert.throws(() => chooseVerifiedProductImage({ product: t, variantTitle: 'Noir' }), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
});

test('a header-only or truncated image is refused: bytes must decode completely', async () => {
  const c = chooseVerifiedProductImage({ product: base([good]), variantTitle: 'Noir' });
  const header = Buffer.from(png()).subarray(0, 60);
  await assert.rejects(() => fetchVerifiedProductImage(c, { fetchImpl: async () => new Response(header) }), (e) => e.code === MEDIA_ERROR.INVALID_IMAGE_BYTES);
});

test('fallback: a corrupt first image is skipped and the next eligible image of the SAME variant is used', async () => {
  const second = image(12, 'TYESO_Wander_Black_25oz_b.jpg', 'TYESO black 750ml', 1500, 1500);
  const shopify = source(base([good, second]));
  const fetchImpl = async (url) => new Response(url.includes('_b.jpg') ? png(1500, 1500) : Buffer.from(png()).subarray(0, 60));
  const staged = await stageVerifiedShopifyMedia({ shopify, snapshot: snapshot(), variantTitle: 'Noir', workdir: mkdtempSync(join(tmpdir(), 'nordla-fallback-')), fetchImpl });
  assert.equal(staged.record.media_id, second.id);
  assert.deepEqual(staged.record.rejected_before, [{ media_id: good.id, code: MEDIA_ERROR.INVALID_IMAGE_BYTES }]);
});

test('only a connector verified for THIS tenant is accepted', async () => {
  const plain = { async graphql() { return { product: base([good]) }; } };
  await assert.rejects(() => resolveVerifiedShopifyMedia({ shopify: plain, snapshot: snapshot(), variantTitle: 'Noir' }), (e) => e.code === MEDIA_ERROR.CONNECTOR_NOT_VERIFIED);
  await assert.rejects(() => resolveVerifiedShopifyMedia({ shopify: source(base([good]), 'MISCONFIGURED'), snapshot: snapshot(), variantTitle: 'Noir' }), (e) => e.code === MEDIA_ERROR.CONNECTOR_NOT_VERIFIED);
});

test('the creative engine receives the price read NOW, not the older snapshot price, and ports are bound to the selected bytes', async () => {
  const current = { ...base([good]), variants: { nodes: [{ id: BLACK, title: 'Noir', price: '24.90', inventoryQuantity: 3 }, { id: PINK, title: 'Rose', price: '24.90', inventoryQuantity: 0 }] } };
  const calls = []; const bound = [];
  await runAutonomousWithShopifyMedia({ shopify: source(current), snapshot: snapshot(), variantTitle: 'Noir', objective: 'x', brand: {}, format: 'INSTAGRAM_FEED_4_5',
    workdir: mkdtempSync(join(tmpdir(), 'nordla-fresh-')), fetchImpl: async () => new Response(png()),
    portsFor: async (b) => { bound.push(b.sha256); return { text: null }; },
    run: async (args) => { calls.push(args); return { status: 'TEST_DOUBLE_DONE' }; } });
  assert.equal(calls[0].input.product.variants.nodes[0].price, '24.90');
  assert.match(calls[0].input.readAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(bound.length, 1); assert.equal(bound[0].length, 64);
});
