// Meta publishers for chantier E: Instagram (reuses the Activation adapter, which owns the container -> publish protocol) and Facebook
// Pages (new; Activation has none). Both speak the SAME small publisher port the Nordla publisher drives:
//
//   verifyConnection() -> { ok, reason?, display_name? }       live check of the account the credential designates
//   publish(post, { media, scheduleAt? }) -> { status: PUBLISHED | PROCESSING | SCHEDULED, submission_id?, post_id?, permalink?, scheduled_for? }
//   inspect(post) -> { exists, published, scheduled_for?, permalink? }     a LIVE read, never a cache
//   cancelScheduled(post) -> void
//   normalizeError(error) -> { code, retryable, unknown, retry_after_ms }
//
// Status of the facts below: Instagram follows the 2026-10-09 audit of the Activation layer, re-read on 2026-10-16 against the Meta
// "Content Publishing" page (media must be on a public URL at the time of the attempt, JPEG images only, 100 API posts / 24 h).
// Facebook Page facts (photos / feed / scheduled_publish_time / DELETE) come from the Pages API as I know it and are NOT yet
// verified against the live platform: every Facebook capability is tested against a fake only (see docs).
// NOTHING here has ever been called against a real account.

import { createInstagramAdapter } from '../../activation/providers/instagram.js';
import { PROVIDER_ERROR as PE } from '../../activation/constants.js';
import {
  ProviderRejection, normalizeThrown, providerCall,
} from '../../activation/providers/common.js';
import { seal } from '../../activation/validation.js';
import { FORMAT, MODE } from '../constants.js';
import { composeCaption } from '../post.js';

const IG_HOST = 'https://graph.instagram.com';
const FB_HOST = 'https://graph.facebook.com';
const VERSION = /^v\d+\.\d+$/;

function mapGraphError(response) {
  const error = response.body?.error ?? {};
  const code = Number(error.code);
  if (code === 190 || code === 102) return { code: PE.AUTH_INVALID, safeCode: code };
  if ([4, 17, 32, 613, 368].includes(code)) return { code: PE.RATE_LIMITED, safeCode: code };
  if (code === 10 || (code >= 200 && code < 300)) return { code: PE.SCOPE_MISSING, safeCode: code };
  if (code === 1 || code === 2) return { code: PE.PROVIDER_UNAVAILABLE, safeCode: code };
  if (response.status === 400) return { code: PE.INVALID_PAYLOAD, safeCode: Number.isFinite(code) ? code : 400 };
  return {};
}

