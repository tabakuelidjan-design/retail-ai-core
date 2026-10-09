import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import * as R from '../src/resources/index.js';
import { creativeBrandInterface } from '../src/branding/index.js';
import { buildMemoryFlow, colorRule, sampleExpression } from './branding-v11-world.js';
import { FONT, FONT_AR, LATER, code, demoDocument, resolveAllMedia } from './creative-intelligence-fixtures.js';

// `// PC2-N text` markers are rows of the PRE-C2 coverage matrix (docs/architecture/creative-pre-c2-foundation.md).

const M = '11111111-1111-4111-8111-111111111111';
const tenant = { merchantId: M };
const read = async (file) => new Uint8Array(await readFile(new URL(`./fixtures/fonts/${file}`, import.meta.url)));
const dejavuBytes = await read('DejaVuSans.ttf');
const naskhBytes = await read('NotoNaskhArabic_400Regular.ttf');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const meta = (bytes, family) => ({
  family, style: 'normal', weight: 400, version: '1.0', format: 'ttf', content_hash: sha(bytes), license_ref: 'license://fixture-font',
});
const dejavu = P.createRealFont({ font_ref: FONT, bytes: dejavuBytes, metadata: meta(dejavuBytes, 'DejaVu Sans') });
const naskh = P.createRealFont({ font_ref: FONT_AR, bytes: naskhBytes, metadata: meta(naskhBytes, 'Noto Naskh Arabic') });
const realFonts = () => P.createRealFontRegistry([dejavu, naskh]);
const productionDoc = () => CI.solveLayout({
  document: demoDocument(), recipe_id: 'PRODUCT_HERO', fonts: realFonts(), assets: { 'asset://demo/product-cutout': { width_px: 800, height_px: 1000 }, 'asset://demo/logo': { width_px: 600, height_px: 200 } }, created_at: LATER,
}).document;

const GENERIC_SOURCES = ['creative-intelligence', 'resources'];
const sourceFiles = async () => {
  const out = [];
  for (const dir of GENERIC_SOURCES) {
    for (const file of (await readdir(new URL(`../src/${dir}/`, import.meta.url))).filter((f) => f.endsWith('.js'))) out.push(`${dir}/${file}`);
  }
  out.push('branding/expression-system.js');
  return out;
};
const offending = (source, pattern) => (source.match(pattern) ?? [null])[0];

const benchmarkConfig = JSON.parse(await readFile(new URL('../benchmarks/creative-intelligence/habb-creative-benchmark-001.json', import.meta.url), 'utf8'));

// ------------------------------------------------------------------ the real verifications issue evidence

