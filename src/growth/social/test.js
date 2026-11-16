// Growth > Abonnés: the test item (direction + Creator brief) and the review of the post that came out of it. Pure.
//
// THE BRIEF (what Growth hands to Nordla Creator): format, hook, order of the shots, what the customer must show, tone, the call to follow, and the success indicator DEFINED BEFORE
// PUBLICATION (attributed follows per 1 000 accounts reached, at a fixed observation age), with the evidence (post id / link / date / metric / window / source) and its version. Creator has
// no entry for a social brief today (its brief is built from a product, an objective, a brand and a format: src/creative-autonomy/brief.js): the brief is a structured, copyable export with
// its provenance, not a call. The brief only restates the observed examples: it invents no figure, link or trend.
//
// THE REVIEW (rule growth-review-social.1): the declared post is looked up in the source by id; it must belong to the planned account and network, be observed at the planned age, and be
// compared with the OTHER organic (or same-status) posts of the same account, network and format observed at the same age. Attribution missing -> the account's net follower variation is kept
// as a separate observation and the review stays manual. The result is an observed evolution, never a proof of cause.
import { createHash } from 'node:crypto';
import { ratePer1000, comparableTo, SOCIAL_CONFIG, SOCIAL_RULE, NETWORK_NAMES } from './social.js';

export const SOCIAL_REVIEW_RULE = 'growth-review-social.1';
const SHOTS = { demonstration: ['finishedProduct', 'transformation', 'followInvite'], presentation: ['product', 'features', 'followInvite'] };
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
const normStructure = (s) => (s ? String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, '') : null);
export const merchantRefOf = (merchantId) => createHash('sha256').update(String(merchantId)).digest('hex');
/** the id of a brief: bound to its network, account, opportunity, version, direction, evidence and merchant (Creator recomputes it to detect an altered file) */
export const briefIdOf = (body) => `brief_${sha(body)}`;
const shotKey = (structure) => { const n = normStructure(structure) ?? ''; return n.startsWith('demo') ? 'demonstration' : n.startsWith('present') ? 'presentation' : null; };

/** The Creator brief of a direction. `version` is bumped by Growth when the evidence changes; the id binds merchant account, network, opportunity and evidence. */
export function buildBrief({ social, diagnosis, opportunityId, version = 1, merchantId = null, config = SOCIAL_CONFIG }) {
  const d = diagnosis.direction; if (!d) return null;
  const byId = new Map(social.posts.map((p) => [p.id, p])); const ex = new Map(social.examples.map((e) => [e.id, e]));
  const evidence = [...d.evidencePosts.map((id) => byId.get(id)).filter(Boolean).map((p) => ({ kind: 'own_post', postId: p.id, url: p.url, network: p.network, accountId: p.accountId, date: p.postedAt, format: p.format, paid: p.paid, structure: p.structure, topic: p.topic, hook: p.hook, metric: 'follows_per_1000_reach', ageDays: p.observed.ageDays, reach: p.observed.reach, follows: p.observed.follows, rate: ratePer1000(p), source: social.source, window: social.window })),
    ...d.publicExamples.map((id) => ex.get(id)).filter(Boolean).map((e) => ({ kind: 'public_example', postId: e.id, url: e.url, network: e.network, account: e.account, date: e.postedAt, format: e.format, structure: e.structure, topic: e.topic, hook: e.hook, metric: e.metric, rate: e.rate, window: e.window, group: e.group, market: e.market, source: e.source }))];
  const shots = (SHOTS[shotKey(d.structure)] ?? ['result', 'how', 'followInvite']).map((code, i) => ({ order: i + 1, code }));
  const brand = social.brand ?? {};
  const merchantRef = merchantId ? merchantRefOf(merchantId) : null; // a hash, never the merchant id itself: Creator recomputes it from ITS merchant to refuse a brief of another shop
  const body = { network: d.network, accountId: social.account.id, opportunityId, version, direction: { kind: d.kind, element: 'structure', value: d.structure }, evidenceIds: evidence.map((e) => e.postId), ...(merchantRef ? { merchantRef } : {}) };
  return { briefId: briefIdOf(body), version, merchant: merchantRef ? { ref: merchantRef } : null, goal: 'gain_followers', network: d.network, networkName: NETWORK_NAMES[d.network], account: { id: social.account.id, handle: social.account.handle }, market: social.market, opportunityId,
    direction: body.direction, format: d.format, hook: { text: d.hook, source: d.hook ? 'observed_top_post' : 'unknown' }, shots, show: brand.process ? [brand.process] : [], tone: brand.tone ?? null, cta: { code: 'follow' },
    successMetric: { id: 'follows_per_1000_reach', observationDays: d.group.ageDays ?? config.observationDays, definedBeforePublication: true, baselineRate: d.baselineRate, comparedWith: { network: d.network, format: d.format, paid: 'organic', ageDays: d.group.ageDays } },
    option: { trialReels: { requested: social.network === 'instagram' && d.format === 'reel', available: social.network === 'instagram' ? social.capabilities.trialReels : null } },
    evidence, missing: diagnosis.missing, provenance: { source: social.source, rule: SOCIAL_RULE, retrievedAt: social.retrievedAt, window: social.window, receivedBy: 'none automatically (Creator imports the file by hand: "Importer un brief social"; no social-brief production route yet)' } };
}

