import { createHash } from 'node:crypto';

import { DEFECT_KIND, DEFECT_KINDS, DEFECT_SOURCE, REPAIR_BLOCK } from './constants.js';

// DEFECT REGIONS and the CRITIQUE -> ACTION mapping. A defect is a statement "this is wrong HERE", from a gate, a critique or a measurement. It is attributed to the layer that owns the pixels (the topmost layer at that
// place, by the z-order of the scene), never to the creative as a whole. Pure and deterministic.

export class DefectError extends Error {
  constructor(message, code = REPAIR_BLOCK.DEFECT_INVALID) { super(message); this.name = 'DefectError'; this.code = code; }
}

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * A DefectRegion. `region` is in canvas pixels (or null when the defect names a node or a layer instead of a place); `node_id` / `layer_id` name the owner explicitly; `evidence` is the RepairEvidence: where the defect
 * was observed and what was measured.
 */
export function createDefectRegion({
  kind, source = DEFECT_SOURCE.OWNER_REGION, region = null, node_id = null, layer_id = null, severity = 'MEDIUM', evidence = {}, reason = null,
}) {
  if (!DEFECT_KINDS.includes(kind)) throw new DefectError(`unknown defect kind: ${kind}`);
  if (!Object.values(DEFECT_SOURCE).includes(source)) throw new DefectError(`unknown defect source: ${source}`);
  if (region !== null && !(finite(region.x) && finite(region.y) && finite(region.width) && finite(region.height) && region.width > 0 && region.height > 0)) throw new DefectError('a defect region needs finite x, y and a positive width and height');
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(severity)) throw new DefectError(`unknown severity: ${severity}`);
  const body = { kind, source, region, node_id, layer_id, severity };
  return Object.freeze({ defect_id: `def-${digestOf(body)}`, ...body, reason, evidence: Object.freeze({ observed_in: evidence.observed_in ?? source, rule: evidence.rule ?? null, measurement: evidence.measurement ?? null }) });
}

const inside = (b, px, py) => px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height;
const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * The owner of a defect: an explicit node or layer first; otherwise the TOPMOST layer at the centre of the region (text > foreground prop > the real product > midground prop > background prop > plate).
 * @returns {{ node_id: string|null, via: string, touches_product: boolean }}
 */
export function attributeDefect(artifact, defect) {
  const n = artifact.nodes;
  const ids = new Set([n.plate.node_id, ...n.props.map((p) => p.node_id), n.product.node_id, ...n.text.map((t) => t.node_id), ...n.text_style.map((s) => s.node_id), 'COMPOSITE_BASE', 'COMPOSITE_STACK', 'RENDER']);
  const touchesProduct = defect.region ? intersects(defect.region, n.product.rect) : false;
  if (defect.node_id) return { node_id: ids.has(defect.node_id) ? defect.node_id : null, via: 'NODE', touches_product: touchesProduct };
  if (defect.layer_id) { const id = `PROP:${defect.layer_id}`; return { node_id: ids.has(id) ? id : null, via: 'LAYER', touches_product: touchesProduct }; }
  if (!defect.region) return { node_id: null, via: 'NONE', touches_product: false };
  const cx = defect.region.x + defect.region.width / 2; const cy = defect.region.y + defect.region.height / 2;
  const hit = (b) => inside(b, cx, cy);
  const text = n.text.find((t) => hit(t.geometry));
  if (text) return { node_id: `TEXT:${text.role}`, via: 'REGION', touches_product: touchesProduct };
  const fg = n.props.filter((p) => p.kind === 'PROP_FOREGROUND' && hit(p.box)).at(-1);
  if (fg) return { node_id: fg.node_id, via: 'REGION', touches_product: touchesProduct };
  if (hit(n.product.rect)) return { node_id: n.product.node_id, via: 'REGION', touches_product: true };
  const mid = n.props.filter((p) => p.kind === 'PROP_MIDGROUND' && hit(p.box)).at(-1) ?? n.props.filter((p) => p.kind === 'PROP_BACKGROUND' && hit(p.box)).at(-1);
  if (mid) return { node_id: mid.node_id, via: 'REGION', touches_product: touchesProduct };
  if (hit(n.plate.box)) return { node_id: n.plate.node_id, via: 'REGION', touches_product: touchesProduct };
  return { node_id: null, via: 'NONE', touches_product: touchesProduct };
}

/**
 * The defects the gates of a delivered candidate already name (the critique -> action mapping of the machine's own findings). A finding that cannot be attributed to a layer is returned as a defect without an owner:
 * the planner refuses it (DEFECT_NOT_ATTRIBUTABLE) instead of guessing.
 */
