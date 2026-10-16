// SocialService: what the owner's phone and the agents call. Thin: every rule lives in workflow.js, every write goes through the store.
// It also owns the one side effect that must follow a human decision: removing a copy the PLATFORM holds (a Facebook post scheduled
// natively) when the approval is revoked, the post is edited, unscheduled or cancelled. That removal is recorded as pending in the same
// durable write as the decision, and retried until the platform confirms - a revoked post must not publish itself later.

import { ROLE, SOCIAL_ERROR as E, fail } from './constants.js';
import { contentHashOf, newPost } from './post.js';
import { editPost, transition } from './workflow.js';
import { importProposals as importFromD } from './intake.js';
import { acknowledgementFor, assertNoUnacknowledgedDuplicate } from './duplicates.js';
import { defaultIntegrity } from './integrity.js';

export const SYSTEM_ACTOR = Object.freeze({ id: 'nordla-publisher', role: ROLE.SYSTEM });

export function createSocialService({
  store, publishers = {}, clock = () => Date.now(), confirmedFacts = [], integrity = defaultIntegrity(),
}) {
  const nowIso = () => new Date(clock()).toISOString();

  async function settleRemoteCancel(id) {
    const post = await store.get(id);
    const pending = post?.publication?.remote_cancel_pending;
    if (!pending) return post;
    const publisher = publishers[post.platform];
    if (!publisher?.cancelScheduled) return post;
    try {
      await publisher.cancelScheduled({ publication: { platform_schedule: { post_id: pending.post_id } } });
    } catch (error) {
      const n = publisher.normalizeError(error);
      return store.update(id, (p) => transition(p, 'annotate', SYSTEM_ACTOR, {
        now: nowIso(), note: 'removal of the scheduled copy at the platform FAILED: it may still publish', detail: { code: n.code, remote_cancel_failed: true },
      }));
    }
    return store.update(id, (p) => transition(p, 'annotate', SYSTEM_ACTOR, {
      now: nowIso(), note: 'the scheduled copy was removed at the platform', publication: { remote_cancel_pending: null }, detail: { remote_cancel_confirmed: true },
    }));
  }

  async function createPost(input, actor, { id } = {}) {
    if (actor.role === ROLE.SYSTEM) fail(E.FORBIDDEN, 'the publisher creates no content');
    return store.create(newPost(input, { actor, now: nowIso(), ...(id ? { id } : {}) }));
  }

  async function edit(id, patch, actor) {
    let outcome;
    const saved = await store.update(id, (p) => { outcome = editPost(p, patch, actor, { now: nowIso() }); return outcome.post; });
    return outcome.needs_remote_cancel ? settleRemoteCancel(id) : saved;
  }

  /** Any workflow action. Returns the new post; a copy held by the platform is removed when the decision requires it. */
  async function act(id, action, actor, params = {}) {
    let remote = false;
    const saved = await store.update(id, async (p, ctx) => {
      // duplicate content (audit D4): decided INSIDE the same atomic step as the transition, over every post as it is at that instant
      let duplicateAck = null;
      if (action === 'approve') duplicateAck = acknowledgementFor(p, await ctx.list(), params);
      else if (['schedule', 'retry', 'mark_manual_schedule'].includes(action)) assertNoUnacknowledgedDuplicate(p, await ctx.list());
      // the client's params can never carry the key ring, the confirmed facts or the duplicate acknowledgement: they are set here, after the spread
      const next = transition(p, action, actor, { ...params, confirmed: confirmedFacts, integrity, duplicate_ack: duplicateAck, now: nowIso() });
      remote = Boolean(next.history.at(-1)?.detail?.needs_remote_cancel);
      return next;
    });
    return remote ? settleRemoteCancel(id) : saved;
  }

  return {
    store,
    confirmedFacts,
    integrity,
    createPost,
    editPost: edit,
    act,
    settleRemoteCancel,
    get: (id) => store.get(id),
    list: () => store.list(),
    audit: () => store.audit(),
    contentHashOf,
    /** Posts proposed by chantier D (social-post-proposal.v1). Idempotent; a changed proposal edits the post and voids its approval. */
    importProposals: (proposals, actor) => importFromD({ proposals, actor, store, createPost, editPost: edit, act, confirmed: confirmedFacts }),
  };
}
