import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assertAlibabaExternalUse,
  assertScopedExternalMediaUse,
  assessScopedExternalMediaUse,
  EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED,
  loadAlibabaCreativeConfig,
} from '../src/marketing-creative/alibaba/index.js';

// The scoped external-media authorization of the real HABB asset (`// SA-N` markers). It names one asset, one provider, one region, one purpose; it never changes
// the global PUBLIC-only default and it sends nothing.

const root = new URL('../', import.meta.url);
const authorization = JSON.parse(await readFile(new URL('benchmarks/creative-intelligence/habb-c2-external-media-authorization.json', root), 'utf8'));
const config = JSON.parse(await readFile(new URL('benchmarks/creative-intelligence/habb-creative-benchmark-001.json', root), 'utf8'));
const PINNED = config.private_payloads.find((p) => p.ref === 'asset://habb/benchmark-001/real-personalised-case-001');
const ASSET = { ref: PINNED.ref, sha256: PINNED.sha256 };
const request = (over = {}) => ({
  authorization, asset: ASSET, provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1', purpose: 'C2_HABB_BENCHMARK_001', operation: 'IMAGE_EDIT', ...over,
});
const refusal = (input) => { const r = assessScopedExternalMediaUse(input); assert.equal(r.allowed, false); assert.equal(r.code, EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED); return r.reason; };

test('The committed authorization clears exactly the real asset, for Alibaba, in Frankfurt, for the C2 benchmark', () => {
  // SA-1 the exact asset ref, bytes, provider, region, purpose and operation are cleared
  const clearance = assertScopedExternalMediaUse(request());
  assert.equal(clearance.asset_ref, ASSET.ref);
  assert.equal(clearance.region, 'eu-central-1');
  assert.ok(Object.isFrozen(clearance));
  assert.equal(assertScopedExternalMediaUse(request({ operation: 'VISION_CRITIQUE' })).operation, 'VISION_CRITIQUE');
  // SA-2 the record is bound to the benchmark's pinned asset (same ref, same hash)
  assert.equal(authorization.asset.asset_sha256, PINNED.sha256);
  assert.equal(authorization.asset.asset_ref, config.bindings.asset.ref);
});

test('Everything else is refused with EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED', () => {
  // SA-3 another asset (ref or bytes), another provider, another region (Singapore), another purpose, another operation
  assert.equal(refusal(request({ asset: { ...ASSET, ref: 'asset://habb/other' } })), 'ASSET_REF_NOT_AUTHORIZED');
  assert.equal(refusal(request({ asset: { ...ASSET, sha256: '0'.repeat(64) } })), 'ASSET_BYTES_NOT_AUTHORIZED');
  assert.equal(refusal(request({ provider_id: 'krea' })), 'PROVIDER_NOT_AUTHORIZED');
  assert.equal(refusal(request({ provider_id: 'google-gemini' })), 'PROVIDER_NOT_AUTHORIZED');
  assert.equal(refusal(request({ region: 'ap-southeast-1' })), 'REGION_NOT_AUTHORIZED');
  assert.equal(refusal(request({ purpose: 'MARKETING_CAMPAIGN' })), 'PURPOSE_NOT_AUTHORIZED');
  assert.equal(refusal(request({ operation: 'VIDEO_GENERATE' })), 'OPERATION_NOT_AUTHORIZED');
  // SA-4 no record, no asset identity, a record of another kind or with an unknown key
  assert.equal(refusal(request({ authorization: null })), 'NO_AUTHORIZATION_RECORD');
  assert.equal(refusal(request({ asset: null })), 'ASSET_NOT_IDENTIFIED');
  assert.equal(refusal(request({ authorization: { ...authorization, kind: 'SOMETHING_ELSE' } })), 'NOT_AN_EXTERNAL_MEDIA_AUTHORIZATION');
  assert.equal(refusal(request({ authorization: { ...authorization, scope_creep: 'ALL_ASSETS' } })), 'UNKNOWN_KEY_IN_AUTHORIZATION');
  assert.equal(assertScopedExternalMediaUse.length, 1);
  assert.throws(() => assertScopedExternalMediaUse(request({ region: 'ap-southeast-1' })), (error) => error.code === EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED);
});

