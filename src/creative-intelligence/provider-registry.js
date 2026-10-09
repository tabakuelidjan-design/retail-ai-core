// Provider Capability Registry (CONTRACT, no live adapter, no network). Providers are DATA, not code: a registry describes what a
// provider can do and under which conditions it may be used; it never ranks, prefers or defaults. "Which one is best today" is
// answered by evidence (a benchmark referenced by benchmark_refs) in a later stage and can change without touching this contract.
//
// Selecting for a task = FILTERING by capability, input privacy class, region and health. The result is every provider that
// qualifies, in provider_id order (a stable order, not a preference).

import {
  CI_ERROR as E, FORBIDDEN_RANKING_KEYS, LATENCY_CLASS, PRIVACY_CLASS, PROVIDER_CAPABILITY, PROVIDER_HEALTH,
} from './constants.js';
import {
  closedObject, deepFreeze, enumValue, fail, idToken, privacyAtLeast, ref, refList, rejectKeysDeep, tokenList,
} from './validation.js';

const KEYS = [
  'provider_id', 'capabilities', 'regions', 'privacy_class', 'commercial_rights_ref', 'latency_class', 'cost_model_ref', 'health',
  'benchmark_refs',
];

export function normalizeProviderEntry(input, field = 'provider') {
  rejectKeysDeep(input, FORBIDDEN_RANKING_KEYS, E.PROVIDER_RANKING_FORBIDDEN, field);
  closedObject(input, KEYS, field, E.PROVIDER_INVALID);
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) fail(E.PROVIDER_INVALID, `${field}.capabilities must list at least one capability`, { field });
  const regions = tokenList(input.regions, `${field}.regions`, { max: 20 });
  if (!regions.length) fail(E.PROVIDER_INVALID, `${field}.regions must list at least one region`, { field });
  return deepFreeze({
    provider_id: idToken(input.provider_id, `${field}.provider_id`),
    capabilities: [...new Set(input.capabilities.map((c, i) => enumValue(c, PROVIDER_CAPABILITY, `${field}.capabilities[${i}]`, E.PROVIDER_INVALID)))].sort(),
    regions,
    // the MOST sensitive class of input this provider may receive (a provider cleared for PERSONAL also accepts BUSINESS / PUBLIC)
    privacy_class: enumValue(input.privacy_class, PRIVACY_CLASS, `${field}.privacy_class`, E.PROVIDER_INVALID),
    commercial_rights_ref: ref(input.commercial_rights_ref, `${field}.commercial_rights_ref`),
    latency_class: enumValue(input.latency_class, LATENCY_CLASS, `${field}.latency_class`, E.PROVIDER_INVALID),
    cost_model_ref: ref(input.cost_model_ref, `${field}.cost_model_ref`),
    health: enumValue(input.health ?? PROVIDER_HEALTH.UNKNOWN, PROVIDER_HEALTH, `${field}.health`, E.PROVIDER_INVALID),
    benchmark_refs: refList(input.benchmark_refs, `${field}.benchmark_refs`, { max: 30 }),
  });
}

export function createProviderRegistry(entries = []) {
  const providers = entries.map((e, i) => normalizeProviderEntry(e, `providers[${i}]`));
  if (new Set(providers.map((p) => p.provider_id)).size !== providers.length) fail(E.PROVIDER_DUPLICATE, 'the same provider_id is registered twice');
  const sorted = [...providers].sort((a, b) => (a.provider_id < b.provider_id ? -1 : 1));
  return Object.freeze({
    list: () => sorted,
    get: (id) => sorted.find((p) => p.provider_id === id) ?? null,
    /**
     * Every provider that can do `capability` with an input of `inputPrivacy` (and, when given, in `region`) and is not UNAVAILABLE.
     * UNKNOWN health is returned as such (the caller decides); nothing is ranked.
     */
    findByCapability(capability, { inputPrivacy, region = null, allowDegraded = true } = {}) {
      enumValue(capability, PROVIDER_CAPABILITY, 'capability', E.PROVIDER_INVALID);
      enumValue(inputPrivacy, PRIVACY_CLASS, 'inputPrivacy', E.PROVIDER_INVALID);
      return sorted.filter((p) => p.capabilities.includes(capability)
        && privacyAtLeast(p.privacy_class, inputPrivacy)
        && (region == null || p.regions.includes(region))
        && p.health !== PROVIDER_HEALTH.UNAVAILABLE
        && (allowDegraded || p.health !== PROVIDER_HEALTH.DEGRADED));
    },
  });
}
