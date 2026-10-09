// Scoped external-media authorization: the ONLY way a non-PUBLIC merchant asset may be cleared for Alibaba Model Studio.
//
// The global default (policy.js: Alibaba accepts PUBLIC data only, no personal data, no face) is NOT changed and NOT consulted here. An authorization is a
// narrow record that names ONE asset (ref + SHA-256), ONE provider, ONE region, ONE purpose and the allowed operations. Anything else is refused with the stable
// code EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED. Retention is stated, never embellished: a Zero-Data-Retention claim needs evidence.
// This module authorizes in memory: it sends nothing, reads no credential and never touches the network.

export const EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED = 'EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED';

const KEYS = ['kind', 'authorization_id', 'purpose_note', 'asset', 'provider', 'purpose', 'allowed_operations', 'transmissible', 'retention', 'authorization', 'state', 'global_policy'];
const ZDR_STATUS = new Set(['NOT_CONFIRMED', 'CONFIRMED_ACTIVE']);
const OPERATIONS = new Set(['IMAGE_EDIT', 'VISION_CRITIQUE']);

export class ExternalMediaSharingError extends Error {
  constructor(reason) {
    super(`${EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED}: ${reason}`);
    this.name = 'ExternalMediaSharingError';
    this.code = EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED;
    this.reason = reason;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `{ allowed: true, clearance }` or `{ allowed: false, reason }`. Never throws for a refusal.
 * @param {object} input { authorization, asset: { ref, sha256 }, provider_id, region, purpose, operation }
 */
export function assessScopedExternalMediaUse({ authorization, asset, provider_id: providerId, region, purpose, operation } = {}) {
  const no = (reason) => Object.freeze({ allowed: false, code: EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED, reason });
  if (!isObject(authorization)) return no('NO_AUTHORIZATION_RECORD');
  if (authorization.kind !== 'EXTERNAL_MEDIA_AUTHORIZATION') return no('NOT_AN_EXTERNAL_MEDIA_AUTHORIZATION');
  for (const key of Object.keys(authorization)) if (!KEYS.includes(key)) return no('UNKNOWN_KEY_IN_AUTHORIZATION');
  if (!isObject(authorization.asset) || !isObject(authorization.provider) || !isObject(authorization.retention) || !isObject(authorization.authorization)) return no('AUTHORIZATION_INCOMPLETE');
  if (!isObject(asset) || typeof asset.ref !== 'string' || typeof asset.sha256 !== 'string') return no('ASSET_NOT_IDENTIFIED');
  // asset-specific: the reference AND the exact bytes
  if (authorization.asset.asset_ref !== asset.ref) return no('ASSET_REF_NOT_AUTHORIZED');
  if (authorization.asset.asset_sha256 !== asset.sha256) return no('ASSET_BYTES_NOT_AUTHORIZED');
  if (authorization.asset.contains_face !== false || authorization.asset.contains_personal_data !== false) return no('FACE_OR_PERSONAL_DATA_NOT_EXCLUDED');
  // provider-, region- and purpose-specific
  if (authorization.provider.provider_id !== providerId) return no('PROVIDER_NOT_AUTHORIZED');
  if (authorization.provider.region !== region) return no('REGION_NOT_AUTHORIZED');
  if (authorization.purpose !== purpose) return no('PURPOSE_NOT_AUTHORIZED');
  if (!Array.isArray(authorization.allowed_operations) || !authorization.allowed_operations.every((o) => OPERATIONS.has(o)) || !authorization.allowed_operations.includes(operation)) return no('OPERATION_NOT_AUTHORIZED');
  // retention is acknowledged and honest
  const retention = authorization.retention;
  if (retention.acknowledged !== true) return no('RETENTION_NOT_ACKNOWLEDGED');
  if (!Number.isInteger(retention.standard_inference_retention_days_max) || retention.standard_inference_retention_days_max < 1) return no('RETENTION_NOT_STATED');
  if (!ZDR_STATUS.has(retention.zdr_status)) return no('ZDR_STATUS_UNKNOWN_VALUE');
  if ((retention.zdr_status === 'CONFIRMED_ACTIVE') !== (retention.zdr_claimed === true)) return no('ZDR_CLAIM_INCONSISTENT');
  if (retention.zdr_claimed === true && !(typeof retention.zdr_evidence_ref === 'string' && retention.zdr_evidence_ref.length > 0)) return no('ZDR_CLAIMED_WITHOUT_EVIDENCE');
  if (authorization.authorization.revoked !== false) return no('AUTHORIZATION_REVOKED');
  if (authorization.global_policy?.changed_by_this_record !== false) return no('AUTHORIZATION_MUST_NOT_CHANGE_THE_GLOBAL_POLICY');
  return Object.freeze({
    allowed: true,
    clearance: Object.freeze({
      authorization_id: authorization.authorization_id,
      asset_ref: asset.ref,
      asset_sha256: asset.sha256,
      provider_id: providerId,
      region,
      purpose,
      operation,
      retention: Object.freeze({
        standard_inference_retention_days_max: retention.standard_inference_retention_days_max,
        zdr_status: retention.zdr_status,
      }),
    }),
  });
}

/** The same assessment as a guard: returns the clearance or throws ExternalMediaSharingError. */
export function assertScopedExternalMediaUse(input) {
  const result = assessScopedExternalMediaUse(input);
  if (!result.allowed) throw new ExternalMediaSharingError(result.reason);
  return result.clearance;
}
