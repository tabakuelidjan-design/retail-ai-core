import { substituteWordsIn } from '../creative-brain/substitutes.js';
import { deriveId } from '../creative-brain/validation.js';
import { FORMAT_RESOURCES } from '../creative-planning/index.js';
import { createCampaignBudget } from '../creative-campaign/budget.js';
import {
  GATE_REASON, LAYER_KIND, LAYER_SOURCE, PRODUCT_STATUS, PRODUCTION_STATUS,
} from './constants.js';
import { reassemble, recoverLockedCopy, sha256Text } from './copy-integrity.js';
import { encodePng } from '../creative-intelligence/png-encode.js';
import { describeLayeredRuntime } from '../creative-runtime/layered-runtime.js';
import { evaluateProviderGate, productionReadinessLevel } from './gate.js';
import { matteProp } from './prop-matte.js';
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
export const productionSample = () => {
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

/** A 64 x 64 prop fixture: a plain ground with the given rectangles (x0, y0, x1, y1, grey). */
const fixtureProp = (rects) => {
  const pixels = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i += 1) pixels.set([230, 226, 218, 255], i * 4);
  for (const [x0, y0, x1, y1, v] of rects) for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) pixels.set([v, v, v, 255], (y * 64 + x) * 4);
  return encodePng({ width: 64, height: 64, pixels });
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
  const base = productionSample();
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
  // the layered production is executable from the runtime: the stages are really called, and there is no single-image fallback
  const runtime = describeLayeredRuntime();
  out.push(['The creative runtime executes a layered scene through every stage', 'THE_LAYERED_RUNTIME_IS_REACHABLE', runtime.wired === true && runtime.entry === 'runLayeredCreative' && Object.values(runtime.stages).every(Boolean) && productionReadinessLevel({ parityOk: true, runtime }).runtime_executable === true]);
  out.push(['The layered runtime has no fallback to the single-image generator', 'THE_LAYERED_RUNTIME_NEVER_FALLS_BACK', runtime.single_image_fallback === false && productionReadinessLevel({ parityOk: true, runtime: { ...runtime, single_image_fallback: true } }).runtime_executable === false]);
  out.push(['A runtime with a missing stage is not reported executable', 'AN_UNWIRED_STAGE_IS_NOT_REPORTED_AS_WIRED', productionReadinessLevel({ parityOk: true, runtime: { ...runtime, stages: { ...runtime.stages, compositor: false } } }).runtime_executable === false && evaluateProviderGate({ production: null, readiness: null, runtime: { ...runtime, wired: false } }).reasons.includes(GATE_REASON.COMPOSITOR_NOT_WIRED_TO_THE_RUNTIME)]);
  // a generated prop is untrusted: one object on a plain ground passes, a second object or an object off the frame does not
  const single = matteProp({ png: fixtureProp([[20, 20, 44, 44, 60]]) });
  const two = matteProp({ png: fixtureProp([[8, 20, 22, 44, 60], [40, 20, 54, 44, 60]]) });
  const off = matteProp({ png: fixtureProp([[0, 10, 40, 50, 60]]) });
  out.push(['A prop alone on a plain ground is cut out', 'A_GENERATED_PROP_IS_CUT_OUT_ONLY_FROM_A_PLAIN_GROUND', single.ok === true && single.width === 24 && single.height === 24]);
  out.push(['A second object or an object off the frame refuses the prop', 'A_BAD_PROP_IS_REFUSED_BEFORE_COMPOSITION', two.ok === false && two.reasons.includes('MORE_THAN_ONE_OBJECT') && off.ok === false && off.reasons.includes('THE_OBJECT_TOUCHES_THE_FRAME')]);
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
  { stage: 'PROP_MATTE', model: false, derivation: 'matteProp: a generated prop is cut out of its plain ground or refused with the measurement that failed', validator: 'src/creative-production/prop-matte.js#matteProp' },
  { stage: 'LAYERED_RUNTIME', model: false, derivation: 'runLayeredCreative: a specified scene is executed end to end through the gates of the single-image runtime; only the selected tool runs; a stop names its replanning', validator: 'src/creative-runtime/layered-runtime.js#describeLayeredRuntime' },
  { stage: 'PROVIDER_GATE', model: false, derivation: 'evaluateProviderGate: fails closed; never calls a provider', validator: 'src/creative-production/gate.js#evaluateProviderGate' },
]);

/** The rules of the layered runtime, a component of its own in the combined readiness gate (the probes are the same ones the production audit runs). */
export const LAYERED_RUNTIME_RULES = Object.freeze([
  'THE_LAYERED_RUNTIME_IS_REACHABLE', 'THE_LAYERED_RUNTIME_NEVER_FALLS_BACK', 'AN_UNWIRED_STAGE_IS_NOT_REPORTED_AS_WIRED', 'A_GENERATED_PROP_IS_CUT_OUT_ONLY_FROM_A_PLAIN_GROUND', 'A_BAD_PROP_IS_REFUSED_BEFORE_COMPOSITION',
]);
const LAYERED_RUNTIME_STAGES = Object.freeze(['PROP_MATTE', 'LAYERED_RUNTIME']);

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

export function auditLayeredRuntimeParity() {
  const all = auditProductionParity();
  const rows = all.rows.filter((r) => (r.kind === 'PROBE' && LAYERED_RUNTIME_RULES.includes(r.path)) || LAYERED_RUNTIME_STAGES.includes(r.stage));
  const failures = all.failures.filter((f) => LAYERED_RUNTIME_RULES.some((r) => f.startsWith(`${r}:`)));
  for (const rule of LAYERED_RUNTIME_RULES) if (!rows.some((r) => r.path === rule)) failures.push(`${rule}: the rule has no probe`);
  return { ready: failures.length === 0, stages: all.stages.filter((s) => LAYERED_RUNTIME_STAGES.includes(s.stage)), rows, failures };
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
