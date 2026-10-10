// HABB C3: the first real BLIND critique of the existing autonomous candidate. It judges ONE image; it generates NOTHING (no revised candidate).
//
//   node scripts/run-c3-critic.mjs --check     no network: credentials, the candidate (hash, PNG, size), the scoped clearance for these exact bytes, the recorded gate results. Sends nothing.
//   node scripts/run-c3-critic.mjs --live      exactly ONE billable vision call (the Creative Critic looks at the rendered PNG), guarded by a lock that code never releases.
//   node scripts/run-c3-critic.mjs --compare   offline: only AFTER critique-001.json exists, loads the owner's review and records agreement / disagreement per dimension.
//
// The critic is blind: --live never reads the owner's review, and its instruction is built from the brief's public facts and the brand's own expression principles. Credentials
// come from the environment only. Outputs are written OUTSIDE the repository (NORDLA_PRIVATE_DIR, default ~/nordla-private/c2-habb-benchmark-001/creative-run-001).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assessScopedExternalMediaUse, createQwenVisionPort, deriveCandidateAuthorization, isHeaderSafeApiKey, JsonlCallJournal, loadAlibabaCreativeConfig, requireAlibabaCreativeConfig, SpendGuard, takeLiveCallLock,
} from '../src/marketing-creative/alibaba/index.js';
import { createCreativeCritic, finalizeVerdict } from '../src/creative-critic/index.js';

const root = new URL('../', import.meta.url);
const mode = ['--check', '--live', '--compare'].find((m) => process.argv.includes(m))?.slice(2);
if (!mode) { console.error('use --check (no network), --live (ONE billable vision call) or --compare (offline, after the critique)'); process.exit(64); }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));
// the pinned hash identifies the reviewed candidate: it lives in the owner's review record, not in code
const PINNED_SHA = json('benchmarks/creative-intelligence/habb-c2-owner-review-001.json').candidate_sha256;
const CANDIDATE_REF = 'candidate:habb-c2-creative-run-001';

const privateDir = process.env.NORDLA_PRIVATE_DIR ? path.join(process.env.NORDLA_PRIVATE_DIR, 'creative-run-001') : path.join(os.homedir(), 'nordla-private', 'c2-habb-benchmark-001', 'creative-run-001');
const report = { mode, status: null, checks: [], private_directory: privateDir };
const finish = (status, code) => { report.status = status; console.log(JSON.stringify(report, null, 2)); process.exit(code); };
const check = (name, ok, detail = null) => { report.checks.push({ name, ok, detail }); return ok; };

if (mode === 'compare') {
  const { compareWithOwner } = await import('../src/creative-critic/owner-review.js');
  let stored;
  try { stored = JSON.parse(await readFile(path.join(privateDir, 'critique-001.json'), 'utf8')); } catch { check('the blind critique exists', false); finish('BLOCKED: NO_CRITIQUE_YET', 3); }
  const comparison = compareWithOwner({ critique: stored.critique, ownerReview: json('benchmarks/creative-intelligence/habb-c2-owner-review-001.json') });
  await writeFile(path.join(privateDir, 'owner-comparison-001.json'), `${JSON.stringify(comparison, null, 2)}\n`, { mode: 0o600 });
  report.comparison = comparison;
  finish('COMPARED', 0);
}

// ---- credentials (names only are reported, never a value)
const config = loadAlibabaCreativeConfig(process.env);
const missing = ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID'].filter((name) => !process.env[name]);
if (!check('credentials present', missing.length === 0, missing.length ? { missing_environment_variables: missing } : null)) finish('BLOCKED: CREDENTIALS_NOT_PROVISIONED', 3);
if (!check('API key has a valid format (one token, no spaces or line breaks)', isHeaderSafeApiKey(config.apiKey), { key_length: String(process.env.ALIBABA_MODEL_STUDIO_API_KEY).length })) finish('BLOCKED: API_KEY_FORMAT_INVALID', 3);
try { requireAlibabaCreativeConfig(config); check('credentials and region valid', true, { region: config.region, model: config.textModel }); } catch (error) { check('credentials and region valid', false, { reason: error.message }); finish('BLOCKED: CONFIG_INVALID', 3); }

// ---- the candidate: exact bytes, a PNG, the recorded size
let png;
try { png = new Uint8Array(await readFile(path.join(privateDir, 'candidate.png'))); } catch { check('candidate available', false); finish('BLOCKED: CANDIDATE_UNAVAILABLE', 3); }
const isPng = png.length > 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => png[i] === b);
const dims = isPng ? { width: new DataView(png.buffer, png.byteOffset).getUint32(16), height: new DataView(png.buffer, png.byteOffset).getUint32(20) } : null;
if (!check('candidate hash matches the pinned hash', sha256(png) === PINNED_SHA, { sha256: sha256(png) })) finish('BLOCKED: CANDIDATE_HASH_MISMATCH', 3);
if (!check('candidate is a 1080x1350 PNG', isPng && dims.width === 1080 && dims.height === 1350, dims)) finish('BLOCKED: CANDIDATE_NOT_AS_RECORDED', 3);

