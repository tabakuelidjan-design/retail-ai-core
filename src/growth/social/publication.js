// Growth > Abonnés (lot _09): where a social test stands in Publication sociale, and WHEN its measurement may start. Pure.
//
// OWNERSHIP (one owner per step; the identifier that links a step to the next one in brackets)
//   Growth       the opportunity, the brief version, the success indicator, the review          [growth_test_id = the opportunity id, brief_id + brief_version]
//   Creator      the creation and its version, the editorial elements delivered                  [creation_id + creation_version]
//   Publication  the draft, the owner's validation, the calendar, the publication and its state [post id, origin.links, publication.post_id = the NETWORK post id]
//
// WHAT STARTS A MEASUREMENT: only a CONFIRMED publication: state PUBLISHED / VERIFIED, with a real publication date and an identifier or link from the network, NOT a simulated
// publisher. A calendar date, a SCHEDULED state, a publication in progress or one whose outcome is unknown never starts anything. The review date is the real date (Brussels day,
// the owner module's own conversion) plus the window fixed by the brief.
import { brusselsParts } from '../../social/calendar.js';

export const STAGE = Object.freeze({ DRAFT: 'draft', VALIDATED: 'validated', SCHEDULED: 'scheduled', UNCERTAIN: 'uncertain', PUBLISHED: 'published', SIMULATED: 'simulated', FAILED: 'failed', CANCELLED: 'cancelled' });
const STAGE_OF = { DRAFT: 'draft', READY_FOR_REVIEW: 'draft', NEEDS_CHANGES: 'draft', REJECTED: 'draft', APPROVED: 'validated', SCHEDULED: 'scheduled', PUBLISHING: 'uncertain', PUBLICATION_UNKNOWN: 'uncertain', PUBLISHED: 'published', VERIFIED: 'published', ERROR: 'failed', CANCELLED: 'cancelled' };
const validIso = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s));
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The linked posts of ONE test: same merchant, same exact account and network, same growth test id. Anything else is counted apart, never used. */
export function linkedPosts(posts, { merchantRef, testId, network, accountId }) {
  const mine = []; let otherMerchant = 0; let otherAccount = 0;
  for (const p of posts) {
    const l = p?.origin?.links; if (!l || l.growth_test_id !== testId) continue;
    if (merchantRef && l.merchant_ref !== merchantRef) { otherMerchant += 1; continue; }
    if (l.account?.network !== network || l.account?.id !== accountId) { otherAccount += 1; continue; }
    mine.push(p);
  }
  return { posts: mine, otherMerchant, otherAccount };
}

/** The post to follow: the latest creation version, a cancelled one only when nothing else exists. */
export function currentPost(posts) {
  const live = posts.filter((p) => p.state !== 'CANCELLED'); const pool = live.length ? live : posts;
  return pool.slice().sort((a, b) => (b.origin.links.brief_version - a.origin.links.brief_version) || (b.origin.links.creation_version - a.origin.links.creation_version) || String(b.updated_at).localeCompare(String(a.updated_at)))[0] ?? null;
}

/**
 * @param {object} post a Publication sociale post with origin.links
 * @param {{ acceptSimulated?: boolean }} o acceptSimulated is for the simulation only: a simulated publisher publishes nothing, so in a real installation it never starts a review
 */
export function publicationOf(post, { acceptSimulated = false } = {}) {
  const l = post.origin.links; const pub = post.publication ?? null;
  const simulatedMode = pub?.mode === 'SIMULATION' || l.simulated === true;
  let stage = STAGE_OF[post.state] ?? 'uncertain';
  const publishedAt = pub && validIso(pub.published_at) ? pub.published_at : null;
  const networkPostId = pub?.post_id ? String(pub.post_id) : null; const permalink = pub?.permalink && /^https:\/\//.test(pub.permalink) ? pub.permalink : null;
  const reachedNetwork = stage === 'published';
  if (reachedNetwork && simulatedMode) stage = 'simulated';
  const confirmed = reachedNetwork && Boolean(publishedAt) && Boolean(networkPostId || permalink) && (!simulatedMode || acceptSimulated);
  const day = (iso) => (validIso(iso) ? brusselsParts(iso).date : null);
  const days = Number.isInteger(l.observation_days) ? l.observation_days : null;
  const publishedDay = confirmed ? day(publishedAt) : null;
  return {
    socialPostId: post.id, state: post.state, stage, confirmed, simulated: simulatedMode,
    plannedAt: validIso(post.publish_at) ? post.publish_at : null, plannedDay: day(post.publish_at), // the calendar date: a plan, never a measurement start
    publishedAt: confirmed ? publishedAt : null, publishedDay, networkPostId: confirmed ? networkPostId : null, permalink: confirmed ? permalink : null,
    approved: ['APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'VERIFIED', 'PUBLICATION_UNKNOWN'].includes(post.state) && Boolean(post.approval),
    reviewDueDay: publishedDay && days ? addDays(publishedDay, days) : null, observationDays: days,
    links: { testId: l.growth_test_id, briefId: l.brief_id, briefVersion: l.brief_version, creationId: l.creation_id, creationVersion: l.creation_version },
    measurement: confirmed ? 'READY' : 'NOT_STARTED',
  };
}

/** @returns {object|null} `null` = no linked post: the brief is only prepared (Growth), nothing has reached Publication sociale. */
export function publicationForTest(posts, query, opts) {
  const { posts: mine, otherMerchant, otherAccount } = linkedPosts(posts, query);
  const cur = currentPost(mine);
  if (!cur) return otherMerchant || otherAccount ? { stage: 'none', versions: 0, ignored: { otherMerchant, otherAccount } } : null;
  return { ...publicationOf(cur, opts), versions: mine.length, ignored: { otherMerchant, otherAccount } };
}
