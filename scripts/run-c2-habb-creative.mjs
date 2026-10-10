// HABB C2-C: the first AUTONOMOUS run of Nordla's product-preserving creative runtime on the real Samsung Galaxy A17 photograph.
//
//   node scripts/run-c2-habb-creative.mjs --check   no network: credentials, the real asset, the fonts, the brief, and a LOCAL segmentation dry-run. Sends nothing, bills nothing.
//   node scripts/run-c2-habb-creative.mjs --live    exactly TWO billable provider calls (one text completion for the Creative Director, one text-only environment image),
//                                                   guarded by a lock that refuses a second run; then the runtime composes, types and gates the real product.
//
// This script makes NO creative decision. It maps configuration (the benchmark, the Brief data, the brand package, the real fonts) into a Brief and wires the real
// ports; the preservation mode, the segmentation, the direction, the strategy, the provider request, the placement and the typography are decided by Nordla's agents
// and rules and recorded in the ledger. The result is a candidate READY_FOR_REVIEW at best: no Critic, no approval.
//
// Credentials come from the environment only (ALIBABA_MODEL_STUDIO_API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID). Outputs, journal and summary are written OUTSIDE the repository
// (NORDLA_PRIVATE_DIR, default ~/nordla-private/c2-habb-benchmark-001/creative-run-001).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as P from '../src/creative-intelligence/production.js';
import {
  createQwenDirectorPort, FileOutputStore, generateEnvironmentBackground, isHeaderSafeApiKey, JsonlCallJournal, loadAlibabaCreativeConfig, requireAlibabaCreativeConfig, SpendGuard, takeLiveCallLock,
} from '../src/marketing-creative/alibaba/index.js';
import {
  createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector, DIRECTOR_CONSTANTS, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import { buildBrandPackage } from './build-benchmark-brand-package.mjs';
import { createBenchmarkResolver } from './benchmark-resources.mjs';

const root = new URL('../', import.meta.url);
const mode = process.argv.includes('--live') ? 'live' : (process.argv.includes('--check') ? 'check' : null);
if (!mode) { console.error('use --check (no network) or --live (two billable provider calls)'); process.exit(64); }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));

const privateDir = process.env.NORDLA_PRIVATE_DIR ? path.join(process.env.NORDLA_PRIVATE_DIR, 'creative-run-001') : path.join(os.homedir(), 'nordla-private', 'c2-habb-benchmark-001', 'creative-run-001');
const report = { mode, status: null, checks: [], private_directory: privateDir };
const finish = (status, code) => { report.status = status; console.log(JSON.stringify(report, null, 2)); process.exit(code); };
const check = (name, ok, detail = null) => { report.checks.push({ name, ok, detail }); return ok; };

// ---- credentials (names only are reported, never a value)
const config = loadAlibabaCreativeConfig(process.env);
const missing = ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID'].filter((name) => !process.env[name]);
if (!check('credentials present', missing.length === 0, missing.length ? { missing_environment_variables: missing } : null)) finish('BLOCKED: CREDENTIALS_NOT_PROVISIONED', 3);
if (!check('API key has a valid format (one token, no spaces or line breaks)', isHeaderSafeApiKey(config.apiKey), { key_length: String(process.env.ALIBABA_MODEL_STUDIO_API_KEY).length })) finish('BLOCKED: API_KEY_FORMAT_INVALID', 3);
try { requireAlibabaCreativeConfig(config); check('credentials and region valid', true, { region: config.region, text_model: config.textModel, image_model: config.imageModel }); } catch (error) { check('credentials and region valid', false, { reason: error.message }); finish('BLOCKED: CONFIG_INVALID', 3); }

