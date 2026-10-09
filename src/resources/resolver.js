// The common Socle Resource Resolver.
//
//   CommonResourceResolver  ->  registered owner adapters / registries  ->  owner truth
//
// It composes adapters and duplicates no data. For a reference it asks EVERY registered adapter (no adapter is chosen from the shape of
// the reference): zero matches -> UNRESOLVED; exactly one -> that is the resolution; more than one -> refused as a conflict. The kind
// comes from the owning adapter, never from the reference text. No network in the core: it is deterministic over adapter answers.

import {
  MAX_PAYLOAD_BYTES, PAYLOAD_KINDS, PLATFORM_LEVEL_KINDS, RES_ERROR as E, RESOURCE_KIND, RESOURCE_STATUS, RESOURCE_RESOLVER_VERSION,
} from './constants.js';
import { normalizeMetadata } from './metadata.js';
import {
  closedObject, deepFreeze, enumValue, fail, idToken, number, ref, sha256,
} from './validation.js';

const ADAPTER_ANSWER_KEYS = ['ref', 'kind', 'merchant_id', 'version', 'status', 'metadata', 'evidence_ref'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tenantOf(tenant) {
  const merchantId = tenant?.merchantId;
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) fail(E.INVALID_TENANT, 'tenant.merchantId must be a UUID', { field: 'tenant' });
  return Object.freeze({ merchantId: merchantId.toLowerCase() });
}

function validateAdapter(adapter, index) {
  if (adapter == null || typeof adapter !== 'object') fail(E.INVALID_ADAPTER, `adapters[${index}] must be an object`, { index });
  const id = idToken(adapter.adapter_id, `adapters[${index}].adapter_id`);
  if (!Array.isArray(adapter.supported_kinds) || adapter.supported_kinds.length === 0) fail(E.INVALID_ADAPTER, `adapter ${id} declares the kinds it owns`, { adapter: id });
  const kinds = adapter.supported_kinds.map((k) => enumValue(k, RESOURCE_KIND, `adapter ${id} kind`, E.INVALID_ADAPTER));
  if (typeof adapter.resolve !== 'function') fail(E.INVALID_ADAPTER, `adapter ${id} must implement resolve(ref, tenant)`, { adapter: id });
  return Object.freeze({ adapter_id: id, supported_kinds: Object.freeze([...new Set(kinds)].sort()), resolve: adapter.resolve.bind(adapter), loadPayload: typeof adapter.loadPayload === 'function' ? adapter.loadPayload.bind(adapter) : null });
}

function candidateFrom(adapter, raw, reference, tenant) {
  closedObject(raw, ADAPTER_ANSWER_KEYS, `adapter ${adapter.adapter_id} answer`, E.INVALID_RESOLUTION);
  if (raw.ref !== reference) fail(E.INVALID_RESOLUTION, `adapter ${adapter.adapter_id} answered for another reference`, { adapter: adapter.adapter_id });
  const status = enumValue(raw.status, RESOURCE_STATUS, 'answer.status', E.INVALID_RESOLUTION);
  if (status === RESOURCE_STATUS.UNRESOLVED) return null; // an adapter that does not know the reference is not a match
  const kind = enumValue(raw.kind, RESOURCE_KIND, 'answer.kind', E.INVALID_RESOLUTION);
  // the adapter may only answer for the kinds it declared it owns
  if (!adapter.supported_kinds.includes(kind)) fail(E.ADAPTER_KIND_UNDECLARED, `adapter ${adapter.adapter_id} answered with a kind it did not declare`, { adapter: adapter.adapter_id });
  const owner = raw.merchant_id == null ? null : String(raw.merchant_id).toLowerCase();
  if (owner !== null && (!UUID.test(owner))) fail(E.INVALID_RESOLUTION, 'answer.merchant_id must be a UUID or null', { field: 'merchant_id' });
  if (owner !== null && owner !== tenant.merchantId) fail(E.CROSS_MERCHANT, 'the resource belongs to another merchant', { field: 'merchant_id' });
  if (owner === null && !PLATFORM_LEVEL_KINDS.includes(kind)) fail(E.CROSS_MERCHANT, `a ${kind} must belong to the merchant`, { field: 'merchant_id' });
  // an ACTIVE resource must say where its truth is recorded: no evidence, no readiness
  let evidence = null;
  if (raw.evidence_ref != null) evidence = ref(raw.evidence_ref, 'answer.evidence_ref');
  if (status === RESOURCE_STATUS.ACTIVE && !evidence) fail(E.EVIDENCE_REQUIRED, `adapter ${adapter.adapter_id}: an ACTIVE resource needs an evidence reference`, { adapter: adapter.adapter_id });
  const metadata = normalizeMetadata(kind, raw.metadata);
  const version = raw.version == null ? null : number(raw.version, 'answer.version', { min: 1, max: 1_000_000, integer: true, code: E.INVALID_RESOLUTION });
  return {
    adapter_id: adapter.adapter_id, kind, merchant_id: owner, version, status, metadata, evidence_ref: evidence,
  };
}

