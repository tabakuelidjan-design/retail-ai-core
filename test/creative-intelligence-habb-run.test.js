import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

import { runBenchmark } from '../scripts/run-benchmark-001.mjs';

// HABB CREATIVE BENCHMARK 001: the real run (`// HR-N` markers). The private photograph is only present on a trusted local machine: the tests that need it run
// only there; everywhere else the run must report BLOCKED at readiness (never PASS, never a fallback).

const root = new URL('../', import.meta.url);
const CONFIG = 'benchmarks/creative-intelligence/habb-creative-benchmark-001.json';
const SPEC = 'benchmarks/creative-intelligence/habb-benchmark-001-run-spec.json';
const config = JSON.parse(await readFile(new URL(CONFIG, root), 'utf8'));
const HERE = existsSync(new URL(config.private_payloads[0].path, root));
const AT = '2026-10-09T20:36:09Z';
const stageOf = (report, name) => report.stages.find((s) => s.stage === name);

test('The run harness is generic, clock-free and never falls back', async () => {
  const source = await readFile(new URL('scripts/run-benchmark-001.mjs', root), 'utf8');
  // HR-1 no clock, no network, no provider, no generation in the harness
  assert.doesNotMatch(source, /Date\.now\(|new Date\(\)|performance\.now|fetch\(|node:https?|node:net|randomUUID|Math\.random/);
  const code = source.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith(String.fromCharCode(47, 47))).join(String.fromCharCode(10));
  assert.doesNotMatch(code, /provider|generat|mock|fixture|placeholder|synthetic/i);
  // HR-2 nothing about the merchant is hard-coded in it: the benchmark and the spec are configuration
  assert.doesNotMatch(source, /habb|samsung|a17|playfair|montserrat|36b1a1a7/i);
  // HR-3 the run needs its instant as an argument
  assert.match(source, /--at <ISO instant> is required/);
  // HR-4 the evidence and the derived PNG go to the gitignored private location only
  assert.doesNotThrow(() => execSync('git check-ignore -q data/private/benchmark-runs/x/candidate.png', { cwd: root }));
  const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n');
  assert.ok(!tracked.some((f) => f.startsWith('data/private/')));
});

test('The run: the verdict is exactly what the gates return; the real asset is consumed; no fallback', async () => {
  const report = await runBenchmark({ at: AT, configPath: CONFIG, specPath: SPEC, outDir: null });
  // HR-5 no fallback, ever; the environment is the local real-asset one
  assert.equal(report.fallback.used, false);
  assert.equal(report.environment, 'LOCAL_REAL_ASSET');
  if (!HERE) {
    // HR-6 a clean clone (no private payload): BLOCKED at readiness, ASSET_PAYLOAD_UNAVAILABLE, nothing else is attempted
    assert.equal(report.verdict, 'BLOCKED');
    assert.deepEqual(report.readiness.blockers, [{ id: 'asset', reason: 'ASSET_PAYLOAD_UNAVAILABLE' }]);
    assert.equal(report.stages.length, 1);
    assert.equal(report.asset, undefined);
    return;
  }
  // HR-7 locally: readiness RUNNABLE, the pinned hash verified again, the real photograph consumed
  assert.equal(stageOf(report, 'readiness').actual, 'RUNNABLE');
  assert.equal(stageOf(report, 'asset_hash').verdict, 'PASS');
  assert.equal(report.asset.ref, 'asset://habb/benchmark-001/real-personalised-case-001');
  assert.equal(report.asset.sha256, config.private_payloads[0].sha256);
  assert.equal(report.asset.consumed, true);
  assert.equal(report.png.asset_resolutions, 1);
  assert.equal(report.product.ref, 'product://habb/benchmark-001/samsung-galaxy-a17');
  assert.equal(report.product.product_gid, 'gid://shopify/Product/15684483187036');
  assert.equal(report.product.handle, 'coque-personnalisee-samsung-galaxy-a17');
  // HR-8 Preflight really ran (19 checks, none failing); the PNG is a RESOLVED render with REAL typography at the canvas size
  assert.equal(report.preflight.status, 'PASS');
  assert.ok(report.preflight.checks.length >= 19 && report.preflight.checks.every((c) => !/=FAIL$/.test(c)));
  assert.equal(report.png.render_mode, 'RESOLVED');
  assert.equal(report.png.typography_mode, 'REAL');
  assert.deepEqual([report.png.width, report.png.height], [1080, 1350]);
  // HR-9 Creative Fidelity: the five required checks are MEASURED on the delivered PNG (values within the approved tolerances), then aggregated by the existing gate
  assert.deepEqual(report.fidelity.required_checks.slice().sort(), ['PIECE_COUNT', 'PRODUCT_COLOR', 'PRODUCT_GEOMETRY', 'PRODUCT_IDENTITY', 'TEXT']);
  assert.equal(report.fidelity.observed, 5);
  const byCode = Object.fromEntries(report.fidelity.observations.map((o) => [o.code, o]));
  for (const code of report.fidelity.required_checks) assert.ok(['PASS', 'FAIL', 'NOT_MEASURABLE'].includes(byCode[code].outcome), code);
  assert.equal(report.fidelity.outcome, report.fidelity.observations.every((o) => o.outcome === 'PASS') ? 'PASS' : report.fidelity.outcome);
  assert.ok(byCode.PRODUCT_COLOR.evidence.mean_abs_diff <= 0.5 && byCode.TEXT.evidence.regions[0].max_channel_diff <= 2);
  // HR-10 Brand Guardian: the three hard rules are applicable and consume that Fidelity outcome
  assert.equal(report.guardian.applicable_hard_rules, 3);
  assert.deepEqual(report.guardian.rules.map((r) => r.rule_id), ['habb-palette-closed', 'habb-typography-two-families', 'habb-product-fidelity-gate']);
  assert.notEqual(report.guardian.hard_outcome_reason, 'NO_APPLICABLE_HARD_RULES');
  // the verdict is derived, never asserted: PASS only when every stage passed, FAIL when one failed, BLOCKED otherwise
  const verdicts = report.stages.map((s) => s.verdict);
  assert.equal(report.verdict, verdicts.includes('FAIL') ? 'FAIL' : (verdicts.every((v) => v === 'PASS') ? 'PASS' : 'BLOCKED'));
  // HR-11 the run is deterministic: the same instant gives the same PNG and the same measurements, byte for byte
  const again = await runBenchmark({ at: AT, configPath: CONFIG, specPath: SPEC, outDir: null });
  assert.equal(again.png.sha256, report.png.sha256);
  assert.deepEqual(again.fidelity.observations, report.fidelity.observations);
  assert.equal(again.verdict, report.verdict);
  const recorded = config.execution.attempts.at(-1);
  assert.equal(report.png.sha256, recorded.png_sha256);
  assert.equal(report.verdict, recorded.verdict);
});

test('The recorded execution tells the truth about every attempt, and C2 is not started by it', () => {
  const e = config.execution;
  const last = e.attempts.at(-1);
  // HR-12 every attempt is kept, in order, the original failures as found and classified; the summary follows the LAST verdict
  assert.equal(e.attempts.length, 3);
  assert.match(e.attempts[0].decisive, /INVALID_Z_ORDER = FAIL/);
  assert.match(e.attempts[0].decisive, /harness defect/);
  assert.equal(e.attempts[1].verdict, 'BLOCKED');
  assert.match(e.attempts[1].contract, /^before the measurement contract/);
  assert.equal(e.summary, `RUNNABLE -> RUN -> ${last.verdict}`);
  assert.equal(e.verdict, last.verdict);
  assert.equal(e.fallback_used, false);
  assert.equal(e.real_asset_consumed, true);
  // HR-13 the configuration status records the execution (RUN), the result is kept apart (PASS), and C2 is not started by it
  assert.equal(config.status, 'RUN');
  assert.match(e.c2, /C2 is NOT started/);
});

test('The existing C2 gate contract is satisfied only by a recorded real run, never by readiness', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const CI = await import('../src/creative-intelligence/index.js');
  const P = await import('../src/creative-intelligence/production.js');
  const { creativeBrandInterface } = await import('../src/branding/index.js');
  const { buildBrandPackage } = await import('../scripts/build-benchmark-brand-package.mjs');
  const { createBenchmarkResolver } = await import('../scripts/benchmark-resources.mjs');
  const { demoDocument, resolveAllMedia } = await import('./creative-intelligence-fixtures.js');
  const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
  const pkg = read(config.brand.package_file);
  const brand = buildBrandPackage(pkg.inputs, read(pkg.inputs.expression_file).expression_system);
  const iface = creativeBrandInterface(brand.context);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const bytes = (f) => new Uint8Array(readFileSync(new URL(`./fixtures/fonts/${f}`, import.meta.url)));
  const meta = (b, family) => ({ family, style: 'normal', weight: 400, version: '1', format: 'ttf', content_hash: sha(b), license_ref: 'license://fixture-font' });
  const dj = bytes('DejaVuSans.ttf'); const nk = bytes('NotoNaskhArabic_400Regular.ttf');
  const dejavu = P.createRealFont({ font_ref: 'font:synthetic-sans', bytes: dj, metadata: meta(dj, 'DejaVu Sans') });
  const naskh = P.createRealFont({ font_ref: 'font:synthetic-arabic', bytes: nk, metadata: meta(nk, 'Noto Naskh Arabic') });
  const fonts = P.createRealFontRegistry([dejavu, naskh]);
  const document = CI.solveLayout({
    document: demoDocument(), recipe_id: 'PRODUCT_HERO', fonts, assets: { 'asset://demo/product-cutout': { width_px: 800, height_px: 1000 }, 'asset://demo/logo': { width_px: 600, height_px: 200 } }, created_at: '2026-10-10T10:00:00.000Z',
  }).document;
  const capabilities = async () => ({
    RESOURCE_RESOLVER: await P.verifyResourceResolver(),
    BRAND_EXPRESSION_SYSTEM: P.assessExpressionReadiness(iface).evidence,
    REAL_FONT_METRICS: await P.verifyFontMetrics(dejavu),
    COMPLEX_SCRIPT_SHAPING: await P.verifyShaping({ latinFont: dejavu, arabicFont: naskh }),
    ARABIC_BIDI_RTL_VERIFICATION: await P.verifyArabicBidi({ font: dejavu }),
    DETERMINISTIC_RASTERIZER: await P.verifyRasterizer(),
    REAL_PNG_RENDER_PATH: await P.verifyPngPath({ document, fonts, assetResolver: resolveAllMedia }),
  });
  // HR-14 with every capability closed but no recorded run, C2 stays closed (RUNNABLE or readiness opens nothing)
  const without = CI.assessCreativeC2Readiness(await capabilities());
  assert.equal(without.c2_allowed, false);
  assert.deepEqual(without.open_blockers, ['REAL_CAMPAIGN_BENCHMARK']);
  if (!HERE) return;
  // HR-15 locally, the real run's recorded evidence closes the last dependency: the gate contract is satisfied (C2 is still NOT started by this)
  const resolver = createBenchmarkResolver(config);
  const readiness = await P.assessBenchmarkReadiness({ config, resolver, tenant: { merchantId: config.merchant.merchant_id }, creativeInterface: iface });
  const report = await runBenchmark({ at: AT, configPath: CONFIG, specPath: SPEC, outDir: null });
  assert.equal(report.verdict, 'PASS');
  const evidence = P.recordBenchmarkRun({
    readiness, results: { preflight_status: report.preflight.status, fidelity_status: report.fidelity.outcome, guardian_status: report.guardian.outcome, png_sha256: report.png.sha256 }, ran_at: AT,
  });
  const gateResult = CI.assessCreativeC2Readiness({ ...(await capabilities()), REAL_CAMPAIGN_BENCHMARK: evidence });
  assert.equal(gateResult.c2_allowed, true);
  assert.deepEqual(gateResult.open_blockers, []);
  // a run whose gates are not all PASS cannot be recorded
  assert.throws(() => P.recordBenchmarkRun({ readiness, results: { preflight_status: 'PASS', fidelity_status: 'NOT_MEASURABLE', guardian_status: 'PASS', png_sha256: report.png.sha256 }, ran_at: AT }), /fidelity_status must be PASS/);
});