test('Retention is stated and never embellished; a face, personal data or a revocation refuses', () => {
  // SA-5 the committed record says up to 30 days and that ZDR is NOT confirmed and NOT claimed
  assert.equal(authorization.retention.standard_inference_retention_days_max, 30);
  assert.equal(authorization.retention.zdr_status, 'NOT_CONFIRMED');
  assert.equal(authorization.retention.zdr_claimed, false);
  assert.equal(authorization.retention.zdr_evidence_ref, null);
  assert.equal(authorization.retention.acknowledged, true);
  // SA-6 an unacknowledged retention, a ZDR claim without evidence, or an inconsistent ZDR claim refuses
  const withRetention = (retention) => request({ authorization: { ...authorization, retention: { ...authorization.retention, ...retention } } });
  assert.equal(refusal(withRetention({ acknowledged: false })), 'RETENTION_NOT_ACKNOWLEDGED');
  assert.equal(refusal(withRetention({ standard_inference_retention_days_max: null })), 'RETENTION_NOT_STATED');
  assert.equal(refusal(withRetention({ zdr_status: 'CONFIRMED_ACTIVE', zdr_claimed: true })), 'ZDR_CLAIMED_WITHOUT_EVIDENCE');
  assert.equal(refusal(withRetention({ zdr_status: 'CONFIRMED_ACTIVE', zdr_claimed: false })), 'ZDR_CLAIM_INCONSISTENT');
  assert.equal(refusal(withRetention({ zdr_status: 'MAYBE' })), 'ZDR_STATUS_UNKNOWN_VALUE');
  assert.equal(assertScopedExternalMediaUse(withRetention({ zdr_status: 'CONFIRMED_ACTIVE', zdr_claimed: true, zdr_evidence_ref: 'evidence://alibaba/zdr-workspace' })).retention.zdr_status, 'CONFIRMED_ACTIVE');
  // SA-7 a face or personal data, or a revoked authorization
  const withAsset = (asset) => request({ authorization: { ...authorization, asset: { ...authorization.asset, ...asset } } });
  assert.equal(refusal(withAsset({ contains_face: true })), 'FACE_OR_PERSONAL_DATA_NOT_EXCLUDED');
  assert.equal(refusal(withAsset({ contains_personal_data: true })), 'FACE_OR_PERSONAL_DATA_NOT_EXCLUDED');
  assert.equal(refusal(request({ authorization: { ...authorization, authorization: { ...authorization.authorization, revoked: true } } })), 'AUTHORIZATION_REVOKED');
  // SA-8 a record that claims to change the global policy refuses
  assert.equal(refusal(request({ authorization: { ...authorization, global_policy: { alibaba_default: 'PUBLIC_ONLY', changed_by_this_record: true } } })), 'AUTHORIZATION_MUST_NOT_CHANGE_THE_GLOBAL_POLICY');
});

test('The global PUBLIC-only default is unchanged, with or without the scoped authorization', () => {
  // SA-9 the policy still accepts PUBLIC only, no personal data, no face
  assert.ok(assertAlibabaExternalUse({ classification: 'PUBLIC' }));
  for (const classification of ['EU_CLOUD', 'LOCAL_ONLY']) assert.throws(() => assertAlibabaExternalUse({ classification }), /only accepts PUBLIC data/);
  assert.throws(() => assertAlibabaExternalUse({ classification: 'PUBLIC', contains_face: true }), /rejects personal data and faces/);
  assert.throws(() => assertAlibabaExternalUse({ classification: 'PUBLIC', contains_personal_data: true }), /rejects personal data and faces/);
  // SA-10 holding a clearance for the real asset does not make any other private media acceptable, nor the asset itself acceptable under the global policy
  assertScopedExternalMediaUse(request());
  assert.throws(() => assertAlibabaExternalUse({ classification: authorization.asset.data_class }), /Unsupported data classification/);
  assert.throws(() => assertAlibabaExternalUse({ classification: 'EU_CLOUD', consent_ref: authorization.authorization_id }), /only accepts PUBLIC data/);
  // SA-11 the region pin of the existing lane is unchanged (Frankfurt only; Singapore is not supported by this lane)
  assert.equal(loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_REGION: 'eu-central-1' }).region, 'eu-central-1');
  assert.throws(() => loadAlibabaCreativeConfig({ ALIBABA_MODEL_STUDIO_REGION: 'ap-southeast-1' }), /Unsupported Alibaba Model Studio region/);
  // SA-12 the policy source does not mention scoped authorizations at all
  return readFile(new URL('src/marketing-creative/alibaba/policy.js', root), 'utf8').then((source) => assert.doesNotMatch(source, /scoped|authorization_id|EXTERNAL_MEDIA/i));
});

test('The record is honest: authorized, not transmitted, no credential, no secret, no URL', () => {
  // SA-13 nothing was sent and no credential was created
  assert.equal(authorization.state.transmission, 'NOT_TRANSMITTED');
  assert.equal(authorization.state.credentials, 'NOT_PROVISIONED');
  assert.equal(authorization.global_policy.changed_by_this_record, false);
  assert.equal(authorization.global_policy.alibaba_default, 'PUBLIC_ONLY');
  assert.equal(authorization.provider.other_providers, 'NOT_AUTHORIZED');
  // SA-14 it holds no secret, key, token, signed URL or workspace id
  assert.doesNotMatch(JSON.stringify(authorization), /https?:\/\/|api[_-]?key|secret|token|bearer|workspace[_-]?id|sk-[A-Za-z0-9]/i);
  // SA-15 the authentication limit is stated, not hidden
  assert.match(authorization.authorization.authentication, /Not authenticated by Nordla Identity/);
});
