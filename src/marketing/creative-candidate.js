// SelectedCreativeCandidate: the contract of a candidate that Creative Intelligence has CHOSEN (contract only - M3 builds no
// Creative Intelligence). `selection_ref` means Creative Intelligence made the selection; M3 never re-evaluates it
// artistically. No prompt, model, provider, cost, quality score or winner score can be stored; assets are opaque refs
// (no raw media, no signed or credentialed URL, no base64).
//
// Trust boundary: the candidate comes from a trusted server-side adapter; M3 validates its form and its scope against the Brief.

import { CONTENT_KIND } from '../branding/constants.js';
import { MKT_ERROR as E } from './understand-constants.js';
import { FORBIDDEN_CANDIDATE_KEYS, M3_ERROR as Z, MAX_CANDIDATE_ASSETS } from './m3-constants.js';
import { rejectKeysDeep, safeRef, safeRefList } from './m3-validation.js';
import {
  closedObject, deepFreeze, enumValue, fail, idValue, isPlainObject, isoTimestamp, toMs, upperToken, uuidValue,
} from './understand-validation.js';

const KEYS = [
  'candidate_id', 'merchant_id', 'brand_id', 'brief_ref', 'deliverable_ref', 'selection_ref', 'content_kind', 'channel', 'asset_refs',
  'provenance_ref', 'selected_at', 'candidate_expires_at',
];

/**
 * @param {object} input the candidate supplied by a trusted Creative Intelligence adapter
 * @param {object} p { brief } the already re-validated Brief it must belong to
 *
 * Scope: same merchant, same brand, brief_ref == brief.brief_id, an existing deliverable, same content_kind and channel as that
 * deliverable, candidate_expires_at <= brief.expires_at. Freshness against a live clock is evaluated by the callers.
 */
export function normalizeSelectedCreativeCandidate(input, { brief } = {}) {
  if (!isPlainObject(brief)) fail(E.INVALID_FIELD, 'a candidate is validated against its Brief', { field: 'candidate' });
  rejectKeysDeep(input, FORBIDDEN_CANDIDATE_KEYS, Z.FORBIDDEN_CREATIVE_FIELD, 'candidate');
  closedObject(input, KEYS, 'candidate');

  if (uuidValue(input.merchant_id, 'candidate.merchant_id') !== brief.merchant_id) fail(Z.CANDIDATE_TENANT_MISMATCH, 'the candidate belongs to another merchant than the Brief');
  if (uuidValue(input.brand_id, 'candidate.brand_id') !== brief.brand_id) fail(Z.CANDIDATE_BRAND_MISMATCH, 'the candidate belongs to another brand than the Brief');
  const briefRef = safeRef(input.brief_ref, 'candidate.brief_ref');
  if (briefRef !== brief.brief_id) fail(Z.CANDIDATE_BRIEF_MISMATCH, 'the candidate answers another Brief');

  const deliverableRef = safeRef(input.deliverable_ref, 'candidate.deliverable_ref');
  const spec = brief.deliverables.find((d) => d.deliverable_id === deliverableRef);
  if (!spec) fail(Z.CANDIDATE_UNKNOWN_DELIVERABLE, 'the candidate answers a deliverable the Brief does not contain');
  const contentKind = enumValue(input.content_kind, CONTENT_KIND, 'candidate.content_kind');
  if (contentKind !== spec.content_kind) fail(Z.CANDIDATE_KIND_MISMATCH, 'the candidate content_kind differs from its deliverable');
  const channel = upperToken(input.channel, 'candidate.channel');
  if (channel !== spec.channel) fail(Z.CANDIDATE_CHANNEL_MISMATCH, 'the candidate channel differs from its deliverable');

  const assetRefs = safeRefList(input.asset_refs, 'candidate.asset_refs', { max: MAX_CANDIDATE_ASSETS });
  if (!assetRefs.length) fail(E.INVALID_FIELD, 'a candidate needs at least one asset_ref', { field: 'candidate.asset_refs' });

  const selectedAt = isoTimestamp(input.selected_at, 'candidate.selected_at');
  const expiresAt = isoTimestamp(input.candidate_expires_at, 'candidate.candidate_expires_at', Z.CANDIDATE_INVALID_EXPIRY);
  if (toMs(expiresAt) <= toMs(selectedAt)) fail(Z.CANDIDATE_INVALID_EXPIRY, 'candidate_expires_at must be after selected_at');
  if (toMs(expiresAt) > toMs(brief.expires_at)) fail(Z.CANDIDATE_OUTLIVES_BRIEF, 'a candidate cannot outlive its Brief');

  return deepFreeze({
    candidate_id: idValue(input.candidate_id, 'candidate.candidate_id'),
    merchant_id: brief.merchant_id,
    brand_id: brief.brand_id,
    brief_ref: briefRef,
    deliverable_ref: deliverableRef,
    selection_ref: safeRef(input.selection_ref, 'candidate.selection_ref'),
    content_kind: contentKind,
    channel,
    asset_refs: assetRefs,
    provenance_ref: safeRef(input.provenance_ref, 'candidate.provenance_ref'),
    selected_at: selectedAt,
    candidate_expires_at: expiresAt,
  });
}
