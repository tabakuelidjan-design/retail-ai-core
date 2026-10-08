// The LIVE gate before any creative work is prepared.
//
// A stored object is never an authority. The conclusion is recomputed from the ORIGINALS and an explicit clock:
//   the original MarketingFinding · the original SocleDecisionPackage · the selected MarketingPushProposal
//   · the SocleCreateAuthorization · the Brand Context · asOf
// and reuses the live M2 evaluators (evaluatePackageStatus, evaluatePushReadiness - which themselves re-validate the Finding
// through M1) instead of any `readiness` / `package_status` snapshot carried by a serialized object.
//
// Structural problems (forged or foreign objects, wrong tenant / brand / finding, a Push that is not in the package, a brandless
// Push, a Brand Context of another brand) are REFUSED with a stable code. Time- and state-dependent conclusions are reported
// as a status, in this precedence: STALE > NOT_AUTHORIZED > PUSH_NOT_READY > BRAND_GATED > READY_FOR_CREATIVE.

import { buildBrandContext } from '../branding/interfaces.js';
import { BRAND_CONTEXT_STATUS } from '../branding/constants.js';
import { PACKAGE_STATUS, PUSH_READINESS } from './m2-constants.js';
import { evaluatePushReadiness, liveFinding, normalizeMarketingPushProposal } from './push-proposal.js';
import { evaluatePackageStatus, normalizeSocleDecisionPackage } from './socle-decision-package.js';
import { BRIEF_READINESS, M3_ERROR as Z } from './m3-constants.js';
import { normalizeSocleCreateAuthorization } from './create-authorization.js';
import { canonical } from './m3-validation.js';
import { asOfValue, fail, isPlainObject, tenantMerchantId, toMs } from './understand-validation.js';

// The Brand Context is never trusted on its READY flag alone (same rule as the Guardian): it is rebuilt from its brand, Core,
// Memory and the tenant. A context that is missing, gated, or not rebuildable is BRAND_GATED, not an error; a READY context of
// ANOTHER brand is a structural error.
function inspectBrand({ tenant, brandContext, brandId }) {
  if (!isPlainObject(brandContext) || brandContext.status !== BRAND_CONTEXT_STATUS.READY) return { ready: false, reason: 'BRAND_CONTEXT_NOT_READY' };
  let rebuilt;
  try {
    rebuilt = buildBrandContext({ tenant, brand: brandContext.brand, core: brandContext.core, memory: brandContext.memory });
  } catch {
    return { ready: false, reason: 'BRAND_CONTEXT_NOT_REBUILDABLE' };
  }
  if (rebuilt.status !== BRAND_CONTEXT_STATUS.READY) return { ready: false, reason: 'BRAND_CONTEXT_REBUILD_GATED' };
  if (rebuilt.brand.brand_id !== brandId) fail(Z.BRAND_MISMATCH, 'the Brand Context is about another brand than the Push');
  return { ready: true, rebuilt };
}

function gateOf(r) {
  const stale = [];
  if (r.findingStale) stale.push('FINDING_EXPIRED');
  if (r.pushStatus === PUSH_READINESS.STALE) stale.push('PUSH_EXPIRED');
  if (r.packageStatus === PACKAGE_STATUS.STALE) stale.push('PACKAGE_EXPIRED');
  if (r.authState === 'EXPIRED') stale.push('AUTHORIZATION_EXPIRED');
  if (stale.length) return { status: BRIEF_READINESS.STALE, reason_codes: stale };

  if (r.authState === 'MISSING') return { status: BRIEF_READINESS.NOT_AUTHORIZED, reason_codes: ['AUTHORIZATION_MISSING'] };
  if (r.authState === 'NOT_YET_VALID') return { status: BRIEF_READINESS.NOT_AUTHORIZED, reason_codes: ['AUTHORIZATION_NOT_YET_VALID'] };

  const notReady = [];
  if (r.pushStatus !== PUSH_READINESS.READY_FOR_SOCLE) notReady.push(`PUSH_${r.pushStatus}`);
  if (r.packageStatus !== PACKAGE_STATUS.READY_FOR_SOCLE) notReady.push(`PACKAGE_${r.packageStatus}`);
  if (notReady.length) return { status: BRIEF_READINESS.PUSH_NOT_READY, reason_codes: notReady };

  if (!r.brand.ready) return { status: BRIEF_READINESS.BRAND_GATED, reason_codes: [r.brand.reason] };
  return { status: BRIEF_READINESS.READY_FOR_CREATIVE, reason_codes: ['AUTHORIZED_READY_BRANDED'] };
}