// ---- configuration -> a Brief (data only: nothing here is a creative decision)
const bench = json('benchmarks/creative-intelligence/habb-creative-benchmark-001.json');
const briefData = json('benchmarks/creative-intelligence/habb-c2-brief.json');
const pkg = json(bench.brand.package_file);
const expression = json(pkg.inputs.expression_file).expression_system;
const brand = buildBrandPackage(pkg.inputs, expression);
const payload = bench.private_payloads[0];
let bytes;
try { bytes = new Uint8Array(await readFile(new URL(payload.path, root))); } catch { check('real asset available', false); finish('BLOCKED: ASSET_PAYLOAD_UNAVAILABLE', 3); }
if (!check('real asset hash matches the pinned hash', sha256(bytes) === payload.sha256)) finish('BLOCKED: ASSET_HASH_MISMATCH', 3);
const assetRecord = bench.owned_records.find((r) => r.ref === payload.ref);
const formatRecord = bench.owned_records.find((r) => r.ref === bench.bindings.format.ref);
const claims = bench.bindings.claims.map((c) => ({ ref: c.ref, role: briefData.claim_roles[c.id].text_role, wording: bench.owned_records.find((r) => r.ref === c.ref).metadata.approved_wording }));
const resolver = createBenchmarkResolver(bench);
const tenant = { merchantId: bench.merchant.merchant_id };
const loaded = {};
for (const [name, r] of Object.entries(bench.typography.roles)) loaded[name] = await P.loadRealFont({ resolver, font_ref: r.font_ref, instance_ref: r.instance_ref, variations: r.variations, tenant });
const fonts = P.createRealFontRegistry(Object.values(loaded));
check('real fonts loaded and verified', true, { roles: Object.keys(loaded) });
const brief = {
  ids: { merchant_id: bench.merchant.merchant_id, brand_id: pkg.inputs.brand.brand_id, brief_ref: briefData.brief_ref, product_ref: bench.bindings.product.ref },
  public_facts: briefData.public_facts,
  approved_copy: briefData.approved_copy.map((c) => ({ ref: c.ref, role: c.role, content: c.content })),
  claims,
  format: {
    ref: bench.bindings.format.ref, canvas: formatRecord.metadata.canvas, medium: formatRecord.metadata.medium, aspect_ratio: '4:5', safe_zones: formatRecord.metadata.safe_zones, forbidden_zones: formatRecord.metadata.forbidden_zones, locale: 'fr-BE',
  },
  brand: {
    expression,
    colors: brand.memory.design_tokens.colors,
    typography_roles: Object.fromEntries(Object.entries(bench.typography.roles).map(([name, r]) => [name, { instance_ref: r.instance_ref }])),
  },
  asset: {
    ref: payload.ref, bytes, media_type: assetRecord.metadata.media_type, width_px: assetRecord.metadata.width_px, height_px: assetRecord.metadata.height_px, origin: assetRecord.metadata.origin, sha256: payload.sha256,
    rights_class: 'OWNED', privacy_class: 'BUSINESS',
  },
  identity_annotations: bench.asset_evidence.identity_annotations,
};
check('brief assembled from configuration (approved copy and claims only)', true, { approved_copy: brief.approved_copy.length, claims: claims.map((c) => c.role) });

// ---- a LOCAL dry-run of the segmentation: the mask is judged before any money is spent (no network, no provider)
const dryLedger = createDecisionLedger();
const dry = await createLocalProductSegmenter({ ledger: dryLedger }).segment({ asset: brief.asset, annotations: brief.identity_annotations });
if (!check('local segmentation dry-run is confident', dry.quality.confident, { edge_step_positive_share: dry.quality.edge_step_positive_share, shape_model: dry.quality.shape.model, median_residual_px: dry.quality.shape.median_residual_px ?? null })) finish('BLOCKED: SEGMENTATION_LOW_CONFIDENCE', 3);
if (mode === 'check') finish('READY_FOR_ONE_AUTONOMOUS_RUN (nothing was sent)', 0);

// ---- exactly one live run (two billable calls), guarded by a lock that code never releases
await mkdir(privateDir, { recursive: true });
try { await takeLiveCallLock(path.join(privateDir, 'live-run-001.lock')); } catch { check('single live run lock', false, { lock: path.join(privateDir, 'live-run-001.lock') }); finish('BLOCKED: LIVE_RUN_ALREADY_ATTEMPTED', 3); }

