import { substituteWordsIn } from '../creative-brain/substitutes.js';
import { deriveId } from '../creative-brain/validation.js';
import { FORMAT_RESOURCES } from '../creative-planning/index.js';
import { createCampaignBudget } from '../creative-campaign/budget.js';
import {
  GATE_REASON, LAYER_KIND, LAYER_SOURCE, PRODUCT_STATUS, PRODUCTION_STATUS,
} from './constants.js';
import { reassemble, recoverLockedCopy, sha256Text } from './copy-integrity.js';
import { evaluateProviderGate } from './gate.js';
import { detectSubstitutes, resolveProductIdentity } from './product-identity.js';
import { estimateProduction, reserveProduction } from './production-cost.js';
import {
  buildSceneSpec, plateRequest, propRequest, validateSceneSpec,
} from './scene-spec.js';
import { selectTool } from './capability-router.js';

// THE PARITY AUDIT OF THE PRODUCTION STAGES. Production is specification and gates, with no model in it, so there is no instruction to compare to a validator. The audit is therefore a MECHANICAL PROBE: it builds
// a valid sample scene with the real builders, proves that the validator accepts it, then breaks it once per rule and proves that the validator names exactly that rule. A rule the validator cannot name is a rule
// nobody enforces. The same is done for the substitute detection (the Attempt 12 scene), the budget, the text integrity, the capability routing and the provider gate.

