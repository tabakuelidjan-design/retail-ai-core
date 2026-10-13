import { createHash } from 'node:crypto';

import { runLayeredCreative, createLayerStore } from '../creative-runtime/layered-runtime.js';
import { COMPONENT, DECISION } from '../creative-runtime/ledger.js';
import { describeMaskedEditCapability } from './masked-edit.js';
import { createRefineMemory } from './memory.js';
import { REPAIR_BLOCK, SCHEMA } from './constants.js';
import { buildLayerDependencyMap } from './dependency-map.js';
import { defectsFromCandidate } from './defects.js';
import { planRepair } from './planner.js';

// THE EXECUTABLE REFINE. It repairs a delivered layered candidate by re-running the layered runtime on a COPY of the shared layers, with exactly the overrides of the repair plan:
//   - the layers the plan keeps are served from the store (judged again, for free, by their own gates): the same bytes, the same hashes;
//   - the layer the plan replaces is the only one that is paid for, within the allowance of the plan, with the tool the specification selected;
//   - the real product, the locked text, the concept and the art direction are not inputs of the repair at all.
// After the run the repair is CHECKED against its own plan, layer by layer: a change outside the invalidated nodes, any change to the product or to the locked text, or a tool switch REJECTS the repair and the original
// candidate (and the original store) stay exactly as they were. A repair is never a regeneration: there is no path from here to a whole-creative rerun.

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DELIVERED = new Set(['READY_FOR_REVIEW', 'PREFLIGHT_FAIL', 'FIDELITY_FAIL', 'GUARDIAN_FAIL']);
const component = COMPONENT.REFINE_EXECUTOR;

/** The digest of every node of an artifact (what a repair is checked against). */
export function nodeDigests(artifact) {
  const map = buildLayerDependencyMap(artifact);
  return map ? Object.fromEntries(map.nodes.filter((x) => !x.upstream).map((x) => [x.node_id, x.digest ?? null])) : null;
}

/** What changed between two artifacts of the same scene, by node. */
export function diffArtifacts(before, after) {
  const a = nodeDigests(before); const b = nodeDigests(after);
  if (!a || !b) return null;
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return {
    changed: ids.filter((id) => id in a && id in b && a[id] !== b[id]),
    added: ids.filter((id) => !(id in a) && id in b),
    removed: ids.filter((id) => id in a && !(id in b)),
    unchanged: ids.filter((id) => id in a && id in b && a[id] === b[id]),
  };
}

const mergePolicy = (base = {}, over = {}) => ({
  ...base,
  ...over,
  ...(base.drop_layers || over.drop_layers ? { drop_layers: [...new Set([...(base.drop_layers ?? []), ...(over.drop_layers ?? [])])].sort() } : {}),
  ...(base.anchors || over.anchors ? { anchors: { ...(base.anchors ?? {}), ...(over.anchors ?? {}) } } : {}),
  ...(base.placement || over.placement ? { placement: { ...(base.placement ?? {}), ...(over.placement ?? {}) } } : {}),
  ...(base.typography || over.typography ? { typography: { ...(base.typography ?? {}), ...(over.typography ?? {}) } } : {}),
});

/**
 * @param {object} input
 *  candidate  the result of runLayeredCreative to repair (a delivered candidate: it carries its artifact)
 *  defects    DefectRegion[] (omitted: the defects the gates of the candidate already name)
 *  run        the inputs of the original runLayeredCreative call: { at, brief, fonts, agents, ports, ledger, guardian, production, scene_id, gate, policy }
 *  store      the shared layers the candidate was produced with (never modified: the repair works on a copy)
 *  budget     the layer budget of the production (optional: without it the repair has a budget of its own)
 *  memory     the refine memory (optional)
 *  allowedScopes  restricts the repair to these scopes (optional; a scope that does not exist, such as a full regeneration, is refused)
 * @returns RepairResult
 */
