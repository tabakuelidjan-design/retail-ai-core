// Google Business Profile adapter (Business Profile "My Business" API v4, localPosts). Facts verified against the official
// documentation on 2026-10-09:
//   POST https://mybusiness.googleapis.com/v4/{parent=accounts/*/locations/*}/localPosts (accounts.locations.localPosts.create) ·
//   OAuth scope https://www.googleapis.com/auth/business.manage · the response is the created LocalPost (name, state, searchUrl) ·
//   topicType STANDARD / EVENT / OFFER / ALERT (no PRODUCT: product posts are NOT supported by this API) · EVENT and OFFER need an
//   event schedule (title + start/end date and time) · callToAction.actionType BOOK / ORDER / SHOP / LEARN_MORE / SIGN_UP / CALL
//   (GET_OFFER is deprecated) · LocalPost media supports `sourceUrl` only.
//
// The target is the LOCATION designated by the connector's external_id (`accounts/{id}/locations/{id}`): never the first location.
// Every text (summary, CTA url, event title, coupon...) comes from APPROVED content refs; this layer chooses no CTA and writes no copy.

import { ACT_ERROR as E, CHANNEL_PROVIDER, PROVIDER_ERROR as PE } from '../constants.js';
import {
  fail, iso, ref,
} from '../validation.js';
import {
  ProviderRejection, bearerHeader, closedOptions, normalizeThrown, outcome, providerCall, requireHttp,
} from './common.js';

