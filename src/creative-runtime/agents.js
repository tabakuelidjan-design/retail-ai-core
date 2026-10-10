import { AGENT_ROLE, defineCreativeAgent, TEXT_KIND } from '../creative-intelligence/index.js';
import { COMPONENT, DECISION } from './ledger.js';

// The Nordla agents of the product-preserving runtime. Each one is a C1 agent (defineCreativeAgent: its output crosses the trust boundary and is normalized by the
// existing contracts) and records every decision in the ledger with its own component identity. Their rules rest on the brand's expression system and on the
// asset's facts, never on the case at hand:
//   Product / Asset Analyst        -> the product-preservation mode (and which regions are protected)
//   Creative Director (model-backed) -> the idea: concept, hierarchy, spatial intent, negative space, the look of the environment
//   Approved-copy agent            -> which APPROVED texts fill the roles of the hierarchy (nothing is written)
//   Visual Production Director      -> the production strategy: which capabilities, with which constraints, and that no product pixel reaches a provider

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** The first statement of a brand-expression section list that contains `phrase` (case-insensitive), or null. */
export function brandStatement(expression, section, list, phrase) {
  const items = expression?.[section]?.[list];
  if (!Array.isArray(items)) return null;
  return items.find((s) => norm(s).includes(norm(phrase))) ?? null;
}

const bboxOf = (outline) => {
  const xs = outline.map((p) => p[0]); const ys = outline.map((p) => p[1]);
  const x0 = Math.max(0, Math.min(...xs)); const y0 = Math.max(0, Math.min(...ys));
  return { x: x0, y: y0, width: Math.min(1, Math.max(...xs)) - x0, height: Math.min(1, Math.max(...ys)) - y0 };
};

// ---- Product / Asset Analyst
/**
 * The preservation mode of a product, from the asset's facts and the brand's product-presentation principles.
 *   merchant-provided real pixels + a cut-out outline + printed content to protect -> COMPOSITE (the real pixels, cut out, on a new environment)
 *   anything weaker (no outline to cut) -> PIXEL_PRESERVE (the whole photograph untouched)
 * A provider is never allowed to redraw a real product that has a real asset (this is also what the brand's own principles say).
 */
export function decidePreservationMode({ asset, annotations, expression }) {
  const protectedCount = (annotations?.text_regions?.length ?? 0) + (annotations?.artwork_region ? 1 : 0);
  const prefers = brandStatement(expression, 'product_presentation', 'do', 'prefer cut-out and compositing over product regeneration');
  const forbids = brandStatement(expression, 'product_presentation', 'dont', 'regenerate a real product when the real asset exists');
  const basis = [prefers, forbids].filter(Boolean);
  if (asset.origin === 'MERCHANT_PROVIDED' && Array.isArray(annotations?.outline) && annotations.outline.length >= 3 && protectedCount > 0) {
    return { mode: 'COMPOSITE', rule: basis.length ? 'BRAND_PREFERS_COMPOSITE_OVER_REGENERATION' : 'MERCHANT_REAL_PIXELS_ARE_AUTHORITATIVE', basis };
  }
  return { mode: 'PIXEL_PRESERVE', rule: 'NO_CUTOUT_OUTLINE_OR_NO_PROTECTED_CONTENT', basis };
}

export function createProductAssetAnalyst({ ledger, expression }) {
  return defineCreativeAgent(AGENT_ROLE.PRODUCT_ASSET_ANALYST, ({
    merchant_id: merchantId, brand_id: brandId, product_ref: productRef, asset, identity_annotations: annotations, at,
  }) => {
    const decision = decidePreservationMode({ asset, annotations, expression });
    ledger.record({
      decision: DECISION.PRODUCT_PRESERVATION_MODE, decided_by: COMPONENT.PRODUCT_ASSET_ANALYST, rule: decision.rule, basis: decision.basis,
      outcome: { mode: decision.mode, asset_ref: asset.ref, origin: asset.origin, protected_regions: (annotations?.text_regions?.length ?? 0) + (annotations?.artwork_region ? 1 : 0) },
    });
    const regions = [
      ...(annotations?.artwork_region ? [{ region_id: 'printed-artwork', ...annotations.artwork_region }] : []),
      ...(annotations?.text_regions ?? []).map((r) => ({ region_id: r.region_id, x: r.x, y: r.y, width: r.width, height: r.height })),
    ];
    const composite = decision.mode === 'COMPOSITE';
    return {
      product_understanding: {
        merchant_id: merchantId,
        brand_id: brandId,
        product_ref: productRef,
        asset_refs: [asset.ref],
        protected_regions: regions,
        logo_regions: [],
        packaging_text_regions: [],
        dominant_orientation: 'UNKNOWN',
        product_bounds: annotations?.outline ? bboxOf(annotations.outline) : null,
        transformation_policy: {
          mode: decision.mode, allow_crop: false, allow_relight: false, allow_shadow: composite, allow_rotation: false, justification_ref: `decision://nordla/rule/${decision.rule.toLowerCase()}`,
        },
        created_at: at,
      },
      asset_observations: [{
        asset_ref: asset.ref, kind: 'PRODUCT', width_px: asset.width_px, height_px: asset.height_px, has_alpha: false, cutout_available: false,
        rights_class: asset.rights_class ?? 'UNKNOWN', privacy_class: asset.privacy_class ?? 'BUSINESS', released: true,
      }],
    };
  });
}