/** Builds the common resolver over owner adapters. Adapters are data providers: the resolver holds no resource of its own. */
export function createCommonResourceResolver({ adapters = [] } = {}) {
  const registered = adapters.map(validateAdapter).sort((a, b) => (a.adapter_id < b.adapter_id ? -1 : 1));
  if (new Set(registered.map((a) => a.adapter_id)).size !== registered.length) fail(E.DUPLICATE_ADAPTER, 'the same adapter_id is registered twice');

  async function matches(reference, tenant) {
    const out = [];
    for (const adapter of registered) {
      let raw;
      try {
        raw = await adapter.resolve(reference, tenant);
      } catch {
        // an outage is never read as "not found": the resolution is refused
        return fail(E.ADAPTER_FAILED, `owner adapter ${adapter.adapter_id} failed`, { adapter: adapter.adapter_id });
      }
      if (raw == null) continue;
      const candidate = candidateFrom(adapter, raw, reference, tenant);
      if (candidate) out.push(candidate);
    }
    return out;
  }

  async function resolve(reference, tenantInput) {
    ref(reference, 'reference');
    const tenant = tenantOf(tenantInput);
    const found = await matches(reference, tenant);
    if (found.length > 1) fail(E.CONFLICT, 'more than one owner adapter resolves this reference', { adapters: found.map((f) => f.adapter_id) });
    if (found.length === 0) {
      return deepFreeze({
        ref: reference, kind: null, merchant_id: null, version: null, status: RESOURCE_STATUS.UNRESOLVED, metadata: null, provenance: null,
      });
    }
    const [one] = found;
    return deepFreeze({
      ref: reference,
      kind: one.kind,
      merchant_id: one.merchant_id,
      version: one.version,
      status: one.status,
      metadata: one.metadata,
      provenance: {
        adapter_id: one.adapter_id,
        evidence_ref: one.evidence_ref,
        content_hash: one.metadata && one.metadata.content_hash ? one.metadata.content_hash : null,
        resolver_version: RESOURCE_RESOLVER_VERSION,
      },
    });
  }

  /** Resolves and requires an ACTIVE resource of one of `kinds`; otherwise a stable refusal. */
  async function require(reference, kinds, tenant) {
    const allowed = Array.isArray(kinds) ? kinds : [kinds];
    const resolution = await resolve(reference, tenant);
    if (resolution.status !== RESOURCE_STATUS.ACTIVE) fail(E.NOT_ACTIVE, `the resource is ${resolution.status}`, { status: resolution.status });
    if (!allowed.includes(resolution.kind)) fail(E.KIND_MISMATCH, 'the owner says this resource is of another kind', { field: 'reference' });
    return resolution;
  }

  /**
   * The EPHEMERAL payload (font bytes, image bytes) of an ACTIVE ASSET / FONT, loaded through the adapter that owns it and checked against
   * the content hash it declared. The bytes are returned to the caller for one use: they are never part of a resolution.
   */
  async function loadPayload(reference, tenantInput) {
    const tenant = tenantOf(tenantInput);
    const resolution = await require(reference, PAYLOAD_KINDS, tenant);
    const adapter = registered.find((a) => a.adapter_id === resolution.provenance.adapter_id);
    if (!adapter?.loadPayload) fail(E.NO_PAYLOAD, 'the owner adapter exposes no payload for this resource', { field: 'reference' });
    let bytes;
    try {
      bytes = await adapter.loadPayload(reference, tenant);
    } catch {
      return fail(E.ADAPTER_FAILED, `owner adapter ${adapter.adapter_id} failed to load the payload`, { adapter: adapter.adapter_id });
    }
    if (!(bytes instanceof Uint8Array)) fail(E.NO_PAYLOAD, 'the payload must be bytes', { field: 'payload' });
    if (bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES) fail(E.PAYLOAD_TOO_LARGE, 'the payload is empty or too large', { field: 'payload' });
    const hash = sha256(bytes);
    if (hash !== resolution.metadata.content_hash) fail(E.PAYLOAD_HASH_MISMATCH, 'the payload does not match the content hash its owner declared', { field: 'payload' });
    return Object.freeze({ ref: reference, kind: resolution.kind, content_hash: hash, version: resolution.version, bytes });
  }

  return Object.freeze({
    resolve,
    require,
    loadPayload,
    adapters: () => registered.map((a) => ({ adapter_id: a.adapter_id, supported_kinds: a.supported_kinds })),
    /** The function the Creative resource boundary expects: (ref, tenant) -> resolution. */
    asBoundaryResolver: () => (reference, tenant) => resolve(reference, tenant),
  });
}
