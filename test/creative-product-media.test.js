import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseVerifiedProductImages, resolveVerifiedShopifyMedia, fetchVerifiedProductImage, stageVerifiedShopifyMedia, runAutonomousWithShopifyMedia,
  CREATIVE_PRODUCT_MEDIA_QUERY, CREATIVE_PRODUCT_MEDIA_QUERY_COST, SHOPIFY_SINGLE_QUERY_MAX_COST, requestedCost, MEDIA_ERROR, CreativeMediaError,
} from '../src/creative-autonomy/product-media.js';
import { MediaTransmissionJournal } from '../src/creative-autonomy/media-processing-policy.js';
import { assessBrief, BRIEF_STATUS } from '../src/creative-brain/brief-assessment.js';

// ---- fixtures shaped exactly like the read-only answer of the HABB store on 2026-11-02 (TYESO TS-8771C, 750 ml, variant Noir)
const M = 'merchant-habb';
const PID = 'gid://shopify/Product/15514012254556';
const BLACK = 'gid://shopify/ProductVariant/57246326784348';
const PINK = 'gid://shopify/ProductVariant/57246326620508';
const CDN = 'https://cdn.shopify.com/s/files/1/0988/1524/6684/files/';
const TITLE = 'Gourde Tyeso TS-8771C à paille – 750 ml';
const image = (id, file, alt = 'TYESO 750ml', width = 2000, height = 2000) => ({ id: 'gid://shopify/MediaImage/' + id, alt, image: { url: CDN + file + '?v=1', width, height, altText: alt } });
const page = (nodes, hasNextPage = false) => ({ nodes, pageInfo: { hasNextPage } });
const live20 = image(69343263981916, 'TYESO_Wander_lockable_Stainless_Steel_Sports_Bottle_With_Straw_Black_20oz.webp', 'Tyeso 318 Straw Bottle 750ml – Gourde sportive');
const good = image(2, 'TYESO_Wander_With_Straw_Black_25oz.jpg', 'TYESO black 750ml');
const goodB = image(12, 'TYESO_Wander_With_Straw_Black_25oz_b.jpg', 'TYESO black 750ml', 1500, 1500);
const pink = image(4, 'TYESO_Wander_Pink_25oz.jpg', 'TYESO pink 750ml');
const read = ({ productMedia = [live20, good, pink], variantMedia = [], title = TITLE, variantTitle = 'Noir', variantId = BLACK, options = [{ name: 'Couleur', value: 'Noir' }],
  hasOnlyDefaultVariant = false, variants = null, price = '29.90', stock = 7, variantProductId = PID, mediaNext = false, variantMediaNext = false, variantsNext = false } = {}) => ({
  product: { id: PID, title, status: 'ACTIVE', description: 'Une gourde sport TYESO avec paille.', productType: '', tags: [], hasOnlyDefaultVariant,
    variants: page(variants ?? [{ id: BLACK, title: 'Noir', price, inventoryQuantity: stock }, { id: PINK, title: 'Rose', price, inventoryQuantity: 5 }], variantsNext),
    media: page([{}, ...productMedia], mediaNext) },
  productVariant: { id: variantId, title: variantTitle, price, inventoryQuantity: stock, product: { id: variantProductId }, selectedOptions: options, media: page(variantMedia, variantMediaNext) },
});
const pick = (data, extra = {}) => chooseVerifiedProductImages({ ...data, productId: PID, variantId: data.productVariant.id, ...extra });
const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pngCache = new Map();
/** a REAL, fully decodable PNG (a 44-byte header is not an image) */
function png(width = 2000, height = 2000) {
  const k = width + 'x' + height;
  if (!pngCache.has(k)) pngCache.set(k, execFileSync(PY, ['-c', `import sys,io\nfrom PIL import Image\nb=io.BytesIO();Image.new('RGB',(${width},${height}),(20,20,20)).save(b,'PNG');sys.stdout.buffer.write(b.getvalue())`]));
  return pngCache.get(k);
}
/** the shape of src/connectors/shopify.js once it verified the shop belongs to the tenant */
const shop = (data, { state = 'CONFIGURED', merchantId = M, fail = null } = {}) => ({ kind: 'shopify', merchantId, calls: [], async state() { return state; },
  async graphql(q, vars) { this.calls.push({ q, vars }); if (fail) throw new Error(fail); return data; } });