// ---- Creative Director (a model behind the C1 agent boundary)
const DIRECTION_FIELDS = ['concept', 'copy_intent', 'visual_intent', 'product_role', 'spatial_intent', 'negative_space_intent', 'hierarchy'];

/** The instruction the Director model receives, built from the brief and the brand's expression system (never from this case's composition). */
export function buildDirectorInstruction({ brief, constants }) {
  const system = [
    'You are the Nordla Creative Director. You decide ONE creative direction for a product visual from the brief and the brand expression system you are given.',
    'You return ONLY one JSON object with exactly these keys: concept, copy_intent, visual_intent, product_role, spatial_intent, negative_space_intent, hierarchy.',
    `product_role is one of: ${constants.PRODUCT_ROLE.join(', ')}.`,
    `spatial_intent is one of: ${constants.SPATIAL_INTENT.join(', ')}.`,
    `negative_space_intent is one of: ${constants.NEGATIVE_SPACE.join(', ')}.`,
    `hierarchy is a list of roles in reading order, each one of: ${constants.HIERARCHY_ROLE.join(', ')}; it may only use roles the brief provides approved text for, plus PRODUCT.`,
    'visual_intent describes ONLY the environment around the product (surface, light, atmosphere, colour restraint): the real product is composited afterwards and is never generated.',
    'You never write marketing copy, prices or claims, never choose a channel, budget or audience, and never mention anything the brand expression forbids.',
  ].join(' ');
  const user = JSON.stringify({
    brief: brief.public_facts, approved_text_roles: brief.approved_text_roles, format: brief.format, brand_expression: brief.expression,
  });
  return { system, user };
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('the Creative Director returned no JSON object');
  return JSON.parse(trimmed.slice(start, end + 1));
}

/**
 * @param {object} deps
 *  complete  async ({ system, user }) -> { text, request_id?, model? }   the language-model port (live: the text-model lane; tests: a fake). The model writes the creative fields only.
 */
export function createCreativeDirector({ ledger, complete, constants }) {
  return defineCreativeAgent(AGENT_ROLE.CREATIVE_DIRECTOR, async ({ brief, ids }) => {
    const reply = await complete(buildDirectorInstruction({ brief, constants }));
    const raw = parseJsonObject(reply.text);
    const extra = Object.keys(raw).filter((k) => !DIRECTION_FIELDS.includes(k));
    if (extra.length) throw new Error('the Creative Director returned fields that are not part of a direction');
    // identity, evidence and the constraints are decided by the runtime from the brief, never by the model
    const direction = {
      merchant_id: ids.merchant_id,
      brand_id: ids.brand_id,
      brief_ref: ids.brief_ref,
      ...Object.fromEntries(DIRECTION_FIELDS.map((k) => [k, raw[k]])),
      required_asset_refs: ids.asset_refs,
      claim_refs: ids.claim_refs,
      forbidden_transformations: ['REDRAW_PRODUCT', 'ALTER_PRODUCT_PIXELS', 'TEXT_IN_PROVIDER_PIXELS'],
      evidence_refs: ids.evidence_refs ?? [],
    };
    ledger.record({
      decision: DECISION.CREATIVE_DIRECTION, decided_by: COMPONENT.CREATIVE_DIRECTOR, rule: 'DIRECTION_FROM_BRIEF_AND_BRAND_EXPRESSION',
      basis: [ids.brief_ref], outcome: { model: reply.model ?? null, request_id: reply.request_id ?? null, spatial_intent: raw.spatial_intent, negative_space_intent: raw.negative_space_intent, hierarchy: raw.hierarchy, product_role: raw.product_role },
    });
    return { directions: [direction] };
  });
}

