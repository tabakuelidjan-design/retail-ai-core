// Resource resolution BOUNDARY (an interface and its checks - no registry, no database, no network).
//
//   resolve(ref, tenant)  ->  { ref, kind, merchant_id, version?, status, metadata? }
//
// Creative Intelligence receives opaque references (subject_ref, asset_ref, claim_ref, font_ref, format_ref). It NEVER decides what one
// of them names by reading the string: `category://phone-cases` is not a category and `product://x` is not a product until a trusted,
// injected resolver says so. The resolver's `kind` is authoritative; a reference that does not resolve stays unresolved and can never
// become READY; a resource of another merchant is refused; a location is never a resource identity.
//
// A future Socle Resource / Evidence Resolver implements `resolver`. That implementation is a PRE-C2 dependency (see readiness.js).

import {
  CI_ERROR as E, PLATFORM_LEVEL_KINDS, RESOURCE_KIND, RESOURCE_STATUS, SUBJECT_KINDS,
} from './constants.js';
import {
  closedObject, deepFreeze, enumValue, fail, integer, isPlainObject, plainJson, ref, uuid,
} from './validation.js';

const KEYS = ['ref', 'kind', 'merchant_id', 'version', 'status', 'metadata'];
// metadata is descriptive data about the resource (sizes, safe zones...). It can never carry a location or a payload.
const LOCATION_IN_TEXT = /\b(?:https?|ftps?|file|data|blob|wss?):\/?\/?[^\s"']*|\bdata:[a-z]+\/[a-z0-9.+-]+;base64,/i;

function assertNoLocation(value, path = 'metadata') {
  if (typeof value === 'string' && LOCATION_IN_TEXT.test(value)) fail(E.RESOURCE_METADATA_LOCATION, `${path} must not carry a location or a payload`, { path });
  if (Array.isArray(value)) value.forEach((v, i) => assertNoLocation(v, `${path}[${i}]`));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) assertNoLocation(v, `${path}.${k}`);
}

/**
 * Validates what a resolver answered for `requestedRef` in the scope of `tenant` ({ merchantId }). A resolver that does not know the
 * reference answers null / undefined (or status UNRESOLVED): that is an explicit UNRESOLVED resolution with no kind, never a guess.
 */
export function normalizeResourceResolution(raw, { ref: requestedRef, tenant }) {
  ref(requestedRef, 'resolution.ref');
  const merchantId = uuid(tenant?.merchantId, 'tenant.merchantId');
  if (raw == null) {
    return deepFreeze({
      ref: requestedRef, kind: null, merchant_id: null, version: null, status: RESOURCE_STATUS.UNRESOLVED, metadata: null,
    });
  }
  const data = plainJson(raw, 'resolution');
  closedObject(data, KEYS, 'resolution', E.RESOURCE_INVALID);
  if (data.ref !== requestedRef) fail(E.RESOURCE_REF_MISMATCH, 'the resolver answered for another reference', { field: 'resolution.ref' });
  const status = enumValue(data.status, RESOURCE_STATUS, 'resolution.status', E.RESOURCE_INVALID);
  const kind = data.kind == null ? null : enumValue(data.kind, RESOURCE_KIND, 'resolution.kind', E.RESOURCE_INVALID);
  if (kind == null && status !== RESOURCE_STATUS.UNRESOLVED) fail(E.RESOURCE_INVALID, 'a resolved resource states its kind', { field: 'resolution.kind' });
  const owner = data.merchant_id == null ? null : uuid(data.merchant_id, 'resolution.merchant_id');
  if (owner !== null && owner !== merchantId) fail(E.RESOURCE_CROSS_MERCHANT, 'the resource belongs to another merchant', { field: 'resolution.merchant_id' });
  if (owner === null && kind !== null && !PLATFORM_LEVEL_KINDS.includes(kind)) {
    fail(E.RESOURCE_CROSS_MERCHANT, `a ${kind} must belong to the merchant`, { field: 'resolution.merchant_id' });
  }
  if (data.metadata != null) assertNoLocation(data.metadata);
  return deepFreeze({
    ref: requestedRef,
    kind,
    merchant_id: owner,
    version: data.version == null ? null : integer(data.version, 'resolution.version', { min: 1, max: 1000000, code: E.RESOURCE_INVALID }),
    status,
    metadata: data.metadata ?? null,
  });
}

