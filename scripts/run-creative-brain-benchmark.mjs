// HABB CREATIVE BRAIN BENCHMARK 001: the first live run of the Creative Brain, end to end, on the real Samsung Galaxy A17 photograph. It starts from the original brief and the source asset ONLY:
// no earlier candidate, critique, direction or owner review is read, and no reference image is passed.
//
//   node scripts/run-creative-brain-benchmark.mjs --check     NO network call at all: credentials (names only), the real asset and its hash, the brand package and fonts, the Creative Brain contracts,
//                                                             the capabilities, a local segmentation dry-run, a writable private output path, and the WORST-CASE number of calls and cost.
//   node scripts/run-creative-brain-benchmark.mjs --explain   offline and read-only: the execution chain, the provider calls and the stop reason, reconstructed from the stored evidence.
//   node scripts/run-creative-brain-benchmark.mjs --live --confirm-creative-brain-benchmark
//                                                             the explicit human confirmation. Billable calls (worst case printed by --check) under one exclusive lock that code never releases.
//
// This script makes NO creative decision: it loads data and wires ports. The decisions are the Creative Brain's and the deterministic gates'. The final result is one of BLOCKED, TECHNICAL_FAIL,
// TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT, READY_FOR_OWNER_REVIEW, and the owner's approval is always PENDING. Credentials come from the environment only. Output goes OUTSIDE the repository
// (NORDLA_PRIVATE_DIR/creative-brain-benchmark-001, default ~/nordla-private/creative-brain-benchmark-001), never into the folder of the earlier run.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as P from '../src/creative-intelligence/production.js';
import {
  assessScopedExternalMediaUse, createQwenBrainPort, createQwenVisionPort, deriveCandidateAuthorization, FileOutputStore, generateEnvironmentBackground, isHeaderSafeApiKey, JsonlCallJournal,
  loadAlibabaCreativeConfig, requireAlibabaCreativeConfig,
} from '../src/marketing-creative/alibaba/index.js';
import { createBrandGuardianGate } from '../src/creative-runtime/index.js';
import {
  BENCHMARK_ID, createFileStore, runCheck, runExplain, runLive,
} from '../src/creative-brain-benchmark/index.js';
import { environmentOperationId } from '../src/creative-brain-benchmark/runner.js';
import { checkCreativeReadiness } from '../src/creative-readiness/index.js';
import { buildBrandPackage } from './build-benchmark-brand-package.mjs';
import { createBenchmarkResolver } from './benchmark-resources.mjs';

const root = new URL('../', import.meta.url);
const mode = process.argv.includes('--live') ? 'live' : (process.argv.includes('--check') ? 'check' : (process.argv.includes('--explain') ? 'explain' : null));
const confirmed = process.argv.includes('--confirm-creative-brain-benchmark');
const json = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));
const outDir = process.env.NORDLA_PRIVATE_DIR ? path.join(process.env.NORDLA_PRIVATE_DIR, BENCHMARK_ID) : path.join(os.homedir(), 'nordla-private', BENCHMARK_ID);
const OK_STATUSES = new Set(['EXPLAINED', 'READY_FOR_OWNER_REVIEW', 'TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT']);

