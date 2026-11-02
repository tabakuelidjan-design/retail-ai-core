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
import { createMemoryCreativeLedger } from '../src/creative-autonomy/creative-ledger.js';
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
const pillowReady = (() => { try { execFileSync(PY, ['-c', 'import PIL'], { stdio: 'ignore' }); return true; } catch { return false; } })();
// the source photo is validated by a full Pillow decode (the engines' own dependency): without Pillow these tests are skipped, never faked
const PIL = { skip: !pillowReady && `the full image decode needs Python with Pillow (NORDLA_PYTHON=${PY})` };
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
test('download: CDN host only, no redirect, real type and dimensions, and the bytes must decode completely', PIL, async () => {
  const [c] = pick(read({ productMedia: [good] }));
  const calls = [];
  const got = await fetchVerifiedProductImage(c, { fetchImpl: async (url, init) => { calls.push(init); return new Response(png()); } });
  assert.equal(got.info.media_type, 'image/png'); assert.equal(calls[0].redirect, 'error');
  await assert.rejects(() => fetchVerifiedProductImage({ ...c, url: 'https://evil.example/x.jpg' }, { fetchImpl: async () => new Response(png()) }), (e) => e.code === MEDIA_ERROR.UNSAFE_MEDIA_URL);
  await assert.rejects(() => fetchVerifiedProductImage(c, { fetchImpl: async () => new Response(png(1000, 1000)) }), (e) => e.code === MEDIA_ERROR.INVALID_IMAGE_BYTES);
  await assert.rejects(() => fetchVerifiedProductImage(c, { fetchImpl: async () => new Response(Buffer.from(png()).subarray(0, 60)) }), (e) => e.code === MEDIA_ERROR.INVALID_IMAGE_BYTES);
});

