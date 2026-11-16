// The contract with chantier D (creation / assets): `social-post-proposal.v1`.
//
//   D OWNS: the final asset (reference + immutable version + sha256), the caption proposal, the hashtags, the subject, the AI flag.
//   E OWNS: the calendar, the approval, the publication. D never publishes, never schedules, never approves.
//
// One proposal = one creative piece offered to one or more (platform, format) targets. Import is idempotent: the post id is derived from
// (proposal_id, platform, format). Re-delivering the SAME content is a no-op; delivering a NEW asset version or caption edits the post
// and, by the workflow rules, sends it back to DRAFT and voids any approval - D can never silently change what the owner approved.
// A post that may already exist on a platform (publishing, published...) is never touched: a new proposal_id is required.

import { createHash } from 'node:crypto';
import { contentFingerprint } from './duplicates.js';
import {
  FROZEN_STATES, PROPOSAL_SCHEMA, ROLE, SocialError,
} from './constants.js';
import { contentHashOf, normalizeContent, normalizeLinks, readinessProblems } from './post.js';

export const D_ACTOR = Object.freeze({ id: 'chantier-d', role: ROLE.AGENT });

export const proposalPostId = (proposalId, platform, format) => `post_${createHash('sha256').update(`${proposalId}|${platform}|${format}`).digest('hex').slice(0, 32)}`;

/**
 * A post that already carries (or lacks) a link keeps its ORIGIN: a re-delivery can never move it to another Growth test, brief, brief version, merchant, account or window, drop its link, or attach
 * one to a post that had none. Only the creation VERSION moves forward (same creation id). Anything else is a conflict: refused with its reason, the post and its history untouched.
 * (The post id derives from proposal_id + platform + format, so a different test arriving under the same proposal_id lands here.)
 */
function relinkRefusal(old, next) {
  if (!old && !next) return null;
  if (!old) return 'LINK_ON_UNLINKED_POST: this post was imported without a link; a new proposal_id is required to link it';
  if (!next) return 'LINK_REMOVED: this post is linked to a Growth test; a re-delivery cannot drop the link';
  for (const k of ['growth_test_id', 'brief_id', 'brief_version', 'merchant_ref', 'creation_id', 'observation_days']) if (old[k] !== next[k]) return `LINK_CONFLICT: ${k} differs from the link this post was created with; a new proposal_id is required`;
  if (old.account.network !== next.account.network || old.account.id !== next.account.id) return 'LINK_CONFLICT: account differs from the link this post was created with; a new proposal_id is required';
  if (next.creation_version < old.creation_version) return 'CREATION_VERSION_OLDER: a delivery cannot go back to an earlier creation version';
  if ((old.simulated === true) !== (next.simulated === true)) return 'LINK_CONFLICT: simulated differs from the link this post was created with';
  return null;
}

/** the link must belong to THIS merchant and to the exact account of the target; refusals carry their reason, never silent. */
function checkLinks(links, p, context) {
  const refuse = (reason) => { throw new SocialError('SOCIAL_INVALID', reason, { reason }); };
  if (context.merchantRef && links.merchant_ref !== context.merchantRef) refuse('MERCHANT_MISMATCH: the link belongs to another merchant');
  for (const t of p.targets) {
    if (t.platform !== links.account.network) refuse(`ACCOUNT_NETWORK_MISMATCH: the link targets ${links.account.network}, the target is ${t.platform}`);
    if (!t.account_ref) refuse('ACCOUNT_REQUIRED: a linked proposal names its exact account (account_ref)');
    if (t.account_ref !== links.account.id) refuse('ACCOUNT_MISMATCH: account_ref is not the account of the test');
    const configured = context.accounts?.[t.platform];
    if (configured && configured !== t.account_ref) refuse('ACCOUNT_NOT_CONNECTED: this account is not the one connected for this network');
  }
}

function validateProposal(p) {
  if (!p || typeof p !== 'object') throw new SocialError('SOCIAL_INVALID', 'a proposal is an object');
  if (p.schema !== PROPOSAL_SCHEMA) throw new SocialError('SOCIAL_INVALID', `schema must be ${PROPOSAL_SCHEMA}`, { field: 'schema' });
  if (typeof p.proposal_id !== 'string' || p.proposal_id.length < 4 || p.proposal_id.length > 200) throw new SocialError('SOCIAL_INVALID', 'proposal_id is required (stable per creative decision)', { field: 'proposal_id' });
  if (!Array.isArray(p.targets) || !p.targets.length) throw new SocialError('SOCIAL_INVALID', 'targets: at least one { platform, format }', { field: 'targets' });
  const seen = new Set();
  for (const t of p.targets) {
    const key = `${t.platform}|${t.format}`;
    if (seen.has(key)) throw new SocialError('SOCIAL_INVALID', `duplicate target ${key}`, { field: 'targets' });
    seen.add(key);
  }
}