const unknownOf = (e) => e instanceof ProviderRejection && ['TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(e.code);

/** { code, retryable, unknown, retry_after_ms } - no payload, no secret. */
export function normalizePublisherError(error) {
  const n = normalizeThrown(error);
  return Object.freeze({
    code: n.code, retryable: n.retryable && n.code !== PE.PUBLISH_RESULT_UNKNOWN, unknown: n.code === PE.PUBLISH_RESULT_UNKNOWN, retry_after_ms: n.retry_after_ms,
  });
}

const needVersion = (v) => { if (typeof v !== 'string' || !VERSION.test(v)) throw new TypeError('the Graph API version is configuration: pass graphVersion such as "v25.0"'); return v; };

async function credentialOf(credentials, platform) {
  const c = await credentials.resolve(platform);
  if (!c?.access_token || !c.account_id) throw new ProviderRejection({ code: PE.AUTH_INVALID, safeCode: 'NO_CREDENTIAL' });
  if (c.expires_at && Date.parse(c.expires_at) <= Date.now()) throw new ProviderRejection({ code: PE.AUTH_INVALID, safeCode: 'TOKEN_EXPIRED' });
  return { token: c.access_token, accountId: String(c.account_id) };
}

// ------------------------------------------------------------------------------------------------------------------------------------
export function createInstagramPublisher({
  http, graphVersion, credentials, timeoutMs, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), settleTries = 3, settleWaitMs = 2000,
}) {
  needVersion(graphVersion);
  const adapter = createInstagramAdapter({ http, graphVersion, timeoutMs });
  const call = (request) => providerCall(http, request, { timeoutMs, mapError: mapGraphError });
  const base = `${IG_HOST}/${graphVersion}`;
  const pack = async () => {
    const { token, accountId } = await credentialOf(credentials, 'instagram');
    return { connector: { external_id: accountId }, credential: { access_token: seal(token) }, token, accountId };
  };

  return {
    platform: 'instagram',
    mode: MODE.LIVE,
    capabilities: Object.freeze({ formats: [FORMAT.IMAGE, FORMAT.REEL], native_scheduling: false, image_types: ['image/jpeg'], max_caption: 2200 }),
    normalizeError: normalizePublisherError,

    async verifyConnection() {
      const { connector, credential } = await pack();
      const r = await adapter.verifyAccount({ connector, credential });
      if (!r.professional) return { ok: false, reason: 'ACCOUNT_NOT_PROFESSIONAL' };
      if (!r.id_matches) return { ok: false, reason: 'ACCOUNT_MISMATCH' };
      return { ok: true, display_name: r.display_name, account_type: r.account_state };
    },

    async publish(post, { media, onProgress = async () => {} }) {
      const { connector, credential } = await pack();
      let containerId = post.publication?.submission_id ?? null; // a container already exists: resume, never create a second one
      if (!containerId) {
        const content = {
          contentKind: post.format === FORMAT.REEL ? 'VIDEO' : 'IMAGE',
          transport: { content_type: media.content_type, ephemeral_location: seal(media.url) },
          texts: { caption: composeCaption(post) },
        };
        const built = adapter.buildSubmission({ content, options: { caption_asset_ref: 'caption' } });
        const submission = post.asset?.ai_generated ? { ...built, params: { ...built.params, is_ai_generated: true } } : built;
        const created = await adapter.submit({ connector, credential, submission });
        containerId = created.provider_submission_id;
        await onProgress({ submission_id: containerId }); // durable BEFORE the publish step: a failure there resumes this container
      }
      for (let i = 0; i < settleTries; i += 1) {
        const r = await adapter.fetchStatus({ connector, credential, providerSubmissionId: containerId });
        if (r.outcome === 'PUBLISHED') return { status: 'PUBLISHED', submission_id: containerId, post_id: r.provider_post_ids[0] ?? null, permalink: null };
        if (i < settleTries - 1) await sleep(settleWaitMs);
      }
      return { status: 'PROCESSING', submission_id: containerId };
    },

    async inspect(post) {
      const { token } = await pack();
      const id = post.publication?.post_id;
      if (!id) return { exists: false, published: false };
      try {
        const res = await call({ method: 'GET', url: `${base}/${id}`, query: { fields: 'id,permalink,timestamp,media_type', access_token: seal(token) } });
        return { exists: String(res.body?.id) === String(id), published: true, permalink: res.body?.permalink ?? null, published_at: res.body?.timestamp ?? null };
      } catch (e) {
        if (e instanceof ProviderRejection && (e.safe_provider_code === '100' || e.code === PE.ACCOUNT_INVALID)) return { exists: false, published: false };
        throw e;
      }
    },

    async cancelScheduled() { /* Instagram has no platform-side schedule in this integration */ },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------
export function createFacebookPagePublisher({ http, graphVersion, credentials, timeoutMs }) {
  needVersion(graphVersion);
  const call = (request) => providerCall(http, request, { timeoutMs, mapError: mapGraphError });
  const base = `${FB_HOST}/${graphVersion}`;
  const pack = () => credentialOf(credentials, 'facebook');

  // A creating call that times out or fails on the server side may have created the post: its outcome is unknown, never "failed".
  async function creating(request) {
    try { return await call(request); } catch (e) {
      if (unknownOf(e)) throw new ProviderRejection({ code: PE.PUBLISH_RESULT_UNKNOWN, safeCode: e.code });
      throw e;
    }
  }

  return {
    platform: 'facebook',
    mode: MODE.LIVE,
    capabilities: Object.freeze({
      formats: [FORMAT.IMAGE, FORMAT.TEXT], native_scheduling: true, image_types: ['image/jpeg', 'image/png'], max_caption: 2200, schedule_min_lead_ms: 15 * 60_000, schedule_max_lead_ms: 28 * 86_400_000,
    }),
    normalizeError: normalizePublisherError,

    async verifyConnection() {
      const { token, accountId } = await pack();
      const res = await call({ method: 'GET', url: `${base}/${accountId}`, query: { fields: 'id,name', access_token: seal(token) } });
      if (String(res.body?.id) !== accountId) return { ok: false, reason: 'ACCOUNT_MISMATCH' };
      return { ok: true, display_name: res.body?.name ?? null };
    },

    async publish(post, { media, scheduleAt = null }) {
      const { token, accountId } = await pack();
      const message = composeCaption(post);
      const body = { access_token: seal(token) };
      if (scheduleAt) Object.assign(body, { published: false, scheduled_publish_time: Math.floor(Date.parse(scheduleAt) / 1000), unpublished_content_type: 'SCHEDULED' });
      let res;
      if (post.format === FORMAT.IMAGE) {
        res = await creating({ method: 'POST', url: `${base}/${accountId}/photos`, body: { ...body, url: seal(media.url), caption: message } });
      } else {
        res = await creating({ method: 'POST', url: `${base}/${accountId}/feed`, body: { ...body, message } });
      }
      const postId = res.body?.post_id ?? res.body?.id;
      if (!postId) throw new ProviderRejection({ code: PE.PUBLISH_RESULT_UNKNOWN, safeCode: 'NO_POST_ID' });
      return scheduleAt
        ? { status: 'SCHEDULED', post_id: String(postId), scheduled_for: new Date(Date.parse(scheduleAt)).toISOString() }
        : { status: 'PUBLISHED', post_id: String(postId), permalink: null };
    },

    async inspect(post) {
      const { token } = await pack();
      const id = post.publication?.post_id;
      if (!id) return { exists: false, published: false };
      try {
        const res = await call({ method: 'GET', url: `${base}/${id}`, query: { fields: 'id,is_published,scheduled_publish_time,permalink_url,created_time', access_token: seal(token) } });
        const scheduled = res.body?.scheduled_publish_time ? new Date(Number(res.body.scheduled_publish_time) * 1000).toISOString() : null;
        return { exists: true, published: res.body?.is_published !== false, scheduled_for: scheduled, permalink: res.body?.permalink_url ?? null };
      } catch (e) {
        if (e instanceof ProviderRejection && (e.safe_provider_code === '100' || e.code === PE.ACCOUNT_INVALID)) return { exists: false, published: false };
        throw e;
      }
    },

    async cancelScheduled(post) {
      const { token } = await pack();
      const id = post.publication?.platform_schedule?.post_id ?? post.publication?.post_id;
      if (!id) return;
      try {
        await call({ method: 'DELETE', url: `${base}/${id}`, query: { access_token: seal(token) } });
      } catch (e) {
        if (e instanceof ProviderRejection && (e.safe_provider_code === '100' || e.code === PE.ACCOUNT_INVALID)) return; // already gone: the goal is reached
        throw e;
      }
    },
  };
}