test('fallback stays inside the variant: a corrupt first image falls back to the next one of the SAME variant; all corrupt -> no image, attempts recorded', PIL, async () => {
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
const OWNER = 'user-owner-1';
const T0 = new Date('2026-11-02T10:00:00Z');
async function acceptedLedger(policy = POLICY, { accept = true } = {}) {
  const ledger = createMemoryCreativeLedger({ members: new Map([[M, new Map([[OWNER, 'OWNER'], ['user-viewer', 'VIEWER']])]]) });
  if (accept) assert.equal((await ledger.acceptPolicy({ merchantId: M, actorId: OWNER, policy, now: T0 })).status, 'ACCEPTED');
  return ledger;
}
/** a guard shaped like SpendGuard: max, snapshot */
const guardOf = (max = 0.5, spent = 0.0123) => ({ maxSpendEur: max, snapshot: () => ({ max_spend_eur: max, reserved_eur: 0, settled_eur: spent }) });
// a run double that really goes through the provider journal: one critique "call" (RESERVED -> SUCCEEDED with a request id), like qwen-vision does
const criticCallRun = (seen, { requestId = 'req-critic-1' } = {}) => async (a) => {
  seen.runs.push(a);
  const j = a.ports.journal;
  await j.append({ operation: 'VISION_CRITIQUE', operation_id: 'op-critic-1', event: 'RESERVED', estimated_cost_eur: 0.01 });
  seen.sent += 1; // the request would be sent here
  await j.append({ operation: 'VISION_CRITIQUE', operation_id: 'op-critic-1', event: 'SUCCEEDED', request_id: requestId, actual_cost_eur: 0.0123 });
  return { status: 'PROPOSALS_READY_FOR_OWNER', human_interventions: [{ when: 'après le passage', who: 'client', what: 'accepte, révise ou refuse le visuel fini', creative: true }] };
};
async function harness({ data = read({ price: '24.90', stock: 3, productMedia: [good] }), ledger = null, portsSha = null, enginesBinding = 'bound', scene = true, wireJournal = true, guard = guardOf(), sharedGuard = true, run = null, runId = 'run-1' } = {}) {
  const seen = { ports: [], engines: [], runs: [], sent: 0 };
  const L = ledger ?? await acceptedLedger();
  const args = {
    shopify: shop(data), request: REQ, objective: 'Faire découvrir la gourde noire', brand: { merchant_id: M }, format: 'INSTAGRAM_FEED_4_5',
    workdir: tmp('nordla-run-'), ledger: L, policyId: POLICY.policy_id, runCeilingEur: 0.5, now: () => T0, runId, nonProduction: true,
    fetchImpl: async () => new Response(png()),
    providers: {
      critic: TARGET, ...(scene ? { scene: TARGET } : {}),
      portsFor: async (b) => { seen.ports.push(b); return { text: null, journal: b.journal, budget: guard, binding: { transmits_source_media: true, source_sha256: portsSha ?? b.sha256, journal_id: wireJournal ? b.journal.id : 'another-journal' } }; },
      enginesFor: async (b) => { seen.engines.push(b); return enginesBinding === 'bound' ? { spendGuard: sharedGuard ? guard : guardOf(), binding: { transmits_source_media: Boolean(b.authorization), source_sha256: b.sha256, authorization_id: b.authorization?.authorization_id, journal_id: b.journal.id } }
        : enginesBinding === 'none' ? {} : { binding: { transmits_source_media: false, source_sha256: null } }; },
    },
    run: null,
  };
  args.run = run ?? criticCallRun(seen);
  return { args, seen, ledger: L };
}

test('end of the chain: photo chosen and validated, SHA computed, ACCEPTED policy read from the ledger, ceiling reserved, providers built FROM the bytes, lifecycle recorded from real call evidence, settled, nothing published', PIL, async () => {
  const { args, seen, ledger } = await harness();
  const r = await runAutonomousWithShopifyMedia(args);
  assert.equal(r.status, 'PROPOSALS_READY_FOR_OWNER'); assert.equal(r.published, false); assert.equal(r.customer_review, 'PENDING');
  const sha = r.media_selection.sha256;
  assert.equal(seen.ports[0].sha256, sha); assert.equal(seen.engines[0].sha256, sha);
  assert.deepEqual(seen.ports[0].authorization.allowed_operations, ['VISION_CRITIQUE']); assert.deepEqual(seen.engines[0].authorization.allowed_operations, ['IMAGE_EDIT']);
  assert.ok(seen.ports[0].authorization.authorization_id.startsWith(`${POLICY.policy_id}@v1#`), 'the ACCEPTED version names the authorization');
  assert.equal(seen.runs[0].input.product.variants.nodes[0].price, '24.90'); // read now, not the 29.90 of an older snapshot
  const snap = ledger.snapshot();
  const critic = snap.events.filter((e) => e.operation === 'VISION_CRITIQUE').map((e) => [e.event, e.attemptRef, e.requestId]);
  assert.deepEqual(critic, [['AUTHORIZED', 'run', null], ['RESERVED', 'run', null], ['ATTEMPTED', 'op-critic-1', null], ['SENT', 'op-critic-1', 'req-critic-1'], ['SUCCEEDED', 'op-critic-1', 'req-critic-1']]);
  // the scene was authorised and reserved but never called by this run double: no ATTEMPTED / SENT is invented for it
  assert.deepEqual(snap.events.filter((e) => e.operation === 'IMAGE_EDIT').map((e) => e.event), ['AUTHORIZED', 'RESERVED']);
  assert.ok(snap.events.every((e) => e.sourceSha256 === sha && e.runId === 'run-1' && e.policyVersion === 1 && e.merchantId === M));
  assert.deepEqual(snap.reservations.map((x) => [x.run_id, x.status, x.settled_eur]), [['run-1', 'SETTLED', 0.0123]]);
  assert.ok(!JSON.stringify(r).match(/confirm|valider la photo|which photograph/i));
});

test('no media attempted -> the reservation is RELEASED and each operation is CANCELLED (never SENT)', PIL, async () => {
  const { args, ledger } = await harness({ run: async () => ({ status: 'CONCEPTS_ONLY_ASSET_NOT_USABLE', human_interventions: [] }) });
  await runAutonomousWithShopifyMedia(args);
  const snap = ledger.snapshot();
  assert.equal(snap.reservations[0].status, 'RELEASED');
  assert.deepEqual(snap.events.map((e) => e.event).filter((e) => !['AUTHORIZED', 'RESERVED'].includes(e)), ['CANCELLED', 'CANCELLED']);
});

test('a call that fails without a provider request id is FAILED with transmission UNKNOWN, never SENT; the reservation is settled conservatively', PIL, async () => {
  const seen = { runs: [] };
  const { args, ledger } = await harness({ run: async (a) => { seen.runs.push(a); await a.ports.journal.append({ operation: 'IMAGE_EDIT', operation_id: 'op-edit-1', event: 'RESERVED' });
    await a.ports.journal.append({ operation: 'IMAGE_EDIT', operation_id: 'op-edit-1', event: 'FAILED', request_id: null, reason: 'NETWORK' }); throw Object.assign(new Error('network'), { code: 'NETWORK' }); } });
  await assert.rejects(() => runAutonomousWithShopifyMedia(args), /network/);
  const snap = ledger.snapshot();
  assert.deepEqual(snap.events.filter((e) => e.operation === 'IMAGE_EDIT').map((e) => e.event), ['AUTHORIZED', 'RESERVED', 'ATTEMPTED', 'FAILED']);
  assert.equal(snap.events.find((e) => e.event === 'FAILED').detail.transmission, 'UNKNOWN');
  assert.equal(snap.reservations[0].status, 'SETTLED');
});

test('P0-C fail closed: preconstructed services refused; another SHA, no binding, unconnected scene, a provider not wired to the run audit, a separate spend guard, a guard above the reservation: all stop BEFORE the run and the reservation is released', PIL, async () => {
  const pre = await harness();
  await assert.rejects(() => runAutonomousWithShopifyMedia({ ...pre.args, ports: { text: null } }), TypeError);
  await assert.rejects(() => runAutonomousWithShopifyMedia({ ...pre.args, engines: {} }), TypeError);
  for (const [opts, label] of [[{ portsSha: 'f'.repeat(64) }, 'another source'], [{ enginesBinding: 'none' }, 'no binding'], [{ enginesBinding: 'local' }, 'not connected'],
    [{ wireJournal: false }, 'transmission audit'], [{ sharedGuard: false }, 'same guard'], [{ guard: guardOf(0.9) }, 'reserved ceiling']]) {
    const h = await harness(opts);
    await assert.rejects(() => runAutonomousWithShopifyMedia(h.args), (e) => e.code === MEDIA_ERROR.PROVIDER_BINDING_NOT_ESTABLISHED && e.message.includes(label), label);
    assert.equal(h.seen.runs.length, 0, label);
    assert.equal(h.ledger.snapshot().reservations[0].status, 'RELEASED', label);
  }
});

test('a mismatched source SHA cannot be sent: the ledger refuses ATTEMPTED and the provider journal throws BEFORE the request', PIL, async () => {
  const seen = { runs: [], sent: 0 };
  const { args, ledger } = await harness({ run: async (a) => {
    // a port bound to another source would write ITS source sha: simulate by recording the attempt for another run context through the same ledger
    const r = await ledger.record({ merchantId: M, runId: 'run-1', operation: 'VISION_CRITIQUE', attemptRef: 'op-x', event: 'ATTEMPTED', policyId: POLICY.policy_id, policyVersion: 1,
      authorizationId: 'x', sourceSha256: 'e'.repeat(64), providerId: TARGET.provider_id, region: TARGET.region, now: T0 });
    assert.equal(r.reason, 'NOT_AUTHORIZED_FOR_THIS_SOURCE');
    return criticCallRun(seen)(a);
  } });
  await runAutonomousWithShopifyMedia(args);
  // and through the recorder itself: an attempt after the reservation closed is refused, so the port throws and sends nothing
  const after = (await harness({ ledger })).args;
  await assert.rejects(() => runAutonomousWithShopifyMedia({ ...after, run: criticCallRun(seen) }), (e) => e.code === MEDIA_ERROR.SPEND_NOT_RESERVED, 'run-1 is settled: the same run id cannot run again');
});

test('the recorder blocks the request at the media boundary when the ledger refuses the attempt (revoked mid-run is not enough to block a live reservation, a closed one is)', PIL, async () => {
  let sent = 0;
  const { args, ledger } = await harness({ run: async (a) => {
    await ledger.settle({ merchantId: M, runId: 'run-1', settledEur: 0, basis: 'TEST_CLOSE', now: T0 }); // the reservation is closed under the run
    await a.ports.journal.append({ operation: 'VISION_CRITIQUE', operation_id: 'op-late', event: 'RESERVED' }); // throws: RESERVATION_NOT_LIVE
    sent += 1; return { status: 'X' };
  } });
  await assert.rejects(() => runAutonomousWithShopifyMedia(args), (e) => e.code === 'MEDIA_TRANSMISSION_REFUSED' && e.reason === 'RESERVATION_NOT_LIVE');
  assert.equal(sent, 0);
});

test('standing policy refusals stop before any provider is built: no accepted policy, revoked, invalid content, processing not covered, ceiling above the per-run limit', PIL, async () => {
  const revoked = await acceptedLedger(); await revoked.revokePolicy({ merchantId: M, actorId: OWNER, policyId: POLICY.policy_id, now: T0 });
  const cases = [
    [await acceptedLedger(POLICY, { accept: false }), MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED, 'NO_ACCEPTED_POLICY'],
    [revoked, MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED, 'NO_ACCEPTED_POLICY'],
    [await acceptedLedger({ ...POLICY, processing: [{ ...POLICY.processing[1], cross_border_possible: false }, POLICY.processing[0]] }), MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED, 'POLICY_INVALID'],
    [await acceptedLedger({ ...POLICY, processing: [POLICY.processing[0]] }), MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED, 'PROCESSING_NOT_COVERED'],
    [await acceptedLedger({ ...POLICY, spend: { currency: 'EUR', per_run_max: 0.2, monthly_max: 5 } }), MEDIA_ERROR.PROCESSING_NOT_AUTHORIZED, 'SPEND_LIMIT'],
  ];
  for (const [ledger, code, reason] of cases) {
    const h = await harness({ ledger });
    await assert.rejects(() => runAutonomousWithShopifyMedia(h.args), (e) => e.code === code && e.message.includes(reason), reason);
    assert.equal(h.seen.ports.length + h.seen.engines.length + h.seen.runs.length, 0, reason);
    assert.equal(ledger.snapshot().reservations.length, 0, reason);
  }
});

test('only an OWNER/ADMIN of the tenant accepts the policy; a viewer cannot; a policy change is a new version that must be accepted again', async () => {
  const ledger = await acceptedLedger();
  assert.equal((await ledger.acceptPolicy({ merchantId: M, actorId: 'user-viewer', policy: POLICY, now: T0 })).reason, 'ACTOR_NOT_TENANT_ADMIN');
  assert.equal((await ledger.acceptPolicy({ merchantId: M, actorId: OWNER, policy: POLICY, now: T0 })).status, 'ALREADY_ACCEPTED');
  const v2 = await ledger.acceptPolicy({ merchantId: M, actorId: OWNER, policy: { ...POLICY, spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 9 } }, now: T0 });
  assert.equal(v2.version, 2); assert.equal((await ledger.currentPolicy({ merchantId: M, policyId: POLICY.policy_id })).version, 2);
  assert.equal((await ledger.reserve({ merchantId: M, runId: 'old-v', policyId: POLICY.policy_id, policyVersion: 1, ceilingEur: 0.1, now: T0 })).reason, 'POLICY_NOT_IN_FORCE');
});

test('concurrent runs cannot exceed the monthly limit (memory ledger, same contract as the PostgreSQL functions proven in test/pg/97)', PIL, async () => {
  const ledger = await acceptedLedger({ ...POLICY, spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 1 } });
  const outs = await Promise.all(Array.from({ length: 6 }, async (_, i) => { const h = await harness({ ledger, runId: `par-${i}` }); return runAutonomousWithShopifyMedia(h.args).then(() => 'OK', (e) => e.code); }));
  assert.equal(outs.filter((o) => o === 'OK').length, 2, JSON.stringify(outs));
  assert.ok(outs.filter((o) => o !== 'OK').every((o) => o === MEDIA_ERROR.SPEND_NOT_RESERVED));
  const settled = ledger.snapshot().reservations.filter((x) => x.status === 'SETTLED');
  assert.ok(settled.reduce((s, x) => s + x.settled_eur, 0) <= 1);
});

