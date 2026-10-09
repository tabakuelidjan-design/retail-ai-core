import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import * as R from '../src/resources/index.js';
import {
  buildBrandContext, creativeBrandInterface, isExpressionNonEmpty, normalizeExpressionSystem,
} from '../src/branding/index.js';
import { buildMemoryFlow, reviseMemory } from './branding-v11-world.js';
import { loadFontManifest } from '../scripts/benchmark-resources.mjs';

// HABB CREATIVE BENCHMARK 001 preparation. `// HB-N` markers follow the numbered list of the preparation mandate. The HABB data lives in
// benchmarks/creative-intelligence/*.json; nothing about HABB is in src/.

const read = async (file) => JSON.parse(await readFile(new URL(`../benchmarks/creative-intelligence/${file}`, import.meta.url), 'utf8'));
const config = await read('habb-creative-benchmark-001.json');
const expressionFile = await read('habb-expression-system-benchmark-001.json');
const HABB = { merchantId: config.merchant.merchant_id };
const PRICE = 'claim://habb/benchmark-001/price-25';
const SPEED = 'claim://habb/benchmark-001/express-5-minutes';
const fontResources = loadFontManifest(config.resource_manifests[0]);
const resolverOf = (records = [], payloads = {}) => R.createCommonResourceResolver({
  adapters: [
    R.createStaticResourceAdapter({ adapter_id: 'benchmark-owned', records: [...config.owned_records, ...fontResources.records], payloads: fontResources.payloads }),
    ...(records.length ? [R.createStaticResourceAdapter({ adapter_id: 'other-owner', records, payloads })] : []),
  ],
});
const assess = (over = {}) => P.assessBenchmarkReadiness({
  config: over.config ?? config, resolver: over.resolver ?? resolverOf(), tenant: HABB, creativeInterface: over.creativeInterface ?? null,
});
const reasonOf = (report, id) => report.bindings.find((b) => b.id === id)?.reason;
const everyText = (domain) => [...domain.principles, ...domain.do, ...domain.dont];

test('Benchmark 001 claims: exact approved wording, benchmark-owned evidence, qualified promise', async () => {
  const price = await resolverOf().resolve(PRICE, HABB);
  const speed = await resolverOf().resolve(SPEED, HABB);
  // HB-1 the price claim resolves ACTIVE with exactly "25 €", its approval and its evidence
  assert.equal(price.kind, 'CLAIM');
  assert.equal(price.status, 'ACTIVE');
  assert.equal(price.merchant_id, HABB.merchantId);
  assert.equal(price.metadata.approved_wording, '25 €');
  assert.equal(price.metadata.approval_ref, 'approval://habb/GBP-PROD-01');
  assert.equal(price.provenance.evidence_ref, 'evidence://habb/GBP-PROD-01/price');
  // HB-2 the speed claim resolves ACTIVE with exactly "5 minutes"
  assert.equal(speed.status, 'ACTIVE');
  assert.equal(speed.metadata.approved_wording, '5 minutes');
  assert.equal(speed.metadata.approval_ref, 'approval://habb/GBP-PROD-01');
  assert.equal(speed.provenance.evidence_ref, 'evidence://habb/GBP-PROD-01/speed');
  // another merchant never sees these claims
  assert.equal(await resolverOf().resolve(PRICE, { merchantId: '22222222-2222-4222-8222-222222222222' }).catch((e) => e.code), R.RES_ERROR.CROSS_MERCHANT);
  // HB-3 the operational qualification of "5 minutes" is preserved beside the evidence, not dropped and not widened into the generic contract
  const q = config.claim_evidence.claims[SPEED].qualification;
  assert.deepEqual(q.only_when, ['the compatible case/model is available', "the customer's file is ready and usable"]);
  assert.match(q.not, /unconditional/);
  assert.match(config.claim_evidence.claims[SPEED].approved_source_text, /selon la disponibilité du modèle/);
  assert.deepEqual(Object.keys(speed.metadata).sort(), ['approval_ref', 'approved_wording']);
  assert.equal(config.claim_evidence.claims[SPEED].display_wording, '5 minutes');
  // HB-4 the evidence is benchmark-owned trusted data, not a production Claims Registry; 25 EUR is not generalized
  assert.equal(config.claim_evidence.registry_status, 'BENCHMARK_OWNED_NOT_A_CLAIMS_REGISTRY');
  assert.match(config.claim_evidence.note, /does not exist yet/);
  assert.match(config.claim_evidence.claims[PRICE].scope, /NOT generalized/);
  assert.match(config.claim_evidence.claims[PRICE].scope, /24\.90/);
  assert.ok(config.owned_records.filter((r) => r.kind === 'CLAIM').every((r) => r.ref.startsWith('claim://habb/benchmark-001/')));
});

