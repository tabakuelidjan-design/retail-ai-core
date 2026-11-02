// TEST ONLY, run with --import ./scene-fetch-double-preload.mjs (no network, no cost, no credential).
// The customer workflow end to end THROUGH THE INTEGRATION HUB (src/integration): the customer picked a product variant and asked for a visual ->
// CREATIVE.produce_product_visual -> tenant-verified Shopify connector (double) -> exact variant -> verified photo (real bytes from the CDN double)
// -> the tenant's ACCEPTED policy in the Creative ledger -> atomic reservation -> the REAL critic port and the REAL scene engine built from the
// selected bytes, journaling into the run's transmission recorder -> the real local Python engines -> checks -> result for the customer, nothing published.
// The product is a clearly labelled TEST product (not TYESO: its real photo is blocked until the physical product is verified).
// argv: <workdir> <photoPath> <scenario: ok | wrong-variant | stale-price | live-provider | revoked>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIntegration, MODULE } from '../../../src/integration/index.js';
import { createMemoryCreativeLedger } from '../../../src/creative-autonomy/creative-ledger.js';
import { connectProviders } from '../../../src/creative-autonomy/providers.js';
import { localEngines } from '../../../src/creative-autonomy/run.js';
import { createSceneEngine } from '../../../src/creative-autonomy/scene-engine.js';
import { loadAlibabaCreativeConfig } from '../../../src/marketing-creative/alibaba/config.js';
import { SpendGuard } from '../../../src/marketing-creative/alibaba/budget.js';
import { FileOutputStore } from '../../../src/marketing-creative/alibaba/output-store.js';
import { IMAGE_EDIT_MODEL } from '../../../src/marketing-creative/alibaba/qwen-image-edit.js';

const [workdir, photoPath, scenario = 'ok'] = process.argv.slice(2);
const photo = readFileSync(photoPath);
const M = '00000000-0000-4000-8000-00000000e2e1'; // test tenant
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const PID = 'gid://shopify/Product/990000000001';
const BLACK = 'gid://shopify/ProductVariant/990000000101';
const WHITE = 'gid://shopify/ProductVariant/990000000102';
const CDN = 'https://cdn.shopify.com/s/files/1/0000/0000/files/';
const img = (id, file, alt, w = 900, h = 1200) => ({ id: `gid://shopify/MediaImage/99${id}`, alt, image: { url: CDN + file, width: w, height: h, altText: alt } });
const black500 = img(1, 'TEST_gourde_demo_noir_500ml.jpg', 'TEST gourde démo noire 500 ml');
const black350 = img(2, 'TEST_gourde_demo_noir_350ml.jpg', 'TEST gourde démo noire 350 ml');
const white500 = img(3, 'TEST_gourde_demo_blanc_500ml.jpg', 'TEST gourde démo blanche 500 ml');
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });
const price = scenario === 'stale-price' ? '17.90' : '19.90';
const answer = {
  product: { id: PID, title: 'TEST — Gourde démo 500 ml', status: 'ACTIVE', description: 'Produit de test Nordla : gourde isotherme de démonstration.', productType: 'Gourde', tags: ['test'], hasOnlyDefaultVariant: false,
    variants: page([{ id: BLACK, title: 'Noir', price, inventoryQuantity: 4 }, { id: WHITE, title: 'Blanc', price: '19.90', inventoryQuantity: 2 }]),
    media: page([black350, white500, black500]) },
  productVariant: { id: BLACK, title: 'Noir', price, inventoryQuantity: 4, product: { id: PID }, selectedOptions: [{ name: 'Couleur', value: 'Noir' }],
    media: page(scenario === 'wrong-variant' ? [black350] : [black500]) },
};
const shopify = { kind: 'shopify', merchantId: M, async state() { return 'CONFIGURED'; }, async graphql() { return answer; } };
const cdnFetch = async (url) => (String(url).startsWith(CDN) ? new Response(photo) : new Response('', { status: 404 }));