const REQ = { merchantId: M, productId: PID, variantId: BLACK, expectedVariantTitle: 'Noir' };
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// ---------------------------------------------------------------- query
test('the read-only query targets the exact variant by ID, asks every pagination flag and stays far under Shopify\'s single-query cost limit', () => {
  assert.match(CREATIVE_PRODUCT_MEDIA_QUERY, /productVariant\(id: \$variantId\)/);
  assert.match(CREATIVE_PRODUCT_MEDIA_QUERY, /product\(id: \$productId\)/);
  assert.equal((CREATIVE_PRODUCT_MEDIA_QUERY.match(/pageInfo \{ hasNextPage \}/g) ?? []).length, 3);
  assert.doesNotMatch(CREATIVE_PRODUCT_MEDIA_QUERY, /mutation/);
  assert.ok(CREATIVE_PRODUCT_MEDIA_QUERY_COST <= SHOPIFY_SINGLE_QUERY_MAX_COST / 2, `requested cost ${CREATIVE_PRODUCT_MEDIA_QUERY_COST}`);
  // the previous shape (100 variants x 20 media each) is refused by Shopify before execution: proven with the same cost rules
  const img = { fragment: 'MediaImage', children: [{ name: 'id' }, { name: 'image', object: true, children: [{ name: 'url' }] }] };
  const previous = [{ name: 'product', object: true, children: [
    { name: 'variants', first: 100, connection: true, node: [{ name: 'id' }, { name: 'selectedOptions', object: true, children: [{ name: 'value' }] }, { name: 'media', first: 20, connection: true, node: [img] }] },
    { name: 'media', first: 100, connection: true, node: [img] }] }];
  assert.ok(requestedCost(previous) > SHOPIFY_SINGLE_QUERY_MAX_COST, `previous shape cost ${requestedCost(previous)}`);
});

