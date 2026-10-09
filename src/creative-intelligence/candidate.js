// CreativeCandidate V1: one produced creative = its DesignDocument + the reference of its render + its preflight report (+ an
// optional quality report) + provenance. It states a FACT about the pipeline; it never claims a verdict that belongs to another
// module: Creative Fidelity (product), Brand Guardian (brand), Activation (publishing). It is also NOT the Marketing
// SelectedCreativeCandidate (that one is what Creative Intelligence hands to Marketing after selection and approval).

import {
  CI_ERROR as E, CI_VERSION, FORBIDDEN_APPROVAL_KEYS, FORBIDDEN_PROVIDER_KEYS, FORBIDDEN_SCORE_KEYS, LAYER_ORIGIN, RENDER_MODE,
} from './constants.js';
import { normalizeDesignDocument } from './design-document.js';
import { normalizeQualityReport } from './creative-quality.js';
import {
  closedObject, deepFreeze, deriveId, enumValue, fail, iso, ref, refList, rejectKeysDeep, uuid,
} from './validation.js';

const KEYS = [
  'candidate_id', 'schema_version', 'merchant_id', 'brand_id', 'brief_ref', 'direction_ref', 'render_mode', 'rendered_asset_ref', 'design_document', 'preflight_report',
  'quality_report', 'provenance', 'created_at',
];
const REPORT_KEYS = ['report_id', 'schema_version', 'document_ref', 'status', 'checks', 'context_provided'];

/** The durable reference of a render: the digest of its bytes. The pixels themselves live in the asset store, not here. */
export function renderedAssetRefOf(rendered) {
  // a structural render (unresolved placeholders) has no production reference: it can never back a render-ready candidate
  if (rendered?.render_mode !== RENDER_MODE.RESOLVED) fail(E.RENDER_NOT_RESOLVED, 'only a RESOLVED render can back a candidate: some media references are unresolved', { unresolved: rendered?.unresolved_asset_refs ?? null });
  return `render:${rendered.digest}`;
}

/** Shape + identity of a stored preflight report. Its VALUE is never trusted: the selector recomputes it from the document. */
export function assertPreflightReportShape(report, documentId) {
  closedObject(report, REPORT_KEYS, 'preflight_report', E.CANDIDATE_INVALID);
  const { report_id: id, ...body } = report;
  if (deriveId('cpr', body) !== id) fail(E.ID_MISMATCH, 'preflight_report.report_id does not follow from its content', { field: 'preflight_report' });
  if (report.document_ref !== documentId) fail(E.CANDIDATE_REPORT_STALE, 'the preflight report belongs to another document', { field: 'preflight_report.document_ref' });
  return report;
}

export function normalizeCreativeCandidate(input) {
  rejectKeysDeep(input, [...FORBIDDEN_APPROVAL_KEYS, ...FORBIDDEN_SCORE_KEYS], E.CANDIDATE_APPROVAL_CLAIMED, 'candidate');
  rejectKeysDeep(input, FORBIDDEN_PROVIDER_KEYS, E.FORBIDDEN_KEY, 'candidate');
  closedObject(input, KEYS, 'candidate', E.CANDIDATE_INVALID);
  const document = normalizeDesignDocument(input.design_document);
  const merchantId = uuid(input.merchant_id, 'candidate.merchant_id');
  const brandId = uuid(input.brand_id, 'candidate.brand_id');
  if (document.merchant_id !== merchantId || document.brand_id !== brandId) fail(E.CANDIDATE_INVALID, 'the candidate and its document belong to different merchants or brands', { field: 'candidate' });
  const briefRef = ref(input.brief_ref, 'candidate.brief_ref');
  const directionRef = ref(input.direction_ref, 'candidate.direction_ref');
  if (document.brief_ref !== briefRef || document.direction_ref !== directionRef) fail(E.CANDIDATE_INVALID, 'the candidate and its document answer different briefs or directions', { field: 'candidate' });
  const report = assertPreflightReportShape(input.preflight_report, document.document_id);
  let quality = null;
  if (input.quality_report != null) {
    quality = normalizeQualityReport(input.quality_report);
    if (quality.document_ref !== document.document_id) fail(E.CANDIDATE_REPORT_STALE, 'the quality report belongs to another document', { field: 'candidate.quality_report' });
  }
  closedObject(input.provenance, ['created_by', 'producer_refs', 'evidence_refs'], 'candidate.provenance', E.CANDIDATE_INVALID);
  const body = {
    schema_version: CI_VERSION,
    merchant_id: merchantId,
    brand_id: brandId,
    brief_ref: briefRef,
    direction_ref: directionRef,
    render_mode: input.render_mode === RENDER_MODE.RESOLVED ? RENDER_MODE.RESOLVED : fail(E.RENDER_NOT_RESOLVED, 'a render-ready candidate states render_mode RESOLVED', { field: 'candidate.render_mode' }),
    rendered_asset_ref: ref(input.rendered_asset_ref, 'candidate.rendered_asset_ref'),
    design_document: document,
    preflight_report: report,
    quality_report: quality,
    provenance: {
      created_by: enumValue(input.provenance.created_by, LAYER_ORIGIN, 'candidate.provenance.created_by', E.CANDIDATE_INVALID),
      producer_refs: refList(input.provenance.producer_refs, 'candidate.provenance.producer_refs', { max: 20 }),
      evidence_refs: refList(input.provenance.evidence_refs, 'candidate.provenance.evidence_refs', { max: 30 }),
    },
    created_at: iso(input.created_at, 'candidate.created_at'),
  };
  const id = deriveId('ccc', body);
  if (input.schema_version !== undefined && input.schema_version !== CI_VERSION) fail(E.ID_MISMATCH, 'candidate.schema_version is not this contract version', { field: 'candidate.schema_version' });
  if (input.candidate_id !== undefined && input.candidate_id !== id) fail(E.ID_MISMATCH, 'candidate.candidate_id does not follow from its content', { field: 'candidate.candidate_id' });
  return deepFreeze({ candidate_id: id, ...body });
}
