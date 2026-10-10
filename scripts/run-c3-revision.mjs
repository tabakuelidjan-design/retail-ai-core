// HABB C3 Revision Cycle 1: Candidate 1 -> critique v2 -> semantic revision intents -> revised Creative Direction -> new production plan -> environment -> deterministic product-preserving
// composite -> deterministic text -> Preflight -> Fidelity -> Brand Guardian -> critique of Candidate 2. It stops there: the owner reviews, nothing is approved, no second cycle.
//
//   node scripts/run-c3-revision.mjs --check                              no network: credentials, Candidate 1, critique v2, the derived revision request, the canonical revision evidence (refused
//                                                                           if it holds anything non-semantic), a LOCAL segmentation dry-run. Sends nothing, bills nothing.
//   node scripts/run-c3-revision.mjs --live --confirm-revision-cycle=1   the explicit human confirmation of THIS cycle. THREE billable calls under one lock that code never releases:
//                                                                           one text completion (the revision Director), one text-only environment image, one vision call (the critic on Candidate 2).
//
// This script makes NO creative decision and never loads the owner's review: the revision Director receives only canonical evidence and the semantic intents Nordla derived from
// critique v2. Credentials come from the environment only. Outputs go OUTSIDE the repository (NORDLA_PRIVATE_DIR, default ~/nordla-private/c2-habb-benchmark-001/creative-run-001/revision-001).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as P from '../src/creative-intelligence/production.js';
import {
  assessScopedExternalMediaUse, createQwenDirectorPort, createQwenVisionPort, deriveCandidateAuthorization, FileOutputStore, generateEnvironmentBackground, isHeaderSafeApiKey, JsonlCallJournal,
  loadAlibabaCreativeConfig, requireAlibabaCreativeConfig, SpendGuard, takeLiveCallLock,
} from '../src/marketing-creative/alibaba/index.js';
import {
  buildCandidateEvidence, buildRevisionInstruction, createApprovedCopyAgent, createBrandGuardianGate, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst,
  createRevisionDirector, createVisualProductionDirector, DIRECTOR_CONSTANTS, normalizeRevisionEvidence, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import { buildRevisionRequest, createCreativeCritic, finalizeVerdict } from '../src/creative-critic/index.js';
import { buildBrandPackage } from './build-benchmark-brand-package.mjs';
import { createBenchmarkResolver } from './benchmark-resources.mjs';

const root = new URL('../', import.meta.url);
const mode = process.argv.includes('--live') ? 'live' : (process.argv.includes('--check') ? 'check' : null);
const confirmed = process.argv.includes('--confirm-revision-cycle=1');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));
const CRITIQUE_FILE = 'critique-002.json';
// the semantic intents the owner approved as the input of this cycle (the scope of the authorization, not a creative decision): Nordla derived them from critique v2
const APPROVED_INTENTS = ['INTEGRATE_PRICE_WITH_THE_COMPOSITION', 'ELEVATE_RETAIL_QUALITY', 'REDUCE_TEMPLATE_FEEL', 'IMPROVE_PRODUCT_ENVIRONMENT_INTEGRATION', 'CLARIFY_VISUAL_HIERARCHY', 'REFINE_TYPOGRAPHIC_COMPOSITION', 'REBALANCE_WHITESPACE', 'REBALANCE_COMPOSITION'];

const runDir = process.env.NORDLA_PRIVATE_DIR ? path.join(process.env.NORDLA_PRIVATE_DIR, 'creative-run-001') : path.join(os.homedir(), 'nordla-private', 'c2-habb-benchmark-001', 'creative-run-001');
const outDir = path.join(runDir, 'revision-001');
const report = { mode, status: null, checks: [], private_directory: outDir };
// Never process.exit(): on Windows, Node 24 aborts with a libuv assertion when the process exits while an HTTPS fetch is closing. The exit code is set and the script unwinds.
const STOP = Symbol('stop');
const finish = (status, code) => { report.status = status; console.log(JSON.stringify(report, null, 2)); process.exitCode = code; throw STOP; };
const check = (name, ok, detail = null) => { report.checks.push({ name, ok, detail }); return ok; };

