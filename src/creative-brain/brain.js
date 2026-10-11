import { normalizeCreativeDirection } from '../creative-intelligence/creative-direction.js';
import { createArtDirector } from './art-direction.js';
import { composeLayout, createCompositionPlanner } from './composition.js';
import { createConceptDirector } from './concept.js';
import { createConceptSelector, SELECTION } from './concept-selection.js';
import { createProblemFramer, observeBrief } from './problem-frame.js';
import { planProduction, RECOVERY_ACTION } from './production-strategist.js';
import { diagnoseRecovery } from './recovery.js';
import { composeScene } from './scene-composer.js';
import {
  BRAIN_ERROR, deepFreeze, deriveId, fail,
} from './validation.js';
import { COMPONENT, DECISION } from '../creative-runtime/ledger.js';

// THE CREATIVE BRAIN. Not a prompt: a sequence of decision stages, each with a canonical contract, a responsibility, concise recorded evidence and a deterministic guard, in the order
//   OBSERVE -> FRAME -> IDEATE -> SELECT CONCEPT -> ART DIRECT -> COMPOSE -> SCENE -> PRODUCTION STRATEGY   (and, after a candidate is critiqued: DIAGNOSE -> REFINE / RECOMPOSE / RECONCEPT)
// Language models sit behind ports and are asked for fields of a contract, never for their private reasoning; the stage keeps a concise rationale for the record. The scene composer, the
// production strategist and the recovery diagnosis are deterministic. The brain produces a CreativePlan: canonical data from which the production runtime works. It owns no provider.

const MAX_CONCEPT_ROUNDS = 2;

const ledgerRecord = (ledger, decision, component, rule, outcome) => ledger?.record({ decision, decided_by: component, rule, basis: [], outcome });

/** The approved text roles of a brief (what the composition must keep). */
const approvedRolesOf = (observation) => observation.approved_text_roles;

/** A plan must hold together: each stage answers the stage before, and no approved text is dropped. */
export function assertPlanCoherent(plan) {
  const bad = (problem) => fail(BRAIN_ERROR.RULE_VIOLATION, 'the creative plan does not hold together', 'creative_plan', { problem });
  if (plan.art_direction.concept_id !== plan.concept.concept_id) bad('ART_DIRECTION_IS_NOT_OF_THE_SELECTED_CONCEPT');
  if (plan.scene.art_direction_id !== plan.art_direction.art_direction_id) bad('SCENE_IS_NOT_OF_THE_ART_DIRECTION');
  if (plan.production_plan.composition_id !== plan.composition.composition_id) bad('PRODUCTION_PLAN_IS_NOT_OF_THE_COMPOSITION');
  const text = plan.composition.narrative_flow.filter((r) => r !== 'PRODUCT').sort();
  if (JSON.stringify(text) !== JSON.stringify([...plan.observation.approved_text_roles].sort())) bad('COMPOSITION_DROPS_OR_INVENTS_A_TEXT_ROLE');
  return plan;
}

const SPATIAL_FOR = Object.freeze({
  BESIDE: { START: 'PRODUCT_START_TEXT_END', END: 'PRODUCT_END_TEXT_START' },
  STAGGERED: { START: 'PRODUCT_START_TEXT_END', END: 'PRODUCT_END_TEXT_START' },
});
const NEGATIVE_FOR = Object.freeze({ START: 'START', END: 'END', TOP: 'TOP', BOTTOM: 'BOTTOM', SURROUNDING: 'SURROUNDING' });
const oneLineClip = (s, n = 300) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The fields of a canonical Creative Direction (the contract the existing runtime and its gates already consume), projected from the plan: the Brain does not bypass the C1 contracts, it feeds them.
 * @returns {{ concept, copy_intent, visual_intent, product_role, spatial_intent, negative_space_intent, hierarchy }}
 */