const POLICY = {
  kind: 'TENANT_MEDIA_PROCESSING_POLICY', policy_id: 'policy://test-tenant/creative-media', version: 1,
  tenant: { merchant_id: M }, accepted_by: { role: 'TENANT_OWNER', at: '2026-11-02T08:00:00Z' }, valid_from: '2026-11-01T00:00:00Z', valid_until: null, revoked: false,
  sources: { allowed_origins: ['SHOPIFY_CATALOG_VERIFIED_METADATA'], tenant_attests_catalog_product_images_show_no_people: true },
  processing: [
    { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'EU', cross_border_possible: false, purpose: 'NORDLA_CREATIVE_CRITIQUE', operations: ['VISION_CRITIQUE'] },
    { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'GLOBAL', cross_border_possible: true, purpose: 'NORDLA_SCENE_PRODUCTION', operations: ['IMAGE_EDIT'] },
  ],
  retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
  spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 5 }, audit: { journal_required: true },
};
const ledger = createMemoryCreativeLedger({ members: new Map([[M, new Map([[OWNER, 'OWNER']])]]) });
await ledger.acceptPolicy({ merchantId: M, actorId: OWNER, policy: POLICY, now: new Date('2026-11-02T08:00:00Z') });
if (scenario === 'revoked') await ledger.revokePolicy({ merchantId: M, actorId: OWNER, policyId: POLICY.policy_id, now: new Date('2026-11-02T09:00:00Z') });

const env = { ...process.env, ALIBABA_QWEN_TEXT_MODEL: 'qwen3-vl-plus', NORDLA_ALIBABA_SCOPE: 'EU' };
const imageEnv = { ...env, ALIBABA_MODEL_STUDIO_API_KEY: env.ALIBABA_MODEL_STUDIO_IMAGE_API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: env.ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID, ALIBABA_QWEN_IMAGE_MODEL: IMAGE_EDIT_MODEL };
const budget = new SpendGuard({ maxSpendEur: 0.5, maxImages: 3, maxVideoSeconds: 0 });
const local = localEngines({ renderScale: 0.5, samples: 8 });
const TARGET = { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' };

const integration = createIntegration({ tenant_id: M, creativeProduction: {
  shopify, ledger, policyId: POLICY.policy_id, runCeilingEur: 0.5, brand: { merchant_id: M, merchant_name: 'Boutique test' }, nonProduction: true, fetchImpl: cdnFetch,
  workdirFor: (runId) => join(workdir, 'runs', runId),
  providers: {
    simulated: scenario !== 'live-provider', critic: TARGET, scene: TARGET,
    portsFor: ({ photoBytes, authorization, journal }) => connectProviders({ env: { ...env, NORDLA_MEDIA_AUTHORIZATION_FILE: '' }, journal, budget, sourcePhotoBytes: photoBytes, mediaAuthorization: authorization, trialAuthorized: true, maxTextCalls: 8, maxVisionCalls: 1 }),
    enginesFor: ({ sha256, authorization, journal }) => createSceneEngine({ baseEngines: local, config: loadAlibabaCreativeConfig(imageEnv), authorization, photoSha256: sha256, budget, journal,
      outputStore: new FileOutputStore(join(workdir, 'provider-outputs')), variants: 3, maxImageCalls: 1 }),
  },
} });
const out = await integration.call(MODULE.CREATIVE, 'produce_product_visual',
  { product_id: PID, variant_id: BLACK, expected_variant_title: 'Noir', objective: 'Faire découvrir la gourde démo noire aux clients de la boutique test', run_id: `e2e-${scenario}` },
  { workflow_id: `wf-${scenario}`, initiated_by: { kind: 'HUMAN', id: OWNER, role: 'OWNER' } });
const snap = ledger.snapshot();
let facts = null; try { facts = JSON.parse(readFileSync(join(workdir, 'runs', `e2e-${scenario}`, 'faits.json'), 'utf8')); } catch {}
console.log(JSON.stringify({ hub: { ok: out.ok, status: out.status, code: out.code ?? null, reason: out.reason ?? null }, result: out.result ?? null, facts,
  events: snap.events.map((e) => ({ op: e.operation, event: e.event, ref: e.attemptRef, req: e.requestId, sha: e.sourceSha256 })), reservations: snap.reservations }));
