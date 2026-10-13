import { createHash } from 'node:crypto';

import {
  DEFECT_KIND, MASKED_EDIT, REFINE_POLICY, REPAIR_BLOCK, REPAIR_SCOPE, REPAIR_SCOPES, SCHEMA,
} from './constants.js';
import { buildLayerDependencyMap, invalidationOf } from './dependency-map.js';
import { attributeDefect } from './defects.js';

// THE REPAIR PLANNER: the SMALLEST VALID repair for a set of defects, or the reason there is none. Deterministic and pure; it asks nothing of a model and calls no provider.
//
// Order of decisions, always the same:
//   1. refuse what is never allowed        (the real product pixels, locked copy, a defect that only a masked edit could fix, Phase 5 work)
//   2. send upstream what is upstream      (a concept / layout defect is a REPLAN request; it is never answered by regenerating layers)
//   3. attribute the rest to a layer       (explicit owner, or the topmost layer at the defect; an owner that cannot be named is refused, never guessed)
//   4. choose the cheapest scope that answers the defect   (reposition or remove a prop, redraw the text style, recompute the composite, regenerate ONE layer)
//   5. compute what is invalidated (the targets and what depends on them) and what is reused (everything else), and refuse a plan that reaches a protected node or regenerates (nearly) everything.

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PROP_KINDS = new Set([DEFECT_KIND.PROP_UNUSABLE, DEFECT_KIND.PROP_RESEMBLES_THE_PRODUCT]);
const PLACEMENT_KINDS = new Set([DEFECT_KIND.PROP_OVERLAP, DEFECT_KIND.PROP_NO_ROOM]);
const MAX_REPOSITIONS = 2;
const FOREGROUND_INSETS = Object.freeze([0.15, 0.05]); // a smaller inset pulls a foreground prop LESS over the product corner

const blocked = (code, detail, replan, defects = []) => Object.freeze({ schema: SCHEMA.plan, status: 'BLOCKED', block: Object.freeze({ code, detail, replan }), scope: [], steps: [], defects, invalidated: [], reused: [], overrides: null, cost: null });

/** What the planner needs to know about the earlier attempts (the working memory of the scene). */
const triedOf = (memory, sceneId) => ({
  attempts: memory?.attempts?.(sceneId) ?? [],
  fingerprints: new Set((memory?.attempts?.(sceneId) ?? []).filter((a) => a.outcome !== 'REPAIRED').map((a) => a.fingerprint)),
  repositions: (layerId) => (memory?.attempts?.(sceneId) ?? []).filter((a) => a.steps?.some((s) => s.scope === REPAIR_SCOPE.LAYER_REMOVE_OR_REPOSITION && s.target === `PROP:${layerId}`)).length,
});

/**
 * @param {object} input { artifact (the layered artifact of the candidate), defects, memory? (the refine memory), maskedEdit? ({ executable }), pricing? ({ [request_key]: unit eur }), expectedArtifactDigest? }
 * @returns the RepairPlan (status PLANNED | REPLAN_REQUIRED | BLOCKED)
 */
