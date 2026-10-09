// Readiness, honestly derived.
//
//   assessLiveConnectionReadiness      per connection: NOT_CONFIGURED -> OAUTH_READY -> CONNECTED -> VERIFIED -> PRODUCTION_ELIGIBLE
//   assessProviderProvisioningReadiness per provider: what still blocks going live (BACKEND_READY .. PRODUCTION_READY)
//   activationFactsFrom                feeds assessActivationProductionReadiness (Activation V1) with REAL facts
//
// Nothing is inferred: every fact is stated by the caller from something it can prove. The default is "nothing is cleared".

import { assessActivationProductionReadiness } from '../activation/production-readiness.js';
import { CHANNEL_PROVIDER as P } from '../activation/constants.js';
import {
  CONNECTION_STATE as C, CREDENTIAL_STATUS, LIVE_READINESS as L, PROVISIONING_STATUS as S,
} from './constants.js';
import { deepFreeze } from './validation.js';

/**
 * @param {{ provider, appConfigured: boolean, credential: object|null, connectorStatus?: string, verified?: boolean, facts?: object }} input
 *   facts (for PRODUCTION_ELIGIBLE): { provider_audit_ready, media_transport_ready, consent_compliant, scopes_approved }
 */
export function assessLiveConnectionReadiness({
  provider, appConfigured, credential, connectorStatus = C.NOT_CONFIGURED, verified = false, facts = {},
}) {
  const blockers = [];
  let level = L.NOT_CONFIGURED;
  if (appConfigured) level = L.OAUTH_READY; else blockers.push('APP_CONFIG_REQUIRED');
  const hasCredential = Boolean(credential && credential.status === CREDENTIAL_STATUS.ACTIVE);
  if (level === L.OAUTH_READY && hasCredential) level = L.CONNECTED; else if (appConfigured) blockers.push('OAUTH_CONSENT_REQUIRED');
  if (level === L.CONNECTED && verified && connectorStatus === C.CONFIGURED) level = L.VERIFIED; else if (hasCredential) blockers.push('VERIFICATION_REQUIRED');
  if (level === L.VERIFIED) {
    if (!facts.scopes_approved) blockers.push('SCOPES_APPROVAL_REQUIRED');
    if (!facts.provider_audit_ready) blockers.push('PROVIDER_REVIEW_REQUIRED');
    if (!facts.media_transport_ready) blockers.push('MEDIA_DELIVERY_REQUIRED');
    if (!facts.consent_compliant) blockers.push('CONSENT_COMPLIANCE_REQUIRED');
    if (!blockers.length) level = L.PRODUCTION_ELIGIBLE;
  }
  return deepFreeze({ provider, level, blockers: [...new Set(blockers)].sort() });
}

/**
 * Per provider, the first unmet requirement: app settings & credential store -> a merchant's consent and a bound target -> approved
 * scopes, provider audit and consent compliance -> controlled media delivery. With no fact at all: BACKEND_READY (the code is done, the
 * provider side is untouched).
 */
export function assessProviderProvisioningReadiness(facts = {}) {
  const report = {};
  for (const provider of Object.values(P)) {
    const f = facts[provider] ?? {};
    const untouched = Object.keys(f).length === 0;
    const steps = [
      [S.APP_CONFIG_REQUIRED, f.app_registered === true && f.credential_store_ready === true],
      [S.OAUTH_CONSENT_REQUIRED, f.account_authorized === true && f.target_bound === true],
      [S.PROVIDER_REVIEW_REQUIRED, f.scopes_approved === true && f.provider_audit_ready === true && f.consent_compliant === true],
      [S.MEDIA_DELIVERY_REQUIRED, f.media_transport_ready === true],
    ];
    const blocked = steps.filter(([, ok]) => !ok).map(([name]) => name);
    report[provider] = {
      status: untouched ? S.BACKEND_READY : (blocked[0] ?? S.PRODUCTION_READY),
      open_blockers: blocked,
      backend_ready: true,
    };
  }
  return deepFreeze(report);
}

/** The facts the Activation readiness report understands, derived from the provisioning facts (never invented). */
export function activationFactsFrom(facts = {}) {
  const out = {};
  const f = (provider) => facts[provider] ?? {};
  out[P.INSTAGRAM] = {
    adapter_tested: true, meta_app_configured: f(P.INSTAGRAM).app_registered === true, scopes_approved: f(P.INSTAGRAM).scopes_approved === true,
    professional_account: f(P.INSTAGRAM).target_bound === true, credential_store: f(P.INSTAGRAM).credential_store_ready === true, media_transport: f(P.INSTAGRAM).media_transport_ready === true,
    sandbox_verified: f(P.INSTAGRAM).sandbox_verified === true,
  };
  out[P.TIKTOK] = {
    adapter_tested: true, app_registered: f(P.TIKTOK).app_registered === true, content_posting_enabled: f(P.TIKTOK).content_posting_enabled === true,
    video_publish_approved: f(P.TIKTOK).scopes_approved === true, target_account: f(P.TIKTOK).target_bound === true, client_audited: f(P.TIKTOK).provider_audit_ready === true,
    domain_verified: f(P.TIKTOK).media_transport_ready === true, consent_ux_compliant: f(P.TIKTOK).consent_compliant === true, credential_store: f(P.TIKTOK).credential_store_ready === true,
    sandbox_verified: f(P.TIKTOK).sandbox_verified === true,
  };
  out[P.GOOGLE_BUSINESS_PROFILE] = {
    adapter_tested: true, api_access: f(P.GOOGLE_BUSINESS_PROFILE).app_registered === true, oauth_client: f(P.GOOGLE_BUSINESS_PROFILE).app_registered === true,
    business_manage_granted: f(P.GOOGLE_BUSINESS_PROFILE).scopes_approved === true, target_account: f(P.GOOGLE_BUSINESS_PROFILE).account_authorized === true,
    location_bound: f(P.GOOGLE_BUSINESS_PROFILE).target_bound === true, credential_store: f(P.GOOGLE_BUSINESS_PROFILE).credential_store_ready === true,
    media_transport: f(P.GOOGLE_BUSINESS_PROFILE).media_transport_ready === true, sandbox_verified: f(P.GOOGLE_BUSINESS_PROFILE).sandbox_verified === true,
  };
  return out;
}

export const assessActivationReadinessFromProvisioning = (facts) => assessActivationProductionReadiness(activationFactsFrom(facts));
