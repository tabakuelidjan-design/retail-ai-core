// Standing, tenant-level media-processing policy for Creative Production (proposal, see docs/creative-autonomy/media-processing-policy.md).
//
// WHY: the customer never selects, confirms or approves a source product photo before a creation. Data-processing authorization is therefore
// given ONCE per tenant (provider, region, purpose, operations, data classes, retention, spend), not per photo. Each run derives, in memory,
// the narrow per-photo EXTERNAL_MEDIA_AUTHORIZATION the existing guards expect (exact SHA-256, provider, region, purpose, operation) and
// writes a transmission journal entry. Nothing here sends anything, reads a credential or touches the network.
//
// A standing policy is NOT a bypass: only media from the tenant's own verified catalog are covered. Customer uploads, personal data,
// faces or any other origin need their own consent and are refused here with SOURCE_REQUIRES_SPECIFIC_CONSENT.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assessScopedExternalMediaUse } from '../marketing-creative/alibaba/scoped-media-authorization.js';

export const POLICY_KIND = 'TENANT_MEDIA_PROCESSING_POLICY';
export const CATALOG_ORIGIN = 'SHOPIFY_CATALOG_VERIFIED_METADATA';
export const POLICY_REFUSAL = Object.freeze({
  NO_POLICY: 'NO_POLICY', POLICY_INVALID: 'POLICY_INVALID', POLICY_REVOKED: 'POLICY_REVOKED', POLICY_NOT_IN_FORCE: 'POLICY_NOT_IN_FORCE',
  TENANT_MISMATCH: 'TENANT_MISMATCH', SHOP_MISMATCH: 'SHOP_MISMATCH', SOURCE_REQUIRES_SPECIFIC_CONSENT: 'SOURCE_REQUIRES_SPECIFIC_CONSENT',
  PROCESSING_NOT_COVERED: 'PROCESSING_NOT_COVERED', SPEND_LIMIT: 'SPEND_LIMIT', SOURCE_NOT_IDENTIFIED: 'SOURCE_NOT_IDENTIFIED',
});
const SCOPES = new Set(['EU', 'GLOBAL']);
const OPERATIONS = new Set(['IMAGE_EDIT', 'VISION_CRITIQUE']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Structural validation. Returns a list of problems (empty = valid). Unknown keys are refused: a policy says exactly what it says. */
export function policyProblems(p) {
  const out = [];
  const KEYS = ['kind', 'policy_id', 'version', 'tenant', 'accepted_by', 'valid_from', 'valid_until', 'revoked', 'sources', 'processing', 'retention', 'spend', 'audit'];
  if (!isObj(p)) return ['not an object'];
  for (const k of Object.keys(p)) if (!KEYS.includes(k)) out.push(`unknown key ${k}`);
  if (p.kind !== POLICY_KIND) out.push('kind');
  if (typeof p.policy_id !== 'string' || !p.policy_id) out.push('policy_id');
  if (!Number.isInteger(p.version) || p.version < 1) out.push('version');
  if (!isObj(p.tenant) || typeof p.tenant.merchant_id !== 'string' || !p.tenant.merchant_id) out.push('tenant.merchant_id');
  if (!isObj(p.accepted_by) || typeof p.accepted_by.role !== 'string' || typeof p.accepted_by.at !== 'string') out.push('accepted_by');
  if (typeof p.valid_from !== 'string' || Number.isNaN(Date.parse(p.valid_from))) out.push('valid_from');
  if (p.valid_until != null && (typeof p.valid_until !== 'string' || Number.isNaN(Date.parse(p.valid_until)))) out.push('valid_until');
  if (typeof p.revoked !== 'boolean') out.push('revoked');
  const s = p.sources;
  if (!isObj(s) || !Array.isArray(s.allowed_origins) || s.allowed_origins.some((o) => o !== CATALOG_ORIGIN)) out.push('sources.allowed_origins (catalog media only)');
  if (!isObj(s) || s.tenant_attests_catalog_product_images_show_no_people !== true) out.push('sources.tenant_attests_catalog_product_images_show_no_people');
  if (!Array.isArray(p.processing) || !p.processing.length) out.push('processing');
  for (const [i, r] of (Array.isArray(p.processing) ? p.processing : []).entries()) {
    if (!isObj(r) || typeof r.provider_id !== 'string' || typeof r.region !== 'string' || !SCOPES.has(r.scope) || typeof r.cross_border_possible !== 'boolean'
      || typeof r.purpose !== 'string' || !Array.isArray(r.operations) || !r.operations.length || r.operations.some((o) => !OPERATIONS.has(o))) out.push(`processing[${i}]`);
    else if (r.scope === 'GLOBAL' && r.cross_border_possible !== true) out.push(`processing[${i}]: a GLOBAL scope must declare cross-border processing`);
  }
  const r = p.retention;
  if (!isObj(r) || r.acknowledged !== true || !Number.isInteger(r.standard_inference_retention_days_max) || r.standard_inference_retention_days_max < 1
    || !['NOT_CONFIRMED', 'CONFIRMED_ACTIVE'].includes(r.zdr_status) || (r.zdr_status === 'CONFIRMED_ACTIVE') !== (r.zdr_claimed === true)
    || (r.zdr_claimed === true && !(typeof r.zdr_evidence_ref === 'string' && r.zdr_evidence_ref))) out.push('retention');
  if (!isObj(p.spend) || p.spend.currency !== 'EUR' || !isNum(p.spend.per_run_max) || !isNum(p.spend.monthly_max) || p.spend.per_run_max > p.spend.monthly_max) out.push('spend');
  if (!isObj(p.audit) || p.audit.journal_required !== true) out.push('audit.journal_required');
  return out;
}

/**
 * Decide one transmission. `{ allowed: true, authorization, journal_entry }` or `{ allowed: false, reason }`. Never throws for a refusal.
 * request: { merchantId, shopId?, source: { sha256, asset_ref, origin, media_id? }, provider_id, region, purpose, operation, runCeilingEur, monthToDateEur, now }
 */
export function authorizeTransmission({ policy, request }) {
  const no = (reason, detail = null) => Object.freeze({ allowed: false, reason, detail });
  if (!policy) return no(POLICY_REFUSAL.NO_POLICY);
  const problems = policyProblems(policy);
  if (problems.length) return no(POLICY_REFUSAL.POLICY_INVALID, problems);
  if (policy.revoked) return no(POLICY_REFUSAL.POLICY_REVOKED);
  const now = request.now ?? new Date();
  if (Date.parse(policy.valid_from) > now.getTime() || (policy.valid_until && Date.parse(policy.valid_until) <= now.getTime())) return no(POLICY_REFUSAL.POLICY_NOT_IN_FORCE);
  if (request.merchantId !== policy.tenant.merchant_id) return no(POLICY_REFUSAL.TENANT_MISMATCH);
  if (policy.tenant.shop_id && request.shopId !== policy.tenant.shop_id) return no(POLICY_REFUSAL.SHOP_MISMATCH);
  const src = request.source;
  if (!isObj(src) || !/^[0-9a-f]{64}$/.test(src.sha256 ?? '') || typeof src.asset_ref !== 'string') return no(POLICY_REFUSAL.SOURCE_NOT_IDENTIFIED);
  if (!policy.sources.allowed_origins.includes(src.origin)) return no(POLICY_REFUSAL.SOURCE_REQUIRES_SPECIFIC_CONSENT, src.origin ?? null);
  const rule = policy.processing.find((r) => r.provider_id === request.provider_id && r.region === request.region && r.purpose === request.purpose && r.operations.includes(request.operation));
  if (!rule) return no(POLICY_REFUSAL.PROCESSING_NOT_COVERED, `${request.provider_id} ${request.region} ${request.purpose} ${request.operation}`);
  if (!isNum(request.runCeilingEur) || request.runCeilingEur > policy.spend.per_run_max) return no(POLICY_REFUSAL.SPEND_LIMIT, 'per run');
  // the MONTHLY limit is enforced atomically by the durable ledger's reservation (creative_spend_reserve), never by a read-then-write here;
  // a caller may still pass a known month-to-date figure for an early refusal
  if (request.monthToDateEur !== undefined && (!isNum(request.monthToDateEur) || request.monthToDateEur + request.runCeilingEur > policy.spend.monthly_max)) return no(POLICY_REFUSAL.SPEND_LIMIT, 'monthly');
  // the version that counts is the one the tenant ACCEPTED in the ledger (acceptedVersion), not the author's draft number
  const version = Number.isInteger(request.acceptedVersion) ? request.acceptedVersion : policy.version;
  // the narrow per-photo record the existing guards (assessScopedExternalMediaUse, deriveCandidateAuthorization) already enforce
  const authorization = Object.freeze({
    kind: 'EXTERNAL_MEDIA_AUTHORIZATION',
    authorization_id: `${policy.policy_id}@v${version}#${request.operation}#${src.sha256.slice(0, 16)}`,
    purpose_note: `derived in memory from standing tenant policy ${policy.policy_id} v${version} (${rule.scope}${rule.cross_border_possible ? ', cross-border possible' : ''}); catalog media, no people attested by the tenant`,
    asset: Object.freeze({ asset_ref: src.asset_ref, asset_sha256: src.sha256, data_class: 'MERCHANT_PRIVATE_MEDIA', contains_personal_data: false, contains_face: false }),
    provider: Object.freeze({ provider_id: rule.provider_id, region: rule.region }),
    purpose: rule.purpose, allowed_operations: Object.freeze([request.operation]),
    transmissible: 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY',
    retention: Object.freeze({ ...policy.retention }),
    authorization: Object.freeze({ revoked: false }), state: Object.freeze({}), global_policy: Object.freeze({ changed_by_this_record: false }),
  });
  // belt and braces: the derived record must pass the existing per-photo guard exactly as an owner-written one would
  const check = assessScopedExternalMediaUse({ authorization, asset: { ref: src.asset_ref, sha256: src.sha256 }, provider_id: rule.provider_id, region: rule.region, purpose: rule.purpose, operation: request.operation });
  if (!check.allowed) return no(POLICY_REFUSAL.POLICY_INVALID, check.reason);
  const journal_entry = Object.freeze({
    event: 'MEDIA_TRANSMISSION_AUTHORIZED', at: now.toISOString(), merchant_id: request.merchantId, shop_id: request.shopId ?? null,
    policy_id: policy.policy_id, policy_version: version, authorization_id: authorization.authorization_id,
    source_sha256: src.sha256, media_id: src.media_id ?? null, asset_ref: src.asset_ref, origin: src.origin,
    provider_id: rule.provider_id, region: rule.region, scope: rule.scope, cross_border_possible: rule.cross_border_possible,
    purpose: rule.purpose, operation: request.operation, run_id: request.runId ?? null, run_ceiling_eur: request.runCeilingEur,
  });
  return Object.freeze({ allowed: true, authorization, journal_entry, rule });
}

/** Local append-only JSONL mirror of transmission events, for diagnostics and offline tests ONLY. The authoritative trail and the spending
 *  reservations are in the durable Creative ledger (creative-ledger.js); this file never decides whether money may be spent. */
export class MediaTransmissionJournal {
  constructor(path) { this.path = path; }
  append(entry) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
  entries() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}