test('HABB expression system content: owner-approved, normalized, governed, and stated honestly', async () => {
  const expression = expressionFile.expression_system;
  const photography = expression.photography;
  // HB-5 no hidden beige / default-AI style: beige is only ever forbidden, and nothing positively prescribes a default look
  assert.ok(photography.dont.some((t) => /beige/i.test(t) && /default/i.test(t)));
  for (const domain of Object.values(expression)) for (const t of [...domain.principles, ...domain.do]) assert.doesNotMatch(t, /beige|gold|glow|gradient/i, t);
  assert.ok(photography.dont.some((t) => /generic warm gradients/.test(t)) && photography.dont.some((t) => /artificial gold/.test(t)));
  // HB-6 automatic decorative hearts are blocked wherever they could creep in
  for (const domain of ['photography', 'illustration', 'iconography']) assert.ok(expression[domain].dont.some((t) => /hearts/.test(t)), domain);
  // HB-7 automatic decorative leaves / branches / foliage are blocked
  for (const domain of ['photography', 'illustration', 'iconography']) assert.ok(expression[domain].dont.some((t) => /leaves|foliage|branches/.test(t)), domain);
  // HB-8 the product keeps its real geometry and details
  const product = expression.product_presentation;
  assert.ok(product.dont.some((t) => /cut-outs, buttons, camera holes, shape, proportions or material/.test(t)));
  assert.ok(product.dont.some((t) => /regenerate a real product when the real asset exists/.test(t)));
  assert.ok(product.do.some((t) => /preserve original product pixels/.test(t)));
  // HB-9 faces in a customer's personalisation are protected
  assert.ok(product.dont.some((t) => /modify a face appearing in a customer's personalisation/.test(t)));
  assert.ok(product.dont.some((t) => /distort a person's face, body or identity/.test(t)));
  // HB-10 it passes the Brand Memory V1.1 normalizer unchanged in meaning (no hex, URL, prompt, model, seed or score), all seven domains, no locale override
  const normalized = normalizeExpressionSystem(expression);
  assert.deepEqual(Object.keys(normalized), ['photography', 'product_presentation', 'composition', 'layout_principles', 'illustration', 'iconography', 'motion']);
  assert.equal(isExpressionNonEmpty(normalized), true);
  assert.ok(!('locale_overrides' in normalized));
  assert.deepEqual(normalized.photography.reference_asset_refs, []);
  assert.doesNotMatch(JSON.stringify(expression), /#[0-9a-f]{3,8}\b|https?:\/\/|\bseed\b|\bprompt\b/i);
  assert.ok(Object.values(expression).every((d) => everyText(d).length > 0));
  // HB-11 it enters Brand Memory only through the existing governance: a REVISION, REVIEW_REQUIRED first, human approval, old Memory superseded
  // (exercised on a SYNTHETIC brand: the real HABB brand identity / Core / Memory do not exist yet)
  const flow = buildMemoryFlow();
  const next = reviseMemory(flow, { expression_system: expression });
  assert.equal(next.revision.memory.status, 'REVIEW_REQUIRED');
  assert.equal(next.revision.auto_approved, false);
  assert.equal(next.approvedMemory.version, flow.approved.version + 1);
  assert.equal(next.supersededMemory.status, 'SUPERSEDED');
  assert.deepEqual(JSON.parse(JSON.stringify(next.approvedMemory.expression_system)), JSON.parse(JSON.stringify(normalized)));
  // the governed expression closes the benchmark's expression binding (and only that one)
  const context = buildBrandContext({ tenant: flow.tenant, brand: flow.brand, core: flow.core, memory: next.approvedMemory, snapshot: flow.snapshot });
  const report = await assess({ creativeInterface: creativeBrandInterface(context) });
  assert.equal(reasonOf(report, 'expression_system'), 'APPROVED_NON_EMPTY');
  assert.equal(report.status, 'BLOCKED');
  // the content now lives in the APPROVED HABB Brand Memory (creative-intelligence-habb-brand.test.js); without a brand interface the binding is still reported absent
  assert.equal(expressionFile.governance.status, 'IN_APPROVED_BRAND_MEMORY');
  assert.equal(config.bindings.expression.status, 'BOUND_TO_APPROVED_BRAND_MEMORY');
  assert.equal(reasonOf(await assess(), 'expression_system'), 'EXPRESSION_SYSTEM_ABSENT');
});

test('Benchmark 001 readiness: bound where proven, blocked and named where not, never run', async () => {
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const bytes = Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i * 5) % 251));
  const posterRecord = (origin, over = {}) => ({
    ref: 'asset://habb/poster', kind: 'ASSET', merchant_id: HABB.merchantId, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://x',
    metadata: { media_type: 'image/png', width_px: 800, height_px: 1000, content_hash: sha(bytes), origin, approval_ref: 'approval://x' }, ...over,
  });
  const shipped = await assess();
  // HB-12 not RUNNABLE without a real product asset
  assert.equal(shipped.status, 'BLOCKED');
  assert.equal(reasonOf(shipped, 'asset'), 'BINDING_MISSING');
  assert.equal(config.bindings.asset.ref, null);
  assert.equal(config.bindings.asset.status, 'HABB_BENCHMARK_REAL_ASSET_MISSING');
  // HB-13 a generated / synthetic poster (or any non-merchant image) cannot satisfy ASSET, and nothing in the repository ever binds one
  for (const origin of ['GENERATED', 'SYNTHETIC']) {
    const withPoster = { ...config, bindings: { ...config.bindings, asset: { ref: 'asset://habb/poster' } } };
    const report = await assess({ config: withPoster, resolver: resolverOf([posterRecord(origin)], { 'asset://habb/poster': bytes }) });
    assert.equal(reasonOf(report, 'asset'), 'ASSET_NOT_REAL_MERCHANT_ASSET', origin);
    assert.equal(report.status, 'BLOCKED');
  }
  // HB-14 not RUNNABLE without font bindings (a benchmark with no font is blocked), and the test fixtures are not HABB fonts; the shipped benchmark now binds its two fonts
  const noFonts = { ...config, bindings: { ...config.bindings, fonts: [] } };
  assert.equal(reasonOf(await assess({ config: noFonts }), 'fonts'), 'BINDING_MISSING');
  assert.deepEqual(config.bindings.fonts.map((f) => f.ref), ['font://google-fonts/playfair-display', 'font://google-fonts/montserrat']);
  assert.ok(!JSON.stringify(config).match(/DejaVu|Noto/));
  // HB-15 the missing canonical PRODUCT stays a named blocker (no fake catalogue record was created)
  assert.equal(reasonOf(shipped, 'product'), 'BINDING_MISSING');
  assert.equal(config.bindings.product.ref, null);
  assert.equal(config.bindings.product.status, 'HABB_BENCHMARK_PRODUCT_BINDING_MISSING');
  assert.ok(config.bindings_still_missing.some((b) => b.startsWith('HABB_BENCHMARK_PRODUCT_BINDING_MISSING')));
  assert.ok(config.bindings_still_missing.some((b) => b.startsWith('HABB_BENCHMARK_REAL_ASSET_MISSING')));
  assert.ok(!config.bindings_still_missing.some((b) => b.includes('FONT_BINDINGS_MISSING')));
  assert.equal(config.owned_records.filter((r) => r.kind === 'PRODUCT' || r.kind === 'ASSET' || r.kind === 'FONT').length, 0);
  // HB-16 the FORMAT is unchanged: 1080 x 1350 px DIGITAL, explicit empty zones, platform-level
  assert.equal(reasonOf(shipped, 'format'), 'RESOLVED_WITH_EVIDENCE');
  const format = await resolverOf().resolve(config.bindings.format.ref, HABB);
  assert.equal(config.bindings.format.ref, 'format://habb/benchmark-001/instagram-feed-1080x1350');
  assert.deepEqual(JSON.parse(JSON.stringify(format.metadata)), {
    canvas: { width: 1080, height: 1350, unit: 'px' }, medium: 'DIGITAL', safe_zones: [], forbidden_zones: [], production_constraints: [],
  });
  assert.equal(format.merchant_id, null);
  // the claims and the format are the bound items; everything else is individually reported
  assert.deepEqual(shipped.bindings.map((b) => [b.id, b.status]), [
    ['product', 'MISSING'], ['asset', 'MISSING'], ['claim:price', 'BOUND'], ['claim:promise', 'BOUND'], ['format', 'BOUND'], ['font:font://google-fonts/playfair-display', 'BOUND'], ['font:font://google-fonts/montserrat', 'BOUND'], ['expression_system', 'MISSING'],
  ]);
  // HB-17 C2 stays blocked, the benchmark stays NOT_RUN, and a BLOCKED benchmark cannot be recorded as run
  assert.equal(config.status, 'NOT_RUN');
  assert.equal(CI.assessCreativeC2Readiness({}).c2_allowed, false);
  assert.equal(code(() => P.recordBenchmarkRun({ readiness: shipped, results: { preflight_status: 'PASS', fidelity_status: 'PASS', guardian_status: 'PASS', png_sha256: 'a'.repeat(64) }, ran_at: '2026-10-10T10:00:00.000Z' })), CI.CI_ERROR.BENCHMARK_INVALID);
});

function code(fn) { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; }
