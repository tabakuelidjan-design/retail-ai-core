// Domain Fit: is Marketing really the right domain for this problem? (NDR-002/013)
// It records a diagnosis and its reasons. It never carries an action, a lever, a budget or an execution decision.

import {
  DOMAIN_FIT_STATUS, MKT_ERROR as E, TARGET_DOMAIN,
} from './understand-constants.js';
import {
  closedObject, deepFreeze, enumValue, fail, refList, tokenList,
} from './understand-validation.js';

const KEYS = ['status', 'reason_codes', 'evidence_refs', 'target_domains'];
const TARGETS = Object.values(TARGET_DOMAIN);

/**
 * REFER_TO_DOMAIN needs target_domains[], reason_codes[] and evidence_refs[]; target_domains are forbidden otherwise.
 * Used both to build a Domain Fit and to re-validate one received inside a Finding.
 */
export function buildDomainFit(input, field = 'domain_fit') {
  closedObject(input, KEYS, field);
  const status = enumValue(input.status, DOMAIN_FIT_STATUS, `${field}.status`, E.DOMAIN_FIT_INVALID_STATUS);
  const reasonCodes = tokenList(input.reason_codes, `${field}.reason_codes`);
  if (!reasonCodes.length) fail(E.DOMAIN_FIT_REASON_REQUIRED, `${field} needs at least one reason code`, { field });
  const evidenceRefs = refList(input.evidence_refs, `${field}.evidence_refs`);

  const targets = tokenList(input.target_domains, `${field}.target_domains`, { max: TARGETS.length });
  if (targets.some((target) => !TARGETS.includes(target))) {
    fail(E.DOMAIN_FIT_UNKNOWN_TARGET, `${field}.target_domains contains a domain outside the closed registry`, { field });
  }
  if (status === DOMAIN_FIT_STATUS.REFER_TO_DOMAIN) {
    if (!targets.length) fail(E.DOMAIN_FIT_TARGET_REQUIRED, `${field} must name the domain(s) it refers to`, { field });
    if (!evidenceRefs.length) fail(E.DOMAIN_FIT_EVIDENCE_REQUIRED, `${field} cannot refer to a domain without evidence`, { field });
  } else if (targets.length) {
    fail(E.DOMAIN_FIT_TARGET_NOT_ALLOWED, `${field}.target_domains is only allowed with REFER_TO_DOMAIN`, { field });
  }

  return deepFreeze({ status, reason_codes: reasonCodes, evidence_refs: evidenceRefs, target_domains: targets });
}
