// Instagram adapter (Instagram API with Instagram Login). Facts verified against the official documentation on 2026-10-09:
//   scopes instagram_business_basic + instagram_business_content_publish · Professional accounts only (account_type Business or
//   Media_Creator) · POST /<IG_ID>/media -> container · GET /<container>?fields=status_code (IN_PROGRESS / FINISHED / ERROR / EXPIRED /
//   PUBLISHED) · POST /<IG_ID>/media_publish {creation_id} · images JPEG only · Reels via media_type REELS · media must be at a publicly
//   accessible URL at the time of the attempt · the token is passed as the documented `access_token` parameter (sealed, never logged).
//
// `container created != published`: a post id exists only after media_publish. The Graph API version is CONFIGURATION (no default).
// Carousels and Stories are not implemented in V1. The account is the connector's external_id: it is never auto-selected.

import {
  ACT_ERROR as E, CHANNEL_PROVIDER, PROVIDER_ERROR as PE,
} from '../constants.js';
import { fail, refList } from '../validation.js';
import {
  ProviderRejection, closedOptions, normalizeThrown, outcome, providerCall, requireHttp,
} from './common.js';

export const INSTAGRAM_OPTION_KEYS = Object.freeze(['caption_asset_ref']);
const PROFESSIONAL = ['Business', 'Media_Creator'];
const HOST = 'https://graph.instagram.com';

export function normalizeInstagramOptions(options = {}) {
  closedOptions(options, INSTAGRAM_OPTION_KEYS, 'instagram.provider_options');
  const caption = options.caption_asset_ref == null ? [] : refList([options.caption_asset_ref], 'instagram.provider_options.caption_asset_ref');
  return Object.freeze({ caption_asset_ref: caption[0] ?? null });
}

// Generic Graph API error codes (to be re-verified at the sandbox stage). Everything not listed falls back to the HTTP status.
function mapGraphError(response) {
  const error = response.body?.error ?? {};
  const code = Number(error.code);
  if (code === 190) return { code: PE.AUTH_INVALID, safeCode: code };
  if ([4, 17, 32, 613].includes(code)) return { code: PE.RATE_LIMITED, safeCode: code };
  if (code === 10 || (code >= 200 && code < 300)) return { code: PE.SCOPE_MISSING, safeCode: code };
  if (code === 2 || code === 1) return { code: PE.PROVIDER_UNAVAILABLE, safeCode: code };
  if (response.status === 400) return { code: PE.INVALID_PAYLOAD, safeCode: Number.isFinite(code) ? code : 400 };
  return {};
}

