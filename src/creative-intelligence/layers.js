// DesignDocument layers. A layer is a typed, closed, deep-frozen object; an unknown field is refused.
//
// Structural validation refuses what is malformed (unknown key, wrong type, URL used as a reference, fact-bearing text without a
// claim basis, a product effect that would mutate pixels). INTEGRITY questions that depend on the rest of the document or on the
// environment (duplicate ids, z-order, missing assets / fonts / claims, overflow, bounds, collisions) are answered by the
// deterministic PREFLIGHT, so a candidate under construction carries a report instead of throwing.

import {
  CI_ERROR as E, CONSTRAINT_KIND, EFFECT_KIND, FACT_BEARING_TEXT_ROLES, IMAGE_FIT, LAYER_ORIGIN, LAYER_TYPE, MAX_TEXT_CONTENT, MAX_TEXT_LINES,
  OVERFLOW_POLICY, PRESERVATION_MODE, SHAPE_KIND, TEXT_ALIGNMENT, TEXT_DIRECTION, TEXT_KIND, TEXT_ROLE, VISIBILITY,
} from './constants.js';
import {
  bool, closedObject, deepFreeze, enumValue, fail, hexColor, idToken, integer, locale, normalizedRegion, number, optionalHexColor, optionalRef,
  ref, refList, text, textDigest,
} from './validation.js';

const COMMON = ['id', 'type', 'z_index', 'geometry', 'visibility', 'locked', 'source_ref', 'constraints', 'effects', 'provenance'];
const SPECIFIC = {
  BACKGROUND: ['fill'],
  PRODUCT: ['product_ref', 'asset_ref', 'preservation_mode', 'protected_regions', 'allow_crop', 'allow_relight', 'allow_shadow', 'allow_rotation'],
  IMAGE: ['fit'],
  TEXT: [
    'content', 'font_ref', 'font_size', 'min_font_size', 'line_height', 'tracking', 'alignment', 'max_lines', 'color', 'box',
    'overflow_policy', 'locale', 'direction', 'text_role', 'text_kind', 'claim_ref', 'approved_digest',
  ],
  SHAPE: ['shape_kind', 'fill', 'stroke', 'stroke_width', 'corner_radius'],
  LOGO: [],
  GROUP: ['members'],
};
export const MAX_LAYERS = 80;
const MAX_COORDINATE = 100000;

// ---- geometry / constraints / effects / provenance
function geometry(input, field) {
  closedObject(input, ['x', 'y', 'width', 'height', 'rotation_deg'], field, E.GEOMETRY_INVALID);
  return {
    x: number(input.x, `${field}.x`, { min: -MAX_COORDINATE, max: MAX_COORDINATE, code: E.GEOMETRY_INVALID }),
    y: number(input.y, `${field}.y`, { min: -MAX_COORDINATE, max: MAX_COORDINATE, code: E.GEOMETRY_INVALID }),
    width: number(input.width, `${field}.width`, { min: 0.0001, max: MAX_COORDINATE, code: E.GEOMETRY_INVALID }),
    height: number(input.height, `${field}.height`, { min: 0.0001, max: MAX_COORDINATE, code: E.GEOMETRY_INVALID }),
    rotation_deg: number(input.rotation_deg ?? 0, `${field}.rotation_deg`, { min: -360, max: 360, code: E.GEOMETRY_INVALID }),
  };
}

export function normalizeConstraint(input, field, { subjectRequired = false } = {}) {
  closedObject(input, ['kind', 'subject', 'target', 'value'], field, E.CONSTRAINT_INVALID);
  const kind = enumValue(input.kind, CONSTRAINT_KIND, `${field}.kind`, E.CONSTRAINT_INVALID);
  const needsTarget = [CONSTRAINT_KIND.NO_OVERLAP, CONSTRAINT_KIND.ABOVE, CONSTRAINT_KIND.BELOW, CONSTRAINT_KIND.ALIGN_CENTER_X].includes(kind);
  const needsValue = kind === CONSTRAINT_KIND.MIN_MARGIN;
  const subject = input.subject == null ? null : idToken(input.subject, `${field}.subject`);
  if (subjectRequired && !subject) fail(E.CONSTRAINT_INVALID, `${field}.subject is required for a document-level constraint`, { field });
  const target = input.target == null ? null : idToken(input.target, `${field}.target`);
  if (needsTarget && !target) fail(E.CONSTRAINT_INVALID, `${field}.target is required for ${kind}`, { field });
  if (!needsTarget && target) fail(E.CONSTRAINT_INVALID, `${field}.target is not used by ${kind}`, { field });
  const value = input.value == null ? null : number(input.value, `${field}.value`, { min: 0, max: 5000, code: E.CONSTRAINT_INVALID });
  if (needsValue && value == null) fail(E.CONSTRAINT_INVALID, `${field}.value is required for ${kind}`, { field });
  if (!needsValue && value != null) fail(E.CONSTRAINT_INVALID, `${field}.value is not used by ${kind}`, { field });
  return { kind, subject, target, value };
}