/**
 * Re-validates every original and evaluates the live gate. Returns the validated objects plus the gate; never mutates its inputs.
 * @param {object} p { tenant, finding, decisionPackage, push, authorization?, brandContext?, asOf }
 */
export function resolveCreateContext({ tenant, finding, decisionPackage, push, authorization = null, brandContext = null, asOf } = {}) {
  const merchantId = tenantMerchantId(tenant);
  const asOfIso = asOfValue(asOf);

  const live = liveFinding({ tenant, brand: null, finding, asOf: asOfIso });
  const validatedPush = normalizeMarketingPushProposal(push, { tenant, finding: live.validated });
  if (validatedPush.brand_id == null) fail(Z.BRAND_REQUIRED, 'a CREATE needs an explicit brand: the Push has none');
  const validatedPackage = normalizeSocleDecisionPackage(decisionPackage, { tenant, finding: live.validated });
  if (!validatedPackage.proposals.some((p) => p.push_id === validatedPush.push_id && canonical(p) === canonical(validatedPush))) {
    fail(Z.PUSH_NOT_IN_PACKAGE, 'the selected Push is not one of the proposals of the Decision Package');
  }

  // LIVE evaluation by the M2 evaluators (original Finding + explicit asOf); the stored snapshots are never read.
  const pushStatus = evaluatePushReadiness(validatedPush, { tenant, finding: live.validated, asOf: asOfIso }).status;
  const packageStatus = evaluatePackageStatus(validatedPackage, { tenant, finding: live.validated, asOf: asOfIso });

  const validatedAuthorization = authorization == null
    ? null
    : normalizeSocleCreateAuthorization(authorization, { decisionPackage: validatedPackage, push: validatedPush });
  let authState = 'VALID';
  if (!validatedAuthorization) authState = 'MISSING';
  else if (toMs(validatedAuthorization.expires_at) <= toMs(asOfIso)) authState = 'EXPIRED';
  else if (toMs(validatedAuthorization.authorized_at) > toMs(asOfIso)) authState = 'NOT_YET_VALID';

  const brand = inspectBrand({ tenant, brandContext, brandId: validatedPush.brand_id });

  const resolved = {
    merchantId,
    asOfIso,
    finding: live.validated,
    findingStale: live.findingStale,
    push: validatedPush,
    decisionPackage: validatedPackage,
    authorization: validatedAuthorization,
    brandContext,
    brand,
    pushStatus,
    packageStatus,
    authState,
  };
  return { ...resolved, gate: gateOf(resolved) };
}

/** Throws unless the live gate is READY_FOR_CREATIVE: CREATE work needs authorization, a live-ready Push and a READY brand. */
export function assertCreateReady(resolved) {
  if (resolved.gate.status !== BRIEF_READINESS.READY_FOR_CREATIVE) {
    fail(Z.CREATE_NOT_READY, `creative work cannot be prepared: ${resolved.gate.status}`, {
      status: resolved.gate.status, reason_codes: resolved.gate.reason_codes,
    });
  }
  return resolved;
}

/** The live pre-create gate on its own: { status, reason_codes }. Stored readiness / package_status / brief status are never read. */
export function evaluateCreateGate(input) {
  const { gate } = resolveCreateContext(input);
  return Object.freeze({ status: gate.status, reason_codes: Object.freeze([...gate.reason_codes]) });
}