const ART = {
  art_direction_id: 'cad_probe', atmosphere: 'A quiet morning workshop.', material_language: 'worn wood and matte paper.', lighting_intent: 'soft side light.', forbidden_decorative_noise: ['confetti'],
};
const sample = () => {
  const identity = resolveProductIdentity({
    brief: { ids: { product_ref: 'product://probe' }, asset: { ref: 'asset://probe', sha256: 'a'.repeat(40) }, public_facts: { product: 'Coque personnalisée pour téléphone' }, identity_annotations: { outline: [[0, 0], [1, 0], [1, 1]] } },
  });
  const piece = { piece_id: 'pce_probe', unit_ref: 'copy://probe', origin: 'LOCKED', start: 0, end: 5, text: 'Bonjour' };
  const contentAsset = { asset_id: 'ast_probe', canvas: { width: 1080, height: 1350, unit: 'px' }, slots: [{ role: 'HEADLINE', text: 'Bonjour', chars: 7, words: 1, pieces: [piece] }] };
  const assetPlan = {
    asset_plan_id: 'apl_probe', index: 0, narrative_role: 'HOOK', composition_intent: 'WIDE_ESTABLISHING', imagery_intent: 'PRODUCT_IN_CONTEXT', crop_scale: 'WIDE', density: { density_class: 'LOW' }, imagery_brief: null,
  };
  const approvedWords = new Set();
  const plate = plateRequest({ artDirection: ART, canvas: contentAsset.canvas, variant: 'WIDE', identity, approvedWords });
  const mk = (zone, element) => propRequest({ element: { element, zone }, artDirection: ART, identity, approvedWords });
  const props = [mk('MIDGROUND', 'a brass scale'), mk('FOREGROUND', 'a folded cloth')];
  const scene = buildSceneSpec({
    chain: {
      request_ref: 'req:probe', campaign_id: 'cmp_probe', content_plan_id: 'cpl_probe', lane_id: 'L0', art_direction_id: ART.art_direction_id, concept_id: 'cnc_probe', frame_id: 'cpf_probe',
    },
    assetPlan, contentAsset, identity, plate: plate.request, props, resource: FORMAT_RESOURCES[0], feasibility: { fits: true, reasons: [], basis: 'MEASURED_CAPACITY_ONLY' },
  });
  const shared = new Map([plate.request, ...props.map((p) => p.request)].map((r) => [r.request_key, r]));
  return {
    identity, scene, shared, contentAsset, approvedWords,
  };
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const PROBES = Object.freeze({
  EXACTLY_ONE_PRODUCT_LAYER_AND_IT_IS_THE_REAL_ASSET: (s) => { s.layers = s.layers.filter((l) => l.kind !== LAYER_KIND.PRODUCT); },
  NO_GENERATED_LAYER_IS_THE_PRODUCT: (s) => { const l = s.layers.find((x) => x.source === LAYER_SOURCE.GENERATED); l.product_ref = 'product://probe'; },
  Z_ORDER_IS_THE_BAND_ORDER: (s) => { const p = s.layers.find((l) => l.kind === LAYER_KIND.PRODUCT); p.z = 0; },
  TEXT_LAYERS_FOLLOW_FROM_THE_PLANNED_PIECES: (s) => { const t = s.layers.find((l) => l.kind === LAYER_KIND.TEXT); t.text = 'Bonjour!'; s.text_layers[0].text = 'Bonjour!'; },
  FOREGROUND_OVERLAP_IS_BOUNDED: (s) => { s.layers.find((l) => l.kind === LAYER_KIND.PROP_FOREGROUND).overlap.max_share_of_product = 0.9; },
  EVERY_GENERATED_LAYER_HAS_ITS_REQUEST: (s) => { s.layers.find((l) => l.source === LAYER_SOURCE.GENERATED).request_key = 'prk_missing'; },
  PROVENANCE_IS_COMPLETE_FROM_THE_REQUEST_TO_THE_LAYERS: (s) => { s.provenance.product.sha256 = 'b'.repeat(40); },
  EVERY_TOOL_IS_SELECTED_AND_USED_ALONE: (s) => { s.tools[0].execution_policy = 'ANY_TOOL'; },
});
const SHARED_PROBES = Object.freeze({
  A_GENERATED_REQUEST_CARRIES_NO_PRODUCT_PIXEL: (shared) => { for (const r of shared.values()) r.carries_input_asset = true; },
  NO_GENERATED_LAYER_CAN_STAND_IN_FOR_THE_PRODUCT: (shared) => { for (const r of shared.values()) if (r.kind === 'PROP') r.model_text = ['a bare polymer shell']; },
  NO_UNSUPPORTED_CLAIM_OR_DIMENSION_IN_A_LAYER: (shared) => { for (const r of shared.values()) if (r.kind === 'PLATE') r.model_text = ['A guaranteed 40 cm scene']; },
});

export const PRODUCTION_RULES = Object.freeze([...Object.keys(PROBES), ...Object.keys(SHARED_PROBES)]);

const ATTEMPT_12 = Object.freeze([
  'A bare polymer shell resting on a worn wooden counter, half its surface still untouched',
  'A faint human silhouette emerging in wet ink on the shell\'s surface',
]);

/** Each probe: [name, rule it enforces, true when the rule holds]. */
function probes() {
  const out = [];
  const base = sample();
  const ctx = (extra = {}) => ({
    identity: base.identity, sharedLayers: base.shared, approvedWords: base.approvedWords, contentAsset: base.contentAsset, ...extra,
  });
  out.push(['A valid sample scene breaks no rule', 'SAMPLE_IS_VALID', validateSceneSpec(base.scene, ctx()).length === 0 && base.scene.status === PRODUCTION_STATUS.SPECIFIED]);
  for (const [rule, mutate] of Object.entries(PROBES)) { const s = clone(base.scene); mutate(s); out.push([`Breaking ${rule}`, rule, validateSceneSpec(s, ctx()).includes(rule)]); }
  for (const [rule, mutate] of Object.entries(SHARED_PROBES)) { const shared = new Map([...base.shared].map(([k, v]) => [k, clone(v)])); mutate(shared); out.push([`Breaking ${rule}`, rule, validateSceneSpec(base.scene, ctx({ sharedLayers: shared })).includes(rule)]); }
  // the substitute detection knows the Attempt 12 scene, and the product it is relative to
  out.push(['The words of Attempt 12 are refused by the Brain lexicon', 'SUBSTITUTE_LEXICON', ATTEMPT_12.every((t) => substituteWordsIn(t).length > 0)]);
  out.push(['The words of Attempt 12 are refused for this product', 'SUBSTITUTE_RELATIVE_TO_THE_PRODUCT', ATTEMPT_12.every((t) => detectSubstitutes({ text: t, identity: base.identity }).length > 0)]);
  out.push(['A benign element is accepted', 'SUBSTITUTE_DOES_NOT_OVERBLOCK', detectSubstitutes({ text: 'a worn wooden counter and a brass scale', identity: base.identity }).length === 0]);
  // the product identity is explicit when it cannot be verified
  const missing = resolveProductIdentity({ brief: { ids: {}, asset: {} } });
  out.push(['A product with no asset is MISSING', 'PRODUCT_IDENTITY_IS_EXPLICIT', missing.status === PRODUCT_STATUS.MISSING]);
  const blocked = buildSceneSpec({
    chain: { ...base.scene.provenance, request_ref: 'r' }, assetPlan: { asset_plan_id: 'apl_x', index: 0, narrative_role: 'HOOK', composition_intent: 'WIDE_ESTABLISHING', imagery_intent: 'PRODUCT_IN_CONTEXT', crop_scale: 'WIDE', density: { density_class: 'LOW' } }, contentAsset: base.contentAsset, identity: missing, plate: null, props: [], resource: FORMAT_RESOURCES[0], feasibility: null,
  });
  out.push(['A scene of an unverified product is INTENT_ONLY with no layer', 'NO_REPLACEMENT_FOR_A_MISSING_PRODUCT', blocked.status === PRODUCTION_STATUS.INTENT_ONLY && blocked.layers.length === 0]);
  // the text is recoverable and a tampered text is seen
  const sources = new Map([['copy://probe', 'Bonjour le monde']]);
  const layers = [{ pieces: [{ piece_id: 'p1', unit_ref: 'copy://probe', origin: 'LOCKED', start: 0, end: 7, text_sha256: sha256Text('Bonjour') }] }, { pieces: [{ piece_id: 'p2', unit_ref: 'copy://probe', origin: 'LOCKED', start: 8, end: 16, text_sha256: sha256Text('le monde') }] }];
  out.push(['Locked copy is rebuilt byte for byte from its pieces', 'LOCKED_COPY_IS_RECOVERABLE', recoverLockedCopy({ layers, sources }).ok && reassemble('Bonjour le monde', layers.flatMap((l) => l.pieces)) === 'Bonjour le monde']);
  const tampered = [layers[0], { pieces: [{ ...layers[1].pieces[0], text_sha256: sha256Text('le monde!') }] }];
  out.push(['A tampered locked piece is detected', 'LOCKED_COPY_TAMPERING_IS_SEEN', !recoverLockedCopy({ layers: tampered, sources }).ok]);
  // the budget is a hard ceiling that is never reduced to fit
  const estimate = estimateProduction({ sharedStagesEur: 0.3, assets: 7, layers: [{ request_key: 'k', size_class: 'ABOVE_1024', candidates: 2 }] });
  out.push(['A production over the ceiling is refused, not shrunk', 'THE_BUDGET_IS_A_HARD_CEILING', reserveProduction({ estimate, ceilingEur: 0.5 }).ok === false && reserveProduction({ estimate, ceilingEur: 5 }).ok === true]);
  out.push(['The reservation ledger refuses past the ceiling', 'RESERVE_BEFORE_THE_COST', (() => { const b = createCampaignBudget({ ceilingEur: 1 }); b.reserve('a', 1); try { b.reserve('b', 0.01); return false; } catch { return true; } })()]);
  // the routing names the tool, the candidates it passed over, and gives no fallback
  const routed = selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PUBLIC', sideMax: 1350 });
  out.push(['A capability is routed to one explicit tool and passes over the others', 'THE_TOOL_IS_CHOSEN_IN_THE_PLAN', routed.selected?.tool_id === 'text-to-image/primary' && routed.execution_policy === 'ONLY_THE_SELECTED_TOOL' && routed.candidates.length === 2]);
  out.push(['A capability with no admissible tool has none, not a guess', 'NO_TOOL_IS_AN_EXPLICIT_STATE', selectTool('ENVIRONMENT_PLATE_GENERATION', { dataClass: 'PRIVATE', sideMax: 1350 }).selected === null]);
  // the provider gate fails closed
  const gate = evaluateProviderGate({ production: null, readiness: null });
  out.push(['The provider gate fails closed and never calls a provider', 'THE_PROVIDER_GATE_FAILS_CLOSED', gate.status === 'NOT_READY' && gate.provider_calls === 0 && gate.reasons.includes(GATE_REASON.PIPELINE_NOT_READY)]);
  return out;
}

export const PRODUCTION_STAGES = Object.freeze([
  { stage: 'PRODUCT_IDENTITY', model: false, derivation: 'resolveProductIdentity(brief, bytes): the product is a pinned asset or the state is explicitly MISSING, AMBIGUOUS or UNSUPPORTED', validator: 'src/creative-production/product-identity.js#resolveProductIdentity' },
  { stage: 'SUBSTITUTE_DETECTION', model: false, derivation: 'detectSubstitutes(text, identity): the lexicon of the Brain, the family of the product and the words that name it', validator: 'src/creative-production/product-identity.js#detectSubstitutes' },
  { stage: 'CAPABILITY_ROUTING', model: false, derivation: 'selectTool(capability, constraints): ranked candidates declared, one chosen and recorded, none used as a fallback', validator: 'src/creative-production/capability-router.js#selectTool' },
  { stage: 'SCENE_SPEC', model: false, derivation: 'buildSceneSpec(...): the layers, their z-order, their requests, their provenance; a scene that cannot be specified is BLOCKED or INTENT_ONLY', validator: 'src/creative-production/scene-spec.js#validateSceneSpec' },
  { stage: 'TEXT_INTEGRITY', model: false, derivation: 'textLayersOf, checkTextFeasibility and recoverLockedCopy: the copy is never changed to fit and is recoverable byte for byte', validator: 'src/creative-production/copy-integrity.js#recoverLockedCopy' },
  { stage: 'PRODUCTION_COST', model: false, derivation: 'estimateProduction and reserveProduction: every line reserved before it is incurred against a hard ceiling', validator: 'src/creative-production/production-cost.js#reserveProduction' },
  { stage: 'PRODUCTION_STATE', model: false, derivation: 'the production planner: nodes stored with the hash of their inputs, reused only when it is unchanged', validator: 'src/creative-production/production-planner.js#createProductionPlanner' },
  { stage: 'LAYER_COMPOSITOR', model: false, derivation: 'composeLayers: pixel-exact z-ordered composition of the raster layers with measured, bounded overlap', validator: 'src/creative-production/compositor.js#composeLayers' },
  { stage: 'PROVIDER_GATE', model: false, derivation: 'evaluateProviderGate: fails closed; never calls a provider', validator: 'src/creative-production/gate.js#evaluateProviderGate' },
]);

export function auditProductionParity() {
  const rows = []; const failures = [];
  for (const [name, rule, ok] of probes()) {
    rows.push({ stage: 'PROBE', kind: 'PROBE', path: rule, rule: name, instruction: null, validator: 'src/creative-production', stated: ok });
    if (!ok) failures.push(`${rule}: ${name} did not hold`);
  }
  const unnamed = PRODUCTION_RULES.filter((r) => !rows.some((x) => x.path === r));
  for (const r of unnamed) failures.push(`${r}: the rule has no probe`);
  const stages = PRODUCTION_STAGES.map((s) => ({ stage: s.stage, model: false, derivation: s.derivation }));
  for (const s of PRODUCTION_STAGES) rows.push({ stage: s.stage, kind: 'DETERMINISTIC', path: s.stage, rule: s.derivation, instruction: null, validator: s.validator, stated: null });
  return { ready: failures.length === 0, stages, rows, failures };
}

export function renderProductionContractMatrix(audit = auditProductionParity()) {
  const lines = ['# Creative production contract matrix', '', 'Generated by `auditProductionParity()` from the real builders and validators. Do not edit by hand. Production has no model stage: every rule is proved by a probe that breaks it and checks that the validator names it.', ''];
  lines.push('## Probes', '', '| rule | probe | holds |', '|---|---|---|');
  for (const r of audit.rows.filter((x) => x.kind === 'PROBE')) lines.push(`| ${r.path} | ${r.rule} | ${r.stated ? 'yes' : 'NO'} |`);
  lines.push('');
  for (const s of audit.stages) lines.push(`## ${s.stage}`, '', `No model answer: ${s.derivation}`, '');
  lines.push(audit.ready ? 'PARITY: every production rule is enforced by a validator that names it, and every probe holds.' : `PARITY FAILURES:\n${audit.failures.map((f) => `- ${f}`).join('\n')}`);
  return `${lines.join('\n')}\n`;
}

export const productionRulesId = () => deriveId('prl', PRODUCTION_RULES);