function constraintList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) fail(E.CONSTRAINT_INVALID, `${field} must be an array of at most 20 constraints`, { field });
  return value.map((c, i) => normalizeConstraint(c, `${field}[${i}]`));
}

function effects(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 3) fail(E.EFFECT_INVALID, `${field} must be an array of at most 3 effects`, { field });
  return value.map((e, i) => {
    const f = `${field}[${i}]`;
    const kind = enumValue(e?.kind, EFFECT_KIND, `${f}.kind`, E.EFFECT_INVALID);
    if (kind === EFFECT_KIND.SHADOW) {
      closedObject(e, ['kind', 'dx', 'dy', 'blur', 'color', 'opacity'], f, E.EFFECT_INVALID);
      return {
        kind,
        dx: number(e.dx, `${f}.dx`, { min: -200, max: 200, code: E.EFFECT_INVALID }),
        dy: number(e.dy, `${f}.dy`, { min: -200, max: 200, code: E.EFFECT_INVALID }),
        blur: number(e.blur, `${f}.blur`, { min: 0, max: 200, code: E.EFFECT_INVALID }),
        color: hexColor(e.color, `${f}.color`),
        opacity: number(e.opacity, `${f}.opacity`, { min: 0, max: 1, code: E.EFFECT_INVALID }),
      };
    }
    closedObject(e, ['kind', 'value'], f, E.EFFECT_INVALID);
    return { kind, value: number(e.value, `${f}.value`, { min: 0, max: 1, code: E.EFFECT_INVALID }) };
  });
}

export function normalizeLayerProvenance(input, field = 'provenance') {
  closedObject(input, ['origin', 'producer_ref', 'evidence_refs'], field);
  return {
    origin: enumValue(input.origin, LAYER_ORIGIN, `${field}.origin`),
    producer_ref: optionalRef(input.producer_ref, `${field}.producer_ref`),
    evidence_refs: refList(input.evidence_refs, `${field}.evidence_refs`, { max: 20 }),
  };
}

// ---- text
const FACTUAL = /[0-9٠-٩۰-۹%€$£¥]/u;

/**
 * The claim basis of a text: its characters, its role, whether it carries a fact (then an approved claim_ref and the digest of the
 * approved wording) or is NON_CLAIM_CREATIVE_TEXT (no number, price or percentage). Shared by the layer and by the copy agent.
 */
export function normalizeTextBasis(input, field) {
  const content = text(input.content, `${field}.content`, { max: MAX_TEXT_CONTENT, multiline: true });
  // The renderer joins words with ONE space and breaks lines itself: whitespace that could not survive that is refused up front, so
  // the characters that are rendered are exactly the characters that were approved.
  if (/\t|\r|  | \n|\n |^\s|\s$/.test(content)) fail(E.TEXT_LAYER_INVALID, `${field}.content: no tab, carriage return, double space or padding whitespace`, { field });
  const role = enumValue(input.text_role, TEXT_ROLE, `${field}.text_role`, E.TEXT_LAYER_INVALID);
  const kind = input.text_kind == null ? null : enumValue(input.text_kind, TEXT_KIND, `${field}.text_kind`, E.TEXT_LAYER_INVALID);
  const claimRef = optionalRef(input.claim_ref, `${field}.claim_ref`);
  const digest = input.approved_digest == null ? null : input.approved_digest;
  if (kind == null) fail(E.CLAIM_BASIS_MISSING, `${field}: every text layer states whether it is CLAIM_BEARING or NON_CLAIM_CREATIVE_TEXT`, { field });
  if (kind === TEXT_KIND.CLAIM_BEARING) {
    if (!claimRef) fail(E.CLAIM_BASIS_MISSING, `${field}: claim-bearing text needs an approved claim_ref`, { field });
    if (typeof digest !== 'string' || digest !== textDigest(content)) {
      fail(E.TEXT_DIGEST_MISMATCH, `${field}: the text differs from the approved text (digest mismatch)`, { field });
    }
    if (role === TEXT_ROLE.DECORATIVE) fail(E.TEXT_LAYER_INVALID, `${field}: decorative text cannot carry a claim`, { field });
  } else {
    if (claimRef || digest) fail(E.TEXT_LAYER_INVALID, `${field}: NON_CLAIM_CREATIVE_TEXT carries no claim_ref and no approved digest`, { field });
    if (FACT_BEARING_TEXT_ROLES.includes(role)) fail(E.CLAIM_BASIS_MISSING, `${field}: a ${role} text states a fact and must be claim-bearing`, { field });
    if (FACTUAL.test(content)) fail(E.NON_CLAIM_TEXT_FACTUAL, `${field}: non-claim creative text cannot contain a number, a price or a percentage`, { field });
  }
  return { content, role, kind, claimRef, digest };
}

