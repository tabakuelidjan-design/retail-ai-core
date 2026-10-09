// TikTok adapter (Content Posting API, Direct Post). Facts verified against the official documentation on 2026-10-09:
//   scope video.publish · POST /v2/post/publish/creator_info/query/ BEFORE a direct post (privacy_level_options, comment/duet/stitch
//   flags, max duration) · video: POST /v2/post/publish/video/init/ (source PULL_FROM_URL or FILE_UPLOAD) · photo: POST
//   /v2/post/publish/content/init/ (media_type PHOTO, post_mode DIRECT_POST, source PULL_FROM_URL only, URLs verified by the app) ·
//   privacy_level must be one of the creator's options · an UNAUDITED client can only post privately · POST
//   /v2/post/publish/status/fetch/ (PROCESSING_DOWNLOAD / PUBLISH_COMPLETE / FAILED) · errors can come as HTTP 200 with error.code != ok.
//
// `init != published`: the post is published only when the status fetch says PUBLISH_COMPLETE. V1 mode: PULL_FROM_URL for photo AND
// video through the MediaTransport boundary (FILE_UPLOAD is not implemented). Nothing is guessed: privacy_level, is_aigc and the
// brand toggles come from the approved order (a decision), never from this layer. PUBLIC_TO_EVERYONE is never hardcoded.

import { CHANNEL_PROVIDER, PROVIDER_ERROR as PE } from '../constants.js';
import { fail, refList } from '../validation.js';
import { ACT_ERROR as E } from '../constants.js';
import {
  ProviderRejection, bearerHeader, closedOptions, normalizeThrown, outcome, providerCall, requireHttp,
} from './common.js';

