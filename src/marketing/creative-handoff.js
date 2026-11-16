// CreativeHandoffPackage: what Marketing hands to Creative Intelligence - the Brief plus the Brand's creative interface.
//
// M3 stops at the handoff. It calls no model or provider (no Qwen, Alibaba, OpenAI, Runway, local image/video/text model),
// routes nothing and selects nothing; the experimental integrations in src/marketing-creative/* are not activated by M3.
// The Brand interface is EXACTLY what Branding exposes (`creativeBrandInterface`): Brand Memory is neither rebuilt nor copied by hand.
//
// `status_snapshot` records that the live gate was READY at created_at. It is a snapshot, never an authority: a live answer is
// always recomputed from the originals (see evaluateBriefReadiness).

import { creativeBrandInterface } from '../branding/interfaces.js';
import { MKT_ERROR as E } from './understand-constants.js';
import { BRIEF_READINESS, FORBIDDEN_BRIEF_KEYS, M3_ERROR as Z, MARKETING_CREATE_VERSION } from './m3-constants.js';
import { normalizeCreativeBrief } from './creative-brief.js';
import { assertCreateReady, resolveCreateContext } from './create-gate.js';
import { rejectKeysDeep } from './m3-validation.js';
import {
  closedObject, deepFreeze, deriveId, fail, isoTimestamp, toMs,
} from './understand-validation.js';

const OPTION_KEYS = ['tenant', 'finding', 'decisionPackage', 'push', 'authorization', 'brandContext', 'asOf', 'brief', 'expires_at'];
// objects owned by other domains are not scanned for creative keys (a Brand design-token set legitimately has "typography")
const OWNED_BY_OTHERS = ['tenant', 'finding', 'decisionPackage', 'push', 'authorization', 'brandContext', 'brief'];

/**
 * @param {object} p the originals { tenant, finding, decisionPackage, push, authorization, brandContext, asOf } + the stored `brief`
 *                   + an optional `expires_at` (<= brief.expires_at; defaults to it)
 */
export function buildCreativeHandoff(options = {}) {
  rejectKeysDeep(Object.fromEntries(Object.entries(options).filter(([key]) => !OWNED_BY_OTHERS.includes(key))), FORBIDDEN_BRIEF_KEYS, Z.FORBIDDEN_CREATIVE_FIELD, 'handoff');
  closedObject(options, OPTION_KEYS, 'handoff');
  const { brief, expires_at: expiresInput, ...context } = options;

  const resolved = assertCreateReady(resolveCreateContext(context));
  const storedBrief = normalizeCreativeBrief(brief, context); // re-validated against the originals, derived fields recomputed
  if (toMs(storedBrief.expires_at) <= toMs(resolved.asOfIso)) fail(Z.BRIEF_STALE, 'the Brief has expired');

  const brandInterface = creativeBrandInterface(context.brandContext); // exactly the Branding interface, nothing rebuilt here
  if (brandInterface.brand.brand_id !== storedBrief.brand_id) fail(Z.BRAND_MISMATCH, 'the Brand interface is about another brand than the Brief');

  const expiresAt = expiresInput == null ? storedBrief.expires_at : isoTimestamp(expiresInput, 'handoff.expires_at');
  if (toMs(expiresAt) <= toMs(resolved.asOfIso)) fail(E.INVALID_FIELD, 'handoff.expires_at must be after created_at', { field: 'handoff.expires_at' });
  if (toMs(expiresAt) > toMs(storedBrief.expires_at)) fail(Z.HANDOFF_OUTLIVES_BRIEF, 'a handoff cannot outlive its Brief');

  const body = {
    schema_version: MARKETING_CREATE_VERSION,
    creative_brief: storedBrief,
    brand_interface: brandInterface,
    created_at: resolved.asOfIso,
    expires_at: expiresAt,
    status_snapshot: { status: BRIEF_READINESS.READY_FOR_CREATIVE, as_of: resolved.asOfIso },
  };
  return deepFreeze({ handoff_id: deriveId('mch', body), ...body });
}