/**
 * Wraps an injected resolver (sync or async) into the boundary Creative Intelligence uses. The wrapper adds nothing but checks.
 */
export function createResourceBoundary({ resolver } = {}) {
  if (typeof resolver !== 'function') fail(E.RESOURCE_INVALID, 'a resource boundary needs an injected resolver function', { field: 'resolver' });
  async function resolve(reference, tenant) {
    ref(reference, 'reference'); // a URL / payload is not a resource identity: refused before the resolver is even asked
    let raw;
    try {
      raw = await resolver(reference, Object.freeze({ merchantId: tenant?.merchantId }));
    } catch {
      return fail(E.RESOURCE_RESOLVER_FAILED, 'the resource resolver failed', { field: 'reference' });
    }
    return normalizeResourceResolution(raw, { ref: reference, tenant });
  }
  /** The resolved kind must be one of `kinds` and the resource ACTIVE - otherwise a stable refusal. */
  async function require(reference, kinds, tenant) {
    const allowed = Array.isArray(kinds) ? kinds : [kinds];
    const resolution = await resolve(reference, tenant);
    if (resolution.status !== RESOURCE_STATUS.ACTIVE) fail(E.RESOURCE_NOT_ACTIVE, `the resource is ${resolution.status}`, { field: 'reference', status: resolution.status });
    if (!allowed.includes(resolution.kind)) fail(E.RESOURCE_KIND_MISMATCH, 'the resolver says this resource is of another kind', { field: 'reference' });
    return resolution;
  }
  return Object.freeze({ resolve, require });
}

const roleOf = (field, refs, kinds) => refs.map((r) => ({ field, ref: r, kinds }));

/**
 * Resolves every reference of an intake through the boundary and reports - never throws for a kind or status problem - whether the
 * run may go on. `status` is RESOLVED only when EVERY reference is ACTIVE and of an expected kind; anything else is UNRESOLVED and
 * must not become READY downstream. A cross-merchant or malformed answer is a security refusal (it throws).
 */
export async function resolveIntakeResources({ intake, boundary, tenant }) {
  const wanted = [
    ...roleOf('subject_refs', intake.subject_refs, SUBJECT_KINDS),
    ...roleOf('source_asset_refs', intake.source_asset_refs, [RESOURCE_KIND.ASSET]),
    ...roleOf('claim_refs', intake.claim_refs, [RESOURCE_KIND.CLAIM]),
    ...roleOf('format_ref', [intake.output_context.format_ref], [RESOURCE_KIND.FORMAT]),
  ];
  const items = [];
  for (const w of wanted) {
    const resolution = await boundary.resolve(w.ref, tenant);
    let outcome = 'RESOLVED';
    if (resolution.status !== RESOURCE_STATUS.ACTIVE) outcome = `NOT_${resolution.status}`;
    else if (!w.kinds.includes(resolution.kind)) outcome = 'KIND_MISMATCH';
    items.push({
      field: w.field, ref: w.ref, resolved_kind: resolution.kind, status: resolution.status, version: resolution.version, outcome,
    });
  }
  const unresolved = items.filter((i) => i.outcome !== 'RESOLVED');
  return deepFreeze({
    status: unresolved.length === 0 ? 'RESOLVED' : 'UNRESOLVED',
    items,
    unresolved_refs: unresolved.map((i) => ({ field: i.field, ref: i.ref, outcome: i.outcome })),
  });
}
