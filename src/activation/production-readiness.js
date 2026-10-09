// assessActivationProductionReadiness: an honest, deterministic report of how far each provider really is.
//
//   CONTRACT_READY    the contracts, capability and closed schemas exist and are tested
//   ADAPTER_READY     the provider adapter exists and is tested against fake HTTP / credentials / media transport
//   SANDBOX_READY     a sandbox / test account run was verified (needs a credential store and a verified sandbox run)
//   PRODUCTION_READY  every real-world blocker below is cleared - never true by default, never inferred
//
// Nothing here calls a provider. The caller states facts it can prove; the default is "nothing is cleared".

import { CHANNEL_PROVIDER as P, READINESS_LEVEL as L } from './constants.js';
import { deepFreeze } from './validation.js';

const COMMON = { credential_store: 'PRODUCTION_CREDENTIAL_STORE', media_transport: 'CONTROLLED_MEDIA_DELIVERY', target_account: 'TARGET_ACCOUNT_AUTHORIZATION' };

const BLOCKERS = {
  [P.INSTAGRAM]: [
    ['meta_app_configured', 'META_APP_CONFIGURATION'], ['scopes_approved', 'APPROVED_SCOPES_instagram_business_basic_AND_instagram_business_content_publish'],
    ['professional_account', 'PROFESSIONAL_INSTAGRAM_ACCOUNT'], ['credential_store', COMMON.credential_store], ['media_transport', COMMON.media_transport],
  ],
  [P.TIKTOK]: [
    ['app_registered', 'REGISTERED_TIKTOK_APP'], ['content_posting_enabled', 'CONTENT_POSTING_API_ENABLED'], ['video_publish_approved', 'VIDEO_PUBLISH_SCOPE_APPROVED'],
    ['target_account', COMMON.target_account], ['client_audited', 'CLIENT_AUDIT_FOR_PUBLIC_VISIBILITY'], ['domain_verified', 'VERIFIED_MEDIA_DOMAIN_FOR_PULL_FROM_URL'],
    ['consent_ux_compliant', 'CREATOR_UX_AND_CONSENT_COMPLIANCE'], ['credential_store', COMMON.credential_store],
  ],
  [P.GOOGLE_BUSINESS_PROFILE]: [
    ['api_access', 'GOOGLE_CLOUD_API_ACCESS'], ['oauth_client', 'OAUTH_CLIENT'], ['business_manage_granted', 'BUSINESS_MANAGE_SCOPE_GRANTED'],
    ['target_account', 'AUTHORIZED_BUSINESS_ACCOUNT'], ['location_bound', 'EXPLICIT_LOCATION_BINDING'], ['credential_store', COMMON.credential_store],
    ['media_transport', COMMON.media_transport],
  ],
};

/**
 * @param {object} facts { [provider]: { adapter_tested?, sandbox_verified?, <blocker key>: boolean } } - only provable facts; absent = not cleared
 * @returns frozen { [provider]: { level, blockers[] } }
 */
export function assessActivationProductionReadiness(facts = {}) {
  const report = {};
  for (const provider of Object.keys(BLOCKERS)) {
    const f = facts[provider] ?? {};
    const open = BLOCKERS[provider].filter(([key]) => f[key] !== true).map(([, name]) => name);
    let level = L.CONTRACT_READY;
    if (f.adapter_tested !== false) level = L.ADAPTER_READY; // adapters ship with their tests; an explicit `false` withdraws it
    if (level === L.ADAPTER_READY && f.sandbox_verified === true && f.credential_store === true) level = L.SANDBOX_READY;
    if (level === L.SANDBOX_READY && open.length === 0) level = L.PRODUCTION_READY;
    report[provider] = { level, blockers: open };
  }
  return deepFreeze(report);
}
