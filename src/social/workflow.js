// The approval workflow: pure functions, no I/O. (post, action, actor) -> new post. The store makes it durable, the publisher drives the
// system-only actions. Rules that never bend:
//   - only the OWNER approves, schedules, revokes, retries, reconciles or attests - and approval names the exact content_hash it saw;
//   - ANY change to what is published (asset version, caption, hashtags, account, subject, platform, format, publish_at) sends the post
//     back to DRAFT and wipes the approval; an approval whose hash no longer matches is worthless, whatever the state says;
//   - a post that may already exist on a platform (PUBLISHING, PUBLICATION_UNKNOWN, PUBLISHED, VERIFIED) is frozen.

import {
  EDITABLE_STATES, FROZEN_STATES, MODE, OWNER_ACTIONS, POST_STATE as S, ROLE, SOCIAL_ERROR as E, TRANSITIONS, SocialError, fail,
} from './constants.js';
import {
  contentHashOf, lintClaims, normalizeContent, readinessProblems,
} from './post.js';

const clone = (v) => structuredClone(v);
const MIN_SCHEDULE_LEAD_MS = 2 * 60 * 1000;
export const hasValidApproval = (post) => Boolean(post.approval && post.approval.content_hash === contentHashOf(post));

function record(post, { action, actor, from, to, now, note = null, detail = null }) {
  post.history.push({
    seq: post.history.length + 1, at: now, actor: { id: actor.id, role: actor.role }, action, from, to, content_hash: contentHashOf(post), ...(note ? { note } : {}), ...(detail ? { detail } : {}),
  });
  post.rev += 1;
  post.updated_at = now;
  post.state = to;
  return post;
}

/** The platform holds a scheduled copy: remember, durably and in the same write, that it must be removed. */
function armRemoteCancel(post) {
  const held = post.publication?.platform_schedule;
  if (!held) return false;
  post.publication = { ...post.publication, remote_cancel_pending: { post_id: held.post_id }, platform_schedule: null };
  return true;
}

function allow(post, to) {
  if (!TRANSITIONS[post.state]?.includes(to)) fail(E.TRANSITION, `${post.state} -> ${to} is not allowed`, { from: post.state, to });
}
function requireRole(action, actor) {
  if (OWNER_ACTIONS.includes(action) && actor.role !== ROLE.OWNER) fail(E.FORBIDDEN, `only the owner may ${action}: Nordla never takes that decision`, { action });
  if (!OWNER_ACTIONS.includes(action) && SYSTEM_ACTIONS.includes(action) && actor.role !== ROLE.SYSTEM) fail(E.FORBIDDEN, `${action} is reserved to the publisher`, { action });
}
const SYSTEM_ACTIONS = ['annotate', 'claim', 'mark_published', 'retry_later', 'mark_error', 'mark_unknown', 'mark_verified', 'platform_scheduled'];

function requireExactVersion(post, params) {
  if (!params.expected_hash) fail(E.STALE_VERSION, 'the decision must name the content_hash that was shown to the owner', { current: contentHashOf(post) });
  if (params.expected_hash !== contentHashOf(post)) fail(E.STALE_VERSION, 'the content changed since it was shown: look at the new version before deciding', { current: contentHashOf(post) });
}
function requireReady(post, confirmed) {
  const problems = readinessProblems(post, { confirmed });
  if (problems.length) fail(E.CLAIMS, `the post is not ready: ${problems.join(', ')}`, { problems });
}

