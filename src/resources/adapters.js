// An owner adapter backed by a STATIC set of records. This is the smallest adapter that satisfies the contract
//
//   { adapter_id, supported_kinds, resolve(ref, tenant), loadPayload?(ref, tenant) }
//
// It is NOT a production registry: it is used for tests, for trusted configuration (a benchmark) and as the reference implementation of
// the adapter contract. A production adapter (catalogue, DAM, claims registry, font store) implements the same contract over its own
// persistence. The records are the owner's truth; the common resolver never copies them.

import { RESOURCE_STATUS } from './constants.js';
import { deepFreeze, fail, idToken, ref } from './validation.js';
import { RES_ERROR as E } from './constants.js';

export function createStaticResourceAdapter({ adapter_id: adapterId, records = [], payloads = {} } = {}) {
  const id = idToken(adapterId, 'adapter_id');
  const byRef = new Map();
  for (const record of records) {
    const key = ref(record.ref, 'record.ref');
    if (byRef.has(key)) fail(E.INVALID_ADAPTER, `adapter ${id} holds ${key} twice`, { adapter: id });
    byRef.set(key, deepFreeze(JSON.parse(JSON.stringify(record))));
  }
  const kinds = [...new Set([...byRef.values()].map((r) => r.kind))].sort();
  if (!kinds.length) fail(E.INVALID_ADAPTER, `adapter ${id} holds no record`, { adapter: id });
  return Object.freeze({
    adapter_id: id,
    supported_kinds: kinds,
    // The adapter answers for any tenant: scope and platform-level rules are enforced by the common resolver, not trusted to the adapter.
    async resolve(reference) {
      const record = byRef.get(reference);
      if (!record) return null;
      return {
        ref: record.ref,
        kind: record.kind,
        merchant_id: record.merchant_id ?? null,
        version: record.version ?? null,
        status: record.status ?? RESOURCE_STATUS.ACTIVE,
        metadata: record.metadata ?? null,
        evidence_ref: record.evidence_ref ?? null,
      };
    },
    async loadPayload(reference) {
      const bytes = payloads[reference];
      if (!(bytes instanceof Uint8Array)) throw new Error('no payload');
      return bytes;
    },
  });
}