export const GBP_TOPIC_TYPES = Object.freeze(['STANDARD', 'EVENT', 'OFFER']);
export const GBP_CTA_TYPES = Object.freeze(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']);
export const GBP_OPTION_KEYS = Object.freeze([
  'topic_type', 'language_code', 'location_ref', 'summary_asset_ref', 'cta_action_type', 'cta_url_asset_ref', 'event_title_asset_ref',
  'event_start', 'event_end', 'offer_coupon_code_asset_ref', 'offer_redeem_url_asset_ref', 'offer_terms_asset_ref',
]);
const ASSET_KEYS = ['summary_asset_ref', 'cta_url_asset_ref', 'event_title_asset_ref', 'offer_coupon_code_asset_ref', 'offer_redeem_url_asset_ref', 'offer_terms_asset_ref'];
const HOST = 'https://mybusiness.googleapis.com/v4';
const LOCATION = /^accounts\/[^/]+\/locations\/[^/]+$/;

export function normalizeGoogleBusinessOptions(options = {}) {
  closedOptions(options, GBP_OPTION_KEYS, 'google_business_profile.provider_options');
  if (options.topic_type === 'PRODUCT' || options.topic_type === 'PRODUCT_POST') fail(E.PROVIDER_OPTIONS_INVALID, 'Product posts are NOT supported by the Business Profile localPosts API', { key: 'topic_type' });
  if (!GBP_TOPIC_TYPES.includes(options.topic_type)) fail(E.PROVIDER_OPTIONS_INVALID, 'topic_type must be STANDARD, EVENT or OFFER', { key: 'topic_type' });
  if (options.cta_action_type != null && !GBP_CTA_TYPES.includes(options.cta_action_type)) fail(E.PROVIDER_OPTIONS_INVALID, 'cta_action_type is not a supported call-to-action', { key: 'cta_action_type' });
  if (options.cta_action_type && options.cta_action_type !== 'CALL' && !options.cta_url_asset_ref) fail(E.PROVIDER_OPTIONS_INVALID, 'a call-to-action other than CALL needs an approved cta_url_asset_ref');
  if (options.cta_action_type == null && options.cta_url_asset_ref) fail(E.PROVIDER_OPTIONS_INVALID, 'a cta url without cta_action_type is refused (the CTA is never invented)');
  const out = { topic_type: options.topic_type, language_code: options.language_code ?? null, location_ref: options.location_ref == null ? null : ref(options.location_ref, 'location_ref') };
  if (out.language_code !== null && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(out.language_code)) fail(E.PROVIDER_OPTIONS_INVALID, 'language_code must be a BCP 47 code', { key: 'language_code' });
  for (const key of ASSET_KEYS) out[key] = options[key] == null ? null : ref(options[key], key);
  out.cta_action_type = options.cta_action_type ?? null;
  out.event_start = options.event_start == null ? null : iso(options.event_start, 'event_start');
  out.event_end = options.event_end == null ? null : iso(options.event_end, 'event_end');
  if (out.topic_type !== 'STANDARD') {
    if (!out.event_title_asset_ref || !out.event_start || !out.event_end) fail(E.PROVIDER_OPTIONS_INVALID, 'EVENT and OFFER posts need an event title, start and end');
    if (Date.parse(out.event_end) <= Date.parse(out.event_start)) fail(E.PROVIDER_OPTIONS_INVALID, 'event_end must be after event_start');
  } else if (out.event_title_asset_ref || out.event_start || out.event_end || out.offer_coupon_code_asset_ref || out.offer_redeem_url_asset_ref || out.offer_terms_asset_ref) {
    fail(E.PROVIDER_OPTIONS_INVALID, 'event and offer fields belong to EVENT / OFFER posts only');
  }
  return Object.freeze(out);
}

function mapGoogleError(response) {
  const status = response.body?.error?.status;
  const table = {
    UNAUTHENTICATED: PE.AUTH_INVALID, PERMISSION_DENIED: PE.SCOPE_MISSING, INVALID_ARGUMENT: PE.INVALID_PAYLOAD, NOT_FOUND: PE.ACCOUNT_INVALID,
    RESOURCE_EXHAUSTED: PE.RATE_LIMITED, UNAVAILABLE: PE.PROVIDER_UNAVAILABLE, DEADLINE_EXCEEDED: PE.TIMEOUT, ALREADY_EXISTS: PE.PERMANENT_REJECTION,
    FAILED_PRECONDITION: PE.PERMANENT_REJECTION,
  };
  return status && table[status] ? { code: table[status], safeCode: status } : (status ? { safeCode: status } : {});
}

const interval = (isoStart, isoEnd) => {
  const s = new Date(isoStart); const e = new Date(isoEnd);
  const date = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  const time = (d) => ({ hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds(), nanos: 0 });
  return { startDate: date(s), startTime: time(s), endDate: date(e), endTime: time(e) };
};

export function createGoogleBusinessProfileAdapter({ http, timeoutMs, now = () => Date.now() } = {}) {
  requireHttp(http);
  const call = (request) => providerCall(http, request, { timeoutMs, mapError: mapGoogleError, now });

  const settle = (post, fallbackName) => {
    const name = post?.name ?? fallbackName;
    if (post?.state === 'REJECTED') throw new ProviderRejection({ code: PE.POLICY_VIOLATION, safeCode: 'REJECTED' });
    if (post?.state === 'LIVE' && name) {
      return outcome({
        outcome: 'PUBLISHED', provider_submission_id: name, provider_post_ids: [name], published_at: post.createTime ? new Date(Date.parse(post.createTime)).toISOString() : new Date(now()).toISOString(),
        search_url: typeof post.searchUrl === 'string' && post.searchUrl.startsWith('https://') ? post.searchUrl : null,
      });
    }
    if (name) return outcome({ outcome: 'PROCESSING', provider_submission_id: name }); // PROCESSING / SCHEDULED: not published yet
    throw new ProviderRejection({ code: PE.PERMANENT_REJECTION, safeCode: 'NO_LOCAL_POST' });
  };

  return {
    provider: CHANNEL_PROVIDER.GOOGLE_BUSINESS_PROFILE,
    // a timeout / 5xx on the creating call may have created the post: never retried blindly (SUBMISSION_OUTCOME_UNKNOWN, human review)
    ambiguousSubmitCodes: ['TIMEOUT', 'PROVIDER_UNAVAILABLE'],
    normalizeOptions: normalizeGoogleBusinessOptions,
    normalizeProviderError: normalizeThrown,

    /** Live access check on the designated location (list one local post). Never lists or picks other locations. */
    async verifyAccount({ connector, credential }) {
      if (!LOCATION.test(connector.external_id)) fail(E.CONNECTOR_EXTERNAL_ID_REQUIRED, 'the location must be accounts/{accountId}/locations/{locationId}');
      await call({ method: 'GET', url: `${HOST}/${connector.external_id}/localPosts`, headers: bearerHeader(credential), query: { pageSize: 1 } });
      return outcome({ account_state: 'LOCATION_ACCESSIBLE', display_name: null });
    },

    preflight({ connector, content, options }) {
      const reasons = [];
      if (!LOCATION.test(connector.external_id)) reasons.push('LOCATION_NOT_BOUND');
      if (options.location_ref && options.location_ref !== connector.external_id) reasons.push('LOCATION_MISMATCH');
      if (content.contentKind === 'IMAGE' && !content.transport) reasons.push('MEDIA_TRANSPORT_MISSING');
      return outcome({ status: reasons.length ? 'BLOCKED' : 'READY', reason_codes: reasons, review_signals: [] });
    },

    buildSubmission({ content, options }) {
      const text = (key) => (options[key] ? content.texts[options[key]] : undefined);
      const summary = options.summary_asset_ref ? text('summary_asset_ref') : content.ownText;
      const body = { topicType: options.topic_type, summary };
      if (options.language_code) body.languageCode = options.language_code;
      if (options.cta_action_type) {
        body.callToAction = { actionType: options.cta_action_type };
        if (options.cta_url_asset_ref) body.callToAction.url = text('cta_url_asset_ref');
      }
      if (content.contentKind === 'IMAGE') body.media = [{ mediaFormat: 'PHOTO', sourceUrl: content.transport.ephemeral_location }];
      if (options.topic_type !== 'STANDARD') {
        body.event = { title: text('event_title_asset_ref'), schedule: interval(options.event_start, options.event_end) };
      }
      if (options.topic_type === 'OFFER') {
        body.offer = {};
        if (options.offer_coupon_code_asset_ref) body.offer.couponCode = text('offer_coupon_code_asset_ref');
        if (options.offer_redeem_url_asset_ref) body.offer.redeemOnlineUrl = text('offer_redeem_url_asset_ref');
        if (options.offer_terms_asset_ref) body.offer.termsConditions = text('offer_terms_asset_ref');
      }
      return outcome({ kind: 'GBP_LOCAL_POST', body });
    },

    async submit({ connector, credential, submission }) {
      const res = await call({ method: 'POST', url: `${HOST}/${connector.external_id}/localPosts`, headers: bearerHeader(credential), body: submission.body });
      return settle(res.body, null);
    },

    async fetchStatus({ credential, providerSubmissionId }) {
      const res = await call({ method: 'GET', url: `${HOST}/${providerSubmissionId}`, headers: bearerHeader(credential) });
      return settle(res.body, providerSubmissionId);
    },
  };
}
