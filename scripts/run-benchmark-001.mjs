// Runs a campaign benchmark LOCALLY against its real private asset and reports PASS / FAIL / BLOCKED from what the existing gates actually return.
//
//   node scripts/run-benchmark-001.mjs --at <ISO instant> --config <benchmark.json> --spec <run-spec.json> [--out <dir>]
//
// Generic: the benchmark (product, asset, claims, fonts, brand) is the configuration; the composition is the run spec. No clock is read here (the instant is
// an argument), nothing is generated, no network and no provider is used. The private payload is never copied into a tracked location: the PNG and the
// evidence are written under data/private/ (gitignored). Nothing is decided on behalf of a gate: an unmeasurable gate is reported as such and the verdict is
// BLOCKED, never PASS.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import { creativeBrandInterface, evaluateBrandGuardian, fidelityGateObservation } from '../src/branding/index.js';
import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../src/creative-fidelity/fidelity-gates.js';
import { buildBrandPackage } from './build-benchmark-brand-package.mjs';
import { createBenchmarkResolver } from './benchmark-resources.mjs';

const root = new URL('../', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

function stage(report, name, observed, expected, actual, verdict) {
  report.stages.push({ stage: name, observed, expected, actual, verdict });
  return verdict;
}

export async function runBenchmark({ at, configPath, specPath, outDir }) {
  const config = json(configPath);
  const spec = json(specPath);
  const pkg = json(config.brand.package_file);
  const expression = json(pkg.inputs.expression_file).expression_system;
  const tenant = { merchantId: config.merchant.merchant_id };
  const report = {
    benchmark_id: config.benchmark_id, at, environment: 'LOCAL_REAL_ASSET', stages: [], fallback: { used: false, notes: [] },
  };

  // ---- 0. the brand, the real payload and the readiness
  const brand = buildBrandPackage(pkg.inputs, expression);
  const iface = creativeBrandInterface(brand.context);
  const resolver = createBenchmarkResolver(config);
  const readiness = await P.assessBenchmarkReadiness({ config, resolver, tenant, creativeInterface: iface });
  report.readiness = { status: readiness.status, blockers: readiness.blockers, asset: readiness.asset, bindings: readiness.bindings.map((b) => `${b.id}=${b.status}`) };
  if (readiness.status !== 'RUNNABLE') {
    stage(report, 'readiness', readiness.blockers, 'RUNNABLE', readiness.status, 'BLOCKED');
    report.verdict = 'BLOCKED';
    return report;
  }
  stage(report, 'readiness', readiness.blockers, 'RUNNABLE', readiness.status, 'PASS');

  const assetRef = config.bindings.asset.ref;
  const productRef = config.bindings.product.ref;
  const payload = await resolver.loadPayload(assetRef, tenant);
  const assetHash = sha256(payload.bytes);
  const pinned = config.private_payloads.find((p) => p.ref === assetRef).sha256;
  if (assetHash !== pinned) {
    stage(report, 'asset_hash', assetHash, pinned, assetHash, 'BLOCKED');
    report.verdict = 'BLOCKED: ASSET_HASH_MISMATCH';
    return report;
  }
  stage(report, 'asset_hash', assetHash, pinned, assetHash, 'PASS');
  report.asset = { ref: assetRef, sha256: assetHash, bytes: payload.bytes.length, consumed: true };
  report.product = { ...config.product_evidence.catalogue, catalogue_evidence_ref: config.product_evidence.catalogue.ref, ref: productRef };

  // ---- 1. fonts: the real, pinned fonts, one instance per role
  const roles = config.typography.roles;
  const loaded = {};
  for (const [name, r] of Object.entries(roles)) {
    loaded[name] = await P.loadRealFont({ resolver, font_ref: r.font_ref, instance_ref: r.instance_ref, variations: r.variations, tenant });
  }
  const fonts = P.createRealFontRegistry(Object.values(loaded));

  // ---- 2. the document: only the bound product, the real asset and the approved claims
  const format = await resolver.resolve(config.bindings.format.ref, tenant);
  const claimByName = Object.fromEntries(config.bindings.claims.map((c) => [c.id, c]));
  const colors = brand.memory.design_tokens.colors;
  const geo = (x, y, width, height) => ({ x, y, width, height, rotation_deg: 0 });
  const common = (id, type, z, geometry, origin) => ({
    id, type, z_index: z, geometry, visibility: 'VISIBLE', locked: false, source_ref: null, constraints: [], effects: [], provenance: { origin, producer_ref: null, evidence_refs: [] },
  });
  let zText = 20; // each layer has its own z-index (a shared one is an INVALID_Z_ORDER)
  const text = (id, s, claim) => ({
    ...common(id, 'TEXT', zText++, geo(0, 0, 400, 100), 'ENGINE'),
    content: claim ? claim.expected_wording : s.content,
    font_ref: roles[s.typography_role].instance_ref,
    font_size: s.font_size,
    min_font_size: s.min_font_size,
    line_height: 1.15,
    tracking: 0,
    alignment: 'START',
    max_lines: s.max_lines,
    color: colors[s.color_token],
    box: { padding: 0, vertical_align: 'TOP' },
    overflow_policy: 'RELAYOUT_REQUIRED',
    locale: 'fr-BE',
    direction: 'LTR',
    text_role: s.role,
    text_kind: claim ? 'CLAIM_BEARING' : 'NON_CLAIM_CREATIVE_TEXT',
    claim_ref: claim ? claim.ref : null,
    approved_digest: claim ? CI.textDigest(claim.expected_wording) : null,
  });
  const L = spec.layers;
  const layers = [
    { ...common('bg', 'BACKGROUND', 0, geo(0, 0, format.metadata.canvas.width, format.metadata.canvas.height), 'ENGINE'), fill: colors[L.background.token] },
    {
      ...common('product', 'PRODUCT', 10, geo(100, 400, 400, 500), 'PROVIDED_ASSET'),
      product_ref: productRef,
      asset_ref: assetRef,
      preservation_mode: L.product.preservation_mode,
      protected_regions: [],
      allow_crop: false,
      allow_relight: false,
      allow_shadow: false,
      allow_rotation: false,
    },
    text('headline', L.headline, null),
    text('speed', L.speed_claim, claimByName[L.speed_claim.claim]),
    text('price', L.price, claimByName[L.price.claim]),
  ];
  const assets = { [assetRef]: { width_px: config.owned_records.find((r) => r.ref === assetRef).metadata.width_px, height_px: config.owned_records.find((r) => r.ref === assetRef).metadata.height_px } };
  const claimRefs = config.bindings.claims.map((c) => c.ref);
  const document = CI.buildDesignDocument({
    version: 1,
    merchant_id: config.merchant.merchant_id,
    brand_id: pkg.inputs.brand.brand_id,
    brief_ref: spec.brief_ref,
    direction_ref: spec.direction_ref,
    output_context: {
      content_kind: 'IMAGE',
      channel: 'SOCIAL_FEED',
      placement: 'FEED_POST',
      format_ref: config.bindings.format.ref,
      canvas: { width: format.metadata.canvas.width, height: format.metadata.canvas.height },
      aspect_ratio: '4:5',
      physical_or_digital: format.metadata.medium,
      viewing_distance_m: null,
      expected_dwell_time_s: 2,
      safe_zones: format.metadata.safe_zones,
      forbidden_zones: format.metadata.forbidden_zones,
      locale: 'fr-BE',
      direction: 'LTR',
      production_constraints: format.metadata.production_constraints,
    },
    canvas: { width: format.metadata.canvas.width, height: format.metadata.canvas.height, background_color: colors[L.background.token] },
    layers,
    constraints: [],
    asset_refs: [assetRef],
    claim_refs: claimRefs,
    provenance: {
      schema_version: CI.CI_VERSION, derivation: 'CREATE', parent_document_ref: null, created_by: 'ENGINE', producer_refs: ['engine:benchmark-run-harness'], evidence_refs: [],
    },
    created_at: at,
  });
  const solved = CI.solveLayout({
    document, recipe_id: spec.recipe_id, fonts, assets, created_at: at,
  });
  report.document = { id: solved.document.document_id, recipe_id: spec.recipe_id, unplaced: solved.unplaced ?? [], violations: solved.violations ?? [] };

  // ---- 3. Preflight
  const preflight = CI.runCreativePreflight(solved.document, { fonts, assets, approved_claim_refs: claimRefs });
  report.preflight = { status: preflight.status, checks: preflight.checks.map((c) => `${c.code}=${c.status}`) };
  stage(report, 'preflight', report.preflight.checks, 'PASS', preflight.status, preflight.status === 'PASS' ? 'PASS' : (preflight.status === 'FAIL' ? 'FAIL' : 'BLOCKED'));

  // ---- 4. the real, RESOLVED, production PNG (the only payload consumed is the verified private photograph)
  const dataUri = `data:image/jpeg;base64,${Buffer.from(payload.bytes).toString('base64')}`;
  let consumed = 0;
  const rendered = CI.renderDesignDocument({ document: solved.document, fonts, assetResolver: (ref) => { if (ref === assetRef) { consumed += 1; return dataUri; } report.fallback.used = true; report.fallback.notes.push(`unexpected asset requested: ${ref}`); return null; } });
  const png = P.renderProductionPng(rendered);
  report.png = { render_mode: rendered.render_mode, typography_mode: rendered.typography_mode, width: png.width, height: png.height, sha256: png.sha256, asset_resolutions: consumed };
  stage(report, 'png', { render_mode: rendered.render_mode, typography_mode: rendered.typography_mode, asset_resolutions: consumed }, 'RESOLVED + REAL typography + the real asset consumed', `${rendered.render_mode} + ${rendered.typography_mode}, asset consumed ${consumed}x`,
    rendered.render_mode === 'RESOLVED' && rendered.typography_mode === 'REAL' && consumed > 0 ? 'PASS' : 'FAIL');

  // ---- 5. Creative Fidelity gate: only MEASURED observations count. Nothing in the repository measures the product against the source photograph.
  const invariants = config.asset_evidence.fidelity_baseline.invariants;
  const requiredChecks = requiredChecksFromInvariants(invariants);
  const observations = []; // no measurement tool exists: nothing is claimed
  const fidelity = evaluateHardFidelityGate({ observations, requiredChecks });
  report.fidelity = { outcome: fidelity.outcome, required_checks: requiredChecks, observed: observations.length, missing: fidelity.missing };
  stage(report, 'creative_fidelity', { observed: observations.length, missing: fidelity.missing }, 'PASS on every required check', fidelity.outcome, fidelity.outcome === 'PASS' ? 'PASS' : (fidelity.outcome === 'FAIL' ? 'FAIL' : 'BLOCKED'));

  // ---- 6. Brand Guardian on the candidate manifest (structured facts about the candidate; no raw media)
  const hex = (h) => h.toUpperCase();
  const manifest = {
    content_kind: 'IMAGE',
    assets: [{ subject: 'product.asset', coverage: 'COMPLETE', values: [assetRef], evidence_refs: [] }],
    colors: [{ subject: 'canvas.colors', coverage: 'COMPLETE', values: [...new Set([colors[L.background.token], colors[L.headline.color_token], colors[L.price.color_token]].map(hex))], evidence_refs: [] }],
    typography: [{ subject: 'text.families', coverage: 'COMPLETE', values: [...new Set(Object.values(loaded).map((f) => f.family))], evidence_refs: [] }],
    text: [{ subject: 'text.fragments', coverage: 'COMPLETE', values: layers.filter((l) => l.type === 'TEXT').map((l) => l.content), evidence_refs: [] }],
    claims: [{ subject: 'text.claims', coverage: 'COMPLETE', values: claimRefs, evidence_refs: [] }],
    external_gates: [fidelityGateObservation({ gate: fidelity })],
  };
  const guardian = evaluateBrandGuardian({
    tenant: brand.tenant, brandContext: brand.context, candidateManifest: manifest, targetRef: `benchmark:${config.benchmark_id.toLowerCase()}`, evaluatedAt: at,
  });
  report.guardian = { outcome: guardian.outcome, hard_outcome: guardian.hard_outcome, hard_outcome_reason: guardian.hard_outcome_reason, applicable_hard_rules: guardian.rule_results.length, semantic_outcome: guardian.semantic_outcome };
  stage(report, 'brand_guardian', { applicable_hard_rules: guardian.rule_results.length, hard_outcome_reason: guardian.hard_outcome_reason }, 'PASS (a measured hard-rule outcome)', guardian.outcome,
    guardian.outcome === 'PASS' ? 'PASS' : (guardian.outcome === 'FAIL' ? 'FAIL' : 'BLOCKED'));

  // ---- verdict
  const verdicts = report.stages.map((s) => s.verdict);
  report.verdict = verdicts.includes('FAIL') ? 'FAIL' : (verdicts.every((v) => v === 'PASS') ? 'PASS' : 'BLOCKED');
  if (outDir) {
    mkdirSync(new URL(outDir, root), { recursive: true });
    writeFileSync(new URL(`${outDir}/candidate.png`, root), png.bytes);
    writeFileSync(new URL(`${outDir}/evidence.json`, root), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
  const at = arg('at');
  if (!at || !arg('config') || !arg('spec')) throw new Error('--at <ISO instant> is required (the harness never reads the clock), with --config and --spec');
  const report = await runBenchmark({
    at,
    configPath: arg('config'),
    specPath: arg('spec'),
    outDir: arg('out', null),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === 'PASS' ? 0 : 2);
}