// ---- Approved-copy agent
const ROLE_FOR_CLAIM = Object.freeze({ PRICE: 'PRICE', SUBHEADLINE: 'SUBHEADLINE', CTA: 'CTA', LEGAL: 'LEGAL' });

/** The approved texts that fill the roles of the director's hierarchy. A role with no approved text stays empty: nothing is written. */
export function createApprovedCopyAgent({ ledger }) {
  return defineCreativeAgent(AGENT_ROLE.COPY_CLAIMS_AGENT, ({ hierarchy, approved_copy: approvedCopy, claims }) => {
    const items = []; const unfilled = [];
    for (const role of hierarchy.filter((r) => r !== 'PRODUCT' && r !== 'LOGO')) {
      const claim = claims.find((c) => ROLE_FOR_CLAIM[c.role] === role);
      const copy = approvedCopy.find((c) => c.role === role);
      if (claim) items.push({ text_role: role, content: claim.wording, text_kind: TEXT_KIND.CLAIM_BEARING, claim_ref: claim.ref });
      else if (copy) items.push({ text_role: role, content: copy.content, text_kind: TEXT_KIND.NON_CLAIM_CREATIVE_TEXT, claim_ref: null });
      else unfilled.push(role);
    }
    ledger.record({
      decision: DECISION.COPY_SELECTION, decided_by: COMPONENT.APPROVED_COPY_AGENT, rule: 'ONLY_APPROVED_TEXT_FILLS_THE_HIERARCHY', basis: items.map((i) => i.claim_ref).filter(Boolean),
      outcome: { filled_roles: items.map((i) => i.text_role), unfilled_roles: unfilled },
    });
    return { items };
  });
}

// ---- Visual Production Director
/**
 * The production strategy, from the understanding's preservation mode:
 *   COMPOSITE       -> a local product segmentation of the REAL asset + an environment generated WITHOUT any product (no input asset reaches a provider)
 *   PIXEL_PRESERVE  -> no provider at all
 * Every request forbids redrawing the product and putting text in provider pixels.
 */
export function createVisualProductionDirector({ ledger, expression }) {
  return defineCreativeAgent(AGENT_ROLE.VISUAL_PRODUCTION_DIRECTOR, ({ understanding }) => {
    const mode = understanding.transformation_policy.mode;
    const forbidden = ['REDRAW_PRODUCT', 'ALTER_PRODUCT_PIXELS', 'TEXT_IN_PROVIDER_PIXELS', 'ALTER_PRINTED_PERSONALISATION'];
    const basis = [brandStatement(expression, 'product_presentation', 'do', 'generate or compose the environment around the product'),
      brandStatement(expression, 'composition', 'do', 'reserve text space before generating or composing the environment')].filter(Boolean);
    const requests = mode === 'COMPOSITE' ? [
      {
        request_id: 'segment-product', capability: 'PRODUCT_SEGMENT', purpose: 'REFERENCE', input_asset_refs: understanding.asset_refs, privacy_class: 'BUSINESS', text_policy: 'NO_CRITICAL_TEXT', forbidden_transformations: forbidden,
      },
      {
        request_id: 'environment', capability: 'IMAGE_GENERATE', purpose: 'BACKGROUND', input_asset_refs: [], privacy_class: 'PUBLIC', text_policy: 'NO_CRITICAL_TEXT', forbidden_transformations: forbidden,
      },
    ] : [];
    ledger.record({
      decision: DECISION.BACKGROUND_STRATEGY, decided_by: COMPONENT.VISUAL_PRODUCTION_DIRECTOR,
      rule: mode === 'COMPOSITE' ? 'SEGMENT_REAL_PRODUCT_AND_GENERATE_ENVIRONMENT_ONLY' : 'NO_PROVIDER_FOR_A_WHOLE_PHOTOGRAPH', basis,
      outcome: { mode, requests: requests.map((r) => ({ id: r.request_id, capability: r.capability, input_assets: r.input_asset_refs.length, privacy_class: r.privacy_class })) },
    });
    return { requests };
  });
}
