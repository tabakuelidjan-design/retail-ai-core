import { describeMaskedEditCapability, requestMaskedEdit, validateMaskedEditRequest } from './masked-edit.js';
import { createRefineMemory } from './memory.js';
import {
  DEFECT_KIND, MASKED_EDIT, REFINE_POLICY, REPAIR_BLOCK, REPAIR_SCOPE, REPAIR_SCOPES, UPSTREAM_NODES,
} from './constants.js';
import { createDefectRegion } from './defects.js';
import { planRepair } from './planner.js';

// THE PARITY AUDIT OF THE REFINE. The refine is deterministic planning and gates, with no model in it, so there is no instruction to compare to a validator. The audit is a MECHANICAL PROBE, as for the layered
// production: it builds a valid sample artifact, proves that the planner plans a legal repair of it, then breaks each rule once and proves that the planner REFUSES with the code of that rule. A rule the
// planner cannot name is a rule nobody enforces. (The rules of the executor, checked against a real run, are proved by the end-to-end tests RF-1 to RF-24.)

const h = (c) => c.repeat(40);
/** A valid layered artifact (the shape the layered runtime returns): a plate, a midground prop, the real product, a foreground prop, locked text, its style and the composites. */
export const refineSample = () => ({
  schema: 'layered-artifact@1',
  scene_id: 'scn_probe',
  canvas: { width: 1080, height: 1350 },
  tools: { selected: [], executed: { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary', PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/primary' } },
  nodes: {
    plate: { node_id: 'PLATE:plk_probe', request_key: 'plk_probe', candidate_sha256: h('1'), box: { x: 0, y: 0, width: 1080, height: 1350 } },
    props: [
      { node_id: 'PROP:lyr_mid', layer_id: 'lyr_mid', kind: 'PROP_MIDGROUND', request_key: 'prk_mid', candidate_sha256: h('2'), placed_sha256: h('3'), box: { x: 40, y: 900, width: 150, height: 200 }, z: 20 },
      { node_id: 'PROP:lyr_fg', layer_id: 'lyr_fg', kind: 'PROP_FOREGROUND', request_key: 'prk_fg', candidate_sha256: h('4'), placed_sha256: h('5'), box: { x: 700, y: 900, width: 140, height: 190 }, z: 40 },
    ],
    product: { node_id: 'PRODUCT', cutout_sha256: h('6'), placed_sha256: h('7'), rect: { x: 300, y: 400, width: 480, height: 700 } },
    text: [{ node_id: 'TEXT:HEADLINE', role: 'HEADLINE', layer_id: 'lyr_text', text_sha256: h('8'), geometry: { x: 60, y: 100, width: 960, height: 200 } }],
    text_style: [{ node_id: 'TEXT_STYLE:HEADLINE', role: 'HEADLINE', color: '#111111', font_size: 64, plate: false, style_sha256: h('9') }],
    composite: { base_sha256: h('a'), stack_sha256: h('b') },
    render: { png_sha256: h('c') },
  },
  protected_regions: [],
});

const d = (kind, extra = {}) => createDefectRegion({ kind, ...extra });
const plan = (defects, extra = {}) => planRepair({ artifact: refineSample(), defects, ...extra });

export const REFINE_STAGES = Object.freeze([
  { stage: 'REFINE_PLANNER', model: false, derivation: 'the smallest valid repair is derived from the defects, the layer dependency map and the working memory; no model is asked' },
  { stage: 'REFINE_EXECUTOR', model: false, derivation: 'the repair re-runs the layered runtime on a copy of the shared layers and is checked node by node against its own plan' },
  { stage: 'MASKED_EDIT_CAPABILITY', model: false, derivation: 'an interface with a request contract and checks; no provider is connected and nothing is simulated' },
]);