// ---- scoped clearance: the candidate is derived from the authorized asset, same scope
const bench = json('benchmarks/creative-intelligence/habb-creative-benchmark-001.json');
const briefData = json('benchmarks/creative-intelligence/habb-c2-brief.json');
const authorization = json('benchmarks/creative-intelligence/habb-c2-external-media-authorization.json');
const sourceSha = bench.private_payloads[0].sha256;
let candidateAuthorization;
try { candidateAuthorization = deriveCandidateAuthorization({ authorization, source_asset_sha256: sourceSha, candidate_ref: CANDIDATE_REF, candidate_sha256: PINNED_SHA }); } catch (error) { check('scoped clearance covers the derived candidate', false, { reason: error.message }); finish('BLOCKED: EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED', 3); }
const assessment = assessScopedExternalMediaUse({ authorization: candidateAuthorization, asset: { ref: CANDIDATE_REF, sha256: PINNED_SHA }, provider_id: 'alibaba-cloud-model-studio', region: config.region, purpose: authorization.purpose, operation: 'VISION_CRITIQUE' });
if (!check('scoped clearance for VISION_CRITIQUE on these exact bytes', assessment.allowed, assessment.allowed ? { authorization_id: assessment.clearance.authorization_id, retention_days_max: assessment.clearance.retention.standard_inference_retention_days_max, zdr: assessment.clearance.retention.zdr_status } : { reason: assessment.reason })) finish('BLOCKED: EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED', 3);

// ---- recorded deterministic results (the critic never re-judges them; Brand Guardian was never run for this candidate)
const summary = JSON.parse(await readFile(path.join(privateDir, 'summary.json'), 'utf8'));
const deterministic = { preflight: summary.preflight?.status ?? null, fidelity: summary.fidelity?.gate ?? null, guardian: null };
check('recorded deterministic results', true, { ...deterministic, guardian: 'NOT_EVALUATED (the runtime had no Brand Guardian step for this candidate)' });
if (mode === 'check') finish('READY_FOR_ONE_BLIND_CRITIQUE (nothing was sent)', 0);

// ---- the brief the critic receives: public facts and the brand's OWN expression principles only (no review, no defect list)
const pkg = json(bench.brand.package_file);
const expression = json(pkg.inputs.expression_file).expression_system;
const principles = Object.fromEntries(['photography', 'product_presentation', 'composition', 'layout_principles'].map((k) => [k, { principles: expression[k].principles, do: expression[k].do, dont: expression[k].dont }]));
const brief = {
  public_facts: briefData.public_facts,
  brand_principles: principles,
  verified_elsewhere: ['the wording of the headline, the supporting claim and the price', 'the identity, shape and printed artwork of the product', 'fonts, collisions and bounds', 'brand rules'],
};

// ---- exactly one live vision call, guarded by a lock that code never releases
await mkdir(privateDir, { recursive: true });
const lock = path.join(privateDir, 'c3-critique-001.lock');
try { await takeLiveCallLock(lock); } catch { check('single live critique lock', false, { lock }); finish('BLOCKED: LIVE_CRITIQUE_ALREADY_ATTEMPTED', 3); }
const budget = new SpendGuard({ maxSpendEur: 0.2, maxImages: 0, maxVideoSeconds: 0 });
const journal = new JsonlCallJournal(path.join(privateDir, 'c3-provider-calls.jsonl'));
const vlm = createQwenVisionPort({ config, budget, journal, authorization: candidateAuthorization, purpose: authorization.purpose, assetRefFor: () => CANDIDATE_REF, maxCalls: 1 });
const { critique, provenance } = await createCreativeCritic({ vlm }).critique({ candidate: { ref: CANDIDATE_REF, png_bytes: png }, brief });
const verdict = finalizeVerdict({ critique, deterministic });
await writeFile(path.join(privateDir, 'critique-001.json'), `${JSON.stringify({ critique, verdict, deterministic, provenance, budget: budget.snapshot() }, null, 2)}\n`, { mode: 0o600 });
report.result = { creative_status: verdict.creative_status, blockers: verdict.blockers, production_status: verdict.production_status, owner_approval: verdict.owner_approval, outcomes: critique.dimensions.map((d) => [d.dimension, d.outcome]), provenance_called: provenance.called, provenance_failure: provenance.failure ?? null, rejected: provenance.rejected ?? null };
finish(verdict.creative_status, verdict.creative_status === 'NOT_MEASURABLE' ? 3 : 0);
