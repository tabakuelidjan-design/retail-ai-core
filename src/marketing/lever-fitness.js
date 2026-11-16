// Lever Fitness: is this lever a good fit for this Finding? Visible axes, no score, no weights (NDR-006).
// Mirrors the M1 Materiality design on purpose (same aggregation shape, same refusal of a forged overall), but for
// FIT / NOT_FIT. The status of each axis is supplied by an evidenced assessment; M2 computes no fitness itself.
//
// Aggregation (deterministic):
//   any axis NOT_FIT                                  -> NOT_FIT
//   else any axis UNKNOWN                             -> UNKNOWN
//   else >= 1 applicable axis and all applicable FIT  -> FIT
//   else (every axis NOT_APPLICABLE)                  -> UNKNOWN
// NOT_APPLICABLE does not vote. An axis nobody assessed is UNKNOWN (AXIS_NOT_ASSESSED), never silently FIT.

import { AXIS_NOT_ASSESSED, MKT_ERROR as E } from './understand-constants.js';
import {
  FITNESS_AXIS, FITNESS_OVERALL, FITNESS_STATUS, M2_ERROR as X,
} from './m2-constants.js';
import {
  closedObject, deepFreeze, enumValue, fail, isPlainObject, refList, tokenList,
} from './understand-validation.js';

const AXES = Object.values(FITNESS_AXIS);
const AXIS_KEYS = ['status', 'reason_codes', 'evidence_refs'];
const ASSESSMENT_KEYS = ['axes', 'overall', 'deciding_axes'];

function normalizeAxis(input, field) {
  closedObject(input, AXIS_KEYS, field);
  const status = enumValue(input.status, FITNESS_STATUS, `${field}.status`, X.FITNESS_INVALID_STATUS);
  const reasonCodes = tokenList(input.reason_codes, `${field}.reason_codes`);
  const evidenceRefs = refList(input.evidence_refs, `${field}.evidence_refs`);
  const claimsFit = status === FITNESS_STATUS.FIT || status === FITNESS_STATUS.NOT_FIT;
  if (claimsFit && !evidenceRefs.length) fail(X.FITNESS_EVIDENCE_REQUIRED, `${field} cannot be ${status} without evidence`, { field });
  if (!claimsFit && !reasonCodes.length) fail(X.FITNESS_REASON_REQUIRED, `${field} is ${status} and needs a reason code`, { field });
  return { status, reason_codes: reasonCodes, evidence_refs: evidenceRefs };
}

function normalizeAxes(axes) {
  if (axes != null && !isPlainObject(axes)) fail(E.INVALID_FIELD, 'leverFitness.axes must be an object', { field: 'leverFitness.axes' });
  for (const key of Object.keys(axes ?? {})) {
    if (!AXES.includes(key)) fail(X.FITNESS_INVALID_AXIS, `fitness axis ${key} is not part of V1`, { key });
  }
  return Object.fromEntries(AXES.map((axis) => [axis, axes?.[axis] === undefined
    ? { status: FITNESS_STATUS.UNKNOWN, reason_codes: [AXIS_NOT_ASSESSED], evidence_refs: [] }
    : normalizeAxis(axes[axis], `leverFitness.axes.${axis}`)]));
}

function aggregate(axes) {
  const withStatus = (status) => AXES.filter((axis) => axes[axis].status === status);
  const notFit = withStatus(FITNESS_STATUS.NOT_FIT);
  if (notFit.length) return { overall: FITNESS_OVERALL.NOT_FIT, deciding_axes: notFit };
  const unknown = withStatus(FITNESS_STATUS.UNKNOWN);
  if (unknown.length) return { overall: FITNESS_OVERALL.UNKNOWN, deciding_axes: unknown };
  const fit = withStatus(FITNESS_STATUS.FIT);
  if (fit.length) return { overall: FITNESS_OVERALL.FIT, deciding_axes: fit };
  return { overall: FITNESS_OVERALL.UNKNOWN, deciding_axes: [] };
}

/** @param {Record<string, {status, reason_codes, evidence_refs}>} axes keyed by FITNESS_AXIS */
export function assessLeverFitness(axes = {}) {
  const normalized = normalizeAxes(axes);
  return deepFreeze({ axes: normalized, ...aggregate(normalized) });
}

/** Re-validates an assessment received inside a Push: `overall` is RECOMPUTED; a forged one is refused. */
export function normalizeLeverFitness(input, field = 'lever_fitness') {
  closedObject(input, ASSESSMENT_KEYS, field);
  const assessment = assessLeverFitness(input.axes);
  if (input.overall !== assessment.overall) fail(X.FITNESS_OVERALL_MISMATCH, `${field}.overall does not follow from its axes`, { field });
  if (input.deciding_axes !== undefined && JSON.stringify(input.deciding_axes) !== JSON.stringify(assessment.deciding_axes)) {
    fail(X.FITNESS_OVERALL_MISMATCH, `${field}.deciding_axes does not follow from its axes`, { field });
  }
  return assessment;
}
