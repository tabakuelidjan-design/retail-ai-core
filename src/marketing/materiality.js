// Materiality Assessment: visible axes, no universal score, no weighted average, no hard-coded threshold (NDR-006).
// M1 owns the contract, the validation and the deterministic aggregation only. The status of each axis is supplied by
// the owning domain or by a future configurable rule - this module never computes an economic/risk/strategic threshold.
//
// Aggregation (documented, deterministic):
//   at least one axis MATERIAL                                  -> MATERIAL
//   else at least one axis UNKNOWN                              -> UNKNOWN
//   else >= 1 applicable axis and all applicable NOT_MATERIAL   -> NOT_MATERIAL
//   else (every axis NOT_APPLICABLE)                            -> UNKNOWN
// NOT_APPLICABLE does not vote. An axis the caller did not assess is UNKNOWN (AXIS_NOT_ASSESSED), never NOT_MATERIAL.

import {
  AXIS_NOT_ASSESSED, MATERIALITY_AXIS, MATERIALITY_OVERALL, MATERIALITY_STATUS, MKT_ERROR as E,
} from './understand-constants.js';
import {
  closedObject, deepFreeze, enumValue, fail, isPlainObject, refList, tokenList,
} from './understand-validation.js';

const AXES = Object.values(MATERIALITY_AXIS);
const AXIS_KEYS = ['status', 'reason_codes', 'evidence_refs'];
const ASSESSMENT_KEYS = ['axes', 'overall', 'deciding_axes'];

function normalizeAxis(input, field) {
  closedObject(input, AXIS_KEYS, field);
  const status = enumValue(input.status, MATERIALITY_STATUS, `${field}.status`, E.MATERIALITY_INVALID_STATUS);
  const reasonCodes = tokenList(input.reason_codes, `${field}.reason_codes`);
  const evidenceRefs = refList(input.evidence_refs, `${field}.evidence_refs`);
  if (!reasonCodes.length) fail(E.MATERIALITY_REASON_REQUIRED, `${field} needs at least one reason code`, { field });
  const claimsSomething = status === MATERIALITY_STATUS.MATERIAL || status === MATERIALITY_STATUS.NOT_MATERIAL;
  if (claimsSomething && !evidenceRefs.length) {
    fail(E.MATERIALITY_EVIDENCE_REQUIRED, `${field} cannot be ${status} without evidence`, { field });
  }
  return { status, reason_codes: reasonCodes, evidence_refs: evidenceRefs };
}

function normalizeAxes(axes) {
  if (axes != null && !isPlainObject(axes)) fail(E.INVALID_FIELD, 'materiality.axes must be an object', { field: 'materiality.axes' });
  // An unknown axis name is its own error, not a generic unknown key.
  for (const key of Object.keys(axes ?? {})) {
    if (!AXES.includes(key)) fail(E.MATERIALITY_INVALID_AXIS, `materiality axis ${key} is not part of V1`, { key });
  }
  return Object.fromEntries(AXES.map((axis) => [axis, axes?.[axis] === undefined
    ? { status: MATERIALITY_STATUS.UNKNOWN, reason_codes: [AXIS_NOT_ASSESSED], evidence_refs: [] }
    : normalizeAxis(axes[axis], `materiality.axes.${axis}`)]));
}

function aggregate(axes) {
  const withStatus = (status) => AXES.filter((axis) => axes[axis].status === status);
  const material = withStatus(MATERIALITY_STATUS.MATERIAL);
  if (material.length) return { overall: MATERIALITY_OVERALL.MATERIAL, deciding_axes: material };
  const unknown = withStatus(MATERIALITY_STATUS.UNKNOWN);
  if (unknown.length) return { overall: MATERIALITY_OVERALL.UNKNOWN, deciding_axes: unknown };
  const notMaterial = withStatus(MATERIALITY_STATUS.NOT_MATERIAL);
  if (notMaterial.length) return { overall: MATERIALITY_OVERALL.NOT_MATERIAL, deciding_axes: notMaterial };
  return { overall: MATERIALITY_OVERALL.UNKNOWN, deciding_axes: [] };
}

/** @param {Record<string, {status, reason_codes, evidence_refs}>} axes keyed by MATERIALITY_AXIS */
export function assessMateriality(axes = {}) {
  const normalized = normalizeAxes(axes);
  return deepFreeze({ axes: normalized, ...aggregate(normalized) });
}

/**
 * Re-validates an assessment received inside a Finding. The overall verdict is RECOMPUTED from the axes: a forged
 * `overall` that disagrees with its own axes is refused.
 */
export function normalizeMaterialityAssessment(input, field = 'materiality') {
  closedObject(input, ASSESSMENT_KEYS, field);
  const assessment = assessMateriality(input.axes);
  if (input.overall !== assessment.overall) fail(E.MATERIALITY_OVERALL_MISMATCH, `${field}.overall does not follow from its axes`, { field });
  if (input.deciding_axes !== undefined && JSON.stringify(input.deciding_axes) !== JSON.stringify(assessment.deciding_axes)) {
    fail(E.MATERIALITY_OVERALL_MISMATCH, `${field}.deciding_axes does not follow from its axes`, { field });
  }
  return assessment;
}
