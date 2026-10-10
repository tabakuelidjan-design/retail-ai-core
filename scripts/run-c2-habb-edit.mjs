// HABB C2-B: ONE controlled live Qwen Image edit of the real Samsung Galaxy A17 photograph, then the IDENTITY_PRESERVE fidelity gate on the provider output.
//
//   node scripts/run-c2-habb-edit.mjs --check     no network: verifies credentials, the scoped clearance, the asset hash and the private store. Sends nothing.
//   node scripts/run-c2-habb-edit.mjs --live      exactly ONE provider call (a lock file refuses a second one), then the fidelity gate.
//
// Credentials come from the environment only (never from Git): ALIBABA_MODEL_STUDIO_API_KEY and ALIBABA_MODEL_STUDIO_WORKSPACE_ID (region eu-central-1).
// The provider output, the journal and the summary are written OUTSIDE the repository (NORDLA_PRIVATE_DIR, default ~/nordla-private/c2-habb-benchmark-001).
// Result status: PROVIDER_OUTPUT_FIDELITY_PASS | PROVIDER_OUTPUT_FIDELITY_FAIL | BLOCKED. It is never "creatively successful": that needs the text composition
// and the Creative Critic, which come after a fidelity PASS.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertScopedExternalMediaUse,
  editProductImage,
  evaluateProviderEdit,
  isHeaderSafeApiKey,
  FileOutputStore,
  JsonlCallJournal,
  loadAlibabaCreativeConfig,
  PROVIDER_OUTPUT_STATUS,
  requireAlibabaCreativeConfig,
  SpendGuard,
  takeLiveCallLock,
} from '../src/marketing-creative/alibaba/index.js';

const root = new URL('../', import.meta.url);
const mode = process.argv.includes('--live') ? 'live' : (process.argv.includes('--check') ? 'check' : null);
if (!mode) { console.error('use --check (no network) or --live (one provider call)'); process.exit(64); }

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const benchmark = JSON.parse(await readFile(new URL('benchmarks/creative-intelligence/habb-creative-benchmark-001.json', root), 'utf8'));
const authorization = JSON.parse(await readFile(new URL('benchmarks/creative-intelligence/habb-c2-external-media-authorization.json', root), 'utf8'));
const payload = benchmark.private_payloads[0];
const annotations = benchmark.asset_evidence.identity_annotations;
const privateDir = process.env.NORDLA_PRIVATE_DIR || path.join(os.homedir(), 'nordla-private', 'c2-habb-benchmark-001');
const lockPath = path.join(privateDir, 'live-call-001.lock');
const report = { mode, status: null, checks: [], private_directory: privateDir };
const finish = (status, code) => { report.status = status; console.log(JSON.stringify(report, null, 2)); process.exit(code); };
const check = (name, ok, detail = null) => { report.checks.push({ name, ok, detail }); return ok; };

// ---- credentials (names only are reported, never a value)
const config = loadAlibabaCreativeConfig(process.env);
const missing = ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID'].filter((name) => !process.env[name]);
if (!check('credentials present', missing.length === 0, missing.length ? { missing_environment_variables: missing } : null)) finish('BLOCKED: CREDENTIALS_NOT_PROVISIONED', 3);
if (!check('API key has a valid format (one token, no spaces or line breaks)', isHeaderSafeApiKey(config.apiKey), { key_length: String(process.env.ALIBABA_MODEL_STUDIO_API_KEY).length })) finish('BLOCKED: API_KEY_FORMAT_INVALID', 3);
try { requireAlibabaCreativeConfig(config); check('credentials and region valid', true, { region: config.region, model: config.imageModel }); } catch (error) { check('credentials and region valid', false, { reason: error.message }); finish('BLOCKED: CONFIG_INVALID', 3); }

// ---- the real asset and the scoped clearance (before anything can be sent)
let bytes;
try { bytes = new Uint8Array(await readFile(new URL(payload.path, root))); } catch { check('real asset available', false); finish('BLOCKED: ASSET_PAYLOAD_UNAVAILABLE', 3); }
if (!check('real asset hash matches the pinned hash', sha256(bytes) === payload.sha256)) finish('BLOCKED: ASSET_HASH_MISMATCH', 3);
try {
  assertScopedExternalMediaUse({ authorization, asset: { ref: payload.ref, sha256: sha256(bytes) }, provider_id: 'alibaba-cloud-model-studio', region: config.region, purpose: 'C2_HABB_BENCHMARK_001', operation: 'IMAGE_EDIT' });
  check('scoped external-media clearance', true, { authorization_id: authorization.authorization_id, retention_days_max: authorization.retention.standard_inference_retention_days_max, zdr_status: authorization.retention.zdr_status });
} catch (error) { check('scoped external-media clearance', false, { reason: error.reason ?? error.message }); finish('BLOCKED: EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED', 3); }
if (mode === 'check') finish('READY_FOR_ONE_LIVE_CALL (nothing was sent)', 0);