const HANDLERS = {
  submit(post, { actor, now, params }) {
    if (![S.DRAFT, S.NEEDS_CHANGES].includes(post.state)) fail(E.TRANSITION, `cannot submit from ${post.state}`);
    allow(post, S.READY_FOR_REVIEW);
    requireReady(post, params.confirmed);
    return record(post, { action: 'submit', actor, from: post.state, to: S.READY_FOR_REVIEW, now });
  },
  withdraw(post, { actor, now }) {
    allow(post, S.DRAFT);
    return record(post, { action: 'withdraw', actor, from: post.state, to: S.DRAFT, now });
  },
  approve(post, { actor, now, params }) {
    allow(post, S.APPROVED);
    requireExactVersion(post, params);
    requireReady(post, params.confirmed);
    post.approval = { approved_by: actor.id, approved_at: now, content_hash: contentHashOf(post) };
    return record(post, { action: 'approve', actor, from: post.state, to: S.APPROVED, now, note: params.note });
  },
  reject(post, { actor, now, params }) {
    allow(post, S.REJECTED);
    requireExactVersion(post, params);
    return record(post, { action: 'reject', actor, from: post.state, to: S.REJECTED, now, note: params.note });
  },
  request_changes(post, { actor, now, params }) {
    allow(post, S.NEEDS_CHANGES);
    requireExactVersion(post, params);
    if (!params.note?.trim()) fail(E.INVALID, 'say what must be corrected', { field: 'note' });
    return record(post, { action: 'request_changes', actor, from: post.state, to: S.NEEDS_CHANGES, now, note: params.note });
  },
  revoke_approval(post, { actor, now, params }) {
    if (![S.APPROVED, S.SCHEDULED].includes(post.state)) fail(E.TRANSITION, `nothing to revoke in ${post.state}`);
    allow(post, S.READY_FOR_REVIEW);
    post.approval = null;
    const remote = armRemoteCancel(post);
    return record(post, { action: 'revoke_approval', actor, from: post.state, to: S.READY_FOR_REVIEW, now, note: params.note, detail: remote ? { needs_remote_cancel: true } : null });
  },
  schedule(post, { actor, now, params }) {
    allow(post, S.SCHEDULED);
    requireExactVersion(post, params);
    if (!hasValidApproval(post)) fail(E.NO_VALID_APPROVAL, 'the approval does not cover this exact version');
    requireReady(post, params.confirmed);
    if (post.publication?.remote_cancel_pending) fail(E.CONFLICT, 'a previous scheduled copy is still being removed at the platform: try again once it is confirmed gone');
    if (!post.publish_at) fail(E.INVALID, 'choose a date and time before scheduling', { field: 'publish_at' });
    if (Date.parse(post.publish_at) < Date.parse(now) + MIN_SCHEDULE_LEAD_MS) fail(E.INVALID, 'publish_at must be at least 2 minutes in the future', { field: 'publish_at' });
    return record(post, { action: 'schedule', actor, from: post.state, to: S.SCHEDULED, now });
  },
  unschedule(post, { actor, now }) {
    if (post.state !== S.SCHEDULED) fail(E.TRANSITION, 'only a scheduled post can be unscheduled');
    allow(post, S.APPROVED);
    const remote = armRemoteCancel(post);
    return record(post, { action: 'unschedule', actor, from: post.state, to: S.APPROVED, now, detail: remote ? { needs_remote_cancel: true } : null });
  },
  cancel(post, { actor, now, params }) {
    if (post.state === S.PUBLISHING) fail(E.TRANSITION, 'a publication is in flight: wait for its outcome');
    allow(post, S.CANCELLED);
    const remote = armRemoteCancel(post);
    return record(post, { action: 'cancel', actor, from: post.state, to: S.CANCELLED, now, note: params.note, detail: remote ? { needs_remote_cancel: true } : null });
  },
  retry(post, { actor, now }) {
    if (post.state !== S.ERROR) fail(E.TRANSITION, 'only a post in ERROR can be retried');
    if (!hasValidApproval(post)) fail(E.NO_VALID_APPROVAL, 'the approval does not cover this exact version: approve it again');
    allow(post, S.SCHEDULED);
    post.publication = { ...(post.publication ?? {}), retry_authorized_at: now, platform_schedule: null };
    return record(post, { action: 'retry', actor, from: post.state, to: S.SCHEDULED, now });
  },
  reconcile(post, { actor, now, params }) {
    if (post.state !== S.PUBLICATION_UNKNOWN) fail(E.TRANSITION, 'only an unknown outcome needs reconciliation');
    if (params.outcome === 'published') {
      if (!params.permalink || !/^https:\/\//.test(params.permalink)) fail(E.INVALID, 'give the link of the post as proof', { field: 'permalink' });
      allow(post, S.PUBLISHED);
      post.publication = { ...(post.publication ?? {}), mode: MODE.MANUAL, permalink: params.permalink, post_id: params.post_id ?? null, published_at: params.published_at ?? now, reconciled: true };
      return record(post, { action: 'reconcile', actor, from: post.state, to: S.PUBLISHED, now, note: 'owner confirmed the post exists' });
    }
    if (params.outcome === 'not_published') {
      allow(post, S.SCHEDULED);
      post.publication = { ...(post.publication ?? {}), retry_authorized_at: now, submission_id: null, platform_schedule: null, reconciled: true };
      return record(post, { action: 'reconcile', actor, from: post.state, to: S.SCHEDULED, now, note: 'owner confirmed nothing was published' });
    }
    return fail(E.INVALID, "outcome must be 'published' or 'not_published'", { field: 'outcome' });
  },
  attest_manual(post, { actor, now, params }) {
    if (![S.APPROVED, S.SCHEDULED, S.ERROR].includes(post.state)) fail(E.TRANSITION, `cannot attest a manual publication from ${post.state}`);
    if (!hasValidApproval(post)) fail(E.NO_VALID_APPROVAL, 'the approval does not cover this exact version');
    if (!params.permalink || !/^https:\/\//.test(params.permalink)) fail(E.INVALID, 'give the link of the published post', { field: 'permalink' });
    allow(post, S.PUBLISHED);
    post.publication = { ...(post.publication ?? {}), mode: MODE.MANUAL, permalink: params.permalink, post_id: null, published_at: params.published_at ?? now, attempts: post.publication?.attempts ?? 0 };
    return record(post, { action: 'attest_manual', actor, from: post.state, to: S.PUBLISHED, now, note: 'published by hand, attested by the owner' });
  },
  // --- system-only ----------------------------------------------------------------------------------------------------------------
  claim(post, { actor, now, params }) {
    allow(post, S.PUBLISHING);
    if (!hasValidApproval(post)) fail(E.NO_VALID_APPROVAL, 'the approval does not cover this exact version');
    post.publication = {
      ...(post.publication ?? {}), claim_id: params.claim_id, claimed_at: now, attempts: (post.publication?.attempts ?? 0) + 1,
    };
    return record(post, { action: 'claim', actor, from: post.state, to: S.PUBLISHING, now });
  },
  mark_published(post, { actor, now, params }) {
    allow(post, S.PUBLISHED);
    post.publication = {
      ...(post.publication ?? {}), mode: params.mode, submission_id: params.submission_id ?? post.publication?.submission_id ?? null, post_id: params.post_id ?? null,
      permalink: params.permalink ?? null, published_at: params.published_at ?? now,
    };
    return record(post, { action: 'mark_published', actor, from: post.state, to: S.PUBLISHED, now, detail: { mode: params.mode } });
  },
  platform_scheduled(post, { actor, now, params }) { // the platform itself holds the scheduled post: Nordla uptime no longer matters
    if (post.state !== S.PUBLISHING) fail(E.TRANSITION, 'platform scheduling follows a claim');
    allow(post, S.SCHEDULED);
    post.publication = {
      ...(post.publication ?? {}), mode: params.mode, platform_schedule: { post_id: params.post_id, scheduled_for: params.scheduled_for, confirmed_at: now }, post_id: params.post_id,
    };
    return record(post, { action: 'platform_scheduled', actor, from: post.state, to: S.SCHEDULED, now, detail: { mode: params.mode } });
  },
  retry_later(post, { actor, now, params }) {
    allow(post, S.SCHEDULED);
    post.publication = { ...(post.publication ?? {}), next_attempt_at: params.next_attempt_at, last_error: params.code, submission_id: params.submission_id ?? post.publication?.submission_id ?? null };
    return record(post, { action: 'retry_later', actor, from: post.state, to: S.SCHEDULED, now, detail: { code: params.code } });
  },
  mark_error(post, { actor, now, params }) {
    allow(post, S.ERROR);
    post.publication = { ...(post.publication ?? {}), last_error: params.code };
    return record(post, { action: 'mark_error', actor, from: post.state, to: S.ERROR, now, detail: { code: params.code } });
  },
  mark_unknown(post, { actor, now, params }) {
    allow(post, S.PUBLICATION_UNKNOWN);
    post.publication = { ...(post.publication ?? {}), last_error: params.code };
    return record(post, { action: 'mark_unknown', actor, from: post.state, to: S.PUBLICATION_UNKNOWN, now, detail: { code: params.code } });
  },
  annotate(post, { actor, now, params }) { // a fact worth keeping in the history, no state change (failed verification, remote cancel pending...)
    if (params.publication) post.publication = { ...(post.publication ?? {}), ...params.publication };
    return record(post, { action: 'annotate', actor, from: post.state, to: post.state, now, note: params.note, detail: params.detail });
  },
  verify_manual(post, { actor, now, params }) {
    if (post.state !== S.PUBLISHED || post.publication?.mode !== MODE.MANUAL) fail(E.TRANSITION, 'only a manually published post is verified by the owner');
    allow(post, S.VERIFIED);
    post.verification = { at: now, mode: 'MANUAL_ATTESTED', permalink: post.publication.permalink ?? null, evidence: params.note ?? null };
    return record(post, { action: 'verify_manual', actor, from: post.state, to: S.VERIFIED, now, note: 'the owner looked at the live post' });
  },
  mark_verified(post, { actor, now, params }) {
    allow(post, S.VERIFIED);
    if (![MODE.LIVE, MODE.MANUAL].includes(post.publication?.mode)) fail(E.TRANSITION, 'a simulated publication can never be VERIFIED');
    post.verification = { at: now, mode: params.mode, permalink: params.permalink ?? post.publication?.permalink ?? null, evidence: params.evidence ?? null };
    return record(post, { action: 'mark_verified', actor, from: post.state, to: S.VERIFIED, now, detail: { mode: params.mode } });
  },
};
// timestamps given as `at` for system transitions that need a stable clock come from `now`

/** Apply one workflow action. Never mutates its input: returns the new post or throws SocialError. */
export function transition(post, action, actor, { now, ...params } = {}) {
  const handler = HANDLERS[action];
  if (!handler) fail(E.INVALID, `unknown action ${action}`, { action });
  if (!actor?.id || !Object.values(ROLE).includes(actor.role)) fail(E.FORBIDDEN, 'an actor with an id and a role is required');
  if (!now) fail(E.INVALID, 'now is required');
  requireRole(action, actor);
  if (!OWNER_ACTIONS.includes(action) && !SYSTEM_ACTIONS.includes(action) && actor.role === ROLE.SYSTEM) fail(E.FORBIDDEN, `${action} is a human action`);
  return handler(clone(post), { actor, now, params });
}

const CONTENT_FIELDS = ['platform', 'format', 'account_ref', 'subject', 'asset', 'assets', 'caption', 'hashtags', 'publish_at'];
/**
 * Edit content or notes. A change of what is published sends the post to DRAFT and wipes the approval (history says so).
 * Returns { post, changed, approval_invalidated, needs_remote_cancel }.
 */
export function editPost(post, patch, actor, { now }) {
  if (actor.role === ROLE.SYSTEM) fail(E.FORBIDDEN, 'the publisher never edits content');
  if (FROZEN_STATES.includes(post.state)) fail(E.TRANSITION, `a post in ${post.state} cannot be edited: the platform may already hold it`);
  if (!EDITABLE_STATES.includes(post.state)) fail(E.TRANSITION, `a post in ${post.state} cannot be edited`);
  const next = clone(post);
  const merged = { ...Object.fromEntries(CONTENT_FIELDS.map((f) => [f, post[f]])), ...Object.fromEntries(Object.entries(patch).filter(([k]) => CONTENT_FIELDS.includes(k))) };
  const content = normalizeContent(merged);
  Object.assign(next, content);
  if (patch.notes !== undefined) next.notes = String(patch.notes ?? '').slice(0, 1000);
  const changed = contentHashOf(next) !== contentHashOf(post);
  if (!changed) {
    if (patch.notes !== undefined && patch.notes !== post.notes) { record(next, { action: 'edit_notes', actor, from: post.state, to: post.state, now }); }
    return { post: next, changed: false, approval_invalidated: false, needs_remote_cancel: false };
  }
  const invalidated = Boolean(post.approval);
  next.approval = null;
  const needsRemote = armRemoteCancel(next);
  const changedFields = CONTENT_FIELDS.filter((f) => JSON.stringify(post[f] ?? null) !== JSON.stringify(next[f] ?? null));
  record(next, {
    action: 'edit', actor, from: post.state, to: S.DRAFT, now, detail: { changed_fields: changedFields, approval_invalidated: invalidated, ...(needsRemote ? { needs_remote_cancel: true } : {}) },
  });
  return { post: next, changed: true, approval_invalidated: invalidated, needs_remote_cancel: needsRemote };
}

export { SocialError, lintClaims };
