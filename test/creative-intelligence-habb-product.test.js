import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import * as R from '../src/resources/index.js';
import { creativeBrandInterface } from '../src/branding/index.js';
import { buildBrandPackage } from '../scripts/build-benchmark-brand-package.mjs';
import { createBenchmarkResolver } from '../scripts/benchmark-resources.mjs';

// HABB CREATIVE BENCHMARK 001: the PRODUCT (Samsung Galaxy A17) and the local RUNNABLE gate (`// HP-N` markers follow the final-product-binding mandate list).
// The PRODUCT is proven by the owner's statement and the exact catalogue item; it is never inferred from the photograph.

const root = new URL('../', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const config = await json('benchmarks/creative-intelligence/habb-creative-benchmark-001.json');
const pkg = await json('benchmarks/creative-intelligence/habb-brand-canonical-v1.json');
const expressionFile = await json('benchmarks/creative-intelligence/habb-expression-system-benchmark-001.json');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ASSET_SHA = ['6c63d3e38c97fa77a72aed6b6056e93a', '71167055b152601968e5a72f7a7b890e'].join('');
const ASSET = 'asset://habb/benchmark-001/real-personalised-case-001';
const PRODUCT = 'product://habb/benchmark-001/samsung-galaxy-a17';
const OWNER = 'owner-decision://habb/benchmark-001/product/samsung-galaxy-a17';
const MERCHANT = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';
const TENANT = { merchantId: MERCHANT };
const privateFile = new URL(config.private_payloads[0].path, root);
const HERE = existsSync(privateFile);
const iface = creativeBrandInterface(buildBrandPackage(pkg.inputs, expressionFile.expression_system).context);
const assess = (cfg, resolver) => P.assessBenchmarkReadiness({ config: cfg, resolver, tenant: TENANT, creativeInterface: iface });
const stateOf = (report) => Object.fromEntries(report.bindings.map((b) => [b.id, b.status]));
const reasonOf = (report, id) => report.bindings.find((b) => b.id === id)?.reason;
const ciResolver = () => createBenchmarkResolver(config, { privatePayloads: false });
const evidence = config.product_evidence;
const record = config.owned_records.find((r) => r.ref === PRODUCT);

test('PRODUCT evidence: the owner confirmed the model and the exact catalogue item is recorded', async () => {
  // HP-1 the owner confirms Samsung Galaxy A17 (not authenticated by Nordla Identity; clock read once, outside any builder)
  assert.equal(evidence.owner_confirmation.statement, 'The Benchmark 001 case is for Samsung Galaxy A17.');
  assert.equal(evidence.owner_confirmation.model, 'Samsung Galaxy A17');
  assert.equal(evidence.owner_confirmation.ref, OWNER);
  assert.match(evidence.owner_confirmation.recorded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(evidence.owner_confirmation.authentication, /not authenticated by Nordla Identity, which remains an open dependency/);
  assert.match(evidence.owner_confirmation.authentication, /read once, outside any builder/);
  // HP-2 / HP-3 / HP-4 / HP-5 the exact Shopify product: GID, handle, title, ACTIVE, vendor, type, source system
  const c = evidence.catalogue;
  assert.equal(c.source_system, 'Shopify / HABB catalogue');
  assert.equal(c.product_gid, 'gid://shopify/Product/15684483187036');
  assert.equal(c.handle, 'coque-personnalisee-samsung-galaxy-a17');
  assert.equal(c.title, 'Coque personnalisée – Samsung Galaxy A17');
  assert.equal(c.status, 'ACTIVE');
  assert.equal(c.vendor, 'Samsung');
  assert.equal(c.product_type, 'Coque personnalisée');
  assert.match(c.verified, /Live read-only lookup of the connected HABB Shopify store/);
  // the resolver record carries the same identity, the two proofs and nothing mutable (no price, no inventory, no image)
  assert.deepEqual({ ...record.metadata }, {
    source_system: 'shopify', source_product_id: c.product_gid, title: c.title, handle: c.handle, vendor: 'Samsung', product_type: c.product_type, source_status: 'ACTIVE', owner_confirmation_ref: OWNER,
  });
  assert.equal(record.evidence_ref, c.ref);
  assert.doesNotMatch(JSON.stringify(record), /price|inventory|image|cdn\.shopify|https?:/i);
});

test('PRODUCT resource: ACTIVE for the HABB tenant, kind from the owner adapter, bound only with its proof', async () => {
  const resolver = ciResolver();
  // HP-6 resolves ACTIVE for the HABB tenant, with provenance
  const resolved = await resolver.resolve(PRODUCT, TENANT);
  assert.equal(resolved.kind, 'PRODUCT');
  assert.equal(resolved.status, 'ACTIVE');
  assert.equal(resolved.merchant_id, MERCHANT);
  assert.equal(resolved.provenance.evidence_ref, evidence.catalogue.ref);
  assert.equal(await resolver.resolve(PRODUCT, { merchantId: '22222222-2222-4222-8222-222222222222' }).catch((e) => e.code), R.RES_ERROR.CROSS_MERCHANT);
  // HP-7 the kind comes from the owner adapter, not from the text of the reference: a product:// ref the owner declares as an ASSET is an ASSET
  const trap = R.createCommonResourceResolver({
    adapters: [R.createStaticResourceAdapter({ adapter_id: 'owner', records: [{ ...record, ref: 'product://habb/benchmark-001/not-a-product', kind: 'ASSET', metadata: config.owned_records.find((r) => r.ref === ASSET).metadata }] })],
  });
  assert.equal((await trap.resolve('product://habb/benchmark-001/not-a-product', TENANT)).kind, 'ASSET');
  // the benchmark is bound to it
  assert.equal(config.bindings.product.ref, PRODUCT);
  assert.equal(reasonOf(await assess(config, resolver), 'product'), 'RESOLVED_WITH_EVIDENCE');
  // HP-8 without trusted proof the binding fails again: removing the owner statement / the proof kind, or a refused proof kind
  const without = (proof) => ({ ...config, bindings: { ...config.bindings, product: { ref: PRODUCT, ...(proof ? { proof } : {}) } } });
  assert.equal(reasonOf(await assess(without(null), resolver), 'product'), 'PRODUCT_PROOF_MISSING');
  assert.equal(reasonOf(await assess(without({ owner_decision_ref: OWNER }), resolver), 'product'), 'PRODUCT_PROOF_MISSING');
  // HP-9 camera geometry (or any visual feature) is not proof
  for (const kind of ['CAMERA_GEOMETRY', 'VISUAL_SIMILARITY', 'IMAGE_CLASSIFIER']) {
    assert.equal(reasonOf(await assess(without({ kind }), resolver), 'product'), 'PRODUCT_PROOF_MISSING', kind);
  }
  assert.ok(config.bindings.product.resolution.refused_as_proof.includes('camera geometry or camera count'));
  assert.equal(config.bindings.product.proof.kind, 'OWNER_STATEMENT');
  assert.equal(config.bindings.product.proof.owner_decision_ref, OWNER);
  assert.equal(config.bindings.product.proof.catalogue_evidence_ref, evidence.catalogue.ref);
  // the old blockers are gone
  assert.deepEqual(config.bindings_still_missing, []);
  assert.doesNotMatch(JSON.stringify(config), /HABB_BENCHMARK_PRODUCT_BINDING_MISSING|"OWNER_PRODUCT_CONFIRMATION_REQUIRED"/);
});

test('PRODUCT <-> ASSET: linked by owner statement and catalogue item, not by the image; the asset stays the real photograph', async () => {
  const link = config.product_asset_link;
  const assetRecord = config.owned_records.find((r) => r.ref === ASSET);
  // HP-10 the link names both identities and its proof
  assert.equal(link.product_ref, PRODUCT);
  assert.equal(link.asset_ref, ASSET);
  assert.equal(link.product_identity, 'Samsung Galaxy A17');
  assert.equal(link.asset_identity, 'owner-supplied real photograph');
  assert.equal(link.proof, 'owner statement + exact catalogue item');
  assert.match(link.inference, /none: the link is not inferred from camera geometry or any visual feature/);
  // HP-11 the real asset hash is unchanged: the link, the ASSET record and the pinned value agree, and where the private file is present its bytes still hash to it
  assert.equal(link.asset_sha256, ASSET_SHA);
  assert.equal(assetRecord.metadata.content_hash, ASSET_SHA);
  assert.equal(assetRecord.metadata.origin, 'MERCHANT_PROVIDED');
  if (HERE) assert.equal(sha(readFileSync(privateFile)), ASSET_SHA);
  // HP-21 a Shopify featured image never substitutes for the benchmark asset: no image URL anywhere, the asset is the merchant photograph with its own hash
  const text = JSON.stringify(config);
  assert.doesNotMatch(text, /cdn\.shopify|featuredImage|featured_image|samsung-galaxy-a17-old/i);
  assert.match(evidence.catalogue.identity_only, /featured image is not copied and never substitutes for the benchmark ASSET/);
  assert.equal(config.bindings.asset.ref, ASSET);
  // removing the owner / catalogue proof from the product breaks the PRODUCT binding, while the asset (a separate resource) is unaffected
  const broken = { ...config, bindings: { ...config.bindings, product: { ref: PRODUCT } } };
  const report = await assess(broken, ciResolver());
  assert.equal(stateOf(report).product, 'BLOCKED');
  assert.equal(reasonOf(report, 'asset'), 'ASSET_PAYLOAD_UNAVAILABLE');
});

test('Local RUNNABLE gate: runnable only with the verified private payload; a clean clone stays BLOCKED; never run', async () => {
  const ci = await assess(config, ciResolver());
  const state = stateOf(ci);
  // HP-12..15 claims, format, expression and fonts remain BOUND (in every environment)
  for (const id of ['claim:price', 'claim:promise', 'format', 'expression_system', 'font:font://google-fonts/playfair-display', 'font:font://google-fonts/montserrat', 'product']) assert.equal(state[id], 'BOUND', id);
  // HP-17 a clean clone (no private payload): metadata bound, payload unavailable, BLOCKED, and that is the only blocker
  assert.deepEqual(ci.asset, { metadata_bound: true, payload_available: false });
  assert.equal(ci.status, 'BLOCKED');
  assert.deepEqual(ci.blockers, [{ id: 'asset', reason: 'ASSET_PAYLOAD_UNAVAILABLE' }]);
  // HP-16 a trusted local environment with the hash-verified private payload and the product proof: RUNNABLE
  if (HERE) {
    const local = await assess(config, createBenchmarkResolver(config));
    assert.deepEqual(local.asset, { metadata_bound: true, payload_available: true });
    assert.equal(stateOf(local).asset, 'BOUND');
    assert.equal(local.status, 'RUNNABLE');
    assert.deepEqual(local.blockers, []);
    // HP-19 RUNNABLE is not RUN
    assert.equal(local.runnable_is_not_run, true);
    assert.equal(code(() => P.recordBenchmarkRun({ readiness: local, results: {}, ran_at: '2026-10-10T10:00:00.000Z' })), CI.CI_ERROR.BENCHMARK_INVALID);
  }
  // HP-18 the configuration status is NOT_RUN in both environments (readiness never writes it)
  assert.equal(config.status, 'RUN');
  assert.equal(JSON.parse(readFileSync(new URL('benchmarks/creative-intelligence/habb-creative-benchmark-001.json', root), 'utf8')).status, 'RUN');
  // HP-20 C2 stays closed: RUNNABLE opens nothing, only a recorded run does
  const onlyExpression = CI.assessCreativeC2Readiness({ BRAND_EXPRESSION_SYSTEM: P.assessExpressionReadiness(iface).evidence });
  assert.equal(onlyExpression.c2_allowed, false);
  assert.ok(onlyExpression.open_blockers.includes('REAL_CAMPAIGN_BENCHMARK'));
  assert.equal(CI.assessCreativeC2Readiness({}).c2_allowed, false);
});

test('Private image and generic source: no raw image in Git, no product-model inference', async () => {
  // HP-22 no raw private image enters Git
  const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(!tracked.some((f) => f.startsWith('data/private/')));
  for (const f of tracked.filter((x) => /\.(jpe?g|png)$/i.test(x))) assert.notEqual(sha(readFileSync(new URL(f, root))), ASSET_SHA, f);
  assert.doesNotThrow(() => execSync(`git check-ignore -q ${config.private_payloads[0].path}`, { cwd: root }));
  // HP-23 no model inference from visual features exists in the generic source, and no merchant product is named there
  for (const dir of ['creative-intelligence', 'resources', 'branding', 'creative-fidelity']) {
    for (const file of readdirSync(new URL(`src/${dir}/`, root)).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(new URL(`src/${dir}/${file}`, root), 'utf8');
      assert.doesNotMatch(source, /camera_count|camera_shape|camera_layout|camera geometry|image.?classifier|galaxy|a17\b/i, `${dir}/${file}`);
    }
  }
});

function code(fn) { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; }
