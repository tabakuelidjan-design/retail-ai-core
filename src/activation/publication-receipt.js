// ChannelPublicationReceipt: the proof that ONE delivery was really published on ONE connected account.
//
// Produced ONLY from a job that is PUBLISHED (confirmed by the provider status, never from a submission / init / container). It holds
// the provider post id, the publication time and refs - no token, no signed URL, no raw provider response, no caption.
// It does not say the marketing worked: published != engaged != profitable != incremental (M4 judges, later).

import { ACT_ERROR as E, ACTIVATION_VERSION, JOB_STATE } from './constants.js';
import {
  assertNoSecrets, deepFreeze, deriveId, fail, iso, isPlainObject, sortedUnique,
} from './validation.js';

const POST_ID = /^[A-Za-z0-9_.:/~+-]{1,200}$/;
const REF_SAFE = (value) => String(value).replace(/[^A-Za-z0-9:_./#-]/g, '-');
const METADATA_KEYS = ['post_id_kind', 'permalink'];

// Only a public https permalink without query, credentials or fragment may be kept.
export function sanitizeSafeMetadata(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  if (typeof raw.post_id_kind === 'string' && /^[A-Z_]{3,40}$/.test(raw.post_id_kind)) out.post_id_kind = raw.post_id_kind;
  const link = raw.permalink ?? raw.search_url;
  if (typeof link === 'string') {
    try {
      const url = new URL(link);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) out.permalink = url.toString();
    } catch { /* not a URL: dropped */ }
  }
  return out;
}

/** @param {object} job a PUBLISHED job as returned by the repository */
export function buildChannelPublicationReceipt(job) {
  if (!isPlainObject(job) || job.state !== JOB_STATE.PUBLISHED) fail(E.RECEIPT_NOT_PUBLISHED, 'a publication receipt exists only for a job the provider confirmed as PUBLISHED');
  if (typeof job.provider_post_id !== 'string' || !POST_ID.test(job.provider_post_id)) fail(E.RECEIPT_POST_ID_REQUIRED, 'a publication receipt needs the provider post id');
  if (!job.published_at) fail(E.RECEIPT_PUBLISHED_AT_REQUIRED, 'a publication receipt needs the publication time');
  const submission = job.provider_submission_id && POST_ID.test(job.provider_submission_id) ? job.provider_submission_id : null;
  const body = {
    schema_version: ACTIVATION_VERSION,
    merchant_id: job.merchant_id,
    brand_id: job.brand_id,
    activation_manifest_ref: job.activation_manifest_ref,
    manifest_delivery_ref: job.manifest_delivery_ref,
    connector_id: job.connector_id,
    provider: job.provider,
    provider_submission_id: submission,
    provider_post_id: job.provider_post_id,
    published_at: iso(job.published_at, 'published_at'),
    evidence_refs: sortedUnique([
      `provider-post://${job.provider}/${REF_SAFE(job.provider_post_id)}`,
      ...(submission ? [`provider-submission://${job.provider}/${REF_SAFE(submission)}`] : []),
    ]),
    safe_metadata: sanitizeSafeMetadata(job.safe_metadata),
  };
  assertNoSecrets(body, 'publication receipt');
  return deepFreeze({ receipt_id: deriveId('acr', body), ...body });
}

export { METADATA_KEYS };
