// Creative Quality CONTRACT (no VLM integration in C1). "Is this actually a good creative?" is answered per dimension with an
// explicit status and the evidence behind it - never with one opaque beauty score. A dimension nobody assessed is NOT_MEASURABLE,
// never PASS. FAIL is not a status here: hard failures belong to the deterministic preflight.

import {
  CI_ERROR as E, CI_VERSION, FORBIDDEN_SCORE_KEYS, QUALITY_DIMENSIONS, QUALITY_STATUS,
} from './constants.js';
import {
  closedObject, deepFreeze, deriveId, enumValue, fail, optionalRef, ref, refList, rejectKeysDeep, tokenList,
} from './validation.js';

const STATUS_RANK = { PASS: 0, NOT_MEASURABLE: 1, REVIEW_REQUIRED: 2 };

export function normalizeQualityReport(input) {
  rejectKeysDeep(input, FORBIDDEN_SCORE_KEYS, E.FORBIDDEN_KEY, 'quality_report');
  closedObject(input, ['report_id', 'schema_version', 'status', 'document_ref', 'reviewer_ref', 'dimensions'], 'quality_report', E.QUALITY_REPORT_INVALID);
  const given = input.dimensions ?? {};
  closedObject(given, QUALITY_DIMENSIONS, 'quality_report.dimensions', E.QUALITY_REPORT_INVALID);
  const dimensions = {};
  for (const name of QUALITY_DIMENSIONS) {
    const d = given[name];
    if (d === undefined) {
      dimensions[name] = { status: QUALITY_STATUS.NOT_MEASURABLE, reason_codes: ['NOT_ASSESSED'], evidence_refs: [] };
      continue;
    }
    closedObject(d, ['status', 'reason_codes', 'evidence_refs'], `quality_report.dimensions.${name}`, E.QUALITY_REPORT_INVALID);
    const status = enumValue(d.status, QUALITY_STATUS, `quality_report.dimensions.${name}.status`, E.QUALITY_REPORT_INVALID);
    const reasons = tokenList(d.reason_codes, `quality_report.dimensions.${name}.reason_codes`, { max: 10 });
    // REVIEW_REQUIRED / NOT_MEASURABLE must say why; the reasons are codes, not prose, so nothing free-form can sneak a score in.
    if (status !== QUALITY_STATUS.PASS && reasons.length === 0) fail(E.QUALITY_REPORT_INVALID, `quality_report.dimensions.${name} needs at least one reason code`, { field: name });
    dimensions[name] = { status, reason_codes: reasons, evidence_refs: refList(d.evidence_refs, `quality_report.dimensions.${name}.evidence_refs`, { max: 10 }) };
  }
  const status = Object.values(dimensions).map((d) => d.status).reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), QUALITY_STATUS.PASS);
  const body = {
    schema_version: CI_VERSION,
    document_ref: ref(input.document_ref, 'quality_report.document_ref'),
    reviewer_ref: optionalRef(input.reviewer_ref, 'quality_report.reviewer_ref'),
    status,
    dimensions,
  };
  const id = deriveId('cqr', body);
  if ((input.status !== undefined && input.status !== status) || (input.schema_version !== undefined && input.schema_version !== CI_VERSION)) {
    fail(E.QUALITY_REPORT_INVALID, 'quality_report.status / schema_version do not follow from the dimensions', { field: 'quality_report.status' });
  }
  if (input.report_id !== undefined && input.report_id !== id) fail(E.ID_MISMATCH, 'quality_report.report_id does not follow from its content', { field: 'quality_report.report_id' });
  return deepFreeze({ report_id: id, ...body });
}

/** The honest default before any critic ran: every dimension NOT_MEASURABLE. */
export const notAssessedQualityReport = (documentRef) => normalizeQualityReport({ document_ref: documentRef, dimensions: {} });
