// CreativeValidationReport: the Brand Guardian verdict on ONE selected candidate, restated for the activation step.
//
// M3 REALLY calls the existing Guardian (`evaluateBrandGuardian`, unchanged) with the trusted candidate manifest, the READY Brand
// Context, targetRef = the candidate id and evaluatedAt = the explicit asOf. It creates no second verdict:
//   - product fidelity stays Creative Fidelity's: if it ran, its result reaches the Guardian through the manifest's existing
//     `product_fidelity` external gate (adapter `fidelityGateObservation`); M3 never recomputes it and builds no fidelity engine;
//   - artistic quality is not re-judged; brand compliance is the Guardian's.
// The mapping is exact and REVIEW_REQUIRED is never turned into a pass:
//   PASS -> READY_FOR_ACTIVATION_POLICY · REVIEW_REQUIRED -> REVIEW_REQUIRED · FAIL -> BLOCKED · NOT_MEASURABLE -> NOT_MEASURABLE
// `execution_decision` is always null: there is no override, no force and no publish-anyway in M3.
//
// A report is a SNAPSHOT at evaluated_at, never a live authority: it is recomputed from the candidate manifest at each live use.

import { normalizeCandidateManifest } from '../branding/candidate-manifest.js';
import { evaluateBrandGuardian, normalizeSemanticAssessment } from '../branding/guardian.js';
import {
  GUARDIAN_TO_VALIDATION, M3_ERROR as Z, MARKETING_CREATE_VERSION,
} from './m3-constants.js';
import { normalizeCreativeBrief } from './creative-brief.js';
import { isLocation } from './m3-validation.js';
import { normalizeSelectedCreativeCandidate } from './creative-candidate.js';
import { assertCreateReady, resolveCreateContext } from './create-gate.js';
import {
  closedObject, deepFreeze, deriveId, fail, toMs,
} from './understand-validation.js';

const OPTION_KEYS = [
  'tenant', 'finding', 'decisionPackage', 'push', 'authorization', 'brandContext', 'asOf', 'brief', 'candidate', 'candidateManifest',
  'semanticAssessment',
];

/**
 * Validates one candidate entry { candidate, candidateManifest, semanticAssessment? } against an already re-validated Brief and
 * the already resolved (READY) create context. Internal building block shared with the Activation Manifest.
 */
export function validateCandidateEntry({ resolved, tenant, brief, entry }) {
  const candidate = normalizeSelectedCreativeCandidate(entry.candidate, { brief });
  if (toMs(candidate.candidate_expires_at) <= toMs(resolved.asOfIso)) fail(Z.CANDIDATE_STALE, 'the candidate has expired');

  let manifest;
  try {
    manifest = normalizeCandidateManifest(entry.candidateManifest);
  } catch (error) {
    fail(Z.MANIFEST_INVALID, 'the candidate manifest is not a valid Branding candidate manifest', { cause: String(error?.message ?? error) });
  }
  // The Branding manifest only requires its asset values to be whitespace-free tokens; a raw location (URL, signed URL, data URI,
  // blob, file) is not an opaque reference, so M3 refuses it before the Guardian sees it. Media itself never enters a manifest.
  if (manifest.assets.some((observation) => observation.values.some(isLocation))) {
    fail(Z.MANIFEST_INVALID, 'the candidate manifest assets must be opaque references, not locations or media');
  }
  if (manifest.content_kind !== candidate.content_kind) fail(Z.MANIFEST_KIND_MISMATCH, 'the candidate manifest describes another content kind than the candidate');

  // A live revalidation may degrade but never improve by losing evidence: when no current assessment is supplied, the assessment
  // already recorded in the supplied validation snapshot stays in force (an explicit current assessment replaces it).
  const recorded = entry.validation?.guardian_report?.semantic_assessment;
  const semanticInput = entry.semanticAssessment ?? recorded ?? null;
  let semantic = null;
  if (semanticInput != null) {
    try {
      semantic = normalizeSemanticAssessment(semanticInput); // advisory lane only: it has no FAIL
    } catch (error) {
      fail(Z.SEMANTIC_ASSESSMENT_INVALID, 'the semantic assessment is not a valid Branding semantic assessment', { cause: String(error?.message ?? error) });
    }
  }

  // The existing Guardian, unchanged. Any failure of the Guardian itself is not masked: it is reported as is.
  const guardianReport = evaluateBrandGuardian({
    tenant,
    brandContext: resolved.brandContext,
    candidateManifest: manifest,
    targetRef: candidate.candidate_id,
    evaluatedAt: resolved.asOfIso,
    semanticAssessment: semantic,
  });
  if (guardianReport.merchant_id !== brief.merchant_id || guardianReport.brand_id !== brief.brand_id
      || guardianReport.target_ref !== candidate.candidate_id || guardianReport.content_kind !== candidate.content_kind) {
    fail(Z.GUARDIAN_SCOPE_MISMATCH, 'the Guardian report is not about this candidate, brand and merchant');
  }
  const validationStatus = GUARDIAN_TO_VALIDATION[guardianReport.outcome];
  if (!validationStatus) fail(Z.GUARDIAN_OUTCOME_UNKNOWN, 'the Guardian returned an outcome M3 does not know');

  const body = {
    schema_version: MARKETING_CREATE_VERSION,
    merchant_id: brief.merchant_id,
    brand_id: brief.brand_id,
    brief_ref: brief.brief_id,
    candidate_ref: candidate.candidate_id,
    deliverable_ref: candidate.deliverable_ref,
    guardian_report: guardianReport,
    validation_status: validationStatus,
    evaluated_at: resolved.asOfIso,
    execution_decision: null,
  };
  return { candidate, report: deepFreeze({ validation_id: deriveId('mcv', body), ...body }) };
}

/**
 * Builds the validation report of ONE candidate. Requires the originals and an explicit clock: the live create gate must be
 * READY_FOR_CREATIVE, the Brief must be fresh and valid, the candidate fresh and in scope, the Brand Context READY.
 * @param {object} p { tenant, finding, decisionPackage, push, authorization, brandContext, asOf, brief, candidate, candidateManifest,
 *                     semanticAssessment? }
 */
export function buildCreativeValidationReport(options = {}) {
  closedObject(options, OPTION_KEYS, 'validation');
  const { brief, candidate, candidateManifest, semanticAssessment, ...context } = options;
  const resolved = assertCreateReady(resolveCreateContext(context));
  const storedBrief = normalizeCreativeBrief(brief, context);
  if (toMs(storedBrief.expires_at) <= toMs(resolved.asOfIso)) fail(Z.BRIEF_STALE, 'the Brief has expired');
  return validateCandidateEntry({ resolved, tenant: context.tenant, brief: storedBrief, entry: { candidate, candidateManifest, semanticAssessment } }).report;
}