export function createInstagramAdapter({
  http, graphVersion, timeoutMs, now = () => Date.now(),
} = {}) {
  requireHttp(http);
  if (typeof graphVersion !== 'string' || !/^v\d+\.\d+$/.test(graphVersion)) throw new TypeError('the Graph API version is configuration: pass graphVersion such as "v25.0"');
  const call = (request) => providerCall(http, request, { timeoutMs, mapError: mapGraphError, now });
  const base = `${HOST}/${graphVersion}`;

  async function me(credential) {
    const res = await call({ method: 'GET', url: `${base}/me`, query: { fields: 'user_id,username,account_type', access_token: credential.access_token } });
    return { id: String(res.body?.user_id ?? res.body?.id ?? ''), username: res.body?.username ?? null, account_type: res.body?.account_type ?? null };
  }

  async function containerStatus(containerId, credential) {
    const res = await call({ method: 'GET', url: `${base}/${containerId}`, query: { fields: 'status_code', access_token: credential.access_token } });
    return String(res.body?.status_code ?? '');
  }

  async function publishContainer(connector, credential, containerId) {
    const res = await call({ method: 'POST', url: `${base}/${connector.external_id}/media_publish`, body: { creation_id: containerId, access_token: credential.access_token } });
    const mediaId = res.body?.id;
    if (!mediaId) throw new ProviderRejection({ code: PE.PUBLISH_RESULT_UNKNOWN, safeCode: 'NO_MEDIA_ID' });
    return String(mediaId);
  }

  async function settle(connector, credential, containerId) {
    const status = await containerStatus(containerId, credential);
    if (status === 'FINISHED') {
      const postId = await publishContainer(connector, credential, containerId);
      return outcome({ outcome: 'PUBLISHED', provider_submission_id: containerId, provider_post_id: postId, published_at: new Date(now()).toISOString() });
    }
    if (status === 'IN_PROGRESS') return outcome({ outcome: 'PROCESSING', provider_submission_id: containerId });
    if (status === 'ERROR' || status === 'EXPIRED') throw new ProviderRejection({ code: PE.MEDIA_INVALID, safeCode: status });
    // PUBLISHED without a media id in hand: never publish again, never invent an id
    throw new ProviderRejection({ code: PE.PUBLISH_RESULT_UNKNOWN, safeCode: status || 'UNKNOWN_STATUS' });
  }

  return {
    provider: CHANNEL_PROVIDER.INSTAGRAM,
    ambiguousSubmitCodes: [], // creating a container publishes nothing: every retryable error may be retried
    normalizeOptions: normalizeInstagramOptions,
    normalizeProviderError: normalizeThrown,

    /** Live account check: Professional (Business / Media_Creator) and the account the connector designates. */
    async verifyAccount({ connector, credential }) {
      const account = await me(credential);
      return outcome({
        account_state: account.account_type, display_name: account.username,
        professional: PROFESSIONAL.includes(account.account_type), id_matches: account.id === connector.external_id,
      });
    },

    async preflight({ connector, credential, content }) {
      const account = await this.verifyAccount({ connector, credential });
      const reasons = [];
      if (!account.professional) reasons.push('ACCOUNT_NOT_PROFESSIONAL');
      if (!account.id_matches) reasons.push('ACCOUNT_MISMATCH');
      const type = content.transport?.content_type ?? null;
      if (content.contentKind === 'IMAGE' && type !== 'image/jpeg') reasons.push('MEDIA_NOT_COMPATIBLE'); // images must be JPEG
      if (content.contentKind === 'VIDEO' && !(type ?? '').startsWith('video/')) reasons.push('MEDIA_NOT_COMPATIBLE');
      return outcome({ status: reasons.length ? 'BLOCKED' : 'READY', reason_codes: reasons, review_signals: [] });
    },

    /** Pure: the container request. Holds the ephemeral media location (sealed) - never stored. */
    buildSubmission({ content, options }) {
      const params = content.contentKind === 'VIDEO'
        ? { media_type: 'REELS', video_url: content.transport.ephemeral_location }
        : { image_url: content.transport.ephemeral_location };
      if (options.caption_asset_ref) params.caption = content.texts[options.caption_asset_ref];
      return outcome({ kind: 'INSTAGRAM_CONTAINER', params });
    },

    async submit({ connector, credential, submission }) {
      const res = await call({ method: 'POST', url: `${base}/${connector.external_id}/media`, body: { ...submission.params, access_token: credential.access_token } });
      const containerId = res.body?.id;
      if (!containerId) throw new ProviderRejection({ code: PE.PERMANENT_REJECTION, safeCode: 'NO_CONTAINER_ID' });
      // container created != published: media_publish happens in a separate, claimed status step (a timeout there can never re-create a post)
      return outcome({ outcome: 'PROCESSING', provider_submission_id: String(containerId) });
    },

    async fetchStatus({ connector, credential, providerSubmissionId }) {
      return settle(connector, credential, providerSubmissionId);
    },
  };
}

export const assertInstagramKind = (kind) => (['IMAGE', 'VIDEO'].includes(kind) ? kind : fail(E.PROVIDER_OPTIONS_INVALID, 'Instagram V1 publishes IMAGE or VIDEO (Reel) only'));
