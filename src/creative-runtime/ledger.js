// The decision ledger of a creative run. Every creative or production decision is recorded WITH the Nordla component that made it, the rule or evidence it rests on,
// and its outcome. A decision made by a person (or by "manual steering") has no valid component identity here: the ledger refuses it, so a run that needs a human
// choice cannot present itself as an autonomous Nordla run. The ledger is plain data, with no media, no prompt text and no secret.

export const COMPONENT = Object.freeze({
  PRODUCT_ASSET_ANALYST: 'nordla:product-asset-analyst@1',
  CREATIVE_DIRECTOR: 'nordla:creative-director@1',
  APPROVED_COPY_AGENT: 'nordla:approved-copy-agent@1',
  VISUAL_PRODUCTION_DIRECTOR: 'nordla:visual-production-director@1',
  LOCAL_PRODUCT_SEGMENTER: 'nordla:local-product-segmenter@1',
  PROVIDER_REQUEST_BUILDER: 'nordla:provider-request-builder@1',
  LAYOUT_PLANNER: 'nordla:layout-planner@1',
  LAYOUT_ENGINE: 'nordla:layout-constraint-engine@1',
  ENVIRONMENT_SUITABILITY_GATE: 'nordla:environment-suitability-gate@1',
  TYPOGRAPHY_RULES: 'nordla:typography-rules@1',
  SHADOW_RULE: 'nordla:contact-shadow-rule@1',
  RENDERER: 'nordla:deterministic-renderer@1',
  IDENTITY_FIDELITY_GATE: 'nordla:identity-fidelity-gate@1',
  PREFLIGHT: 'nordla:creative-preflight@1',
  BRAND_GUARDIAN: 'nordla:brand-guardian@1',
  REVISION_DIRECTOR: 'nordla:revision-director@1',
  CREATIVE_OBSERVER: 'nordla:creative-observer@1',
  PROBLEM_FRAMER: 'nordla:problem-framer@1',
  CONCEPT_DIRECTOR: 'nordla:concept-director@1',
  CONCEPT_SELECTOR: 'nordla:concept-selector@1',
  ART_DIRECTOR: 'nordla:art-director@1',
  SCENE_COMPOSER: 'nordla:scene-composer@1',
  COMPOSITION_PLANNER: 'nordla:composition-planner@1',
  PRODUCTION_STRATEGIST: 'nordla:production-strategist@1',
  CREATIVE_RECOVERY: 'nordla:creative-recovery@1',
});

export const DECISION = Object.freeze({
  PRODUCT_PRESERVATION_MODE: 'PRODUCT_PRESERVATION_MODE',
  SEGMENTATION: 'SEGMENTATION',
  CREATIVE_DIRECTION: 'CREATIVE_DIRECTION',
  COPY_SELECTION: 'COPY_SELECTION',
  BACKGROUND_STRATEGY: 'BACKGROUND_STRATEGY',
  PROVIDER_REQUEST_CONSTRUCTION: 'PROVIDER_REQUEST_CONSTRUCTION',
  ENVIRONMENT_SUITABILITY: 'ENVIRONMENT_SUITABILITY',
  ENVIRONMENT_CANDIDATE: 'ENVIRONMENT_CANDIDATE', // one image of a bounded set for ONE scene, with its own measurement
  LAYOUT_RECIPE: 'LAYOUT_RECIPE',
  PRODUCT_PLACEMENT: 'PRODUCT_PLACEMENT',
  TYPOGRAPHY_PLACEMENT: 'TYPOGRAPHY_PLACEMENT',
  TEXT_STYLE: 'TEXT_STYLE',
  SHADOW: 'SHADOW',
  FIDELITY: 'FIDELITY',
  PREFLIGHT: 'PREFLIGHT',
  BRAND_GUARDIAN: 'BRAND_GUARDIAN',
  REVISION_DIRECTION: 'REVISION_DIRECTION',
  DIRECTION_REFUSED: 'DIRECTION_REFUSED',
  OBSERVATION: 'OBSERVATION',
  PROBLEM_FRAME: 'PROBLEM_FRAME',
  CONCEPT_ROUND: 'CONCEPT_ROUND',
  CONCEPT_SELECTION: 'CONCEPT_SELECTION',
  ART_DIRECTION: 'ART_DIRECTION',
  SCENE_SPEC: 'SCENE_SPEC',
  COMPOSITION_PLAN: 'COMPOSITION_PLAN',
  PRODUCTION_PLAN: 'PRODUCTION_PLAN',
  RECOVERY_DECISION: 'RECOVERY_DECISION',
});

const KNOWN = new Set(Object.values(COMPONENT));
const DECISIONS = new Set(Object.values(DECISION));

export class LedgerError extends Error {
  constructor(message) { super(message); this.name = 'LedgerError'; this.code = 'DECISION_NOT_ATTRIBUTABLE_TO_A_NORDLA_COMPONENT'; }
}

export function createDecisionLedger() {
  const rows = [];
  return Object.freeze({
    record({ decision, decided_by: decidedBy, rule = null, basis = [], outcome = {} }) {
      if (!DECISIONS.has(decision)) throw new LedgerError(`unknown decision: ${decision}`);
      if (!KNOWN.has(decidedBy)) throw new LedgerError(`the decision ${decision} has no Nordla component: ${decidedBy}`);
      const row = Object.freeze({ seq: rows.length + 1, decision, decided_by: decidedBy, rule, basis: Object.freeze([...basis]), outcome: Object.freeze(JSON.parse(JSON.stringify(outcome))) });
      rows.push(row);
      return row;
    },
    entries: () => [...rows],
    of: (decision) => rows.filter((r) => r.decision === decision),
    /** decision -> deciding component(s), for the final report */
    attribution: () => Object.fromEntries([...new Set(rows.map((r) => r.decision))].map((d) => [d, [...new Set(rows.filter((r) => r.decision === d).map((r) => r.decided_by))]])),
  });
}

/** The decisions that must all be present, each with a Nordla component, for a run to claim "no manual creative steering". */
export const REQUIRED_DECISIONS = Object.freeze([
  DECISION.PRODUCT_PRESERVATION_MODE, DECISION.SEGMENTATION, DECISION.CREATIVE_DIRECTION, DECISION.BACKGROUND_STRATEGY, DECISION.PROVIDER_REQUEST_CONSTRUCTION,
  DECISION.LAYOUT_RECIPE, DECISION.PRODUCT_PLACEMENT, DECISION.ENVIRONMENT_SUITABILITY, DECISION.TYPOGRAPHY_PLACEMENT, DECISION.FIDELITY, DECISION.BRAND_GUARDIAN,
]);

/**
 * `manual_creative_steering` is NONE when every recorded decision belongs to a Nordla component (the ledger cannot hold another kind), and the run's completeness is a separate
 * fact: a run that stopped early has simply not reached some decisions (`decisions_not_reached`), which is not a manual decision.
 */
export function manualSteeringReport(ledger) {
  const present = new Set(ledger.entries().map((e) => e.decision));
  const notReached = REQUIRED_DECISIONS.filter((d) => !present.has(d));
  const foreign = ledger.entries().filter((e) => !KNOWN.has(e.decided_by));
  return Object.freeze({
    manual_creative_steering: foreign.length === 0 ? 'NONE' : 'NORDLA_CREATIVE_RUNTIME_INCOMPLETE',
    run_complete: notReached.length === 0,
    decisions_not_reached: notReached,
    missing_decisions: notReached,
    attribution: ledger.attribution(),
  });
}