// ---------------------------------------------------------------- matching
test('TYESO live data: the Noir variant is linked to Black_20oz in Shopify; that link contradicts 750 ml and is refused (no small bottle, no question to the client)', () => {
  assert.throws(() => pick(read({ variantMedia: [live20], productMedia: [live20, pink] })), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
  assert.throws(() => pick(read({ productMedia: [live20, pink] })), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
});

test('a 25 oz / 750 ml image is selected: by the variant link first, otherwise by explicit colour and capacity; larger source first', () => {
  const linked = pick(read({ variantMedia: [good] }));
  assert.equal(linked[0].media_id, good.id); assert.equal(linked[0].evidence.variant, 'VARIANT_MEDIA_LINK_IN_SHOPIFY');
  const byMeta = pick(read({ productMedia: [live20, goodB, pink, good] }));
  assert.deepEqual(byMeta.map((c) => c.media_id), [good.id, goodB.id]);
  assert.equal(byMeta[0].evidence.variant, 'EXPLICIT_ATTRIBUTES_IN_IMAGE_METADATA'); assert.equal(byMeta[0].evidence.color, 'noir');
  assert.ok(byMeta.every((c) => c.variant_id === BLACK));
});

test('P0-A: a SINGLE variant with an option (XL) does not inherit every product image; only a product WITHOUT options does', () => {
  const tshirt = (opts) => read({ title: 'T-shirt HABB', productMedia: [image(30, 'tshirt_S.jpg', 'T-shirt taille S')], variantTitle: 'XL', options: [{ name: 'Taille', value: 'XL' }],
    variants: [{ id: BLACK, title: 'XL', price: '20.00', inventoryQuantity: 2 }], ...opts });
  assert.throws(() => pick(tshirt()), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE && /XL/.test(e.message));
  const noOptions = read({ title: 'Mug HABB', hasOnlyDefaultVariant: true, variantTitle: 'Default Title', options: [{ name: 'Title', value: 'Default Title' }],
    variants: [{ id: BLACK, title: 'Default Title', price: '12.00', inventoryQuantity: 3 }], productMedia: [image(31, 'mug.jpg', 'Mug HABB')] });
  assert.equal(pick(noOptions)[0].evidence.variant, 'PRODUCT_WITHOUT_OPTIONS');
  // even without options, a contradiction with the product itself excludes the image
  const sized = read({ title: 'Gourde 750 ml', hasOnlyDefaultVariant: true, variantTitle: 'Default Title', options: [], variants: [{ id: BLACK, title: 'Default Title', price: '1', inventoryQuantity: 1 }], productMedia: [image(32, 'gourde_20oz.jpg', '')] });
  assert.throws(() => pick(sized), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
});

test('multi-option and unknown values are never guessed: "Noir / 500 ml" refuses a pink 1000 ml image, "Bordeaux" refuses a black one', () => {
  const two = (media) => read({ title: 'Gourde isotherme', variantTitle: 'Noir / 500 ml', options: [{ name: 'Couleur', value: 'Noir' }, { name: 'Contenance', value: '500 ml' }], productMedia: media });
  assert.throws(() => pick(two([image(40, 'gourde_rose_1000ml.jpg', 'gourde rose 1000ml')])), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
  assert.throws(() => pick(two([image(41, 'gourde_black_1000ml.jpg', 'gourde noire 1000ml')])), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
  assert.equal(pick(two([image(40, 'gourde_rose_1000ml.jpg', ''), image(42, 'gourde_black_500ml.jpg', 'gourde noire 500ml')]))[0].media_id, 'gid://shopify/MediaImage/42');
  assert.throws(() => pick(read({ title: 'Coque', variantTitle: 'Bordeaux', options: [{ name: 'Couleur', value: 'Bordeaux' }], productMedia: [image(43, 'coque_black.jpg', 'coque noire')] })),
    (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
});

test('ambiguous or unsafe images are excluded: another capacity, another model, no attribute, too small, foreign host, plain http', () => {
  for (const sample of [
    image(7, 'TYESO_Wander_Black_25oz.jpg', 'TYESO 20oz black 750ml'),
    image(8, 'TYESO_Wander_Black_25oz.jpg', 'TYESO TS-8772C black 750ml'),
    image(9, 'unlabeled.webp', 'Tyeso 750ml'),
    image(10, 'TYESO_Wander_Black_25oz.jpg', 'Tyeso black 750ml', 600, 600),
    { ...good, image: { ...good.image, url: 'http://evil.example/black_25oz.jpg' } },
    { ...good, image: { ...good.image, url: 'https://tyeso.com/black_25oz.jpg' } },
  ]) assert.throws(() => pick(read({ productMedia: [sample] })), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE, JSON.stringify(sample));
});

test('P1-D identity: immutable IDs decide; another product\'s variant, a variant missing from the product, or an unexpected variant ID are refused; a rename is only recorded', () => {
  assert.throws(() => pick(read({ variantProductId: 'gid://shopify/Product/999' })), (e) => e.code === MEDIA_ERROR.PRODUCT_MISMATCH);
  assert.throws(() => pick(read({ variants: [{ id: PINK, title: 'Rose', price: '1', inventoryQuantity: 1 }] })), (e) => e.code === MEDIA_ERROR.PRODUCT_MISMATCH);
  assert.throws(() => chooseVerifiedProductImages({ ...read(), productId: PID, variantId: PINK }), (e) => e.code === MEDIA_ERROR.VARIANT_NOT_FOUND);
  assert.throws(() => chooseVerifiedProductImages({ ...read(), productId: 'gid://shopify/Product/1', variantId: BLACK }), (e) => e.code === MEDIA_ERROR.PRODUCT_MISMATCH);
});

test('P1-D pagination: product media, variant media and the variant list must each be complete (an absent flag counts as incomplete)', () => {
  for (const o of [{ mediaNext: true }, { variantMediaNext: true }, { variantsNext: true }]) assert.throws(() => pick(read(o)), (e) => e.code === MEDIA_ERROR.INCOMPLETE_MEDIA_LIST, JSON.stringify(o));
  const noFlag = read({ productMedia: [good] }); delete noFlag.productVariant.media.pageInfo;
  assert.throws(() => pick(noFlag), (e) => e.code === MEDIA_ERROR.INCOMPLETE_MEDIA_LIST);
});

// ---------------------------------------------------------------- connector, freshness
test('only the connector verified for THIS tenant, now, is used; a Shopify error (e.g. query cost) is a deterministic error', async () => {
  const data = read({ productMedia: [good] });
  await assert.rejects(() => resolveVerifiedShopifyMedia({ shopify: { async graphql() { return data; } }, request: REQ }), (e) => e.code === MEDIA_ERROR.CONNECTOR_NOT_VERIFIED);
  await assert.rejects(() => resolveVerifiedShopifyMedia({ shopify: shop(data, { merchantId: 'other' }), request: REQ }), (e) => e.code === MEDIA_ERROR.CONNECTOR_NOT_VERIFIED);
  await assert.rejects(() => resolveVerifiedShopifyMedia({ shopify: shop(data, { state: 'MISCONFIGURED' }), request: REQ }), (e) => e.code === MEDIA_ERROR.CONNECTOR_NOT_VERIFIED);
  await assert.rejects(() => resolveVerifiedShopifyMedia({ shopify: shop(data, { fail: 'Shopify GraphQL errors: [{"message":"Query cost is 4502, which exceeds the single query max cost limit (1000)."}]' }), request: REQ }),
    (e) => e.code === MEDIA_ERROR.SHOPIFY_QUERY_FAILED);
  const s = shop(data);
  const r = await resolveVerifiedShopifyMedia({ shopify: s, request: { ...REQ, expectedVariantTitle: 'Black' } });
  assert.deepEqual(s.calls[0].vars, { productId: PID, variantId: BLACK });
  assert.equal(r.identity.variant_title_changed, true);
  assert.equal(r.candidates[0].media_id, good.id);
});

// ---------------------------------------------------------------- bytes and fallback
test('download: CDN host only, no redirect, real type and dimensions, and the bytes must decode completely', async () => {
  const [c] = pick(read({ productMedia: [good] }));
  const calls = [];
  const got = await fetchVerifiedProductImage(c, { fetchImpl: async (url, init) => { calls.push(init); return new Response(png()); } });
  assert.equal(got.info.media_type, 'image/png'); assert.equal(calls[0].redirect, 'error');
  await assert.rejects(() => fetchVerifiedProductImage({ ...c, url: 'https://evil.example/x.jpg' }, { fetchImpl: async () => new Response(png()) }), (e) => e.code === MEDIA_ERROR.UNSAFE_MEDIA_URL);
  await assert.rejects(() => fetchVerifiedProductImage(c, { fetchImpl: async () => new Response(png(1000, 1000)) }), (e) => e.code === MEDIA_ERROR.INVALID_IMAGE_BYTES);
  await assert.rejects(() => fetchVerifiedProductImage(c, { fetchImpl: async () => new Response(Buffer.from(png()).subarray(0, 60)) }), (e) => e.code === MEDIA_ERROR.INVALID_IMAGE_BYTES);
});

test('fallback stays inside the variant: a corrupt first image falls back to the next one of the SAME variant; all corrupt -> no image, attempts recorded', async () => {
  const data = read({ productMedia: [good, goodB, pink] });
  const fetchImpl = async (url) => new Response(url.includes('_b.jpg') ? png(1500, 1500) : Buffer.from(png()).subarray(0, 60));
  const staged = await stageVerifiedShopifyMedia({ shopify: shop(data), request: REQ, workdir: tmp('nordla-fb-'), fetchImpl });
  assert.equal(staged.record.media_id, goodB.id); assert.equal(staged.record.variant_id, BLACK);
  assert.deepEqual(staged.record.rejected_before, [{ media_id: good.id, code: MEDIA_ERROR.INVALID_IMAGE_BYTES }]);
  await assert.rejects(() => stageVerifiedShopifyMedia({ shopify: shop(data), request: REQ, workdir: tmp('nordla-fb2-'), fetchImpl: async () => new Response(Buffer.alloc(10)) }),
    (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE && e.attempts.length === 2 && e.attempts.every((a) => a.media_id !== pink.id));
});

// ---------------------------------------------------------------- production entrypoint: policy, binding, freshness, no client prompt
const POLICY = Object.freeze({
  kind: 'TENANT_MEDIA_PROCESSING_POLICY', policy_id: 'policy://merchant-habb/creative-media', version: 1,
  tenant: { merchant_id: M }, accepted_by: { role: 'TENANT_OWNER', at: '2026-11-02T08:00:00Z' }, valid_from: '2026-11-01T00:00:00Z', valid_until: null, revoked: false,
  sources: { allowed_origins: ['SHOPIFY_CATALOG_VERIFIED_METADATA'], tenant_attests_catalog_product_images_show_no_people: true },
  processing: [
    { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'EU', cross_border_possible: false, purpose: 'NORDLA_CREATIVE_CRITIQUE', operations: ['VISION_CRITIQUE'] },
    { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'GLOBAL', cross_border_possible: true, purpose: 'NORDLA_SCENE_PRODUCTION', operations: ['IMAGE_EDIT'] },
  ],
  retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
  spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 5 }, audit: { journal_required: true },
});
const TARGET = { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' };
function harness({ data = read({ price: '24.90', stock: 3, productMedia: [good] }), policy = POLICY, portsSha = null, enginesBinding = 'bound', scene = true } = {}) {
  const seen = { ports: [], engines: [], runs: [] };
  const journal = new MediaTransmissionJournal(join(tmp('nordla-journal-'), 'transmissions.jsonl'));
  const args = {
    shopify: shop(data), request: REQ, objective: 'Faire découvrir la gourde noire', brand: { merchant_id: M }, format: 'INSTAGRAM_FEED_4_5',
    workdir: tmp('nordla-run-'), policy, journal, runCeilingEur: 0.5, now: () => new Date('2026-11-02T10:00:00Z'), runId: 'run-1',
    fetchImpl: async () => new Response(png()),
    providers: {
      critic: TARGET, ...(scene ? { scene: TARGET } : {}),
      portsFor: async (b) => { seen.ports.push(b); return { text: null, binding: { transmits_source_media: true, source_sha256: portsSha ?? b.sha256 } }; },
      enginesFor: async (b) => { seen.engines.push(b); return enginesBinding === 'bound' ? { binding: { transmits_source_media: Boolean(b.authorization), source_sha256: b.sha256, authorization_id: b.authorization?.authorization_id } }
        : enginesBinding === 'none' ? {} : { binding: { transmits_source_media: false, source_sha256: null } }; },
    },
    run: async (a) => { seen.runs.push(a); return { status: 'PROPOSALS_READY_FOR_OWNER', human_interventions: [{ when: 'après le passage', who: 'client', what: 'accepte, révise ou refuse le visuel fini', creative: true }] }; },
  };
  return { args, seen, journal };
}

test('end of the chain: photo chosen and validated, SHA computed, standing policy applied, both providers built FROM the bytes and checked, fresh price, nothing published', async () => {
  const { args, seen, journal } = harness();
  const r = await runAutonomousWithShopifyMedia(args);
  assert.equal(r.status, 'PROPOSALS_READY_FOR_OWNER'); assert.equal(r.published, false);
  const sha = r.media_selection.sha256;
  assert.equal(seen.ports[0].sha256, sha); assert.equal(seen.engines[0].sha256, sha);
  assert.equal(seen.ports[0].authorization.asset.asset_sha256, sha); assert.deepEqual(seen.ports[0].authorization.allowed_operations, ['VISION_CRITIQUE']);
  assert.equal(seen.engines[0].authorization.asset.asset_sha256, sha); assert.deepEqual(seen.engines[0].authorization.allowed_operations, ['IMAGE_EDIT']);
  assert.equal(seen.runs[0].input.product.variants.nodes[0].price, '24.90'); // read now, not the 29.90 of an older snapshot
  assert.equal(seen.runs[0].input.readAt, '2026-11-02T10:00:00.000Z');
  assert.equal(seen.runs[0].produce, 'SELECTED');
  const entries = journal.entries();
  assert.deepEqual(entries.map((e) => e.operation), ['VISION_CRITIQUE', 'IMAGE_EDIT']);
  assert.ok(entries.every((e) => e.source_sha256 === sha && e.policy_id === POLICY.policy_id && e.authorization_id.includes(sha.slice(0, 16)) && e.run_id === 'run-1'));
  assert.equal(entries[1].cross_border_possible, true);
  assert.ok(!JSON.stringify(r).match(/confirm|valider la photo|which photograph/i));
  assert.ok(r.human_interventions.every((h) => h.when === 'après le passage'));
  const selection = JSON.parse(readFileSync(join(args.workdir, readdirSync(args.workdir).find((f) => f.startsWith('source-media-selection-'))), 'utf8'));
  assert.equal(selection.variant_id, BLACK);
});

test('P0-C fail closed: preconstructed services are refused; a provider bound to another SHA, an engine without binding, or an unconnected scene stop BEFORE the run', async () => {
  const pre = harness();
  await assert.rejects(() => runAutonomousWithShopifyMedia({ ...pre.args, ports: { text: null } }), TypeError);
  await assert.rejects(() => runAutonomousWithShopifyMedia({ ...pre.args, engines: {} }), TypeError);
  for (const [opts, label] of [[{ portsSha: 'f'.repeat(64) }, 'another source'], [{ enginesBinding: 'none' }, 'no binding'], [{ enginesBinding: 'local' }, 'not connected']]) {
    const h = harness(opts);
    await assert.rejects(() => runAutonomousWithShopifyMedia(h.args), (e) => e.code === MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED && e.message.includes(label), label);
    assert.equal(h.seen.runs.length, 0, label);
  }
});

test('standing policy refusals stop before any provider is built: no policy, revoked, other tenant, spend above the cap, processing not covered', async () => {
  const cases = [
    [null, 'NO_POLICY'], [{ ...POLICY, revoked: true }, 'POLICY_REVOKED'], [{ ...POLICY, tenant: { merchant_id: 'other' } }, 'TENANT_MISMATCH'],
    [{ ...POLICY, spend: { currency: 'EUR', per_run_max: 0.2, monthly_max: 5 } }, 'SPEND_LIMIT'],
    [{ ...POLICY, processing: [POLICY.processing[0]] }, 'PROCESSING_NOT_COVERED'],
    [{ ...POLICY, processing: [{ ...POLICY.processing[1], cross_border_possible: false }, POLICY.processing[0]] }, 'POLICY_INVALID'],
  ];
  for (const [policy, reason] of cases) {
    const h = harness({ policy });
    await assert.rejects(() => runAutonomousWithShopifyMedia(h.args), (e) => e.code === MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED && e.message.includes(reason), reason);
    assert.equal(h.seen.ports.length + h.seen.engines.length + h.seen.runs.length, 0, reason);
    assert.equal(h.journal.entries().length, 0, reason);
  }
});

test('the monthly cap counts earlier runs from the journal', async () => {
  const h = harness({ policy: { ...POLICY, spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 0.9 } } });
  await runAutonomousWithShopifyMedia(h.args);
  const second = { ...h.args, runId: 'run-2', workdir: tmp('nordla-run2-') };
  await assert.rejects(() => runAutonomousWithShopifyMedia(second), (e) => /SPEND_LIMIT/.test(e.message));
});

test('a wrong-variant-only gallery stops before any download, provider or run, with no question to the client', async () => {
  const h = harness({ data: read({ productMedia: [live20, pink], variantMedia: [live20] }) });
  let fetched = 0; h.args.fetchImpl = async () => { fetched += 1; return new Response(png()); };
  await assert.rejects(() => runAutonomousWithShopifyMedia(h.args), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
  assert.equal(fetched + h.seen.ports.length + h.seen.runs.length, 0);
});

test('brief: a missing product photo is an INTERNAL media block, never a customer question', () => {
  const a = assessBrief({ brief: { public_facts: { product: 'Gourde' }, approved_copy: [{ role: 'HEADLINE', content: 'x' }], format: { aspect_ratio: '4:5' }, asset: null, ids: {} } });
  assert.equal(a.status, BRIEF_STATUS.BLOCKED_INTERNAL_MEDIA);
  assert.deepEqual(a.issues.map((i) => [i.kind, i.audience, i.question]), [['INTERNAL', 'INTERNAL', null]]);
});