// Never process.exit(): on Windows, Node 24 aborts with a libuv assertion when the process exits while an HTTPS fetch is closing. The exit code is set and the script unwinds.
if (!mode) {
  console.error('use --check (no network), --explain (offline) or --live --confirm-creative-brain-benchmark');
  process.exitCode = 64;
} else if (mode === 'live' && !confirmed) {
  console.error('a live benchmark needs the explicit human confirmation: --confirm-creative-brain-benchmark');
  process.exitCode = 64;
} else {
  const store = createFileStore(outDir);
  let report;
  if (mode === 'explain') report = await runExplain({ store });
  else {
    const config = loadAlibabaCreativeConfig(process.env);
    const bench = json('benchmarks/creative-intelligence/habb-creative-benchmark-001.json');
    const briefData = json('benchmarks/creative-intelligence/habb-c2-brief.json');
    const authorization = json('benchmarks/creative-intelligence/habb-c2-external-media-authorization.json');
    const pkg = json(bench.brand.package_file);
    const expression = json(pkg.inputs.expression_file).expression_system;
    const brand = buildBrandPackage(pkg.inputs, expression);
    const payload = bench.private_payloads[0];
    const journal = new JsonlCallJournal(path.join(outDir, 'provider-calls.jsonl'));
    const outputStore = new FileOutputStore(path.join(outDir, 'outputs'));

    const deps = {
      readiness: () => checkCreativeReadiness(),
      store,
      journal,
      now: () => new Date().toISOString(),
      credentials: () => {
        const missing = ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID'].filter((name) => !process.env[name]);
        if (missing.length) return { present: false, valid: false, missing };
        if (!isHeaderSafeApiKey(config.apiKey)) return { present: true, valid: false, missing: [], detail: { reason: 'API_KEY_FORMAT_INVALID', key_length: String(process.env.ALIBABA_MODEL_STUDIO_API_KEY).length } };
        try {
          requireAlibabaCreativeConfig(config);
          return { present: true, valid: true, missing: [], detail: { region: config.region, text_model: config.textModel, image_model: config.imageModel } };
        } catch (error) { return { present: true, valid: false, missing: [], detail: { reason: error.message } }; }
      },
      loadInputs: async () => {
        const bytes = await readFile(new URL(payload.path, root)).then((b) => new Uint8Array(b)).catch(() => new Uint8Array());
        const assetRecord = bench.owned_records.find((r) => r.ref === payload.ref);
        const formatRecord = bench.owned_records.find((r) => r.ref === bench.bindings.format.ref);
        const claims = bench.bindings.claims.map((c) => ({ ref: c.ref, role: briefData.claim_roles[c.id].text_role, wording: bench.owned_records.find((r) => r.ref === c.ref).metadata.approved_wording }));
        const resolver = createBenchmarkResolver(bench);
        const tenant = { merchantId: bench.merchant.merchant_id };
        const loaded = {};
        for (const [name, r] of Object.entries(bench.typography.roles)) loaded[name] = await P.loadRealFont({ resolver, font_ref: r.font_ref, instance_ref: r.instance_ref, variations: r.variations, tenant });
        const fonts = P.createRealFontRegistry(Object.values(loaded));
        const brief = {
          ids: { merchant_id: bench.merchant.merchant_id, brand_id: pkg.inputs.brand.brand_id, brief_ref: briefData.brief_ref, product_ref: bench.bindings.product.ref },
          public_facts: briefData.public_facts,
          approved_copy: briefData.approved_copy.map((c) => ({ ref: c.ref, role: c.role, content: c.content })),
          claims,
          format: { ref: bench.bindings.format.ref, canvas: formatRecord.metadata.canvas, medium: formatRecord.metadata.medium, aspect_ratio: '4:5', safe_zones: formatRecord.metadata.safe_zones, forbidden_zones: formatRecord.metadata.forbidden_zones, locale: 'fr-BE' },
          brand: { expression, colors: brand.memory.design_tokens.colors, typography_roles: Object.fromEntries(Object.entries(bench.typography.roles).map(([name, r]) => [name, { instance_ref: r.instance_ref }])) },
          asset: { ref: payload.ref, bytes, media_type: assetRecord.metadata.media_type, width_px: assetRecord.metadata.width_px, height_px: assetRecord.metadata.height_px, origin: assetRecord.metadata.origin, sha256: payload.sha256, rights_class: 'OWNED', privacy_class: 'BUSINESS' },
          identity_annotations: bench.asset_evidence.identity_annotations,
        };
        return { brief, fonts, expression };
      },
      ports: {
        brainPort: ({ budget, journal: j, maxCalls }) => createQwenBrainPort({ config, budget, journal: j, maxCalls }),
        environmentPort: ({ budget, journal: j, operationId }) => ({
          async generate({ request, candidate_index: candidateIndex = 1 }) {
            // candidate 1 keeps the historical operation id; each further candidate of the same scene has its own (a reservation id is never reused)
            const result = await generateEnvironmentBackground({ config, request, budget, journal: j, outputStore, operationId: environmentOperationId(operationId, candidateIndex) });
            return {
              output_bytes: await outputStore.readBytes(result.output),
              provenance: {
                provider_id: result.provider_id, model: result.model, region: result.region, request_id: result.request_id, lane: result.lane, carries_input_asset: result.carries_input_asset,
                latency_ms: result.latency_ms, usage: result.usage, cost_eur_estimated: result.cost_eur_estimated, sha256: result.output.sha256, private_output: result.output.ref,
              },
            };
          },
        }),
        vlm: ({ budget, journal: j, candidateRef, candidateSha }) => {
          const candidateAuthorization = deriveCandidateAuthorization({ authorization, source_asset_sha256: payload.sha256, candidate_ref: candidateRef, candidate_sha256: candidateSha });
          const cleared = assessScopedExternalMediaUse({
            authorization: candidateAuthorization, asset: { ref: candidateRef, sha256: candidateSha }, provider_id: 'alibaba-cloud-model-studio', region: config.region, purpose: authorization.purpose, operation: 'VISION_CRITIQUE',
          });
          if (!cleared.allowed) throw Object.assign(new Error('EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED'), { code: 'EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED' });
          return createQwenVisionPort({ config, budget, journal: j, authorization: candidateAuthorization, purpose: authorization.purpose, assetRefFor: () => candidateRef, maxCalls: 1 });
        },
        guardian: ({ candidateRef, at }) => createBrandGuardianGate({ tenant: brand.tenant, brandContext: brand.context, evaluatedAt: at, targetRef: candidateRef }),
      },
    };
    report = mode === 'check' ? await runCheck(deps) : await runLive(deps, { confirmed });
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = OK_STATUSES.has(report.status) || String(report.status).startsWith('READY_FOR_ONE') ? 0 : 3;
}