export function defectsFromCandidate(candidate) {
  const out = [];
  if (candidate?.status === 'PREFLIGHT_FAIL') {
    for (const c of candidate.preflight?.checks ?? []) {
      if (c.status === 'PASS' || c.status === 'NOT_APPLICABLE') continue;
      if (/CONTRAST|LEGIB|READ/i.test(String(c.code))) out.push(createDefectRegion({ kind: DEFECT_KIND.TEXT_ILLEGIBLE, source: DEFECT_SOURCE.GATE, evidence: { observed_in: 'creative-preflight', rule: c.code, measurement: c.evidence ?? null }, reason: `the preflight check ${c.code} failed` }));
      else out.push(createDefectRegion({ kind: DEFECT_KIND.COMPOSITION_REFUSED, source: DEFECT_SOURCE.GATE, evidence: { observed_in: 'creative-preflight', rule: c.code, measurement: c.evidence ?? null }, reason: `the preflight check ${c.code} failed` }));
    }
  }
  if (candidate?.status === 'FIDELITY_FAIL') {
    for (const f of candidate.fidelity?.failed ?? []) {
      const kind = /INSTANCE_COUNT/.test(String(f.observation)) ? DEFECT_KIND.PROP_RESEMBLES_THE_PRODUCT : DEFECT_KIND.PRODUCT_PIXELS;
      out.push(createDefectRegion({ kind, source: DEFECT_SOURCE.GATE, evidence: { observed_in: 'identity-fidelity-gate', rule: `${f.check}/${f.observation}`, measurement: f.evidence ?? null }, reason: `the identity gate failed ${f.check}/${f.observation}` }));
    }
  }
  if (candidate?.status === 'GUARDIAN_FAIL') {
    for (const r of candidate.guardian?.rule_results ?? []) {
      if (r.outcome === 'PASS') continue;
      out.push(createDefectRegion({ kind: /CONTRAST|LEGIB/i.test(String(r.rule_id)) ? DEFECT_KIND.TEXT_ILLEGIBLE : DEFECT_KIND.COMPOSITION_REFUSED, source: DEFECT_SOURCE.GATE, evidence: { observed_in: 'brand-guardian', rule: r.rule_id, measurement: null }, reason: `the Brand Guardian rule ${r.rule_id} did not pass` }));
    }
  }
  return out;
}

/**
 * The existing revision vocabulary of the critic (REVISION_INTENT), mapped to what a LAYER repair can do about it, or to the honest statement that it cannot. Nothing is mapped to "regenerate everything".
 *   layer repair   : the environment, the text style, the composition of the existing layers
 *   not a refine   : the concept, the brand expression, the template feel (upstream: a replan); product prominence / integration (layout / Phase 5)
 */
export const KIND_FOR_INTENT = Object.freeze({
  REGENERATE_CLEANER_ENVIRONMENT: DEFECT_KIND.PLATE_UNSUITABLE,
  CLARIFY_TEXT_HIERARCHY: DEFECT_KIND.TEXT_ILLEGIBLE,
  REFINE_TYPOGRAPHIC_COMPOSITION: DEFECT_KIND.TEXT_ILLEGIBLE,
  ADJUST_CLAIM_PRESENTATION: DEFECT_KIND.TEXT_ILLEGIBLE,
  INTEGRATE_PRICE_WITH_THE_COMPOSITION: DEFECT_KIND.TEXT_ILLEGIBLE,
  CLARIFY_VISUAL_HIERARCHY: DEFECT_KIND.PROP_NO_ROOM,
  REBALANCE_COMPOSITION: DEFECT_KIND.PROP_NO_ROOM,
  REBALANCE_WHITESPACE: DEFECT_KIND.PROP_NO_ROOM,
  INCREASE_PRODUCT_DOMINANCE: DEFECT_KIND.UPSTREAM_LAYOUT,
  IMPROVE_PRODUCT_ENVIRONMENT_INTEGRATION: DEFECT_KIND.REQUIRES_PHASE_5,
  STRENGTHEN_BRAND_EXPRESSION: DEFECT_KIND.UPSTREAM_CONCEPT,
  ELEVATE_RETAIL_QUALITY: DEFECT_KIND.UPSTREAM_CONCEPT,
  REDUCE_TEMPLATE_FEEL: DEFECT_KIND.UPSTREAM_CONCEPT,
  RECONSIDER_THE_OVERALL_CONCEPT: DEFECT_KIND.UPSTREAM_CONCEPT,
});

/** Critique -> action: each normalized revision intent becomes ONE defect of the kind a layer repair (or a replan) can answer. An unknown intent is refused, never guessed. */
export function defectsFromRevisionIntents(intents, { region = null, node_id = null, layer_id = null } = {}) {
  return (intents ?? []).map((i) => {
    const intent = typeof i === 'string' ? i : i?.intent;
    const kind = KIND_FOR_INTENT[intent];
    if (!kind) throw new DefectError(`the revision intent ${intent} has no repair mapping`);
    return createDefectRegion({ kind, source: DEFECT_SOURCE.CRITIQUE, region, node_id, layer_id, evidence: { observed_in: 'creative-critic', rule: intent, measurement: null }, reason: `critique: ${intent}` });
  });
}