function textSpecific(input, field) {
  const {
    content, role, kind, claimRef, digest,
  } = normalizeTextBasis(input, field);
  const fontSize = number(input.font_size, `${field}.font_size`, { min: 1, max: 2000, code: E.TEXT_LAYER_INVALID });
  const boxInput = input.box ?? {};
  closedObject(boxInput, ['padding', 'vertical_align'], `${field}.box`, E.TEXT_LAYER_INVALID);
  return {
    content,
    font_ref: ref(input.font_ref, `${field}.font_ref`),
    font_size: fontSize,
    min_font_size: number(input.min_font_size, `${field}.min_font_size`, { min: 1, max: 2000, code: E.TEXT_LAYER_INVALID }),
    line_height: number(input.line_height, `${field}.line_height`, { min: 0.8, max: 3, code: E.TEXT_LAYER_INVALID }),
    tracking: number(input.tracking ?? 0, `${field}.tracking`, { min: -0.2, max: 1, code: E.TEXT_LAYER_INVALID }),
    alignment: enumValue(input.alignment, TEXT_ALIGNMENT, `${field}.alignment`, E.TEXT_LAYER_INVALID),
    max_lines: integer(input.max_lines, `${field}.max_lines`, { min: 1, max: MAX_TEXT_LINES, code: E.TEXT_LAYER_INVALID }),
    color: hexColor(input.color, `${field}.color`),
    box: {
      padding: number(boxInput.padding ?? 0, `${field}.box.padding`, { min: 0, max: 500, code: E.TEXT_LAYER_INVALID }),
      vertical_align: enumValue(boxInput.vertical_align ?? 'TOP', ['TOP', 'MIDDLE', 'BOTTOM'], `${field}.box.vertical_align`, E.TEXT_LAYER_INVALID),
    },
    overflow_policy: enumValue(input.overflow_policy, OVERFLOW_POLICY, `${field}.overflow_policy`, E.TEXT_LAYER_INVALID),
    locale: locale(input.locale, `${field}.locale`),
    direction: enumValue(input.direction, TEXT_DIRECTION, `${field}.direction`, E.TEXT_LAYER_INVALID),
    text_role: role,
    text_kind: kind,
    claim_ref: claimRef,
    approved_digest: digest,
  };
}

// ---- product
function productSpecific(input, field, geo, effectList) {
  const mode = enumValue(input.preservation_mode, PRESERVATION_MODE, `${field}.preservation_mode`, E.PRODUCT_LAYER_INVALID);
  const flags = {
    allow_crop: bool(input.allow_crop ?? false, `${field}.allow_crop`),
    allow_relight: bool(input.allow_relight ?? false, `${field}.allow_relight`),
    allow_shadow: bool(input.allow_shadow ?? false, `${field}.allow_shadow`),
    allow_rotation: bool(input.allow_rotation ?? false, `${field}.allow_rotation`),
  };
  if (mode === PRESERVATION_MODE.PIXEL_PRESERVE && (flags.allow_crop || flags.allow_relight || flags.allow_rotation)) {
    fail(E.PRODUCT_PIXEL_MUTATION, `${field}: PIXEL_PRESERVE allows no crop, relight or rotation`, { field });
  }
  if (mode === PRESERVATION_MODE.COMPOSITE && flags.allow_relight) {
    fail(E.PRODUCT_PIXEL_MUTATION, `${field}: COMPOSITE places the original pixels; relighting is a CONTROLLED_EDIT`, { field });
  }
  if (geo.rotation_deg !== 0 && !flags.allow_rotation) fail(E.PRODUCT_PIXEL_MUTATION, `${field}: the product is rotated but allow_rotation is false`, { field });
  for (const e of effectList) {
    if (e.kind !== EFFECT_KIND.SHADOW) fail(E.PRODUCT_PIXEL_MUTATION, `${field}: only a cast shadow may accompany a product (no opacity change)`, { field });
    if (!flags.allow_shadow) fail(E.PRODUCT_PIXEL_MUTATION, `${field}: a shadow needs allow_shadow`, { field });
  }
  const regions = Array.isArray(input.protected_regions) ? input.protected_regions : (input.protected_regions == null ? [] : fail(E.PRODUCT_LAYER_INVALID, `${field}.protected_regions must be an array`, { field }));
  return {
    product_ref: ref(input.product_ref, `${field}.product_ref`),
    asset_ref: ref(input.asset_ref, `${field}.asset_ref`),
    preservation_mode: mode,
    protected_regions: regions.map((r, i) => normalizedRegion(r, `${field}.protected_regions[${i}]`)).sort((a, b) => (a.region_id < b.region_id ? -1 : 1)),
    ...flags,
  };
}