export async function refineCreative({
  candidate, defects = null, run, store = createLayerStore(), budget = null, memory = createRefineMemory(), allowedScopes = null,
}) {
  const ledger = run.ledger;
  const sceneId = run.scene_id;
  const result = (status, extra = {}) => Object.freeze({ schema: SCHEMA.result, status, scene_id: sceneId, fallback_to_full_regeneration: false, tool_switch: false, ...extra, original_kept: status !== 'REPAIRED', ledger: ledger.entries() });

  // ---- the candidate and its artifact
  const artifact = candidate?.artifact;
  if (!DELIVERED.has(candidate?.status) || !buildLayerDependencyMap(artifact)) return result('BLOCKED', { block: { code: REPAIR_BLOCK.ARTIFACT_INVALID, detail: `a ${candidate?.status ?? 'missing'} run has no artifact to repair`, replan: 'RUN_THE_SCENE_AGAIN' }, plan: null });
  if (artifact.scene_id !== sceneId) return result('BLOCKED', { block: { code: REPAIR_BLOCK.SCENE_DOES_NOT_MATCH_THE_ARTIFACT, detail: { artifact: artifact.scene_id, run: sceneId }, replan: 'REPAIR_THE_SCENE_OF_THE_ARTIFACT' }, plan: null });
  const found = defects ?? defectsFromCandidate(candidate);

  // ---- the plan (what is invalidated, what is reused, what it costs, or why there is no valid repair)
  const pricing = {};
  for (const r of run.production.shared_layers) pricing[r.request_key] = run.production.production.budget.unit_costs.image_eur_by_size_class[r.size_class];
  const plan = planRepair({ artifact, defects: found, memory, maskedEdit: describeMaskedEditCapability(run.ports), pricing, allowedScopes });
  ledger.record({ decision: DECISION.REFINE_DEFECTS, decided_by: COMPONENT.REFINE_PLANNER, rule: 'A_DEFECT_BELONGS_TO_THE_LAYER_THAT_OWNS_THE_PIXELS', basis: found.map((d) => d.defect_id), outcome: { defects: found.map((d) => ({ id: d.defect_id, kind: d.kind, source: d.source, node: d.node_id ?? d.layer_id ?? null })) } });
  ledger.record({ decision: DECISION.REFINE_PLAN, decided_by: COMPONENT.REFINE_PLANNER, rule: 'THE_SMALLEST_VALID_REPAIR_OR_THE_REASON_THERE_IS_NONE', basis: [plan.plan_id ?? 'no-plan'], outcome: { status: plan.status, scope: plan.scope, invalidated: plan.invalidated, reused: plan.reused, block: plan.block ?? null, replan: plan.replan ?? null, cost: plan.cost ?? null } });
  if (plan.status === 'REPLAN_REQUIRED') return result('REPLAN_REQUIRED', { plan, replan: plan.replan });
  if (plan.status !== 'PLANNED') return result('BLOCKED', { plan, block: plan.block });

  // ---- no silent switch of tool or provider: the port that repairs is the port that produced
  const executedBefore = artifact.tools.executed; const executedNow = run.ports.layers?.executes ?? null;
  if (JSON.stringify(executedBefore) !== JSON.stringify(executedNow)) {
    ledger.record({ decision: DECISION.REFINE_RESULT, decided_by: component, rule: 'A_REPAIR_NEVER_SWITCHES_TOOL_OR_PROVIDER', basis: [plan.plan_id], outcome: { status: 'REJECTED', reason: REPAIR_BLOCK.TOOL_SWITCH_REFUSED, before: executedBefore, now: executedNow } });
    return result('BLOCKED', { plan, block: { code: REPAIR_BLOCK.TOOL_SWITCH_REFUSED, detail: { before: executedBefore, now: executedNow }, replan: 'REPLAN_WITH_THE_TOOL_OF_THE_SPECIFICATION' }, tool_switch: true });
  }

  // ---- the repair runs on a COPY of the shared layers: the original store is replaced only when the repair is accepted
  const repairStore = store.fork();
  for (const r of plan.overrides.reject) repairStore.reject(r.request_key, r.candidate_sha256, plan.overrides.allowance[r.request_key]);
  const before = budget ? budget.snapshot() : { provider_calls: 0, spent_eur: 0 };
  const policy = mergePolicy(run.policy ?? {}, plan.overrides.policy);
  ledger.record({ decision: DECISION.REFINE_EXECUTION, decided_by: component, rule: 'ONLY_THE_INVALIDATED_NODES_ARE_RECOMPUTED', basis: [plan.plan_id], outcome: { scope: plan.scope, steps: plan.steps.map((s) => ({ scope: s.scope, target: s.target, action: s.action.type })), invalidated: plan.invalidated, reused: plan.reused, max_provider_calls: plan.cost.max_provider_calls } });
  const rerun = await runLayeredCreative({ ...run, store: repairStore, policy, ...(budget ? { budget } : {}) });
  const after = rerun.budget ?? { provider_calls: 0, spent_eur: 0 };
  const cost = { provider_calls: after.provider_calls - before.provider_calls, spent_eur: Math.round((after.spent_eur - before.spent_eur) * 1e9) / 1e9, max_provider_calls: plan.cost.max_provider_calls, regenerated_layers: plan.cost.regenerated_layers };
  const attempt = (outcome, reason, extra = {}) => {
    memory.record(sceneId, { plan_id: plan.plan_id, fingerprint: plan.fingerprint, scope: plan.scope, steps: plan.steps.map((s) => ({ scope: s.scope, target: s.target, action: s.action.type })), outcome, reason, before: artifact.nodes.render.png_sha256, after: rerun.artifact?.nodes?.render?.png_sha256 ?? null, cost });
    ledger.record({ decision: DECISION.REFINE_RESULT, decided_by: component, rule: 'A_REPAIR_IS_CHECKED_AGAINST_ITS_OWN_PLAN', basis: [plan.plan_id], outcome: { status: outcome, reason, cost, ...extra } });
  };

  // ---- the repaired candidate must pass every gate of the layered runtime (it is a full candidate, not a patch)
  if (rerun.status !== 'READY_FOR_REVIEW' || !rerun.artifact) {
    attempt('NOT_REPAIRED', REPAIR_BLOCK.REPAIRED_CANDIDATE_REFUSED, { run_status: rerun.status, run_reason: rerun.reason ?? null });
    return result('NOT_REPAIRED', { plan, block: { code: REPAIR_BLOCK.REPAIRED_CANDIDATE_REFUSED, detail: { status: rerun.status, reason: rerun.reason ?? null, blocks: rerun.detail ?? null }, replan: rerun.replan ?? 'REPLAN_THE_SCENE' }, cost, provider_calls: cost.provider_calls });
  }

  // ---- the repair is checked against its plan, node by node
  const diff = diffArtifacts(artifact, rerun.artifact);
  const allowed = new Set(plan.invalidated);
  const outside = [...diff.changed, ...diff.added, ...diff.removed].filter((id) => !allowed.has(id));
  const protectedChanged = plan.protected.filter((id) => diff.changed.includes(id) || diff.removed.includes(id));
  const productIdentical = JSON.stringify(artifact.nodes.product) === JSON.stringify(rerun.artifact.nodes.product);
  const textIdentical = JSON.stringify(artifact.nodes.text) === JSON.stringify(rerun.artifact.nodes.text);
  if (outside.length || protectedChanged.length || !productIdentical || !textIdentical || cost.provider_calls > plan.cost.max_provider_calls) {
    attempt('REJECTED', REPAIR_BLOCK.REPAIR_OUTSIDE_ITS_SCOPE, { outside, protected_changed: protectedChanged, product_identical: productIdentical, locked_copy_identical: textIdentical, provider_calls: cost.provider_calls });
    return result('BLOCKED', { plan, block: { code: REPAIR_BLOCK.REPAIR_OUTSIDE_ITS_SCOPE, detail: { outside, protected_changed: protectedChanged, product_identical: productIdentical, locked_copy_identical: textIdentical, provider_calls: cost.provider_calls }, replan: 'REPLAN_THE_SCENE' }, cost });
  }
  const targets = plan.steps.map((s) => (s.target === 'TEXT_STYLE' ? null : s.target)).filter(Boolean);
  const effective = diff.changed.length + diff.added.length + diff.removed.length > 0 && (targets.length === 0 ? diff.changed.some((id) => id.startsWith('TEXT_STYLE:')) || diff.changed.includes('COMPOSITE_STACK') : targets.some((t) => diff.changed.includes(t) || diff.removed.includes(t) || t === 'COMPOSITE_STACK'));
  if (!effective) {
    attempt('NOT_REPAIRED', REPAIR_BLOCK.REPAIR_HAD_NO_EFFECT);
    return result('NOT_REPAIRED', { plan, block: { code: REPAIR_BLOCK.REPAIR_HAD_NO_EFFECT, detail: { changed: diff.changed }, replan: 'REPLAN_THE_SCENE' }, cost });
  }
  attempt('REPAIRED', null, { changed: diff.changed, removed: diff.removed, added: diff.added, unchanged: diff.unchanged.length });
  return result('REPAIRED', {
    plan, before: artifact, after: rerun.artifact, layer_diff: diff, product_identical: productIdentical, locked_copy_identical: textIdentical, cost, provider_calls: cost.provider_calls, candidate: rerun, store: repairStore, memory: memory.export(), digest: digestOf([plan.plan_id, rerun.artifact.nodes.render.png_sha256]),
  });
}