export function planRepair({
  artifact, defects, memory = null, maskedEdit = { executable: false }, pricing = null, expectedArtifactDigest = null, allowedScopes = null,
}) {
  const map = buildLayerDependencyMap(artifact);
  if (!map) return blocked(REPAIR_BLOCK.ARTIFACT_INVALID, 'the artifact is not a layered artifact', 'RUN_THE_SCENE_AGAIN');
  const artifactDigest = digestOf([map.digest, artifact.scene_id, artifact.nodes.render.png_sha256]);
  if (expectedArtifactDigest && expectedArtifactDigest !== artifactDigest) return blocked(REPAIR_BLOCK.ARTIFACT_STALE, 'the artifact is not the one the defects were observed on', 'OBSERVE_THE_DEFECTS_AGAIN');
  if (!Array.isArray(defects) || defects.length === 0) return blocked(REPAIR_BLOCK.NO_DEFECT, 'no defect was given', 'NOTHING_TO_REPAIR');
  const n = artifact.nodes; const mem = triedOf(memory, artifact.scene_id);
  if (mem.attempts.length >= REFINE_POLICY.max_attempts_per_scene) return blocked(REPAIR_BLOCK.REFINE_ATTEMPTS_EXHAUSTED, `${mem.attempts.length} repairs of this scene were already attempted`, 'REPLAN_THE_SCENE', defects);

  const steps = []; const reasons = []; const upstream = new Set(); const evidence = [];
  const addStep = (step) => { if (!steps.some((s) => s.scope === step.scope && s.target === step.target && JSON.stringify(s.action) === JSON.stringify(step.action))) steps.push(step); };

  for (const d of defects) {
    if (d.kind === DEFECT_KIND.PRODUCT_PIXELS) return blocked(REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS, { defect: d.defect_id, reason: 'a change to the real product pixels was asked for' }, 'VERIFY_THE_PRODUCT_ASSET_AND_REPLAN_THE_SCENE', defects);
    if (d.kind === DEFECT_KIND.COPY_CHANGE) return blocked(REPAIR_BLOCK.REPAIR_WOULD_CHANGE_LOCKED_COPY, { defect: d.defect_id, reason: 'locked copy is exact: a copy change is a replan of the content, not a repair' }, 'REPLAN_THE_COPY_OF_THE_ASSET', defects);
    if (d.kind === DEFECT_KIND.REQUIRES_PHASE_5) return blocked(REPAIR_BLOCK.NOT_AVAILABLE_IN_THIS_PHASE, { defect: d.defect_id, reason: 'relight, contact shadow and grading are not part of Phase 4' }, 'WAIT_FOR_THE_INTEGRATION_PHASE', defects);
    if (d.kind === DEFECT_KIND.LOCAL_PIXEL_DEFECT) {
      if (maskedEdit?.executable !== true) return blocked(REPAIR_BLOCK.NEEDS_A_MASKED_EDIT_PROVIDER, { defect: d.defect_id, masked_edit: MASKED_EDIT.NOT_CONNECTED }, 'CONNECT_A_MASKED_EDIT_PROVIDER_OR_REPLACE_THE_LAYER', defects);
      return blocked(REPAIR_BLOCK.NOT_AVAILABLE_IN_THIS_PHASE, { defect: d.defect_id, reason: 'a masked-edit repair is not an executable scope of this phase' }, 'REPLACE_THE_LAYER', defects);
    }
    if (d.kind === DEFECT_KIND.UPSTREAM_CONCEPT) { upstream.add('ART_DIRECTION'); upstream.add('CONCEPT'); reasons.push({ defect: d.defect_id, why: 'the concept or art direction is the problem: not a layer defect' }); continue; }
    if (d.kind === DEFECT_KIND.UPSTREAM_LAYOUT) { upstream.add('ASSET_PLAN'); reasons.push({ defect: d.defect_id, why: 'the composition intent or layout is the problem: not a layer defect' }); continue; }

    const at = attributeDefect(artifact, d);
    evidence.push({ defect: d.defect_id, observed_in: d.evidence.observed_in, rule: d.evidence.rule, via: at.via, owner: at.node_id });
    if (at.node_id === n.product.node_id) return blocked(REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS, { defect: d.defect_id, region: d.region, reason: 'the defect lies on the real product: its pixels are authoritative and never repaired' }, 'VERIFY_THE_PRODUCT_ASSET_AND_REPLAN_THE_SCENE', defects);
    if (at.node_id?.startsWith('TEXT:') && d.kind !== DEFECT_KIND.TEXT_ILLEGIBLE) return blocked(REPAIR_BLOCK.REPAIR_WOULD_CHANGE_LOCKED_COPY, { defect: d.defect_id, node: at.node_id, reason: 'the defect lies on locked text' }, 'REPLAN_THE_COPY_OF_THE_ASSET', defects);

    // the owner of a prop defect: named, or the ONLY prop of the scene; never a guess between several
    let owner = at.node_id;
    const unnamed = at.via === 'NONE'; // a defect that names a layer, a node or a place is never re-targeted: only a defect that names NOTHING may default to the only candidate
    if (!owner && unnamed && (PROP_KINDS.has(d.kind) || PLACEMENT_KINDS.has(d.kind)) && n.props.length === 1) { owner = n.props[0].node_id; evidence.at(-1).via = 'ONLY_PROP'; evidence.at(-1).owner = owner; }
    if (!owner && unnamed && d.kind === DEFECT_KIND.PLATE_UNSUITABLE) { owner = n.plate.node_id; evidence.at(-1).via = 'ONLY_PLATE'; evidence.at(-1).owner = owner; }

    if (PROP_KINDS.has(d.kind)) {
      const prop = n.props.find((p) => p.node_id === owner);
      if (!prop) return blocked(REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, { defect: d.defect_id, kind: d.kind, owner }, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT', defects);
      addStep({ scope: REPAIR_SCOPE.PROP_REPAIR, target: prop.node_id, layer_id: prop.layer_id, request_key: prop.request_key, action: { type: 'REPLACE_WITH_A_NEW_CANDIDATE', reject_candidate_sha256: prop.candidate_sha256 } });
    } else if (d.kind === DEFECT_KIND.PLATE_UNSUITABLE) {
      if (owner !== n.plate.node_id) return blocked(REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, { defect: d.defect_id, kind: d.kind, owner }, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT', defects);
      addStep({ scope: REPAIR_SCOPE.PLATE_REPAIR, target: n.plate.node_id, request_key: n.plate.request_key, action: { type: 'REPLACE_WITH_A_NEW_CANDIDATE', reject_candidate_sha256: n.plate.candidate_sha256 } });
    } else if (d.kind === DEFECT_KIND.TEXT_ILLEGIBLE) {
      if (n.text_style.length === 0) return blocked(REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, { defect: d.defect_id, reason: 'the scene has no text style to repair' }, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT', defects);
      if (n.text_style.every((s) => s.plate)) return blocked(REPAIR_BLOCK.REPEATED_FAILED_REPAIR, { defect: d.defect_id, reason: 'TYPOGRAPHY_ALREADY_ON_A_PLATE' }, 'REPLAN_THE_PLATE_OR_THE_BRAND_COLOURS', defects);
      addStep({ scope: REPAIR_SCOPE.TYPOGRAPHY_REPAIR, target: 'TEXT_STYLE', action: { type: 'BRAND_PLATE_BEHIND_THE_TEXT' } });
    } else if (PLACEMENT_KINDS.has(d.kind) || (d.kind === DEFECT_KIND.COMPOSITION_REFUSED && owner?.startsWith('PROP:'))) {
      const prop = n.props.find((p) => p.node_id === owner);
      if (!prop) return blocked(REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, { defect: d.defect_id, kind: d.kind, owner }, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT', defects);
      const moved = mem.repositions(prop.layer_id);
      if (moved < MAX_REPOSITIONS) {
        const action = prop.kind === 'PROP_FOREGROUND' ? { type: 'REPOSITION', foreground_inset: FOREGROUND_INSETS[moved] } : { type: 'REPOSITION', anchor: moved + 1 };
        addStep({ scope: REPAIR_SCOPE.LAYER_REMOVE_OR_REPOSITION, target: prop.node_id, layer_id: prop.layer_id, action });
      } else if (REFINE_POLICY.allow_drop_of_a_prop) addStep({ scope: REPAIR_SCOPE.LAYER_REMOVE_OR_REPOSITION, target: prop.node_id, layer_id: prop.layer_id, action: { type: 'REMOVE' } });
      else return blocked(REPAIR_BLOCK.LAYER_CANNOT_BE_DROPPED, { defect: d.defect_id, layer: prop.layer_id }, 'REPLAN_THE_COMPOSITION', defects);
    } else if (d.kind === DEFECT_KIND.COMPOSITION_REFUSED || d.kind === DEFECT_KIND.COMPOSITE_STALE) {
      addStep({ scope: REPAIR_SCOPE.COMPOSITE_REPAIR, target: 'COMPOSITE_STACK', action: { type: 'RECOMPUTE_FROM_VALID_LAYERS' } });
    } else return blocked(REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, { defect: d.defect_id, kind: d.kind }, 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT', defects);
  }

  // upstream defects answer with a replan request: the upstream node is invalidated ONLY because the defect truly originates there, and no layer is repaired in its place
  if (upstream.size) {
    return Object.freeze({
      schema: SCHEMA.plan, status: 'REPLAN_REQUIRED', scope: [], steps: [], defects, reasons, evidence,
      replan: { upstream_nodes: [...upstream].sort(), note: 'the defect originates upstream of the layers: a refine does not answer it' }, invalidated: [...upstream].sort(), reused: [], overrides: null, cost: null,
      plan_id: `plan-${digestOf([map.digest, defects.map((d) => d.defect_id), [...upstream]]).slice(0, 16)}`,
    });
  }

  const scopes = [...new Set(steps.map((s) => s.scope))];
  // the caller may constrain the scope (or ask for one that does not exist, such as a full regeneration): anything outside the declared scopes is refused
  if (scopes.some((s) => !REPAIR_SCOPES.includes(s)) || (allowedScopes && (!allowedScopes.every((s) => REPAIR_SCOPES.includes(s)) || scopes.some((s) => !allowedScopes.includes(s))))) return blocked(REPAIR_BLOCK.REPAIR_SCOPE_INVALID, { planned: scopes, allowed: allowedScopes }, 'REPLAN_THE_SCENE', defects);

  // what is invalidated: the targets and what depends on them
  const targets = new Set();
  for (const s of steps) {
    if (s.target === 'TEXT_STYLE') n.text_style.forEach((t) => targets.add(t.node_id));
    else if (s.target === 'COMPOSITE_STACK') { targets.add('COMPOSITE_STACK'); targets.add('COMPOSITE_BASE'); } else targets.add(s.target);
  }
  const inv = invalidationOf(map, [...targets]);
  if (inv.reached_protected.length || inv.reached_upstream.length) return blocked(REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS, { reached: [...inv.reached_protected, ...inv.reached_upstream] }, 'REPLAN_THE_SCENE', defects);

  // breadth: a repair regenerates at most the declared number of layers and strictly fewer than the scene has
  const regenerate = steps.filter((s) => s.action.type === 'REPLACE_WITH_A_NEW_CANDIDATE');
  const regeneratedKeys = [...new Set(regenerate.map((s) => s.request_key))];
  const generatedCount = 1 + n.props.length;
  if (regeneratedKeys.length > REFINE_POLICY.max_regenerated_layers || regeneratedKeys.length >= generatedCount) return blocked(REPAIR_BLOCK.REPAIR_SCOPE_TOO_BROAD, { regenerated: regeneratedKeys.length, generated_layers: generatedCount, limit: REFINE_POLICY.max_regenerated_layers }, 'REPLAN_THE_SCENE', defects);

  const overrides = { reject: regenerate.map((s) => ({ request_key: s.request_key, candidate_sha256: s.action.reject_candidate_sha256 })), allowance: Object.fromEntries(regeneratedKeys.map((k) => [k, REFINE_POLICY.repair_candidates_per_layer])), policy: {} };
  const drop = steps.filter((s) => s.action.type === 'REMOVE').map((s) => s.layer_id);
  if (drop.length) overrides.policy.drop_layers = drop.sort();
  const anchors = Object.fromEntries(steps.filter((s) => s.action.type === 'REPOSITION' && s.action.anchor !== undefined).map((s) => [s.layer_id, s.action.anchor]));
  if (Object.keys(anchors).length) overrides.policy.anchors = anchors;
  const insets = steps.filter((s) => s.action.type === 'REPOSITION' && s.action.foreground_inset !== undefined).map((s) => s.action.foreground_inset);
  if (insets.length) overrides.policy.placement = { foreground_inset: Math.min(...insets) };
  if (steps.some((s) => s.action.type === 'BRAND_PLATE_BEHIND_THE_TEXT')) overrides.policy.typography = { plate_behind_text: true };

  const fingerprint = digestOf([artifactDigest, steps.map((s) => [s.scope, s.target, s.action]), overrides]).slice(0, 24);
  if (mem.fingerprints.has(fingerprint)) return blocked(REPAIR_BLOCK.REPEATED_FAILED_REPAIR, { fingerprint, reason: 'the same repair of the same artifact already failed' }, 'REPLAN_THE_SCENE', defects);
  const lines = regeneratedKeys.map((key) => ({ request_key: key, max_candidates: REFINE_POLICY.repair_candidates_per_layer, unit_eur: pricing?.[key] ?? null, max_eur: pricing?.[key] != null ? Math.round(pricing[key] * REFINE_POLICY.repair_candidates_per_layer * 1e9) / 1e9 : null }));
  return Object.freeze({
    schema: SCHEMA.plan, status: 'PLANNED', plan_id: `plan-${digestOf([map.digest, defects.map((d) => d.defect_id), steps, overrides]).slice(0, 16)}`, fingerprint, artifact_digest: artifactDigest, dependency_map_digest: map.digest,
    scope: scopes, steps, defects, reasons, evidence,
    invalidated: inv.invalidated, reused: inv.reused, protected: map.nodes.filter((x) => x.protected).map((x) => x.node_id).sort(), upstream_untouched: map.nodes.filter((x) => x.upstream).map((x) => x.node_id),
    overrides, cost: { regenerated_layers: regeneratedKeys.length, max_provider_calls: regeneratedKeys.length * REFINE_POLICY.repair_candidates_per_layer, lines, only_the_repaired_work: true },
    fallback_to_full_regeneration: false,
  });
}