export function toDirectionFields(plan) {
  const { composition, concept, scene, art_direction: art } = plan;
  const { horizontal } = composition.product_anchor;
  const spatial = SPATIAL_FOR[composition.text_adjacency]?.[horizontal]
    ?? (composition.text_adjacency === 'ABOVE' ? 'PRODUCT_CENTER_TEXT_ABOVE' : (composition.text_adjacency === 'BELOW' ? 'PRODUCT_CENTER_TEXT_BELOW' : 'PRODUCT_CENTER_TEXT_BELOW'));
  const region = composition.negative_space_reservation[0]?.region;
  return {
    concept: oneLineClip(`${concept.central_idea}`),
    copy_intent: oneLineClip(plan.problem_frame.understood_immediately),
    visual_intent: oneLineClip(`${art.atmosphere}; ${art.lighting_intent}`),
    product_role: composition.visual_weight.PRODUCT === 'QUIET' ? 'SUPPORTING' : 'HERO',
    spatial_intent: spatial,
    negative_space_intent: region ? NEGATIVE_FOR[region] : 'NONE',
    hierarchy: composition.narrative_flow,
    scene_ref: scene.scene_id,
  };
}

/**
 * The canonical CreativeDirection of a plan (validated by the C1 contract itself): what the production runtime consumes when a Creative Brain plan directs a run.
 * @param {object} input { plan, ids: { merchant_id, brand_id, brief_ref }, assetRef, claimRefs }
 */
export function directionFromPlan({ plan, ids, assetRef, claimRefs = [] }) {
  const { scene_ref: _sceneRef, ...fields } = toDirectionFields(plan);
  return normalizeCreativeDirection({
    merchant_id: ids.merchant_id, brand_id: ids.brand_id, brief_ref: ids.brief_ref, ...fields, required_asset_refs: [assetRef], claim_refs: claimRefs, forbidden_transformations: [], evidence_refs: [],
  });
}

/**
 * @param {object} deps { ports: { frame, ideate, select, art_direct, compose } (each a language-model port, or one shared `complete`), ledger }
 */
