// Small shared helpers for the M4 contracts. Pure; the generic validators live in understand-validation.js / m3-validation.js.

import { M4_ERROR as Z } from './m4-constants.js';
import { canonical, rejectKeysDeep, safeRef, safeRefList } from './m3-validation.js';
import { deriveId, fail, isPlainObject } from './understand-validation.js';

export {
  canonical, rejectKeysDeep, safeRef, safeRefList,
};

export const sortedUnique = (values) => [...new Set(values)].sort();

/** Refuses a forbidden / PII key anywhere in an input (keys only). Originals owned by other domains are never passed here. */
export function rejectForbidden(value, field, steerKeys, piiKeys) {
  rejectKeysDeep(value, steerKeys, Z.FORBIDDEN_FIELD, field);
  rejectKeysDeep(value, piiKeys, Z.PRIVACY_FIELD, field);
}

/** Same refusal on everything an options object carries EXCEPT the originals (objects owned by other domains are never scanned). */
export function rejectForbiddenExtras(options, originalKeys, field, steerKeys, piiKeys) {
  const extras = Object.fromEntries(Object.entries(options ?? {}).filter(([key]) => !originalKeys.includes(key)));
  rejectForbidden(extras, field, steerKeys, piiKeys);
}

// A stored object carries its own content-derived id: a tampered field no longer matches it (a recomputed id is a trust-boundary
// matter, not a contract one). `prefix_` + 32 hex.
function idMatches(object, idField, prefix) {
  const { [idField]: id, ...body } = object;
  return typeof id === 'string' && deriveId(prefix, body) === id;
}

/**
 * The ORIGINAL Push, as built by M2 (mpp_ id over the whole body). M4 has no Finding in its mandate, so it binds the Push to its
 * own id and to the tenant: a forged field no longer matches the id.
 */
export function verifiedPush(push, merchantId) {
  if (!isPlainObject(push) || !idMatches(push, 'push_id', 'mpp')) fail(Z.PUSH_INVALID, 'the Push is not a MarketingPushProposal that matches its own id');
  if (push.merchant_id !== merchantId) fail(Z.SCOPE_MISMATCH, 'the Push does not belong to the resolved tenant');
  if (push.brand_id == null) fail(Z.SCOPE_MISMATCH, 'a Run needs an explicit brand: the Push has none');
  if (!isPlainObject(push.measurement_plan) || !isPlainObject(push.measurement_plan.observation_window)) fail(Z.PUSH_INVALID, 'the Push has no MeasurementPlan');
  return push;
}

/** The ORIGINAL ActivationManifest (mam_ id over the whole body), in the scope of the tenant and about this Push. */
export function verifiedManifest(manifest, push, merchantId) {
  if (!isPlainObject(manifest) || !idMatches(manifest, 'activation_manifest_id', 'mam')) {
    fail(Z.MANIFEST_INVALID, 'the Activation Manifest does not match its own id');
  }
  if (manifest.merchant_id !== merchantId || manifest.brand_id !== push.brand_id) fail(Z.SCOPE_MISMATCH, 'the Activation Manifest is not in the scope of the tenant and the Push');
  if (manifest.push_ref !== push.push_id || manifest.finding_ref !== push.finding_ref) fail(Z.SCOPE_MISMATCH, 'the Activation Manifest is about another Push');
  if (manifest.measurement_plan_ref !== `${push.push_id}#measurement`) fail(Z.SCOPE_MISMATCH, 'the Activation Manifest points at another MeasurementPlan');
  return manifest;
}

/** A stored M4 object must match its own id. */
export function assertOwnId(object, idField, prefix, code, message) {
  if (!isPlainObject(object) || !idMatches(object, idField, prefix)) fail(code, message);
  return object;
}