/**
 * @returns {Promise<Array<{proposal_id, platform, format, post_id, result, problems?, error?}>>} one line per target; one bad proposal never stops the others.
 * result: CREATED | UNCHANGED | UPDATED | REFUSED_FROZEN | REJECTED. A created / updated post is offered for review when it is ready.
 */
export async function importProposals({
  proposals, actor = D_ACTOR, store, createPost, editPost, act, confirmed = [], context = {},
}) {
  const report = [];
  for (const p of proposals) {
    try { validateProposal(p); } catch (e) {
      report.push({ proposal_id: p?.proposal_id ?? null, platform: null, format: null, post_id: null, result: 'REJECTED', error: e.message });
      continue;
    }
    // LINKS (optional): validated once per proposal against the context of this installation (merchant, configured accounts); a proposal without links is imported exactly as before
    let links = null;
    try { links = normalizeLinks(p.links); if (links) checkLinks(links, p, context); } catch (e) {
      for (const t of p.targets) report.push({ proposal_id: p.proposal_id, platform: t.platform, format: t.format, post_id: proposalPostId(p.proposal_id, t.platform, t.format), result: 'REJECTED', error: e.detail?.reason ?? e.message });
      continue;
    }
    for (const target of p.targets) {
      const id = proposalPostId(p.proposal_id, target.platform, target.format);
      const relink = (postId, next) => store.update(postId, (cur) => ({ ...cur, rev: cur.rev + 1, updated_at: new Date().toISOString(), origin: { ...(cur.origin ?? { producer: p.producer ?? 'chantier-d', proposal_id: p.proposal_id }), links: next ?? undefined } }));
      const line = { proposal_id: p.proposal_id, platform: target.platform, format: target.format, post_id: id };
      try {
        const content = {
          platform: target.platform, format: target.format, account_ref: target.account_ref ?? null, subject: p.subject, asset: ['TEXT', 'CAROUSEL'].includes(target.format) ? null : p.asset ?? null, assets: target.format === 'CAROUSEL' ? p.assets ?? null : null,
          caption: p.caption, hashtags: p.hashtags ?? [], publish_at: p.suggested_date ?? null,
        };
        const existing = await store.get(id);
        let post;
        if (existing) { const refusal = relinkRefusal(existing.origin?.links ?? null, links); if (refusal) { report.push({ ...line, result: 'REJECTED', error: refusal }); continue; } }
        if (!existing) {
          post = await createPost({ ...content, notes: p.notes ?? '', origin: { producer: p.producer ?? 'chantier-d', proposal_id: p.proposal_id, ...(links ? { links } : {}) } }, actor, { id });
          line.result = 'CREATED';
        } else {
          // the owner's calendar choice (publish_at) is never overwritten by a creative delivery
          const incoming = normalizeContent({ ...content, publish_at: existing.publish_at });
          const sameContent = contentHashOf({ ...existing, ...incoming }) === contentHashOf(existing);
          const sameLinks = JSON.stringify(existing.origin?.links ?? null) === JSON.stringify(links);
          if (sameContent && sameLinks) { report.push({ ...line, result: 'UNCHANGED' }); continue; }
          if (sameContent) {
            // only the link changed (a new brief or creation version on identical content): content and approval are untouched; a post the platform may hold keeps its link
            if (FROZEN_STATES.includes(existing.state)) { report.push({ ...line, result: 'REFUSED_FROZEN', error: `post is ${existing.state}: its link is fixed` }); continue; }
            await relink(id, links); report.push({ ...line, result: 'UPDATED', links_updated: true }); continue;
          }
          if (FROZEN_STATES.includes(existing.state)) { report.push({ ...line, result: 'REFUSED_FROZEN', error: `post is ${existing.state}: send a new proposal_id for a new version` }); continue; }
          post = await editPost(id, { asset: incoming.asset, assets: incoming.assets, caption: incoming.caption, hashtags: incoming.hashtags, subject: incoming.subject, account_ref: incoming.account_ref }, actor);
          if (!sameLinks) post = await relink(id, links);
          line.result = 'UPDATED';
          line.approval_voided = Boolean(existing.approval);
        }
        // an identical post under another proposal id (audit D4): reported at once, refused later at approval unless the owner accepts the republication
        const twins = (await store.list()).filter((q) => q.id !== post.id && !['CANCELLED', 'REJECTED'].includes(q.state) && contentFingerprint(q) === contentFingerprint(post));
        if (twins.length) line.duplicate_of = twins.map((q) => q.id);
        const problems = readinessProblems(post, { confirmed });
        if (problems.length) line.problems = problems;
        else if (post.state === 'DRAFT') await act(id, 'submit', actor);
        report.push(line);
      } catch (e) {
        report.push({ ...line, result: 'REJECTED', error: e.message });
      }
    }
  }
  return report;
}
