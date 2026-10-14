// NORDLA CORE RESILIENCE: CHANGE OF MIND. When the user changes one thing, only the work that DEPENDS on it is invalidated; valid upstream and unrelated state is preserved. The dependency graph is declared by the
// module (facts the user gives, and stages that read facts or earlier stages); the closure is computed here, generically. Nothing restarts from zero because one item changed.

/** { facts: ['product', 'headline'], stages: [{ name: 'frame', reads: ['audience', 'product'] }, { name: 'ideate', reads: ['frame'] }] }: a stage reads facts and/or EARLIER stages (acyclic by construction). */
export function createDependencyGraph({ facts, stages }) {
  const seen = new Set(facts);
  for (const s of stages) {
    if (seen.has(s.name)) throw new TypeError(`duplicate name ${s.name}`);
    for (const r of s.reads) if (!seen.has(r)) throw new TypeError(`${s.name} reads ${r}, which is neither a fact nor an earlier stage`);
    seen.add(s.name);
  }
  return Object.freeze({ facts: Object.freeze([...facts]), stages: Object.freeze(stages.map((s) => Object.freeze({ name: s.name, reads: Object.freeze([...s.reads]) }))) });
}

/**
 * changes: [{ fact, change: 'CHANGED' | 'REMOVED' | 'ADDED' }]. Returns { recompute: [stages in order], preserved: [stages in order], why: { stage: [the fact or stage it depends on that changed] } }.
 * An unknown fact is refused (a change to something the graph does not know cannot be reasoned about: ASK_USER upstream).
 */
export function invalidate(graph, changes) {
  for (const c of changes) if (!graph.facts.includes(c.fact)) throw Object.assign(new TypeError(`unknown fact ${c.fact}`), { code: 'CORE_UNKNOWN_FACT' });
  const dirty = new Set(changes.map((c) => c.fact));
  const why = {};
  const recompute = [];
  for (const stage of graph.stages) {
    const hit = stage.reads.filter((r) => dirty.has(r));
    if (hit.length) { dirty.add(stage.name); recompute.push(stage.name); why[stage.name] = hit; }
  }
  return { recompute, preserved: graph.stages.map((s) => s.name).filter((n) => !recompute.includes(n)), why };
}

/** Applies an invalidation to a run's committed state: only the affected committed stages are uncommitted. Returns the report plus what was actually removed. */
export function applyChange(graph, runHandle, changes) {
  const plan = invalidate(graph, changes);
  const removed = runHandle.uncommit(plan.recompute);
  runHandle.record({ module: 'core', stage: 'change_of_mind', recovery_action: 'REPLAN', result: `INVALIDATED:${removed.join(',') || 'NOTHING_COMMITTED'}`, rationale: `changed: ${changes.map((c) => `${c.fact}(${c.change})`).join(', ')}` });
  return { ...plan, removed };
}