/** Each probe: [what is done, the rule it enforces, true when the rule holds]. */
function probes() {
  const out = [];
  const ok = plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })]);
  out.push(['A valid sample artifact has a legal, planned repair', 'SAMPLE_IS_REPAIRABLE', ok.status === 'PLANNED' && ok.scope.length === 1 && ok.scope[0] === REPAIR_SCOPE.PROP_REPAIR]);
  out.push(['A change to the real product pixels is refused', 'THE_REAL_PRODUCT_IS_NEVER_REPAIRED',
    plan([d(DEFECT_KIND.PRODUCT_PIXELS)]).block?.code === REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS && plan([d(DEFECT_KIND.PROP_UNUSABLE, { region: { x: 500, y: 700, width: 8, height: 8 } })]).block?.code === REPAIR_BLOCK.REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS]);
  out.push(['A change to locked copy is refused', 'LOCKED_COPY_IS_NEVER_CHANGED',
    plan([d(DEFECT_KIND.COPY_CHANGE)]).block?.code === REPAIR_BLOCK.REPAIR_WOULD_CHANGE_LOCKED_COPY && plan([d(DEFECT_KIND.PROP_UNUSABLE, { node_id: 'TEXT:HEADLINE' })]).block?.code === REPAIR_BLOCK.REPAIR_WOULD_CHANGE_LOCKED_COPY]);
  const everything = plan([d(DEFECT_KIND.PLATE_UNSUITABLE), d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' }), d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' })]);
  out.push(['No scope regenerates the whole creative, and a plan that regenerates every generated layer is refused', 'NO_SCOPE_REGENERATES_THE_CREATIVE',
    REPAIR_SCOPES.length === 5 && REPAIR_SCOPES.every((s) => !/FULL|ALL|REGENERATE|CONCEPT|ART_DIRECTION/.test(s)) && everything.block?.code === REPAIR_BLOCK.REPAIR_SCOPE_TOO_BROAD && REFINE_POLICY.max_regenerated_layers === 2]);
  const layerPlans = [plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' })]), plan([d(DEFECT_KIND.PLATE_UNSUITABLE)]), plan([d(DEFECT_KIND.TEXT_ILLEGIBLE)]), plan([d(DEFECT_KIND.COMPOSITE_STALE)]), plan([d(DEFECT_KIND.PROP_NO_ROOM, { layer_id: 'lyr_mid' })])];
  out.push(['A layer repair never invalidates the upstream reasoning, the product or the locked text', 'UPSTREAM_AND_PROTECTED_NODES_ARE_NEVER_INVALIDATED',
    layerPlans.every((p) => p.status === 'PLANNED' && p.invalidated.every((id) => !UPSTREAM_NODES.includes(id) && id !== 'PRODUCT' && !id.startsWith('TEXT:')) && p.reused.includes('PRODUCT') && p.reused.includes('TEXT:HEADLINE'))]);
  const up = plan([d(DEFECT_KIND.UPSTREAM_CONCEPT)]);
  out.push(['A defect that originates upstream is a replan request, answered by no layer repair', 'AN_UPSTREAM_DEFECT_IS_A_REPLAN', up.status === 'REPLAN_REQUIRED' && up.steps.length === 0 && up.replan.upstream_nodes.includes('ART_DIRECTION')]);
  out.push(['A scope that does not exist, or is not allowed, is refused', 'THE_SCOPE_IS_DECLARED',
    plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })], { allowedScopes: ['FULL_REGENERATION'] }).block?.code === REPAIR_BLOCK.REPAIR_SCOPE_INVALID && plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })], { allowedScopes: [REPAIR_SCOPE.PLATE_REPAIR] }).block?.code === REPAIR_BLOCK.REPAIR_SCOPE_INVALID]);
  out.push(['The owner of a defect is never guessed: an unknown layer, or no name among several props', 'THE_OWNER_OF_A_DEFECT_IS_NEVER_GUESSED',
    plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_nope' })]).block?.code === REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE && plan([d(DEFECT_KIND.PROP_UNUSABLE)]).block?.code === REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE]);
  const memory = createRefineMemory(); const ladder = [];
  for (let i = 0; i < 4; i += 1) {
    const p = plan([d(DEFECT_KIND.PROP_NO_ROOM, { layer_id: 'lyr_mid' })], { memory });
    ladder.push(p.status === 'PLANNED' ? p.steps[0].action.type : p.block.code);
    if (p.status === 'PLANNED') memory.record('scn_probe', { plan_id: p.plan_id, fingerprint: p.fingerprint, steps: p.steps.map((s) => ({ scope: s.scope, target: s.target, action: s.action.type })), outcome: 'NOT_REPAIRED' });
  }
  out.push(['A placement defect escalates (reposition, reposition, remove) and then stops, instead of looping', 'A_REPAIR_ESCALATES_INSTEAD_OF_LOOPING', JSON.stringify(ladder) === JSON.stringify(['REPOSITION', 'REPOSITION', 'REMOVE', REPAIR_BLOCK.REFINE_ATTEMPTS_EXHAUSTED])]);
  const first = plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })]); const failed = createRefineMemory();
  failed.record('scn_probe', { plan_id: first.plan_id, fingerprint: first.fingerprint, steps: [], outcome: 'NOT_REPAIRED' });
  out.push(['The same failed repair of the same artifact is not repeated', 'A_FAILED_REPAIR_IS_NOT_REPEATED', plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })], { memory: failed }).block?.code === REPAIR_BLOCK.REPEATED_FAILED_REPAIR]);
  out.push(['A repair is priced on the repaired layer only, and a deterministic repair costs nothing', 'THE_REPAIR_IS_COSTED_ON_THE_REPAIRED_WORK_ONLY',
    ok.cost.lines.length === 1 && ok.cost.lines[0].request_key === 'prk_mid' && ok.cost.only_the_repaired_work === true && layerPlans[2].cost.max_provider_calls === 0 && layerPlans[2].cost.lines.length === 0]);
  out.push(['A stale, invalid or empty request is refused', 'A_STALE_OR_INVALID_ARTIFACT_IS_REFUSED',
    planRepair({ artifact: { schema: 'x' }, defects: [d(DEFECT_KIND.PROP_UNUSABLE)] }).block?.code === REPAIR_BLOCK.ARTIFACT_INVALID && plan([d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' })], { expectedArtifactDigest: 'stale' }).block?.code === REPAIR_BLOCK.ARTIFACT_STALE && plan([]).block?.code === REPAIR_BLOCK.NO_DEFECT]);
  const cap = describeMaskedEditCapability({});
  out.push(['The masked-edit capability exists but says that no provider is connected, and a repair that needs it is refused', 'A_MASKED_EDIT_IS_NEVER_FAKED',
    cap.interface === MASKED_EDIT.INTERFACE_READY && cap.provider === MASKED_EDIT.NOT_CONNECTED && cap.executable === false && plan([d(DEFECT_KIND.LOCAL_PIXEL_DEFECT, { layer_id: 'lyr_mid' })]).block?.code === REPAIR_BLOCK.NEEDS_A_MASKED_EDIT_PROVIDER]);
  const request = { source_image: { sha256: h('d'), width: 100, height: 100 }, mask: { width: 100, height: 100, regions: [{ x: 45, y: 45, width: 20, height: 20 }] }, instruction: 'x', protected_regions: [{ x: 50, y: 50, width: 40, height: 40 }], expected_output_class: 'REGION_PATCH', provenance: { requested_by: 'probe' }, cost_estimate_eur: 0 };
  out.push(['A mask that touches a protected region is refused before any provider is asked', 'A_MASK_NEVER_TOUCHES_A_PROTECTED_REGION', validateMaskedEditRequest(request).problems.includes('MASK_TOUCHES_A_PROTECTED_REGION')]);
  return out;
}

export const REFINE_RULES = Object.freeze(probes().map((p) => p[1]));

export function auditRefineParity() {
  const rows = probes().map(([rule, id, stated]) => ({ kind: 'PROBE', stage: 'REFINE', path: id, rule, stated }));
  const failures = rows.filter((r) => !r.stated).map((r) => `${r.path}: ${r.rule}`);
  return { ready: failures.length === 0, stages: REFINE_STAGES.map((s) => ({ ...s })), rows, failures };
}

export function renderRefineContractMatrix(audit = auditRefineParity()) {
  const lines = ['# Creative refine contract matrix', '', 'Generated by `auditRefineParity()` from the real planner and masked-edit validators. Do not edit by hand. The refine has no model stage: every rule is proved by a probe that breaks it and checks that the planner refuses with the code of that rule.', ''];
  lines.push('## Probes', '', '| rule | probe | holds |', '|---|---|---|');
  for (const r of audit.rows.filter((x) => x.kind === 'PROBE')) lines.push(`| ${r.path} | ${r.rule} | ${r.stated ? 'yes' : 'NO'} |`);
  lines.push('');
  for (const s of audit.stages) lines.push(`## ${s.stage}`, '', `No model answer: ${s.derivation}`, '');
  lines.push(audit.ready ? 'PARITY: every refine rule is enforced by a planner that refuses with its code, and every probe holds.' : `PARITY FAILURES:\n${audit.failures.map((f) => `- ${f}`).join('\n')}`);
  return `${lines.join('\n')}\n`;
}
