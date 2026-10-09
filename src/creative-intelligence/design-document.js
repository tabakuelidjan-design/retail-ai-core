// DesignDocument V1: the durable output of Creative Intelligence. A SceneGraph of typed layers over a canvas. Rendered PNG / SVG /
// PDF are projections of it; no provider secret, raw media byte or external URL is ever canonical truth (assets are opaque refs).
//
// document_id is derived from the content: any edit yields a new id, and `version` + provenance.parent_document_ref chain the
// revisions. Locked layers cannot be changed or removed by a revision.

import {
  CI_ERROR as E, CI_VERSION, DERIVATION, LAYER_ORIGIN,
} from './constants.js';
import {
  MAX_LAYERS, normalizeConstraint, normalizeLayer,
} from './layers.js';
import { normalizeCanvas, normalizeOutputContext } from './output-context.js';
import {
  canonical, closedObject, deepFreeze, deriveId, enumValue, fail, hexColor, integer, iso, optionalRef, ref, refList, uuid,
} from './validation.js';

const KEYS = [
  'document_id', 'version', 'merchant_id', 'brand_id', 'brief_ref', 'direction_ref', 'output_context', 'canvas', 'layers',
  'constraints', 'asset_refs', 'claim_refs', 'provenance', 'created_at',
];
const PROVENANCE_KEYS = ['schema_version', 'derivation', 'parent_document_ref', 'created_by', 'producer_refs', 'evidence_refs'];

function provenance(input) {
  closedObject(input, PROVENANCE_KEYS, 'document.provenance');
  if (input.schema_version !== CI_VERSION) fail(E.DOCUMENT_INVALID, 'document.provenance.schema_version is not this contract version', { field: 'document.provenance.schema_version' });
  return {
    schema_version: CI_VERSION,
    derivation: enumValue(input.derivation, DERIVATION, 'document.provenance.derivation', E.DOCUMENT_INVALID),
    parent_document_ref: optionalRef(input.parent_document_ref, 'document.provenance.parent_document_ref'),
    created_by: enumValue(input.created_by, LAYER_ORIGIN, 'document.provenance.created_by', E.DOCUMENT_INVALID),
    producer_refs: refList(input.producer_refs, 'document.provenance.producer_refs', { max: 20 }),
    evidence_refs: refList(input.evidence_refs, 'document.provenance.evidence_refs', { max: 30 }),
  };
}

function canvasOf(input) {
  closedObject(input, ['width', 'height', 'background_color'], 'document.canvas', E.CANVAS_INVALID);
  const { width, height } = normalizeCanvas({ width: input.width, height: input.height }, 'document.canvas');
  return { width, height, background_color: hexColor(input.background_color ?? '#FFFFFF', 'document.canvas.background_color') };
}

/**
 * Structural validation of a stored / produced DesignDocument. Throws on a malformed document; integrity questions that depend on
 * the environment are answered by `runCreativePreflight`.
 */
export function normalizeDesignDocument(input) {
  closedObject(input, KEYS, 'document');
  if (!Array.isArray(input.layers) || input.layers.length === 0 || input.layers.length > MAX_LAYERS) {
    fail(E.DOCUMENT_INVALID, `document.layers must hold 1..${MAX_LAYERS} layers`, { field: 'document.layers' });
  }
  const layers = input.layers.map((l, i) => normalizeLayer(l, `document.layers[${i}]`))
    .sort((a, b) => (a.z_index - b.z_index) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rawConstraints = input.constraints ?? [];
  if (!Array.isArray(rawConstraints) || rawConstraints.length > 60) fail(E.CONSTRAINT_INVALID, 'document.constraints must be an array of at most 60 constraints', { field: 'document.constraints' });
  const constraints = rawConstraints.map((c, i) => normalizeConstraint(c, `document.constraints[${i}]`, { subjectRequired: true }));
  const body = {
    version: integer(input.version, 'document.version', { min: 1, max: 100000, code: E.DOCUMENT_INVALID }),
    merchant_id: uuid(input.merchant_id, 'document.merchant_id'),
    brand_id: uuid(input.brand_id, 'document.brand_id'),
    brief_ref: ref(input.brief_ref, 'document.brief_ref'),
    direction_ref: ref(input.direction_ref, 'document.direction_ref'),
    output_context: normalizeOutputContext(input.output_context),
    canvas: canvasOf(input.canvas),
    layers,
    constraints,
    asset_refs: refList(input.asset_refs, 'document.asset_refs', { max: 60 }),
    claim_refs: refList(input.claim_refs, 'document.claim_refs', { max: 60 }),
    provenance: provenance(input.provenance),
    created_at: iso(input.created_at, 'document.created_at'),
  };
  if (body.provenance.derivation !== DERIVATION.CREATE && !body.provenance.parent_document_ref) {
    fail(E.DOCUMENT_INVALID, 'an ADAPT / REFINE / REUSE document names the document it derives from', { field: 'document.provenance.parent_document_ref' });
  }
  const id = deriveId('cdd', body);
  if (input.document_id !== undefined && input.document_id !== id) fail(E.ID_MISMATCH, 'document.document_id does not follow from its content', { field: 'document.document_id' });
  return deepFreeze({ document_id: id, ...body });
}

/** Builds a new document from its parts (document_id is derived). The input is validated exactly like a stored one. */
export function buildDesignDocument(parts) {
  const { document_id: _ignored, ...rest } = parts;
  return normalizeDesignDocument(rest);
}

/**
 * Creates the next version of a document. `edit` receives a plain deep copy of the layers and returns the new layers array. A locked
 * layer must come back unchanged: it can be neither modified nor removed. The result is a new document (new id, version + 1).
 */
export function reviseDesignDocument(document, { layers, asset_refs, claim_refs, constraints, canvas, output_context, created_at, derivation, created_by, producer_refs, evidence_refs } = {}) {
  const base = normalizeDesignDocument(document);
  if (!Array.isArray(layers)) fail(E.DOCUMENT_INVALID, 'a revision supplies the full layers array', { field: 'layers' });
  const next = layers.map((l, i) => normalizeLayer(l, `revision.layers[${i}]`));
  for (const old of base.layers.filter((l) => l.locked)) {
    const kept = next.find((l) => l.id === old.id);
    if (!kept || canonical(kept) !== canonical(old)) fail(E.LAYER_LOCKED, `layer ${old.id} is locked and cannot be modified or removed`, { layer: old.id });
  }
  const { document_id: _id, ...body } = base;
  return buildDesignDocument({
    ...body,
    version: base.version + 1,
    layers: next,
    asset_refs: asset_refs ?? base.asset_refs,
    claim_refs: claim_refs ?? base.claim_refs,
    constraints: constraints ?? base.constraints,
    canvas: canvas ?? base.canvas,
    output_context: output_context ?? base.output_context,
    created_at: created_at ?? base.created_at,
    provenance: {
      ...base.provenance,
      derivation: derivation ?? 'REFINE',
      parent_document_ref: base.document_id,
      created_by: created_by ?? base.provenance.created_by,
      producer_refs: producer_refs ?? base.provenance.producer_refs,
      evidence_refs: evidence_refs ?? base.provenance.evidence_refs,
    },
  });
}

/** Every asset reference a layer uses (used by the preflight to compare with document.asset_refs). */
export function layerAssetRefs(layer) {
  const out = [];
  if (layer.source_ref) out.push(layer.source_ref);
  if (layer.type === 'PRODUCT') out.push(layer.asset_ref);
  return out;
}