export function createCreativeBrain({ ports, complete = null, ledger = null, bounds = null }) {
  const port = (name) => ports?.[name] ?? complete;
  const framer = createProblemFramer({ complete: port('frame') });
  const director = createConceptDirector({ complete: port('ideate'), ...(bounds ? { count: { min: bounds.concepts_per_round, max: bounds.concepts_per_round } } : {}) });
  // with bounds, the number of concept rounds is a budget for the whole life of this brain (plan and recovery together); without, each call may use up to MAX_CONCEPT_ROUNDS
  const roundLimit = bounds ? bounds.concept_rounds : MAX_CONCEPT_ROUNDS;
  let roundsUsed = 0;
  const selector = createConceptSelector({ complete: port('select') });
  const artDirector = createArtDirector({ complete: port('art_direct') });
  const planner = createCompositionPlanner({ complete: port('compose') });

  async function conceptRounds({ frame, rejected = [], refine = null }) {
    let against = [...rejected]; let toRefine = refine; const rounds = [];
    for (let round = 1; round <= roundLimit; round += 1) {
      if (bounds && roundsUsed >= roundLimit) break;
      roundsUsed += 1;
      const { concepts, meta: ideateMeta } = await director.ideate({ frame, rejected: against, refine: toRefine });
      ledgerRecord(ledger, DECISION.CONCEPT_ROUND, COMPONENT.CONCEPT_DIRECTOR, 'GENUINELY_DISTINCT_CONCEPTS_BEFORE_ANY_LAYOUT', { round, concept_ids: concepts.map((c) => c.concept_id), model: ideateMeta.model, request_id: ideateMeta.request_id });
      const { selection, evaluations, meta } = await selector.select({ frame, concepts });
      ledgerRecord(ledger, DECISION.CONCEPT_SELECTION, COMPONENT.CONCEPT_SELECTOR, 'CRITERION_WORDS_WITHOUT_A_SCORE', { round, outcome: selection.outcome, concept_id: selection.concept_id, decisions: selection.decisions.map((d) => [d.concept_id, d.decision]), reasons: selection.reasons, model: meta.model, request_id: meta.request_id });
      rounds.push({ round, concepts, selection, evaluations });
      if (selection.outcome === SELECTION.SELECT) return { status: 'SELECTED', concept: concepts.find((c) => c.concept_id === selection.concept_id), rounds };
      // the next round does not return to what was judged weak: rejected concepts are excluded, a promising one is refined
      if (selection.outcome === SELECTION.REFINE_CONCEPT) {
        const chosen = concepts.find((c) => c.concept_id === selection.concept_id);
        const ev = evaluations.find((e) => e.concept_id === chosen.concept_id);
        toRefine = { concept: chosen, refinements: ev.criteria.filter((c) => c.refinement).map((c) => c.refinement).slice(0, 4) };
        against = [...against, ...concepts.filter((c) => c.concept_id !== chosen.concept_id)];
      } else {
        toRefine = null;
        against = [...against, ...concepts];
      }
    }
    return { status: 'NO_CONCEPT_SELECTED', concept: null, rounds };
  }

  /** From a selected concept: art direction, composition, scene, production plan. */
  async function fromConcept({ observation, frame, concept, productAssetRef, artHints = [], composeHints = [], recovery = null, keep = {} }) {
    const art = keep.art_direction ? { art_direction: keep.art_direction, meta: { model: null, request_id: null } } : await artDirector.direct({ frame, concept, hints: artHints });
    if (!keep.art_direction) ledgerRecord(ledger, DECISION.ART_DIRECTION, COMPONENT.ART_DIRECTOR, 'SEMANTIC_ART_DIRECTION_OF_THE_SELECTED_CONCEPT', { art_direction_id: art.art_direction.art_direction_id, rationale: art.art_direction.rationale, model: art.meta.model, request_id: art.meta.request_id });
    const comp = keep.composition ? { composition: keep.composition, meta: { model: null, request_id: null } } : await planner.plan({ frame, concept, artDirection: art.art_direction, hints: composeHints, approvedRoles: approvedRolesOf(observation) });
    if (!keep.composition) ledgerRecord(ledger, DECISION.COMPOSITION_PLAN, COMPONENT.COMPOSITION_PLANNER, 'RELATIONAL_COMPOSITION_PLAN', { composition_id: comp.composition.composition_id, hero_relationship: comp.composition.hero_relationship, text_adjacency: comp.composition.text_adjacency, rationale: comp.composition.rationale, model: comp.meta.model, request_id: comp.meta.request_id });
    const scene = composeScene({ artDirection: art.art_direction, productAssetRef });
    ledgerRecord(ledger, DECISION.SCENE_SPEC, COMPONENT.SCENE_COMPOSER, 'SCENE_WITH_A_RESERVED_PRODUCT_INTEGRATION_ZONE', { scene_id: scene.scene_id, layers: scene.layers.length, protected_product: scene.protected_product.mode });
    const production = planProduction({ artDirection: art.art_direction, scene, composition: comp.composition, recovery });
    ledgerRecord(ledger, DECISION.PRODUCTION_PLAN, COMPONENT.PRODUCTION_STRATEGIST, 'CAPABILITIES_FROM_THE_ART_DIRECTION', { production_plan_id: production.production_plan_id, required: production.required.map((r) => r.capability), unsupported: production.unsupported.map((u) => u.capability), executable: production.executable });
    return { art_direction: art.art_direction, composition: comp.composition, scene, production_plan: production };
  }

  const assemble = (parts) => {
    const body = { ...parts };
    const plan = { plan_id: deriveId('plan', { ids: [parts.problem_frame.frame_id, parts.concept.concept_id, parts.art_direction.art_direction_id, parts.composition.composition_id, parts.scene.scene_id, parts.production_plan.production_plan_id] }), ...body };
    assertPlanCoherent(plan);
    plan.layout_choice = composeLayout({ plan: plan.composition });
    return deepFreeze(plan);
  };

  return Object.freeze({
    /** Concept rounds still available to this brain (only meaningful with bounds). */
    remainingConceptRounds: () => Math.max(0, roundLimit - roundsUsed),
    /** The first plan for a brief. Returns { status: 'PLANNED', plan } or { status: 'NO_CONCEPT_SELECTED', rounds } (nothing is produced from a round that selected nothing). */
    async plan({ brief, rejected = [] }) {
      const observation = observeBrief({ brief });
      ledgerRecord(ledger, DECISION.OBSERVATION, COMPONENT.CREATIVE_OBSERVER, 'DETERMINISTIC_READING_OF_THE_BRIEF', { approved_text_roles: observation.approved_text_roles, asset_origin: observation.asset_origin, claims: observation.claim_refs.length });
      const { frame, meta } = await framer.frame({ observation });
      ledgerRecord(ledger, DECISION.PROBLEM_FRAME, COMPONENT.PROBLEM_FRAMER, 'FRAME_BEFORE_IDEATION', { frame_id: frame.frame_id, rationale: frame.rationale, model: meta.model, request_id: meta.request_id });
      const picked = await conceptRounds({ frame, rejected });
      if (picked.status !== 'SELECTED') return deepFreeze({ status: picked.status, observation, problem_frame: frame, rounds: picked.rounds });
      const rest = await fromConcept({ observation, frame, concept: picked.concept, productAssetRef: brief.asset.ref });
      return { status: 'PLANNED', plan: assemble({ observation, problem_frame: frame, rounds: picked.rounds, concept: picked.concept, ...rest }) };
    },

    /**
     * After a candidate was critiqued: diagnose the kind of failure and recover accordingly.
     * @param {object} input { brief, plan, critique, conceptCritique, history: [{ concept_id, action }] }
     */
    async replan({ brief, plan, critique, conceptCritique = null, history = [] }) {
      const diagnosis = diagnoseRecovery({ critique, conceptCritique, history, concept_id: plan.concept.concept_id });
      ledgerRecord(ledger, DECISION.RECOVERY_DECISION, COMPONENT.CREATIVE_RECOVERY, 'RECOVERY_FROM_THE_CRITIC_EVIDENCE', { action: diagnosis.action, exhausted: diagnosis.exhausted, reasons: diagnosis.reasons.map((r) => `${r.group}:${r.dimension}=${r.outcome}`), reuse: diagnosis.reuse, redo: diagnosis.redo });
      if (diagnosis.action === 'NONE') return deepFreeze({ status: 'NOTHING_TO_RECOVER', diagnosis });
      const hints = [...(critique?.dimensions ?? []), ...(conceptCritique?.dimensions ?? [])].filter((d) => d.revision_hint && (d.outcome === 'FAIL' || d.outcome === 'REVIEW_REQUIRED')).map((d) => d.revision_hint);
      const { observation, problem_frame: frame } = plan;
      if (diagnosis.action === RECOVERY_ACTION.RECONCEPT) {
        const rejected = [plan.concept, ...history.map((h) => h.concept).filter(Boolean)];
        const picked = await conceptRounds({ frame, rejected });
        if (picked.status !== 'SELECTED') return deepFreeze({ status: picked.status, diagnosis, rounds: picked.rounds });
        const rest = await fromConcept({ observation, frame, concept: picked.concept, productAssetRef: brief.asset.ref, recovery: diagnosis });
        return { status: 'REPLANNED', diagnosis, plan: assemble({ observation, problem_frame: frame, rounds: picked.rounds, concept: picked.concept, ...rest }) };
      }
      const rest = await fromConcept({
        observation, frame, concept: plan.concept, productAssetRef: brief.asset.ref, recovery: diagnosis,
        artHints: diagnosis.action === RECOVERY_ACTION.REFINE ? hints : [],
        composeHints: diagnosis.action === RECOVERY_ACTION.RECOMPOSE ? hints : [],
        keep: diagnosis.action === RECOVERY_ACTION.REFINE ? { composition: plan.composition } : { art_direction: plan.art_direction },
      });
      return { status: 'REPLANNED', diagnosis, plan: assemble({ observation, problem_frame: frame, rounds: plan.rounds, concept: plan.concept, ...rest }) };
    },
  });
}