test('PRE-C2 verifications run real checks and issue the only evidence that closes a dependency', async () => {
  // PC2-77 each verification issues registered evidence for ITS dependency, and assessCreativeC2Readiness accepts nothing else
  const evidence = {
    RESOURCE_RESOLVER: await P.verifyResourceResolver(),
    REAL_FONT_METRICS: await P.verifyFontMetrics(dejavu),
    COMPLEX_SCRIPT_SHAPING: await P.verifyShaping({ latinFont: dejavu, arabicFont: naskh }),
    ARABIC_BIDI_RTL_VERIFICATION: await P.verifyArabicBidi({ font: dejavu }),
    DETERMINISTIC_RASTERIZER: await P.verifyRasterizer(),
    REAL_PNG_RENDER_PATH: await P.verifyPngPath({ document: productionDoc(), fonts: realFonts(), assetResolver: resolveAllMedia }),
  };
  for (const [dependency, item] of Object.entries(evidence)) {
    assert.equal(item.dependency, dependency);
    assert.equal(item.status, 'VERIFIED');
    assert.match(item.evidence_ref, /^probe:\/\//);
    assert.ok(item.details.checks.length >= 1);
  }
  const partial = CI.assessCreativeC2Readiness(evidence);
  assert.equal(partial.c2_allowed, false);
  assert.deepEqual([...partial.open_blockers].sort(), ['BRAND_EXPRESSION_SYSTEM', 'REAL_CAMPAIGN_BENCHMARK']);
  assert.equal(partial.typography_production_ready, true);
  // a copy of the evidence is not the evidence
  assert.equal(code(() => CI.assessCreativeC2Readiness({ RESOURCE_RESOLVER: { ...evidence.RESOURCE_RESOLVER } })), CI.CI_ERROR.READINESS_INVALID);
  // a verification that does not hold throws instead of issuing anything
  assert.equal(await P.verifyFontMetrics({ kind: 'DECLARED' }).catch((e) => e.code), CI.CI_ERROR.PROBE_FAILED);
});

// ------------------------------------------------------------------ expression readiness (27, 28)

test('A brand with no expression system is not C2-ready, and nothing fills the gap with a style', async () => {
  const legacy = buildMemoryFlow();
  const v11 = buildMemoryFlow({ content: { hard_rules: [colorRule], design_tokens: { colors: { primary: '#112233' } }, expression_system: sampleExpression() } });
  // PC2-27 an absent or empty expression system blocks C2; an approved non-empty one closes only its own dependency
  assert.equal(P.assessExpressionReadiness(null).ready, false);
  const absent = P.assessExpressionReadiness(creativeBrandInterface(legacy.context));
  assert.equal(absent.ready, false);
  assert.equal(absent.reason, 'EXPRESSION_SYSTEM_ABSENT');
  assert.equal(absent.evidence, null);
  assert.equal(P.assessExpressionReadiness({ ...creativeBrandInterface(v11.context), expression_system: {} }).reason, 'EXPRESSION_SYSTEM_EMPTY');
  const ready = P.assessExpressionReadiness(creativeBrandInterface(v11.context));
  assert.equal(ready.ready, true);
  assert.equal(ready.evidence.dependency, 'BRAND_EXPRESSION_SYSTEM');
  assert.equal(CI.assessCreativeC2Readiness({ BRAND_EXPRESSION_SYSTEM: ready.evidence }).open_blockers.includes('BRAND_EXPRESSION_SYSTEM'), false);
  // PC2-28 no hidden style fallback: the generic source holds no default background, font, composition, mood or photography
  for (const file of await sourceFiles()) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.equal(offending(source, /(premium|minimalist)|default[_ ]?(font|background|photography|composition)/i), null, file);
    assert.equal(offending(source, /#fff(fff)?|['"]white['"]/i), null, file);
  }
});

// ------------------------------------------------------------------ the HABB benchmark readiness (53-61)

const claimRecord = (ref, wording, over = {}) => ({
  ref, kind: 'CLAIM', merchant_id: M, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://claim-approval', metadata: { approved_wording: wording, approval_ref: 'approval://claim' }, ...over,
});
const assetBytes = Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i * 3) % 251));
const assetRecord = (over = {}) => ({
  ref: 'asset://bench/photo', kind: 'ASSET', merchant_id: M, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://asset-approval',
  metadata: { media_type: 'image/png', width_px: 800, height_px: 1000, content_hash: sha(assetBytes), origin: 'MERCHANT_PROVIDED', approval_ref: 'approval://asset' }, ...over,
});
// A SYNTHETIC complete world, only to exercise the generic readiness logic - never a HABB claim.
const completeConfig = () => ({
  ...benchmarkConfig,
  bindings: {
    ...benchmarkConfig.bindings,
    product: { ref: 'product://bench/item' },
    asset: { ref: 'asset://bench/photo' },
    claims: [
      { id: 'price', ref: 'claim://bench/price', expected_wording: '25 €' },
      { id: 'promise', ref: 'claim://bench/promise', expected_wording: '5 minutes' },
    ],
    fonts: [{ ref: 'font://bench/sans' }],
  },
});
const resolverFor = ({ config = benchmarkConfig, records = [], payloads = {} } = {}) => R.createCommonResourceResolver({
  adapters: [
    R.createStaticResourceAdapter({ adapter_id: 'benchmark-owned', records: config.owned_records }),
    ...(records.length ? [R.createStaticResourceAdapter({ adapter_id: 'merchant-owned', records, payloads })] : []),
  ],
});
const completeRecords = (over = {}) => [
  { ref: 'product://bench/item', kind: 'PRODUCT', merchant_id: M, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://catalogue', metadata: null },
  assetRecord(over.asset),
  claimRecord('claim://bench/price', '25 €', over.price),
  claimRecord('claim://bench/promise', '5 minutes', over.promise),
  {
    ref: 'font://bench/sans', kind: 'FONT', merchant_id: null, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://font', metadata: meta(dejavuBytes, 'DejaVu Sans'), ...over.font,
  },
];
const completePayloads = () => ({ 'asset://bench/photo': assetBytes, 'font://bench/sans': dejavuBytes });
const approvedInterface = () => creativeBrandInterface(buildMemoryFlow({ content: { hard_rules: [colorRule], design_tokens: { colors: { primary: '#112233' } }, expression_system: sampleExpression() } }).context);
const assess = (over = {}) => P.assessBenchmarkReadiness({
  config: over.config ?? completeConfig(),
  resolver: resolverFor({ config: over.config ?? completeConfig(), records: over.records ?? completeRecords(), payloads: over.payloads ?? completePayloads() }),
  tenant,
  creativeInterface: over.creativeInterface === undefined ? approvedInterface() : over.creativeInterface,
});
const reasonOf = (report, id) => report.bindings.find((b) => b.id === id)?.reason;

test('HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real', async () => {
  // PC2-53 the benchmark is configuration data: nothing in the generic source knows the campaign, the merchant or the product
  for (const file of await sourceFiles()) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.equal(offending(source, /habb|phone case|coque|instagram|1080|1350/i), null, file);
  }
  assert.equal(benchmarkConfig.kind, 'CONFIGURATION_DATA');
  // PC2-54 as shipped (product, real asset, fonts and the Brand Memory expression system still missing) the benchmark is BLOCKED, never RUNNABLE, and names every missing binding
  const shipped = await P.assessBenchmarkReadiness({ config: benchmarkConfig, resolver: resolverFor(), tenant: { merchantId: benchmarkConfig.merchant.merchant_id }, creativeInterface: null });
  assert.equal(shipped.status, 'BLOCKED');
  assert.equal(reasonOf(shipped, 'product'), 'BINDING_MISSING');
  assert.equal(reasonOf(shipped, 'asset'), 'BINDING_MISSING');
  assert.equal(reasonOf(shipped, 'claim:price'), 'RESOLVED_WITH_EVIDENCE');
  assert.equal(reasonOf(shipped, 'claim:promise'), 'RESOLVED_WITH_EVIDENCE');
  assert.equal(reasonOf(shipped, 'fonts'), 'BINDING_MISSING');
  assert.equal(reasonOf(shipped, 'expression_system'), 'EXPRESSION_SYSTEM_ABSENT');
  // PC2-55 the FORMAT is the one binding that resolves, from the benchmark's own owned record, through the common resolver (platform-level, 1080x1350 px DIGITAL)
  assert.equal(reasonOf(shipped, 'format'), 'RESOLVED_WITH_EVIDENCE');
  const format = await resolverFor().resolve(benchmarkConfig.bindings.format.ref, tenant);
  assert.deepEqual(format.metadata.canvas, { width: 1080, height: 1350, unit: 'px' });
  assert.equal(format.metadata.medium, 'DIGITAL');
  assert.equal(format.merchant_id, null);
  assert.equal(format.provenance.evidence_ref, 'architect-decision://habb-creative-benchmark-001/primary-canvas');
  assert.deepEqual(Object.keys(format.metadata).sort(), ['canvas', 'forbidden_zones', 'medium', 'production_constraints', 'safe_zones']);
  // PC2-56 a missing real asset is never substituted: a generated, synthetic or unapproved asset, or one without bytes, keeps the benchmark blocked
  for (const origin of ['GENERATED', 'SYNTHETIC']) {
    const report = await assess({ records: completeRecords({ asset: { metadata: { ...assetRecord().metadata, origin } } }) });
    assert.equal(report.status, 'BLOCKED');
    assert.equal(reasonOf(report, 'asset'), 'ASSET_NOT_REAL_MERCHANT_ASSET');
  }
  assert.equal(reasonOf(await assess({ payloads: { 'font://bench/sans': dejavuBytes } }), 'asset'), 'ASSET_PAYLOAD_UNAVAILABLE');
  // PC2-57 claim evidence missing (wording differs, unresolved or revoked) blocks RUNNABLE: nothing approves a claim by itself
  const reworded = await assess({ records: completeRecords({ price: { metadata: { approved_wording: '24,90 €', approval_ref: 'approval://claim' } } }) });
  assert.equal(reworded.status, 'BLOCKED');
  assert.equal(reasonOf(reworded, 'claim:price'), 'CLAIM_WORDING_DIFFERS_FROM_EXPECTED');
  const revoked = await assess({ records: completeRecords({ promise: { status: 'REVOKED' } }) });
  assert.equal(reasonOf(revoked, 'claim:promise'), 'RESOURCE_REVOKED');
  const unknown = await assess({ records: completeRecords().filter((r) => r.ref !== 'claim://bench/promise') });
  assert.equal(reasonOf(unknown, 'claim:promise'), 'RESOURCE_UNRESOLVED');
  // PC2-58 expression system missing or empty blocks RUNNABLE
  assert.equal(reasonOf(await assess({ creativeInterface: null }), 'expression_system'), 'EXPRESSION_SYSTEM_ABSENT');
  assert.equal(reasonOf(await assess({ creativeInterface: { ...approvedInterface(), expression_system: {} } }), 'expression_system'), 'EXPRESSION_SYSTEM_EMPTY');
  // PC2-59 fonts need a licence reference and bytes; a canvas that is not the expected one blocks
  assert.equal(reasonOf(await assess({ records: completeRecords({ font: { metadata: { ...meta(dejavuBytes, 'DejaVu Sans'), license_ref: null } } }) }), 'font:font://bench/sans'), 'FONT_LICENSE_UNKNOWN');
  const wrongCanvas = JSON.parse(JSON.stringify(completeConfig()));
  wrongCanvas.owned_records[0].metadata.canvas.height = 1080;
  assert.equal(reasonOf(await assess({ config: wrongCanvas }), 'format'), 'FORMAT_CANVAS_DIFFERS_FROM_EXPECTED');
  // PC2-60 RUNNABLE only when every binding is real - and RUNNABLE is not RUN
  const runnable = await assess();
  assert.equal(runnable.status, 'RUNNABLE');
  assert.deepEqual(runnable.blockers, []);
  assert.equal(runnable.runnable_is_not_run, true);
  assert.equal(CI.assessCreativeC2Readiness({}).c2_allowed, false);
  assert.equal(code(() => P.recordBenchmarkRun({ readiness: shipped, results: {}, ran_at: LATER })), CI.CI_ERROR.BENCHMARK_INVALID);
  // PC2-61 C2 stays blocked until the benchmark has ACTUALLY been run and its gates passed
  const passing = { preflight_status: 'PASS', fidelity_status: 'PASS', guardian_status: 'PASS', png_sha256: 'a'.repeat(64) };
  for (const gate of ['preflight_status', 'fidelity_status', 'guardian_status']) {
    assert.equal(code(() => P.recordBenchmarkRun({ readiness: runnable, results: { ...passing, [gate]: 'REVIEW_REQUIRED' }, ran_at: LATER })), CI.CI_ERROR.BENCHMARK_INVALID);
  }
  assert.equal(code(() => P.recordBenchmarkRun({ readiness: runnable, results: { ...passing, png_sha256: 'nope' }, ran_at: LATER })), CI.CI_ERROR.BENCHMARK_INVALID);
  const runEvidence = P.recordBenchmarkRun({ readiness: runnable, results: passing, ran_at: LATER });
  assert.equal(runEvidence.dependency, 'REAL_CAMPAIGN_BENCHMARK');
  const expression = P.assessExpressionReadiness(approvedInterface());
  const all = {
    RESOURCE_RESOLVER: await P.verifyResourceResolver(),
    BRAND_EXPRESSION_SYSTEM: expression.evidence,
    REAL_FONT_METRICS: await P.verifyFontMetrics(dejavu),
    COMPLEX_SCRIPT_SHAPING: await P.verifyShaping({ latinFont: dejavu, arabicFont: naskh }),
    ARABIC_BIDI_RTL_VERIFICATION: await P.verifyArabicBidi({ font: dejavu }),
    DETERMINISTIC_RASTERIZER: await P.verifyRasterizer(),
    REAL_PNG_RENDER_PATH: await P.verifyPngPath({ document: productionDoc(), fonts: realFonts(), assetResolver: resolveAllMedia }),
  };
  const withoutRun = CI.assessCreativeC2Readiness(all);
  assert.equal(withoutRun.c2_allowed, false);
  assert.deepEqual(withoutRun.open_blockers, ['REAL_CAMPAIGN_BENCHMARK']);
  assert.equal(CI.assessCreativeC2Readiness({ ...all, REAL_CAMPAIGN_BENCHMARK: runEvidence }).c2_allowed, true);
  // the shipped configuration itself still says NOT_RUN and still lists what is missing
  assert.equal(benchmarkConfig.status, 'NOT_RUN');
  assert.ok(benchmarkConfig.bindings_still_missing.some((b) => b.includes('HABB_BENCHMARK_REAL_ASSET_MISSING')));
});