try {
  if (!mode) { console.error('use --check (no network) or --live --confirm-revision-cycle=1 (three billable calls)'); process.exitCode = 64; throw STOP; }
  if (mode === 'live' && !confirmed) { console.error('a revision cycle needs the explicit human confirmation: --confirm-revision-cycle=1'); process.exitCode = 64; throw STOP; }

  // ---- credentials (names only are reported, never a value)
  const config = loadAlibabaCreativeConfig(process.env);
  const missing = ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID'].filter((name) => !process.env[name]);
  if (!check('credentials present', missing.length === 0, missing.length ? { missing_environment_variables: missing } : null)) finish('BLOCKED: CREDENTIALS_NOT_PROVISIONED', 3);
  if (!check('API key has a valid format (one token, no spaces or line breaks)', isHeaderSafeApiKey(config.apiKey), { key_length: String(process.env.ALIBABA_MODEL_STUDIO_API_KEY).length })) finish('BLOCKED: API_KEY_FORMAT_INVALID', 3);
  try { requireAlibabaCreativeConfig(config); check('credentials and region valid', true, { region: config.region, text_model: config.textModel, image_model: config.imageModel }); } catch (error) { check('credentials and region valid', false, { reason: error.message }); finish('BLOCKED: CONFIG_INVALID', 3); }

  // ---- Candidate 1 and critique v2 (stored, never modified)
  // Candidate 1 is identified by the hash its own run recorded (the owner's review is not consulted anywhere in this script)
  const summary1 = await readFile(path.join(runDir, 'summary.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (!check('the previous direction and the Candidate 1 record exist', Boolean(summary1?.direction && summary1.ledger && /^[0-9a-f]{64}$/.test(summary1.png?.sha256 ?? '')))) finish('BLOCKED: CANDIDATE_1_RECORD_UNAVAILABLE', 3);
  const PINNED_SHA = summary1.png.sha256;
  const png1 = await readFile(path.join(runDir, 'candidate.png')).then((b) => new Uint8Array(b)).catch(() => null);
  if (!check('Candidate 1 is available and matches the hash its run recorded', png1 !== null && sha256(png1) === PINNED_SHA)) finish('BLOCKED: CANDIDATE_1_UNAVAILABLE_OR_CHANGED', 3);
  const stored = await readFile(path.join(runDir, CRITIQUE_FILE), 'utf8').then(JSON.parse).catch(() => null);
  if (!check('critique v2 exists, is about Candidate 1 and is a CREATIVE_FAIL', stored?.critique?.candidate_sha256 === PINNED_SHA && stored.critique.schema_version === 'creative-critique@2' && stored.verdict?.creative_status === 'CREATIVE_FAIL')) finish('BLOCKED: CRITIQUE_V2_UNAVAILABLE', 3);

  // ---- the semantic revision request, derived by Nordla from the critique; it must be the approved set
  const revisionRequest = buildRevisionRequest({ critique: stored.critique, iteration: 1 });
  const intents = revisionRequest.intents.map((i) => i.intent);
  if (!check('the derived intents are exactly the approved ones', JSON.stringify([...intents].sort()) === JSON.stringify([...APPROVED_INTENTS].sort()), { intents })) finish('BLOCKED: REVISION_INTENTS_NOT_THE_APPROVED_SET', 3);

  // ---- the canonical evidence the revision Director will receive (anything non-semantic or foreign is refused here, before any call)
  const candidateEvidence = buildCandidateEvidence({ result: { ledger: summary1.ledger, direction: summary1.direction, copy: summary1.copy, preflight: summary1.preflight, fidelity: summary1.fidelity ? { gate: summary1.fidelity.gate } : null, guardian: null }, candidate_sha256: PINNED_SHA });
  let revision;
  try {
    revision = { previous_direction: summary1.direction, candidate_evidence: candidateEvidence, critique: stored.critique, revision_request: revisionRequest };
    normalizeRevisionEvidence(revision);
    check('canonical revision evidence accepted (no owner review, no coordinates, sizes, fonts or colour literals)', true, { evidence_keys: Object.keys(candidateEvidence), owner_review_loaded: false });
  } catch (error) { check('canonical revision evidence accepted', false, { code: error.code ?? null, field: error.field ?? null }); finish('BLOCKED: REVISION_EVIDENCE_REFUSED', 3); }

  // ---- configuration -> a Brief (data only: nothing here is a creative decision)
  const bench = json('benchmarks/creative-intelligence/habb-creative-benchmark-001.json');
  const briefData = json('benchmarks/creative-intelligence/habb-c2-brief.json');
  const authorization = json('benchmarks/creative-intelligence/habb-c2-external-media-authorization.json');
  const pkg = json(bench.brand.package_file);
  const expression = json(pkg.inputs.expression_file).expression_system;
  const brand = buildBrandPackage(pkg.inputs, expression);
  const payload = bench.private_payloads[0];
  const bytes = await readFile(new URL(payload.path, root)).then((b) => new Uint8Array(b)).catch(() => null);
  if (!check('real asset available and matching the pinned hash', bytes !== null && sha256(bytes) === payload.sha256)) finish('BLOCKED: ASSET_PAYLOAD_UNAVAILABLE', 3);
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
  const dry = await createLocalProductSegmenter({ ledger: createDecisionLedger() }).segment({ asset: brief.asset, annotations: brief.identity_annotations });
  if (!check('local segmentation dry-run is confident', dry.quality.confident)) finish('BLOCKED: SEGMENTATION_LOW_CONFIDENCE', 3);
  // the revision instruction as the model would receive it (built, never sent in --check): only its size and digest are reported
  const instruction = buildRevisionInstruction({
    brief: { public_facts: brief.public_facts, approved_text_roles: [...new Set([...claims.map((c) => c.role), ...brief.approved_copy.map((c) => c.role)])], format: { content_kind: 'IMAGE', aspect_ratio: '4:5', canvas: brief.format.canvas }, expression },
    evidence: normalizeRevisionEvidence(revision), constants: DIRECTOR_CONSTANTS,
  });
  check('revision instruction built', true, { system_chars: instruction.system.length, user_chars: instruction.user.length, user_sha256_prefix: sha256(instruction.user).slice(0, 12) });
  if (mode === 'check') finish('READY_FOR_ONE_REVISION_CYCLE (nothing was sent)', 0);

  // ---- exactly one live cycle (three billable calls), guarded by a lock that code never releases
  await mkdir(outDir, { recursive: true });
  try { await takeLiveCallLock(path.join(outDir, 'revision-001.lock')); } catch { check('single live revision lock', false, { lock: path.join(outDir, 'revision-001.lock') }); finish('BLOCKED: REVISION_CYCLE_ALREADY_ATTEMPTED', 3); }
  const at = new Date().toISOString();
  const budget = new SpendGuard({ maxSpendEur: 0.5, maxImages: 1, maxVideoSeconds: 0 });
  const journal = new JsonlCallJournal(path.join(outDir, 'provider-calls.jsonl'));
  const outputStore = new FileOutputStore(path.join(outDir, 'outputs'));
  const ledger = createDecisionLedger();
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression }),
    director: createCreativeDirector({ ledger, complete: async () => { throw new Error('the initial Director is not used in a revision'); }, constants: DIRECTOR_CONSTANTS }),
    revision_director: createRevisionDirector({ ledger, complete: createQwenDirectorPort({ config, budget, journal }), constants: DIRECTOR_CONSTANTS }),
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression }),
  };
  const ports = {
    segmenter: createLocalProductSegmenter({ ledger }),
    environment: {
      async generate({ request }) {
        const result = await generateEnvironmentBackground({ config, request, budget, journal, outputStore, operationId: 'c3-revision-001-environment' });
        return {
          output_bytes: await outputStore.readBytes(result.output),
          provenance: { provider_id: result.provider_id, model: result.model, region: result.region, request_id: result.request_id, lane: result.lane, carries_input_asset: result.carries_input_asset, latency_ms: result.latency_ms, usage: result.usage, cost_eur_estimated: result.cost_eur_estimated, sha256: result.output.sha256, private_output: result.output.ref },
        };
      },
    },
  };
  const guardian = createBrandGuardianGate({ tenant: brand.tenant, brandContext: brand.context, evaluatedAt: at, targetRef: 'candidate:habb-c3-revision-001-candidate-002' });

  let result;
  try {
    result = await runProductPreservingCreative({ at, brief, fonts, agents, ports, ledger, guardian, revision });
  } catch (error) {
    const cause = error.detail?.cause ?? {};
    report.runtime_error = { code: error.code ?? null, role: error.detail?.role ?? null, cause_name: cause.name ?? null, cause_code: cause.code ?? error.code ?? null, status: cause.status ?? error.status ?? null, request_id: cause.request_id ?? error.requestId ?? null, message: error.message };
    await writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify({ ...report, status: 'BLOCKED: RUNTIME_ERROR', ledger: ledger.entries() }, null, 2)}\n`, { mode: 0o600 });
    finish('BLOCKED: RUNTIME_ERROR', 3);
  }
  const png2Path = path.join(outDir, 'candidate-002.png');
  if (result.png_bytes) await writeFile(png2Path, result.png_bytes, { mode: 0o600 });
  const summary = {
    status: result.status, reason: result.reason ?? null, budget: budget.snapshot(),
    png: result.png_bytes ? { path: png2Path, sha256: result.png_sha256, width: result.width, height: result.height, render: result.render } : null,
    preflight: result.preflight ?? null, guardian: result.guardian ?? null, fidelity: result.fidelity ? { gate: result.fidelity.gate, failed_observations: result.fidelity.failed } : null,
    environment: result.environment ?? null, direction: result.direction ?? null, copy: result.copy ?? null, steering: result.steering ?? null, revision_request: revisionRequest, ledger: result.ledger,
    previous_direction_id: summary1.direction.direction_id,
  };
  await writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify({ ...report, ...summary }, null, 2)}\n`, { mode: 0o600 });

  // ---- the critic looks at Candidate 2 only when every deterministic gate passed (no money is spent judging a blocked candidate)
  report.result = { status: result.status, png: summary.png, preflight: result.preflight?.status ?? null, fidelity_gate: result.fidelity?.gate ?? null, guardian: result.guardian?.outcome ?? null, steering: result.steering?.manual_creative_steering ?? null };
  if (result.status !== 'READY_FOR_REVIEW') finish(`${result.status}: Candidate 2 did not pass the deterministic gates; the critic was not called`, result.status === 'FIDELITY_FAIL' ? 2 : 3);
  const candidateRef = 'candidate:habb-c3-revision-001-candidate-002';
  const candidateAuthorization = deriveCandidateAuthorization({ authorization, source_asset_sha256: payload.sha256, candidate_ref: candidateRef, candidate_sha256: result.png_sha256 });
  const cleared = assessScopedExternalMediaUse({ authorization: candidateAuthorization, asset: { ref: candidateRef, sha256: result.png_sha256 }, provider_id: 'alibaba-cloud-model-studio', region: config.region, purpose: authorization.purpose, operation: 'VISION_CRITIQUE' });
  if (!check('scoped clearance for VISION_CRITIQUE on Candidate 2', cleared.allowed)) finish('BLOCKED: EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED', 3);
  const principles = Object.fromEntries(['photography', 'product_presentation', 'composition', 'layout_principles'].map((k) => [k, { principles: expression[k].principles, do: expression[k].do, dont: expression[k].dont }]));
  const criticBrief = { public_facts: briefData.public_facts, brand_principles: principles, verified_elsewhere: ['the wording of the headline, the supporting claim and the price', 'the identity, shape and printed artwork of the product', 'fonts, collisions and bounds', 'brand rules'] };
  const vlm = createQwenVisionPort({ config, budget, journal, authorization: candidateAuthorization, purpose: authorization.purpose, assetRefFor: () => candidateRef, maxCalls: 1 });
  const { critique, provenance } = await createCreativeCritic({ vlm }).critique({ candidate: { ref: candidateRef, png_bytes: result.png_bytes }, brief: criticBrief });
  const verdict = finalizeVerdict({ critique, deterministic: { preflight: result.preflight.status, fidelity: result.fidelity.gate, guardian: result.guardian.outcome } });
  await writeFile(path.join(outDir, 'critique.json'), `${JSON.stringify({ critique, verdict, provenance, budget: budget.snapshot() }, null, 2)}\n`, { mode: 0o600 });
  report.result.critique = { creative_status: verdict.creative_status, blockers: verdict.blockers, ready_for_owner_review: verdict.ready_for_owner_review, owner_review_blockers: verdict.owner_review_blockers, production_status: verdict.production_status, owner_approval: verdict.owner_approval, outcomes: critique.dimensions.map((d) => [d.dimension, d.outcome]) };
  finish(verdict.ready_for_owner_review ? 'READY_FOR_OWNER_REVIEW' : 'NOT_READY_FOR_OWNER_REVIEW', 0);
} catch (error) { if (error !== STOP) throw error; }