/** Items for Opportunités: one test idea / trend (with its brief), or an account-level test when no per-post attribution exists. */
export function socialItems({ diagnosis, social, version = 1, merchantId = null }) {
  if (!['SIGNAL', 'TREND', 'ATTRIBUTION_UNAVAILABLE'].includes(diagnosis.status)) return [];
  const id = `social:${social.network}:${social.account.id}`; const d = diagnosis.direction;
  const brief = d ? buildBrief({ social, diagnosis, opportunityId: id, version, merchantId }) : null;
  return [{
    id, category: 'social', kind: 'socialTest', sourcePage: 'social',
    title: { code: `social.${diagnosis.status}.title`, params: {} }, explanation: { code: `social.${diagnosis.status}.why`, params: {} }, entity: { type: 'socialAccount', id: social.account.id, title: social.account.handle ?? social.account.id },
    evidence: { status: diagnosis.status, network: social.network, accountId: social.account.id, handle: social.account.handle, goal: diagnosis.goal, market: social.market, source: social.source, window: social.window, retrievedAt: social.retrievedAt,
      netVariation: diagnosis.account.netVariation, gained: diagnosis.account.gained, lost: diagnosis.account.lost, direction: d, missing: diagnosis.missing },
    reliability: 'limited', measurement: { start: social.window.start, end: social.window.end, calculatedAt: social.retrievedAt },
    preparedAction: { code: 'socialTest', change: d ? 'testDirection' : 'accountLevel', network: social.network, accountId: social.account.id, brief, observationDays: brief ? brief.successMetric.observationDays : SOCIAL_CONFIG.observationDays },
    target: { type: 'socialAccount', available: false, id: social.account.id }, prerequisites: [], dataBlocker: null }];
}

/**
 * The review of the post declared as the published result of the test.
 * @param {{ social: object|null, plan: { network: string, accountId: string, observationDays: number }, postId: string, declaredNetwork?: string, now: Date, config?: object }} p
 */
export function reviewSocialPost({ social, plan, postId, now, config = SOCIAL_CONFIG }) {
  const cfg = { ...SOCIAL_CONFIG, ...config };
  const base = { rule: SOCIAL_REVIEW_RULE, metric: 'followsPer1000', calculatedAt: new Date(now).toISOString(), target: { type: 'post', id: postId }, plan: { network: plan.network, accountId: plan.accountId, observationDays: plan.observationDays } };
  if (!social) return { ...base, state: 'LIMITED', limits: ['SOURCE_UNAVAILABLE'], post: null, baseline: null, difference: null, accountNet: null, next: { code: 'wait', reason: 'SOURCE_UNAVAILABLE' } };
  const post = social.posts.find((p) => p.id === postId);
  const accountNet = social.followers.startTotal !== null && social.followers.endTotal !== null ? { start: social.followers.startTotal, end: social.followers.endTotal, net: social.followers.endTotal - social.followers.startTotal, window: social.window, scope: 'account' } : null;
  if (!post) return { ...base, state: 'LIMITED', limits: ['POST_NOT_FOUND'], post: null, baseline: null, difference: null, accountNet, next: { code: 'wait', reason: 'POST_NOT_FOUND' } };
  if (post.network !== plan.network || post.accountId !== plan.accountId || social.network !== plan.network || social.account.id !== plan.accountId) return { ...base, state: 'LIMITED', limits: ['TARGET_MISMATCH'], post: { id: post.id, url: post.url, network: post.network, accountId: post.accountId }, baseline: null, difference: null, accountNet, next: { code: 'wait', reason: 'TARGET_MISMATCH' } };
  const o = post.observed; const rate = ratePer1000(post);
  const postView = { id: post.id, url: post.url, network: post.network, accountId: post.accountId, postedAt: post.postedAt, format: post.format, paid: post.paid, structure: post.structure, ageDays: o ? o.ageDays : null, reach: o ? o.reach : null, follows: o ? o.follows : null, rate };
  const limits = [];
  if (!o || o.ageDays === null || o.ageDays < plan.observationDays) limits.push('WINDOW_NOT_COMPLETE');
  else if (o.ageDays !== plan.observationDays) limits.push('WINDOW_NOT_COMPARABLE');
  if (rate === null) limits.push('ATTRIBUTION_UNAVAILABLE');
  const peers = limits.length ? [] : comparableTo(post, social.posts);
  const sameStatusExists = social.posts.some((q) => q.id !== post.id && q.network === post.network && q.format === post.format && q.observed && q.observed.ageDays === (o ? o.ageDays : null) && q.paid !== post.paid);
  if (!limits.length && peers.length < cfg.minComparable) limits.push(post.paid !== 'organic' && sameStatusExists ? 'PAID_STATUS_NOT_COMPARABLE' : 'LOW_BASELINE');
  if (limits.length) return { ...base, state: 'LIMITED', limits, post: postView, baseline: null, difference: null, accountNet, next: { code: 'wait', reason: limits[0] } };
  const tot = peers.reduce((a, p) => ({ reach: a.reach + p.observed.reach, follows: a.follows + p.observed.follows }), { reach: 0, follows: 0 });
  const baseline = { n: peers.length, reach: tot.reach, follows: tot.follows, rate: tot.reach > 0 ? round2((tot.follows / tot.reach) * 1000) : null, group: { network: post.network, format: post.format, paid: post.paid, ageDays: o.ageDays }, posts: peers.map((p) => p.id) };
  const difference = baseline.rate === null ? null : { perThousand: round2(rate - baseline.rate), ratio: baseline.rate > 0 ? round2(rate / baseline.rate) : null };
  const next = baseline.rate !== null && baseline.rate > 0 && rate >= baseline.rate * cfg.repeatRatio ? { code: 'repeat', reason: 'ABOVE_BASELINE' } : baseline.rate !== null && rate < baseline.rate ? { code: 'adjust', reason: 'BELOW_BASELINE' } : { code: 'wait', reason: 'NOT_DISTINCT' };
  return { ...base, state: 'COMPARABLE', limits: [], post: postView, baseline, difference, accountNet, next };
}
