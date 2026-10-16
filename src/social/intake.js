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
import {
  FROZEN_STATES, PROPOSAL_SCHEMA, ROLE, SocialError,
} from './constants.js';
import { contentHashOf, normalizeContent, readinessProblems } from './post.js';

export const D_ACTOR = Object.freeze({ id: 'chantier-d', role: ROLE.AGENT });

export const proposalPostId = (proposalId, platform, format) => `post_${createHash('sha256').update(`${proposalId}|${platform}|${format}`).digest('hex').slice(0, 32)}`;

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
  proposals, actor = D_ACTOR, store, createPost, editPost, act,
}) {
  const report = [];
  for (const p of proposals) {
    try { validateProposal(p); } catch (e) {
      report.push({ proposal_id: p?.proposal_id ?? null, platform: null, format: null, post_id: null, result: 'REJECTED', error: e.message });
      continue;
    }
    for (const target of p.targets) {
      const id = proposalPostId(p.proposal_id, target.platform, target.format);
      const line = { proposal_id: p.proposal_id, platform: target.platform, format: target.format, post_id: id };
      try {
        const content = {
          platform: target.platform, format: target.format, account_ref: target.account_ref ?? null, subject: p.subject, asset: target.format === 'TEXT' ? null : p.asset,
          caption: p.caption, hashtags: p.hashtags ?? [], publish_at: p.suggested_date ?? null,
        };
        const existing = await store.get(id);
        let post;
        if (!existing) {
          post = await createPost({ ...content, notes: p.notes ?? '', origin: { producer: p.producer ?? 'chantier-d', proposal_id: p.proposal_id } }, actor, { id });
          line.result = 'CREATED';
        } else {
          // the owner's calendar choice (publish_at) is never overwritten by a creative delivery
          const incoming = normalizeContent({ ...content, publish_at: existing.publish_at });
          if (contentHashOf({ ...existing, ...incoming }) === contentHashOf(existing)) { report.push({ ...line, result: 'UNCHANGED' }); continue; }
          if (FROZEN_STATES.includes(existing.state)) { report.push({ ...line, result: 'REFUSED_FROZEN', error: `post is ${existing.state}: send a new proposal_id for a new version` }); continue; }
          post = await editPost(id, { asset: incoming.asset, caption: incoming.caption, hashtags: incoming.hashtags, subject: incoming.subject, account_ref: incoming.account_ref }, actor);
          line.result = 'UPDATED';
          line.approval_voided = Boolean(existing.approval);
        }
        const problems = readinessProblems(post);
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