test('a non-durable ledger is refused for production, and a missing run id is refused', PIL, async () => {
  const { args } = await harness();
  await assert.rejects(() => runAutonomousWithShopifyMedia({ ...args, nonProduction: false }), (e) => e.code === MEDIA_ERROR.LEDGER_NOT_DURABLE);
  await assert.rejects(() => runAutonomousWithShopifyMedia({ ...args, runId: undefined }), TypeError);
});

test('a wrong-variant-only gallery stops before any download, reservation, provider or run, with no question to the client', async () => {
  const h = await harness({ data: read({ productMedia: [live20, pink], variantMedia: [live20] }) });
  let fetched = 0; h.args.fetchImpl = async () => { fetched += 1; return new Response(png()); };
  await assert.rejects(() => runAutonomousWithShopifyMedia(h.args), (e) => e.code === MEDIA_ERROR.NO_VERIFIED_SOURCE_IMAGE);
  assert.equal(fetched + h.seen.ports.length + h.seen.runs.length + h.ledger.snapshot().reservations.length, 0);
});

test('brief: a missing product photo is an INTERNAL media block, never a customer question', () => {
  const a = assessBrief({ brief: { public_facts: { product: 'Gourde' }, approved_copy: [{ role: 'HEADLINE', content: 'x' }], format: { aspect_ratio: '4:5' }, asset: null, ids: {} } });
  assert.equal(a.status, BRIEF_STATUS.BLOCKED_INTERNAL_MEDIA);
  assert.deepEqual(a.issues.map((i) => [i.kind, i.audience, i.question]), [['INTERNAL', 'INTERNAL', null]]);
});