// ---- exactly one live call
await mkdir(privateDir, { recursive: true });
// the lock is exclusive and is never released by code, whatever the provider answers (see live-call-lock.js)
try { await takeLiveCallLock(lockPath); } catch { check('single live call lock', false, { lock: lockPath }); finish('BLOCKED: LIVE_CALL_ALREADY_ATTEMPTED', 3); }

const request = {
  request_id: 'c2b-habb-edit-001',
  capability: 'IMAGE_EDIT',
  text_policy: 'NO_CRITICAL_TEXT',
  purpose: 'C2_HABB_BENCHMARK_001',
  size: '1152*1536',
  scene: 'a clean, bright, seamless premium retail studio environment: a pale neutral surface and backdrop, soft realistic studio light and a soft realistic contact shadow; no dark tabletop, no wood, no clutter',
  product_role: 'the personalised case is the dominant hero object, large, sharp, centred and fully visible',
  preserve: [
    'the exact case outline, corners and proportions',
    'the camera module with exactly three lens openings and the flash bump, in the same position and shape',
    'the printed beach artwork exactly as it is',
    'the printed quotation text on the artwork, letter for letter',
    'the colours of the case and of the artwork',
  ],
  forbid: ['hearts', 'leaves', 'fake gold', 'warm gradient', 'glow', 'decorative props', 'beige background', 'second phone'],
};

const budget = new SpendGuard({ maxSpendEur: 0.25, maxImages: 1, maxVideoSeconds: 0 });
const journal = new JsonlCallJournal(path.join(privateDir, 'provider-calls.jsonl'));
const outputStore = new FileOutputStore(path.join(privateDir, 'outputs'));
let result;
try {
  result = await editProductImage({
    config, authorization, asset: { ref: payload.ref, bytes, media_type: 'image/jpeg' }, request, budget, journal, outputStore, operationId: 'c2b-habb-edit-001',
  });
} catch (error) {
  report.provider_error = { code: error.code ?? null, status: error.status ?? null, request_id: error.requestId ?? null, transient: error.transient ?? null, message: error.message };
  await writeFile(path.join(privateDir, 'summary.json'), `${JSON.stringify({ ...report, status: 'BLOCKED: PROVIDER_CALL_FAILED' }, null, 2)}\n`, { mode: 0o600 });
  finish('BLOCKED: PROVIDER_CALL_FAILED', 3);
}

const outputBytes = await outputStore.readBytes(result.output);
const evaluation = evaluateProviderEdit({
  provider: result,
  outputBytes,
  source: { bytes, sha256: sha256(bytes), origin: 'MERCHANT_PROVIDED', width_px: annotations.source_size_px.width, height_px: annotations.source_size_px.height },
  source_asset_ref: payload.ref,
  derived_asset_ref: 'asset://habb/benchmark-001/provider-edit-001',
  annotations,
});
report.provider = {
  provider_id: result.provider_id, model: result.model, region: result.region, endpoint_class: result.endpoint_class, api_protocol: result.api_protocol, request_id: result.request_id,
  latency_ms: result.latency_ms, usage: result.usage, cost_eur_estimated: result.cost_eur_estimated, output_sha256: result.output.sha256, output_info: result.output_info, private_output: result.output.ref,
};
report.identity_preserve = {
  gate_outcome: evaluation.gate_outcome,
  reason: evaluation.reason ?? null,
  observations: evaluation.observations.map((o) => ({ check: o.code, outcome: o.outcome, sub_observations: o.evidence.sub_observations.map((s) => ({ id: s.id, outcome: s.outcome, evidence: s.evidence })), registration: o.evidence.registration })),
  failed_observations: evaluation.failed_observations,
};
await writeFile(path.join(privateDir, 'summary.json'), `${JSON.stringify({ ...report, status: evaluation.status }, null, 2)}\n`, { mode: 0o600 });
finish(evaluation.status, evaluation.status === PROVIDER_OUTPUT_STATUS.PASS ? 0 : (evaluation.status === PROVIDER_OUTPUT_STATUS.FAIL ? 2 : 3));
