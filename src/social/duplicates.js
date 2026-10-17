// Duplicate content (audit finding D4): two posts, even from two different proposals, that would put the SAME thing in the SAME place.
//
// "The same thing in the same place" = same platform, same format, same account, same picture file(s) (by sha-256, not by reference or version), same text and hashtags once
// whitespace is normalised. The date, the subject and the proposal id are NOT part of it: a copy under another proposal id is still a copy.
//
// Two cases are told apart:
//   - UNINTENDED duplicate: refused when the second post is approved, scheduled, retried or claimed (SOCIAL_DUPLICATE_CONTENT). Nothing is merged or deleted automatically.
//   - AUTHORISED republication: the OWNER approves the second post naming the posts it duplicates (`allow_duplicate_of`) and giving a reason (`duplicate_note`). That acknowledgement is
//     part of the SIGNED approval (integrity.js): it cannot be added to a post by editing the data folder, and any change of the content voids it with the approval.
//   Consent is mutual: if either post acknowledges the other, the pair is allowed.
import { createHash } from 'node:crypto';
import { POST_STATE as S, SOCIAL_ERROR as E, fail } from './constants.js';
import { canonical, composeCaption } from './post.js';

/** States in which a post holds its place: decided by the owner, or possibly on the platform already. */
export const HOLDING_STATES = Object.freeze([S.APPROVED, S.SCHEDULED, S.PUBLISHING, S.PUBLISHED, S.VERIFIED, S.PUBLICATION_UNKNOWN]);
/** States in which the platform may already have it: nothing can take it back. */
export const OUT_THERE_STATES = Object.freeze([S.PUBLISHING, S.PUBLISHED, S.VERIFIED, S.PUBLICATION_UNKNOWN]);

const normalizeText = (t) => String(t ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

export function contentFingerprint(post) {
  const assets = (post.assets ?? (post.asset ? [post.asset] : [])).map((a) => a.sha256);
  return createHash('sha256').update(canonical({
    platform: post.platform, format: post.format, account_ref: post.account_ref ?? null, assets, text: normalizeText(composeCaption(post)),
  })).digest('hex');
}

/** Other posts with the same fingerprint (an empty text-less, picture-less post is never a duplicate of anything). */
export function duplicatesOf(post, all, states = HOLDING_STATES) {
  if (!post.asset && !post.assets && !normalizeText(post.caption)) return [];
  const mine = contentFingerprint(post);
  return all.filter((q) => q.id !== post.id && states.includes(q.state) && contentFingerprint(q) === mine);
}

const acknowledged = (a, b) => (a.approval?.duplicate_ack?.of ?? []).includes(b.id) || (b.approval?.duplicate_ack?.of ?? []).includes(a.id);
/** The duplicates the owner has NOT accepted (mutual consent, from the signed approvals). */
export const unacknowledgedDuplicates = (post, all, states = HOLDING_STATES) => duplicatesOf(post, all, states).filter((q) => !acknowledged(post, q));

const brief = (q) => ({ id: q.id, proposal_id: q.origin?.proposal_id ?? null, state: q.state, publish_at: q.publish_at ?? null });

/**
 * Called when the owner APPROVES `post`: returns the acknowledgement to sign into the approval (or null), or refuses.
 * `params.allow_duplicate_of`: ids of the duplicates the owner accepts; `params.duplicate_note`: why (at least 8 characters).
 */
export function acknowledgementFor(post, all, params = {}) {
  const rivals = duplicatesOf(post, all);
  if (!rivals.length) return null;
  const allowed = Array.isArray(params.allow_duplicate_of) ? params.allow_duplicate_of : [];
  const missing = rivals.filter((q) => !allowed.includes(q.id));
  if (missing.length) fail(E.DUPLICATE_CONTENT, 'DUPLICATE_CONTENT: an identical post already holds this place; approve it again naming it in allow_duplicate_of with a duplicate_note if the republication is intended', { duplicates: rivals.map(brief) });
  const note = String(params.duplicate_note ?? '').trim();
  if (note.length < 8) fail(E.DUPLICATE_CONTENT, 'a deliberate republication needs a reason (duplicate_note, at least 8 characters)', { duplicates: rivals.map(brief) });
  return { of: rivals.map((q) => q.id).sort(), note: note.slice(0, 300) };
}

/** Called before schedule / retry / manual-schedule: the post may not hold a place that an unacknowledged identical post holds. */
export function assertNoUnacknowledgedDuplicate(post, all) {
  const rivals = unacknowledgedDuplicates(post, all);
  if (rivals.length) fail(E.DUPLICATE_CONTENT, 'DUPLICATE_CONTENT: an identical post already holds this place and the owner did not accept the republication', { duplicates: rivals.map(brief) });
}
