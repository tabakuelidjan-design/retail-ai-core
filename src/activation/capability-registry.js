// ChannelCapabilityRegistry: what each provider supports, as VERIFIED against the official documentation (no capability is invented).
// A capability is a static, versioned statement; the live preflight can still degrade or refuse when the real account differs.
//
// Provider facts verified on 2026-10-09 (sources in `verified_against`). Do not extend a capability without re-verifying it.

import { CHANNEL_PROVIDER as P, CHANNEL_PROVIDERS } from './constants.js';
import { deepFreeze } from './validation.js';

const VERIFIED_AT = '2026-10-09T00:00:00.000Z';

const registry = {
  [P.INSTAGRAM]: {
    provider: P.INSTAGRAM,
    account_requirements: ['INSTAGRAM_PROFESSIONAL_ACCOUNT'], // account_type Business or Media_Creator
    supported_content_kinds: ['IMAGE', 'VIDEO'], // VIDEO is published as a REEL; images must be JPEG
    supported_delivery_modes: ['PUBLISH_NOW', 'SCHEDULE_INTERNAL', 'INTERACTIVE_CONFIRMATION'],
    requires_public_media_url: true, // "the media must be hosted on a publicly accessible server at the time of the attempt"
    supports_direct_publish: true,
    supports_status_polling: true, // container status_code: IN_PROGRESS / FINISHED / ERROR / EXPIRED / PUBLISHED
    supports_webhook_status: false,
    supports_provider_scheduling: false,
    requires_interactive_confirmation: false,
    required_scopes: ['instagram_business_basic', 'instagram_business_content_publish'], // Instagram Login
    limitations: [
      'IMAGE_JPEG_ONLY', 'VIDEO_PUBLISHED_AS_REEL', 'CAROUSEL_NOT_SUPPORTED_V1', 'STORIES_NOT_SUPPORTED_V1', 'PUBLIC_MEDIA_URL_REQUIRED',
      'API_PUBLISH_LIMIT_PER_24H', 'PAGE_PUBLISHING_AUTHORIZATION_MAY_BLOCK', 'SHOPPING_TAGS_NOT_SUPPORTED',
    ],
    capability_version: 'instagram.v1',
    verified_against: [
      'https://developers.facebook.com/docs/instagram-platform/content-publishing/',
      'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started',
    ],
    verified_at: VERIFIED_AT,
  },
  [P.TIKTOK]: {
    provider: P.TIKTOK,
    account_requirements: ['TIKTOK_AUTHORIZED_CREATOR'],
    supported_content_kinds: ['IMAGE', 'VIDEO'], // photo post (content/init) and video post (video/init), direct post
    supported_delivery_modes: ['INTERACTIVE_CONFIRMATION'], // explicit creator consent / UX rules apply to a TikTok post
    requires_public_media_url: true, // PULL_FROM_URL from a URL prefix or domain verified by the app
    supports_direct_publish: true,
    supports_status_polling: true, // POST /v2/post/publish/status/fetch/
    supports_webhook_status: true, // exists at the provider; Nordla V1 uses polling only
    supports_provider_scheduling: false,
    requires_interactive_confirmation: true,
    required_scopes: ['video.publish'],
    limitations: [
      'CREATOR_INFO_QUERY_REQUIRED_BEFORE_DIRECT_POST', 'PRIVACY_LEVEL_MUST_MATCH_CREATOR_OPTIONS', 'UNAUDITED_CLIENT_PRIVATE_ONLY',
      'PULL_FROM_URL_REQUIRES_VERIFIED_DOMAIN', 'FILE_UPLOAD_NOT_IMPLEMENTED_V1', 'WEBHOOK_NOT_IMPLEMENTED_V1', 'DAILY_POST_CAP_PER_CREATOR',
      'PUBLIC_POST_ID_ONLY_AFTER_MODERATION',
    ],
    capability_version: 'tiktok.v1',
    verified_against: [
      'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post',
      'https://developers.tiktok.com/doc/content-posting-api-reference-photo-post',
      'https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info',
      'https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status',
    ],
    verified_at: VERIFIED_AT,
  },
  [P.GOOGLE_BUSINESS_PROFILE]: {
    provider: P.GOOGLE_BUSINESS_PROFILE,
    account_requirements: ['GOOGLE_BUSINESS_LOCATION_BOUND_TO_CONNECTOR'],
    supported_content_kinds: ['TEXT', 'IMAGE'], // a local post (summary, optional photo by sourceUrl)
    supported_delivery_modes: ['PUBLISH_NOW', 'SCHEDULE_INTERNAL', 'INTERACTIVE_CONFIRMATION'],
    requires_public_media_url: true, // LocalPost media supports `sourceUrl` only
    supports_direct_publish: true,
    supports_status_polling: true, // LocalPost state: LIVE / PROCESSING / REJECTED...
    supports_webhook_status: false,
    supports_provider_scheduling: false,
    requires_interactive_confirmation: false,
    required_scopes: ['https://www.googleapis.com/auth/business.manage'],
    limitations: ['PRODUCT_POST_UNSUPPORTED', 'ALERT_POST_NOT_SUPPORTED_V1', 'MEDIA_SOURCE_URL_ONLY', 'EVENT_AND_OFFER_NEED_EVENT_SCHEDULE'],
    supported_topic_types: ['STANDARD', 'EVENT', 'OFFER'],
    capability_version: 'google_business_profile.v1',
    verified_against: [
      'https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create',
      'https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts',
    ],
    verified_at: VERIFIED_AT,
  },
};

export const CHANNEL_CAPABILITIES = deepFreeze(registry);

/** The verified capability of a provider, or null for a provider Nordla does not support. */
export const getChannelCapability = (provider) => (CHANNEL_PROVIDERS.includes(provider) ? CHANNEL_CAPABILITIES[provider] : null);

/**
 * Static fit of one delivery against the verified capability: { fits, reason_codes[] }. The live preflight adds what only the real
 * account can tell (scopes actually granted, account type, creator options, media transport...).
 */
export function assessCapabilityFit({ provider, contentKind, publishMode, grantedScopes = [] }) {
  const capability = getChannelCapability(provider);
  const reasons = [];
  if (!capability) return deepFreeze({ fits: false, reason_codes: ['PROVIDER_UNSUPPORTED'] });
  if (!capability.supported_content_kinds.includes(contentKind)) reasons.push('CONTENT_KIND_UNSUPPORTED');
  if (!capability.supported_delivery_modes.includes(publishMode)) reasons.push('DELIVERY_MODE_UNSUPPORTED');
  if (capability.requires_interactive_confirmation && publishMode !== 'INTERACTIVE_CONFIRMATION') reasons.push('INTERACTIVE_CONFIRMATION_REQUIRED');
  for (const scope of capability.required_scopes) if (!grantedScopes.includes(scope)) reasons.push('SCOPE_MISSING');
  return deepFreeze({ fits: reasons.length === 0, reason_codes: [...new Set(reasons)].sort() });
}