test('PRE-C2 coverage matrix: the doc maps every behaviour row and every test it names exists', async () => {
  const doc = await readFile(new URL('../docs/architecture/creative-pre-c2-foundation.md', import.meta.url), 'utf8');
  const matrix = doc.slice(doc.indexOf('<!-- coverage-matrix:start -->'), doc.indexOf('<!-- coverage-matrix:end -->'));
  const rows = [...matrix.matchAll(/^\| PC2-(\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ n: Number(m[1]), ref: m[3] }));
  assert.ok(rows.length >= 81, `at least 81 rows, found ${rows.length}`);
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: rows.length }, (_, i) => i + 1));
  for (const { n, ref } of rows) {
    const [file, name] = ref.split(' › ');
    const text = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes(`test('${name}'`), `PC2-${n} names a test that does not exist: ${ref}`);
    assert.match(text, new RegExp(`^\\s*// PC2-${n} `, 'm'), `PC2-${n} has no marker in ${file}`);
  }
  assert.match(doc, /PRE-C2 TECHNICAL FOUNDATION = COMPLETE/);
  assert.match(doc, /HABB BENCHMARK 001 = NOT_RUN \/ BLOCKED/);
  assert.match(doc, /HABB BENCHMARK 001 PREPARATION = COMPLETE/);
  assert.match(doc, /C2 = NOT READY/);
});