/** Normalizes one layer. Returns a deep-frozen layer holding every key of its type (absent optional values are null). */
export function normalizeLayer(input, field = 'layer') {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) fail(E.LAYER_INVALID, `${field} must be an object`, { field });
  const type = enumValue(input.type, LAYER_TYPE, `${field}.type`, E.LAYER_INVALID);
  closedObject(input, [...COMMON, ...SPECIFIC[type]], field);
  const geo = geometry(input.geometry, `${field}.geometry`);
  const effectList = effects(input.effects, `${field}.effects`);
  const base = {
    id: idToken(input.id, `${field}.id`),
    type,
    z_index: integer(input.z_index, `${field}.z_index`, { min: -1000, max: 1000, code: E.LAYER_INVALID }),
    geometry: geo,
    visibility: enumValue(input.visibility ?? VISIBILITY.VISIBLE, VISIBILITY, `${field}.visibility`, E.LAYER_INVALID),
    locked: bool(input.locked ?? false, `${field}.locked`),
    source_ref: optionalRef(input.source_ref, `${field}.source_ref`),
    constraints: constraintList(input.constraints, `${field}.constraints`),
    effects: effectList,
    provenance: normalizeLayerProvenance(input.provenance, `${field}.provenance`),
  };
  let specific = {};
  switch (type) {
    case LAYER_TYPE.BACKGROUND: {
      const fill = optionalHexColor(input.fill, `${field}.fill`);
      if ((fill == null) === (base.source_ref == null)) fail(E.LAYER_INVALID, `${field}: a background has either a fill or a source_ref`, { field });
      specific = { fill };
      break;
    }
    case LAYER_TYPE.PRODUCT:
      specific = productSpecific(input, field, geo, effectList);
      if (base.source_ref != null) fail(E.PRODUCT_LAYER_INVALID, `${field}: a product layer is sourced through asset_ref, not source_ref`, { field });
      break;
    case LAYER_TYPE.IMAGE:
      if (!base.source_ref) fail(E.LAYER_INVALID, `${field}.source_ref is required for an image`, { field });
      specific = { fit: enumValue(input.fit ?? IMAGE_FIT.COVER, IMAGE_FIT, `${field}.fit`, E.LAYER_INVALID) };
      break;
    case LAYER_TYPE.LOGO:
      if (!base.source_ref) fail(E.LAYER_INVALID, `${field}.source_ref is required for a logo`, { field });
      break;
    case LAYER_TYPE.TEXT:
      specific = textSpecific(input, field);
      if (base.source_ref != null) fail(E.TEXT_LAYER_INVALID, `${field}: a text layer has no source_ref`, { field });
      break;
    case LAYER_TYPE.SHAPE: {
      const kind = enumValue(input.shape_kind, SHAPE_KIND, `${field}.shape_kind`, E.LAYER_INVALID);
      const fill = optionalHexColor(input.fill, `${field}.fill`);
      const stroke = optionalHexColor(input.stroke, `${field}.stroke`);
      if (fill == null && stroke == null) fail(E.LAYER_INVALID, `${field}: a shape needs a fill or a stroke`, { field });
      specific = {
        shape_kind: kind,
        fill,
        stroke,
        stroke_width: number(input.stroke_width ?? 0, `${field}.stroke_width`, { min: 0, max: 500, code: E.LAYER_INVALID }),
        corner_radius: number(input.corner_radius ?? 0, `${field}.corner_radius`, { min: 0, max: 5000, code: E.LAYER_INVALID }),
      };
      break;
    }
    case LAYER_TYPE.GROUP: {
      const members = Array.isArray(input.members) ? input.members : null;
      if (!members || members.length < 1 || members.length > 50) fail(E.LAYER_INVALID, `${field}.members must list 1..50 layer ids`, { field });
      specific = { members: [...new Set(members.map((m, i) => idToken(m, `${field}.members[${i}]`)))].sort() };
      break;
    }
    default:
      fail(E.LAYER_INVALID, `${field}.type is not supported`, { field });
  }
  return deepFreeze({ ...base, ...specific });
}

/** Axis-aligned bounds of a layer, rotation included (rotation about its centre). */
export function layerBounds(layer) {
  const { x, y, width, height, rotation_deg: rot } = layer.geometry;
  if (!rot) return { x, y, width, height };
  const rad = (rot * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = width * cos + height * sin;
  const h = width * sin + height * cos;
  return { x: x + width / 2 - w / 2, y: y + height / 2 - h / 2, width: w, height: h };
}

export const isCriticalLayer = (layer) => layer.type === LAYER_TYPE.TEXT
  || layer.type === LAYER_TYPE.LOGO || layer.type === LAYER_TYPE.PRODUCT;