const budget = new SpendGuard({ maxSpendEur: 0.3, maxImages: 1, maxVideoSeconds: 0 });
const journal = new JsonlCallJournal(path.join(privateDir, 'provider-calls.jsonl'));
const outputStore = new FileOutputStore(path.join(privateDir, 'outputs'));
const ledger = createDecisionLedger();
const agents = {
  analyst: createProductAssetAnalyst({ ledger, expression }),
  director: createCreativeDirector({ ledger, complete: createQwenDirectorPort({ config, budget, journal }), constants: DIRECTOR_CONSTANTS }),
  copy: createApprovedCopyAgent({ ledger }),
  visual_director: createVisualProductionDirector({ ledger, expression }),
};
const ports = {
  segmenter: createLocalProductSegmenter({ ledger }),
  environment: {
    async generate({ request }) {
      const result = await generateEnvironmentBackground({ config, request, budget, journal, outputStore, operationId: 'c2c-habb-environment-001' });
      const outputBytes = await outputStore.readBytes(result.output);
      return {
        output_bytes: outputBytes,
        provenance: {
          provider_id: result.provider_id, model: result.model, region: result.region, request_id: result.request_id, lane: result.lane, carries_input_asset: result.carries_input_asset,
          latency_ms: result.latency_ms, usage: result.usage, cost_eur_estimated: result.cost_eur_estimated, sha256: result.output.sha256, private_output: result.output.ref,
        },
      };
    },
  },
};

let result;
try {
  result = await runProductPreservingCreative({ at: new Date().toISOString(), brief, fonts, agents, ports, ledger });
} catch (error) {
  // a failing agent keeps the SAFE diagnostics of its cause (code, HTTP status, request id): a provider refusal must not look like a bug
  const cause = error.detail?.cause ?? {};
  report.runtime_error = {
    code: error.code ?? null, role: error.detail?.role ?? null, cause_name: cause.name ?? null, cause_code: cause.code ?? error.code ?? null, status: cause.status ?? error.status ?? null, request_id: cause.request_id ?? error.requestId ?? null, message: error.message,
  };
  await writeFile(path.join(privateDir, 'summary.json'), `${JSON.stringify({ ...report, status: 'BLOCKED: RUNTIME_ERROR', ledger: ledger.entries() }, null, 2)}\n`, { mode: 0o600 });
  finish('BLOCKED: RUNTIME_ERROR', 3);
}
if (result.png_bytes) await writeFile(path.join(privateDir, 'candidate.png'), result.png_bytes, { mode: 0o600 });
const summary = {
  status: result.status,
  reason: result.reason ?? null,
  budget: budget.snapshot(),
  png: result.png_bytes ? { path: path.join(privateDir, 'candidate.png'), sha256: result.png_sha256, width: result.width, height: result.height, render: result.render } : null,
  preflight: result.preflight ?? null,
  fidelity: result.fidelity ? { gate: result.fidelity.gate, failed_observations: result.fidelity.failed, observations: result.fidelity.observations.map((o) => ({ check: o.code, outcome: o.outcome, sub_observations: o.evidence.sub_observations.map((s) => ({ id: s.id, outcome: s.outcome, evidence: s.evidence })), registration: o.evidence.registration })) } : null,
  environment: result.environment ?? null,
  segmentation: result.segmentation ?? null,
  suitability: result.suitability ?? null,
  considered_recipes: result.considered ?? null,
  direction: result.direction ?? null,
  copy: result.copy ?? null,
  steering: result.steering ?? null,
  ledger: result.ledger,
};
await writeFile(path.join(privateDir, 'summary.json'), `${JSON.stringify({ ...report, ...summary }, null, 2)}\n`, { mode: 0o600 });
report.result = { status: result.status, png: summary.png, steering: result.steering?.manual_creative_steering ?? null, fidelity_gate: result.fidelity?.gate ?? null };
finish(result.status, result.status === 'READY_FOR_REVIEW' ? 0 : (result.status === 'FIDELITY_FAIL' ? 2 : 3));
