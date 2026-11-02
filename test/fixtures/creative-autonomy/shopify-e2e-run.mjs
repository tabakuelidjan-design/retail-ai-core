// TEST ONLY, run with --import ./scene-fetch-double-preload.mjs (no network, no cost, no credential).
// The customer workflow end to end through the PRODUCTION entrypoint: a tenant-verified Shopify connector (double, realistic answer)
// -> exact variant -> verified photo (real bytes from the CDN double) -> standing tenant policy -> the REAL critic port and the REAL scene engine,
// both built from the selected bytes -> the real local Python engines -> technical and visual checks -> proposals for the customer, nothing published.
// argv: <workdir> <photoPath> <scenario: ok | wrong-variant | stale-price>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAutonomousWithShopifyMedia } from '../../../src/creative-autonomy/product-media.js';
import { MediaTransmissionJournal } from '../../../src/creative-autonomy/media-processing-policy.js';
import { connectProviders } from '../../../src/creative-autonomy/providers.js';
import { localEngines } from '../../../src/creative-autonomy/run.js';
import { createSceneEngine } from '../../../src/creative-autonomy/scene-engine.js';
import { HABB_BRAND } from '../../../src/creative-autonomy/brief.js';
import { loadAlibabaCreativeConfig } from '../../../src/marketing-creative/alibaba/config.js';
import { SpendGuard } from '../../../src/marketing-creative/alibaba/budget.js';
import { JsonlCallJournal } from '../../../src/marketing-creative/alibaba/journal.js';
import { FileOutputStore } from '../../../src/marketing-creative/alibaba/output-store.js';
import { IMAGE_EDIT_MODEL } from '../../../src/marketing-creative/alibaba/qwen-image-edit.js';

const [workdir, photoPath, scenario = 'ok'] = process.argv.slice(2);
const photo = readFileSync(photoPath);
const M = 'merchant-habb';
const PID = 'gid://shopify/Product/15514012254556';
const BLACK = 'gid://shopify/ProductVariant/57246326784348';
const CDN = 'https://cdn.shopify.com/s/files/1/0988/1524/6684/files/';
const img = (id, file, alt, w = 900, h = 1200) => ({ id: `gid://shopify/MediaImage/${id}`, alt, image: { url: CDN + file, width: w, height: h, altText: alt } });
const black25 = img(1, 'TYESO_Wander_Black_25oz.jpg', 'TYESO noir 750ml');
const black20 = img(2, 'TYESO_Wander_Black_20oz.webp', 'Tyeso 750ml', 2000, 2000);
const pink25 = img(3, 'TYESO_Wander_Pink_25oz.jpg', 'TYESO rose 750ml');
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });
const answer = {
  product: { id: PID, title: 'Gourde Tyeso TS-8771C à paille – 750 ml', status: 'ACTIVE', description: 'Une gourde sport TYESO avec paille et couvercle verrouillable.', productType: '', tags: [], hasOnlyDefaultVariant: false,
    variants: page([{ id: BLACK, title: 'Noir', price: scenario === 'stale-price' ? '24.90' : '29.90', inventoryQuantity: 7 }, { id: 'gid://shopify/ProductVariant/57246326620508', title: 'Rose', price: '29.90', inventoryQuantity: 5 }]),
    media: page([black20, pink25, black25]) },
  productVariant: { id: BLACK, title: 'Noir', price: scenario === 'stale-price' ? '24.90' : '29.90', inventoryQuantity: 7, product: { id: PID }, selectedOptions: [{ name: 'Couleur', value: 'Noir' }],
    media: page(scenario === 'wrong-variant' ? [black20] : [black25]) },
};
const shopify = { kind: 'shopify', merchantId: M, async state() { return 'CONFIGURED'; }, async graphql() { return answer; } };
const cdnFetch = async (url) => (String(url).startsWith(CDN) ? new Response(photo) : new Response('', { status: 404 }));

const policy = {
  kind: 'TENANT_MEDIA_PROCESSING_POLICY', policy_id: 'policy://merchant-habb/creative-media', version: 1,
  tenant: { merchant_id: M }, accepted_by: { role: 'TENANT_OWNER', at: '2026-11-02T08:00:00Z' }, valid_from: '2026-11-01T00:00:00Z', valid_until: null, revoked: false,
  sources: { allowed_origins: ['SHOPIFY_CATALOG_VERIFIED_METADATA'], tenant_attests_catalog_product_images_show_no_people: true },
  processing: [
    { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'EU', cross_border_possible: false, purpose: 'NORDLA_CREATIVE_CRITIQUE', operations: ['VISION_CRITIQUE'] },
    { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'GLOBAL', cross_border_possible: true, purpose: 'NORDLA_SCENE_PRODUCTION', operations: ['IMAGE_EDIT'] },
  ],
  retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
  spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 5 }, audit: { journal_required: true },
};
const env = { ...process.env, ALIBABA_QWEN_TEXT_MODEL: 'qwen3-vl-plus', NORDLA_ALIBABA_SCOPE: 'EU' };
const imageEnv = { ...env, ALIBABA_MODEL_STUDIO_API_KEY: env.ALIBABA_MODEL_STUDIO_IMAGE_API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: env.ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID, ALIBABA_QWEN_IMAGE_MODEL: IMAGE_EDIT_MODEL };
const budget = new SpendGuard({ maxSpendEur: 0.5, maxImages: 3, maxVideoSeconds: 0 });
const calls = new JsonlCallJournal(join(workdir, 'provider-calls.jsonl'));
const local = localEngines({ renderScale: 0.5, samples: 8 });

try {
  const r = await runAutonomousWithShopifyMedia({
    shopify, request: { merchantId: M, productId: PID, variantId: BLACK, expectedVariantTitle: 'Noir' },
    objective: 'Donner envie aux habitants de Namur de découvrir la gourde TYESO noire chez HABB', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5',
    workdir: join(workdir, 'run'), policy, journal: new MediaTransmissionJournal(join(workdir, 'transmissions.jsonl')), runCeilingEur: 0.5, runId: 'e2e-1', fetchImpl: cdnFetch,
    providers: {
      critic: { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' }, scene: { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' },
      portsFor: ({ photoBytes, authorization }) => connectProviders({ env: { ...env, NORDLA_MEDIA_AUTHORIZATION_FILE: '' }, journal: calls, budget, sourcePhotoBytes: photoBytes, mediaAuthorization: authorization, trialAuthorized: true, maxTextCalls: 8, maxVisionCalls: 1 }),
      enginesFor: ({ sha256, authorization }) => createSceneEngine({ baseEngines: local, config: loadAlibabaCreativeConfig(imageEnv), authorization, photoSha256: sha256, budget, journal: calls,
        outputStore: new FileOutputStore(join(workdir, 'provider-outputs')), variants: 3, maxImageCalls: 1 }),
    },
  });
  console.log(JSON.stringify({ ok: true, status: r.status, published: r.published, media_selection: r.media_selection, transmissions: r.transmissions,
    human_interventions: r.human_interventions, proposals: (r.proposals ?? []).map((p) => ({ status: p.status, image: p.image, technical: p.technical_quality?.state, fidelity: p.technical_quality?.product_fidelity?.pass, max_visible: p.technical_quality?.product_fidelity?.max_visible_level_difference, creative: p.creative_quality?.state })),
    facts: JSON.parse(readFileSync(join(workdir, 'run', 'faits.json'), 'utf8')), trace: (r.trace ?? []).map((t) => ({ step: t.step, outcome: t.outcome, provider: t.provider })) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code ?? null, message: String(e.message).slice(0, 300) }));
}
