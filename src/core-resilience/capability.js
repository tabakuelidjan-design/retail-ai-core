// NORDLA CORE RESILIENCE: CAPABILITIES. A provider is not a capability: the plan asks for a capability (layout, segmentation, scene, critique, parsing...), and a provider or tool is one way to serve it.
// SWITCH_CAPABILITY is NOT dynamic routing (NDR-D01) and never a silent cross-region or cross-class fallback (NDR-P16): it can only use an alternate that was DECLARED, is AUTHORIZED, is declared to give the SAME
// outcome, stays in the same region and does not widen the data class. An alternate that would degrade the user's requested outcome is never used silently: it is reported so that the user is asked.

export const OUTCOME = Object.freeze({ SAME: 'SAME', DEGRADES: 'DEGRADES' });
const DATA_CLASS_RANK = Object.freeze({ PUBLIC: 0, BUSINESS: 1, PRIVATE: 2 });

export function createCapabilityRegistry() {
  const entries = new Map();
  const registry = {
    /** { id, capability (what it serves), provider, region, data_class (the most sensitive class it may receive), authorized, cross_region_allowed, equivalentTo: [{ id, outcome }] } */
    register(entry) {
      if (typeof entry?.id !== 'string' || !entry.id) throw new TypeError('a capability entry needs an id');
      if (!(entry.data_class in DATA_CLASS_RANK)) throw new TypeError(`${entry.id}: data_class must be PUBLIC, BUSINESS or PRIVATE`);
      for (const e of entry.equivalentTo ?? []) if (!Object.values(OUTCOME).includes(e.outcome)) throw new TypeError(`${entry.id}: outcome of ${e.id} must be SAME or DEGRADES`);
      entries.set(entry.id, Object.freeze({ authorized: true, cross_region_allowed: false, equivalentTo: [], ...entry }));
      return registry;
    },
    get: (id) => entries.get(id) ?? null,
    ids: () => [...entries.keys()].sort(),
    /**
     * The alternates of a capability entry for a request of class `data_class`: { safe: [ids that give the SAME outcome], degrading: [ids that would change the outcome] }. Anything unauthorized, in another region
     * (unless the alternate declares cross_region_allowed), or not allowed to receive this data class, is excluded entirely.
     */
    alternatesFor(id, { data_class = 'PUBLIC' } = {}) {
      const origin = entries.get(id);
      const out = { safe: [], degrading: [] };
      if (!origin) return out;
      for (const declared of origin.equivalentTo) {
        const alt = entries.get(declared.id);
        if (!alt || alt.authorized !== true) continue;
        if (alt.region !== origin.region && alt.cross_region_allowed !== true) continue;
        if (DATA_CLASS_RANK[alt.data_class] < DATA_CLASS_RANK[data_class]) continue;
        (declared.outcome === OUTCOME.SAME ? out.safe : out.degrading).push(alt.id);
      }
      return out;
    },
  };
  return registry;
}
