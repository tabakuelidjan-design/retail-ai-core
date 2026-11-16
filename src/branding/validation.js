import { APPROVER_ROLE } from './constants.js';
import { TENANT_SOURCES, isUuid } from '../tenant/index.js';

const plainObject = (value) => (
  value != null && typeof value === 'object' && !Array.isArray(value)
);

export function assertObject(value, field) {
  if (!plainObject(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

export function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value, field) {
  return value == null ? null : requiredString(value, field);
}

export function integerVersion(value, field = 'version') {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be an integer >= 1`);
  }
  return value;
}

export function isoDate(value, field) {
  const text = requiredString(value, field);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be an ISO date/time`);
  return date.toISOString();
}

export function enumValue(value, allowed, field) {
  const normalized = requiredString(value, field);
  if (!Object.values(allowed).includes(normalized)) {
    throw new TypeError(`unsupported ${field}: ${normalized}`);
  }
  return normalized;
}

export function stringList(value, field, { max = null } = {}) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const out = [...new Set(value.map((item) => requiredString(item, field)))];
  if (max != null && out.length > max) {
    throw new RangeError(`${field} must contain at most ${max} items`);
  }
  return Object.freeze(out);
}

export function objectList(value, field, normalizer) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return Object.freeze(value.map((item, index) => normalizer(item, `${field}[${index}]`)));
}

export function jsonValue(value, field = 'value') {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    return JSON.parse(encoded);
  } catch {
    throw new TypeError(`${field} must be JSON-serializable`);
  }
}

export function uniqueIds(items, field) {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${field} contains duplicate ids`);
  }
}

// A merchant id stored on a Branding document: must be a canonical tenant UUID.
export function merchantIdValue(value, field = 'merchant_id') {
  const text = requiredString(value, field);
  if (!isUuid(text)) throw new TypeError(`${field} must be a tenant UUID`);
  return text.toLowerCase();
}

// A brand id is a stable UUID issued server-side, distinct from the merchant (tenant) id.
export function brandIdValue(value, field = 'brand_id') {
  const text = requiredString(value, field);
  if (!isUuid(text)) throw new TypeError(`${field} must be a brand UUID`);
  return text.toLowerCase();
}

// Branding never resolves a tenant itself (ADR 0003): callers pass the result of
// the canonical resolver in src/tenant ({ merchantId, source }).
export function tenantMerchantId(tenant, field = 'tenant') {
  assertObject(tenant, field);
  if (!TENANT_SOURCES.includes(tenant.source)) {
    throw new TypeError(`${field}.source must be a canonical tenant source`);
  }
  return merchantIdValue(tenant.merchantId, `${field}.merchantId`);
}

export function assertSameTenant(tenant, merchantId, reason) {
  if (tenantMerchantId(tenant) !== merchantIdValue(merchantId)) throw new Error(reason);
}

// `resolved_actor` MUST come from the trusted server / Socle context, never from a client payload.
// Branding performs NO authentication and NO cryptographic verification: it only checks that an
// actor is present, belongs to the same tenant and holds an authorized role. Until Nordla Identity
// exists, whoever builds `resolved_actor` carries that trust (open dependency).
export function assertResolvedActor(resolvedActor, tenant, field = 'resolved_actor') {
  if (resolvedActor == null) throw new Error('RESOLVED_ACTOR_MISSING');
  assertObject(resolvedActor, field);
  const merchantId = tenantMerchantId(tenant);
  if (merchantIdValue(resolvedActor.merchant_id, `${field}.merchant_id`) !== merchantId) {
    throw new Error('RESOLVED_ACTOR_TENANT_MISMATCH');
  }
  return Object.freeze({
    user_id: requiredString(resolvedActor.user_id, `${field}.user_id`),
    role: enumValue(resolvedActor.role, APPROVER_ROLE, `${field}.role`),
    merchant_id: merchantId,
  });
}

export function approval(input, field = 'approval') {
  if (input == null) return null;
  assertObject(input, field);
  return Object.freeze({
    decision_event_id: requiredString(input.decision_event_id, `${field}.decision_event_id`),
    approved_by: requiredString(input.approved_by, `${field}.approved_by`),
    approver_role: enumValue(input.approver_role, APPROVER_ROLE, `${field}.approver_role`),
    approved_at: isoDate(input.approved_at, `${field}.approved_at`),
    note: optionalString(input.note, `${field}.note`),
  });
}

// Recursively freezes plain data so consumers (Marketing, Creative) get read-only views.
export function deepFreeze(value) {
  if (value != null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function validationResult(reasons = []) {
  const unique = [...new Set(reasons)];
  return Object.freeze({
    ok: unique.length === 0,
    reasons: Object.freeze(unique),
  });
}
