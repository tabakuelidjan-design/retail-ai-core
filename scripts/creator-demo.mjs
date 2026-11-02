#!/usr/bin/env node
// Nordla Créateur — LOCAL DEMONSTRATION (npm run creator:demo -> http://127.0.0.1:4420). Loopback only, never deployed.
//
// What is real: the Creator screen and API, the integration hub route CREATIVE.produce_product_visual, the variant-exact product
// photo selection, the Creative ledger rules (accepted tenant policy, atomic reservation, transmission lifecycle), the creative brain
// and the local Python engines that compose the final image around the real product pixels, and the technical checks.
// What is SIMULATED: the providers (text, critique, image edit) — a fetch double answers instead of Alibaba (no network, no key,
// no cost) — the Shopify catalog (a demonstration product: "TEST — Gourde démo 500 ml", not TYESO), and the ledger runs in memory.
// Real provider execution stays refused by the hub (NDR-D02). Nothing is ever published.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

if (!process.env.NORDLA_CREATOR_DEMO_CHILD) {
  // The provider double must be loaded BEFORE anything else (it replaces fetch): re-run this file with it, in a private work directory.
  const work = mkdtempSync(join(tmpdir(), 'nordla-creator-demo-'));
  const env = { ...process.env, NORDLA_CREATOR_DEMO_CHILD: '1', NORDLA_CREATOR_DEMO_DIR: work, NORDLA_SCENE_DOUBLE_DIR: work, NORDLA_PYTHON: PY,
    // test-double credentials: the fetch double answers every call, nothing leaves the machine
    ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-double-0000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-text-eu',
    ALIBABA_MODEL_STUDIO_IMAGE_API_KEY: 'sk-test-image-0000000000', ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID: 'ws-test-image-global' };
  delete env.NODE_OPTIONS; delete env.NORDLA_MEDIA_AUTHORIZATION_FILE; delete env.NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE;
  const child = spawn(process.execPath, ['--import', new URL('../test/fixtures/creative-autonomy/scene-fetch-double-preload.mjs', import.meta.url).href, fileURLToPath(import.meta.url)],
    { env, stdio: 'inherit', cwd: ROOT });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { createIntegration } = await import('../src/integration/index.js');
  const { createMemoryCreativeLedger } = await import('../src/creative-autonomy/creative-ledger.js');
  const { connectProviders } = await import('../src/creative-autonomy/providers.js');
  const { localEngines } = await import('../src/creative-autonomy/run.js');
  const { createSceneEngine } = await import('../src/creative-autonomy/scene-engine.js');
  const { loadAlibabaCreativeConfig } = await import('../src/marketing-creative/alibaba/config.js');
  const { SpendGuard } = await import('../src/marketing-creative/alibaba/budget.js');
  const { FileOutputStore } = await import('../src/marketing-creative/alibaba/output-store.js');
  const { IMAGE_EDIT_MODEL } = await import('../src/marketing-creative/alibaba/qwen-image-edit.js');
  const { createCreatorApp } = await import('../src/creative-autonomy/creator/app.js');

  const work = process.env.NORDLA_CREATOR_DEMO_DIR;
  const photoPath = join(work, 'demo-gourde-noire-500ml.jpg');
  execFileSync(PY, [join(ROOT, 'test/helpers/scene_fixtures.py'), 'photo', photoPath]); // the demonstration product photo (a drawn bottle)
  const photo = readFileSync(photoPath);

  // ---- demonstration tenant and catalog (Shopify connector double: read only) ----
  const M = '00000000-0000-4000-8000-00000000de01';
  const OWNER = '00000000-0000-4000-8000-0000000000a1';
  const PID = 'gid://shopify/Product/990000000001';
  const BLACK = 'gid://shopify/ProductVariant/990000000101';
  const WHITE = 'gid://shopify/ProductVariant/990000000102';
  const CDN = 'https://cdn.shopify.com/s/files/1/0000/0000/files/';
  const img = (id, file, alt) => ({ id: `gid://shopify/MediaImage/99${id}`, alt, image: { url: CDN + file, width: 900, height: 1200, altText: alt } });
  const black500 = img(1, 'TEST_gourde_demo_noir_500ml.jpg', 'TEST gourde démo noire 500 ml');
  const black350 = img(2, 'TEST_gourde_demo_noir_350ml.jpg', 'TEST gourde démo noire 350 ml');
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });
  const VARIANTS = [
    { id: BLACK, title: 'Noir', price: '19.90', inventoryQuantity: 4, media: [black500] },
    { id: WHITE, title: 'Blanc', price: '19.90', inventoryQuantity: 2, media: [] }, // no photo of this variant in the catalog: Nordla refuses, it never asks
  ];
  const product = { id: PID, title: 'TEST — Gourde démo 500 ml', status: 'ACTIVE', description: 'Produit de démonstration Nordla : gourde isotherme.', productType: 'Gourde', tags: ['test'],
    hasOnlyDefaultVariant: false, variants: page(VARIANTS.map(({ media, ...v }) => v)), media: page([black350, black500]) };
  const shopify = { kind: 'shopify', merchantId: M, async state() { return 'CONFIGURED'; },
    async graphql(_q, { productId, variantId }) {
      const v = VARIANTS.find((x) => x.id === variantId);
      return { product: productId === PID ? product : null,
        productVariant: v ? { id: v.id, title: v.title, price: v.price, inventoryQuantity: v.inventoryQuantity, product: { id: PID }, selectedOptions: [{ name: 'Couleur', value: v.title }], media: page(v.media) } : null };
    } };
  const cdnFetch = async (url) => (String(url).startsWith(CDN) ? new Response(photo) : new Response('', { status: 404 }));
  const euro = (p) => `${p.replace('.', ',')} €`;
  const catalog = async () => [{ product_id: PID, title: product.title, variants: VARIANTS.map((v) => ({ variant_id: v.id, title: v.title, price: euro(v.price) })) }];

  // ---- the tenant's standing media policy, accepted ONCE by its owner (ADR 0007-A), in the in-memory ledger ----
  const POLICY = {
    kind: 'TENANT_MEDIA_PROCESSING_POLICY', policy_id: 'policy://demo-tenant/creative-media', version: 1,
    tenant: { merchant_id: M }, accepted_by: { role: 'TENANT_OWNER', at: new Date().toISOString() }, valid_from: '2026-11-01T00:00:00Z', valid_until: null, revoked: false,
    sources: { allowed_origins: ['SHOPIFY_CATALOG_VERIFIED_METADATA'], tenant_attests_catalog_product_images_show_no_people: true },
    processing: [
      { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'EU', cross_border_possible: false, purpose: 'NORDLA_CREATIVE_CRITIQUE', operations: ['VISION_CRITIQUE'] },
      { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', scope: 'GLOBAL', cross_border_possible: true, purpose: 'NORDLA_SCENE_PRODUCTION', operations: ['IMAGE_EDIT'] },
    ],
    retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
    spend: { currency: 'EUR', per_run_max: 0.5, monthly_max: 5 }, audit: { journal_required: true },
  };
  const ledger = createMemoryCreativeLedger({ members: new Map([[M, new Map([[OWNER, 'OWNER']])]]) });
  await ledger.acceptPolicy({ merchantId: M, actorId: OWNER, policy: POLICY, now: new Date() });

  // ---- simulated providers, built per run FROM the selected bytes by the existing factories ----
  const env = { ...process.env, ALIBABA_QWEN_TEXT_MODEL: 'qwen3-vl-plus', NORDLA_ALIBABA_SCOPE: 'EU' };
  const imageEnv = { ...env, ALIBABA_MODEL_STUDIO_API_KEY: env.ALIBABA_MODEL_STUDIO_IMAGE_API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: env.ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID, ALIBABA_QWEN_IMAGE_MODEL: IMAGE_EDIT_MODEL };
  const local = localEngines({ renderScale: 0.5, samples: 8 });
  const TARGET = { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' };
  let runGuard = null; // one SpendGuard per run, shared by its critic and scene engine (the Creator runs one production at a time)
  const integration = createIntegration({ tenant_id: M, creativeProduction: {
    shopify, ledger, policyId: POLICY.policy_id, runCeilingEur: 0.5, brand: { merchant_id: M, merchant_name: 'Boutique de démonstration' }, nonProduction: true, fetchImpl: cdnFetch,
    workdirFor: (runId) => join(work, 'runs', runId),
    providers: {
      simulated: true, critic: TARGET, scene: TARGET,
      portsFor: ({ photoBytes, authorization, journal }) => { runGuard = new SpendGuard({ maxSpendEur: 0.5, maxImages: 3, maxVideoSeconds: 0 });
        return connectProviders({ env: { ...env, NORDLA_MEDIA_AUTHORIZATION_FILE: '' }, journal, budget: runGuard, sourcePhotoBytes: photoBytes, mediaAuthorization: authorization, trialAuthorized: true, maxTextCalls: 8, maxVisionCalls: 1 }); },
      enginesFor: ({ sha256, authorization, journal }) => createSceneEngine({ baseEngines: local, config: loadAlibabaCreativeConfig(imageEnv), authorization, photoSha256: sha256, budget: runGuard, journal,
        outputStore: new FileOutputStore(join(work, 'provider-outputs')), variants: 3, maxImageCalls: 1 }),
    },
  } });

  const handler = createCreatorApp({ integration, catalog, mode: 'SIMULATED', actor: { id: OWNER, role: 'OWNER' }, tenantName: 'Boutique de démonstration (test)' });
  const port = Number(process.env.CREATOR_PORT || 4420);
  http.createServer(handler).listen(port, '127.0.0.1', () => {
    console.log(`Nordla Créateur (DÉMONSTRATION SIMULÉE — aucun fournisseur réel, rien n'est publié) : http://127.0.0.1:${port}`);
  });
}