export const TIKTOK_PRIVACY_LEVELS = Object.freeze(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
export const TIKTOK_OPTION_KEYS = Object.freeze([
  'privacy_level', 'title_asset_ref', 'disable_comment', 'disable_duet', 'disable_stitch', 'video_cover_timestamp_ms', 'photo_cover_index',
  'auto_add_music', 'brand_content_toggle', 'brand_organic_toggle', 'is_aigc',
]);
const HOST = 'https://open.tiktokapis.com';
const REQUIRED_DECISIONS = ['privacy_level', 'brand_content_toggle', 'brand_organic_toggle', 'is_aigc'];
const BOOLEANS = ['disable_comment', 'disable_duet', 'disable_stitch', 'auto_add_music', 'brand_content_toggle', 'brand_organic_toggle', 'is_aigc'];

/** privacy_level, is_aigc and both brand toggles are decisions of the approved order: absent = refused, never defaulted. */
export function normalizeTikTokOptions(options = {}) {
  closedOptions(options, TIKTOK_OPTION_KEYS, 'tiktok.provider_options');
  for (const key of REQUIRED_DECISIONS) {
    if (options[key] === undefined || options[key] === null) fail(E.PROVIDER_OPTIONS_INVALID, `tiktok.provider_options.${key} must be an explicit approved value (never guessed)`, { key });
  }
  if (!TIKTOK_PRIVACY_LEVELS.includes(options.privacy_level)) fail(E.PROVIDER_OPTIONS_INVALID, 'tiktok.provider_options.privacy_level is not a TikTok privacy level');
  for (const key of BOOLEANS) {
    if (options[key] != null && typeof options[key] !== 'boolean') fail(E.PROVIDER_OPTIONS_INVALID, `tiktok.provider_options.${key} must be a boolean`, { key });
  }
  for (const key of ['video_cover_timestamp_ms', 'photo_cover_index']) {
    if (options[key] != null && !(Number.isInteger(options[key]) && options[key] >= 0)) fail(E.PROVIDER_OPTIONS_INVALID, `tiktok.provider_options.${key} must be a non-negative integer`, { key });
  }
  const title = options.title_asset_ref == null ? [] : refList([options.title_asset_ref], 'tiktok.provider_options.title_asset_ref');
  const out = { title_asset_ref: title[0] ?? null };
  for (const key of TIKTOK_OPTION_KEYS) if (key !== 'title_asset_ref') out[key] = options[key] ?? null;
  return Object.freeze(out);
}

function mapTikTokError(response) {
  const code = response.body?.error?.code;
  const table = {
    invalid_param: PE.INVALID_PAYLOAD,
    access_token_invalid: PE.AUTH_INVALID,
    scope_not_authorized: PE.SCOPE_MISSING,
    spam_risk_too_many_posts: PE.DAILY_LIMIT_REACHED,
    spam_risk_user_banned_from_posting: PE.POLICY_VIOLATION,
    spam_risk_too_many_pending_share: PE.DAILY_LIMIT_REACHED,
    reached_active_user_cap: PE.DAILY_LIMIT_REACHED,
    unaudited_client_can_only_post_to_private_accounts: PE.PRIVATE_ONLY_RESTRICTION,
    url_ownership_unverified: PE.MEDIA_INVALID,
    privacy_level_option_mismatch: PE.PRIVACY_MISMATCH,
    rate_limit_exceeded: PE.RATE_LIMITED,
    internal_error: PE.PROVIDER_UNAVAILABLE,
  };
  return code && table[code] ? { code: table[code], safeCode: code } : (code ? { safeCode: code } : {});
}

// TikTok can answer HTTP 200 with a non-"ok" error code (e.g. creator_info with spam_risk_*): that is still a refusal.
const acceptTikTok = (response) => response.status >= 200 && response.status < 300 && (response.body?.error?.code ?? 'ok') === 'ok';

const FAIL_REASONS = {
  internal: PE.PROCESSING_TRANSIENT,
  file_format_check_failed: PE.MEDIA_INVALID, duration_check_failed: PE.MEDIA_INVALID, frame_rate_check_failed: PE.MEDIA_INVALID,
  picture_size_check_failed: PE.MEDIA_INVALID, video_pull_failed: PE.MEDIA_INVALID, photo_pull_failed: PE.MEDIA_INVALID,
  publish_cancelled: PE.PERMANENT_REJECTION, auth_removed: PE.AUTH_INVALID,
  spam_risk_too_many_posts: PE.DAILY_LIMIT_REACHED, spam_risk_user_banned_from_posting: PE.POLICY_VIOLATION,
  spam_risk_text: PE.POLICY_VIOLATION, spam_risk: PE.POLICY_VIOLATION,
};

export function createTikTokAdapter({
  http, timeoutMs, clientAudited = false, now = () => Date.now(),
} = {}) {
  requireHttp(http);
  const call = (request) => providerCall(http, request, { timeoutMs, mapError: mapTikTokError, accept: acceptTikTok, now });
  const authHeader = bearerHeader;

  async function creatorInfo(credential) {
    const res = await call({ method: 'POST', url: `${HOST}/v2/post/publish/creator_info/query/`, headers: authHeader(credential), body: {} });
    return res.body?.data ?? {};
  }

  return {
    provider: CHANNEL_PROVIDER.TIKTOK,
    // a timeout / 5xx on the creating call may have created the post: never retried blindly (SUBMISSION_OUTCOME_UNKNOWN, human review)
    ambiguousSubmitCodes: ['TIMEOUT', 'PROVIDER_UNAVAILABLE'],
    clientAudited,
    normalizeOptions: normalizeTikTokOptions,
    normalizeProviderError: normalizeThrown,

    async verifyAccount({ credential }) {
      const info = await creatorInfo(credential);
      return outcome({ account_state: 'TIKTOK_CREATOR', display_name: info.creator_nickname ?? null, privacy_level_options: [...(info.privacy_level_options ?? [])] });
    },

    /** creator_info/query is mandatory before a direct post: the approved privacy level must be one of the CURRENT creator options. */
    async preflight({ credential, content, options, delivery }) {
      const info = await creatorInfo(credential);
      const reasons = [];
      const signals = [];
      const levels = info.privacy_level_options ?? [];
      if (!levels.includes(options.privacy_level)) reasons.push('PRIVACY_MISMATCH');
      if (!clientAudited) {
        signals.push('TIKTOK_UNAUDITED_PRIVATE_ONLY'); // an unaudited client is restricted to private visibility
        if (options.privacy_level !== 'SELF_ONLY') reasons.push('PRIVATE_ONLY_RESTRICTION');
      }
      if (!content.transport?.domain_verified) reasons.push('URL_OWNERSHIP_UNVERIFIED'); // PULL_FROM_URL needs a verified domain / prefix
      const title = options.title_asset_ref ? content.texts[options.title_asset_ref] : null;
      const max = content.contentKind === 'IMAGE' ? 90 : 2200;
      if (title && title.length > max) reasons.push('CAPTION_TOO_LONG');
      const status = reasons.length ? 'BLOCKED' : (!clientAudited && !delivery.approval_ref ? 'REVIEW_REQUIRED' : 'READY');
      return outcome({ status, reason_codes: reasons, review_signals: signals });
    },

    buildSubmission({ content, options }) {
      const title = options.title_asset_ref ? content.texts[options.title_asset_ref] : undefined;
      const post = { privacy_level: options.privacy_level, brand_content_toggle: options.brand_content_toggle, brand_organic_toggle: options.brand_organic_toggle };
      for (const key of ['disable_comment', 'disable_duet', 'disable_stitch', 'video_cover_timestamp_ms', 'auto_add_music']) {
        if (options[key] !== null && options[key] !== undefined) post[key] = options[key];
      }
      if (title) post.title = title;
      if (content.contentKind === 'VIDEO') {
        post.is_aigc = options.is_aigc;
        delete post.auto_add_music;
        return outcome({ kind: 'TIKTOK_VIDEO', path: '/v2/post/publish/video/init/', body: { post_info: post, source_info: { source: 'PULL_FROM_URL', video_url: content.transport.ephemeral_location } } });
      }
      delete post.video_cover_timestamp_ms;
      return outcome({
        kind: 'TIKTOK_PHOTO',
        path: '/v2/post/publish/content/init/',
        body: {
          media_type: 'PHOTO', post_mode: 'DIRECT_POST', is_aigc: options.is_aigc, post_info: post,
          source_info: { source: 'PULL_FROM_URL', photo_images: [content.transport.ephemeral_location], photo_cover_index: options.photo_cover_index ?? 0 },
        },
      });
    },

    async submit({ credential, submission }) {
      const res = await call({ method: 'POST', url: `${HOST}${submission.path}`, headers: authHeader(credential), body: submission.body });
      const publishId = res.body?.data?.publish_id;
      if (!publishId) throw new ProviderRejection({ code: PE.PERMANENT_REJECTION, safeCode: 'NO_PUBLISH_ID' });
      return outcome({ outcome: 'PROCESSING', provider_submission_id: String(publishId) }); // init != published
    },

    async fetchStatus({ credential, providerSubmissionId }) {
      const res = await call({ method: 'POST', url: `${HOST}/v2/post/publish/status/fetch/`, headers: authHeader(credential), body: { publish_id: providerSubmissionId } });
      const data = res.body?.data ?? {};
      if (data.status === 'PUBLISH_COMPLETE') {
        const publicIds = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id : [];
        // PUBLISH_COMPLETE is the provider's confirmation. The public post id(s) exist only for a public, moderated post: for a private
        // post the list is empty and the receipt stands on the publish_id (the SUBMISSION id) - it is never copied into the post ids.
        return outcome({
          outcome: 'PUBLISHED', provider_submission_id: providerSubmissionId, provider_post_ids: publicIds.map(String), published_at: new Date(now()).toISOString(),
        });
      }
      if (data.status === 'FAILED') {
        throw new ProviderRejection({ code: FAIL_REASONS[data.fail_reason] ?? PE.PERMANENT_REJECTION, safeCode: data.fail_reason ?? 'FAILED' });
      }
      return outcome({ outcome: 'PROCESSING', provider_submission_id: providerSubmissionId });
    },
  };
}
