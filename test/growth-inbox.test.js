// Lot _10: conversations -> qualified requests. Simulated, fictitious customers (opaque ids only). The engine, the sources, the review: unique conversations, provenance, the qualification rate,
// the real zero vs unavailable vs low volume, and what is never done (no deduplication across grains, no attribution on weak evidence, nothing sent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInbox, diagnoseInbox, readInbox, reviewInquiry, inboxItems } from '../src/growth/inbox/inbox.js';
import { createInboxSource, createInboxReviewSource } from '../src/growth/server/inbox.js';

const NOW = new Date('2026-11-15T12:00:00Z'); const FROM = '2026-11-03';
const th = (id, day, o = {}) => ({ id, started_at: day, messages: 1, origin: { kind: 'post', post_id: 'test1', attribution: 'connection' }, ...o });
// 12 conversations attributed to the test post (some with several messages), 3 of unknown origin
const ATTRIBUTED = Array.from({ length: 12 }, (_, i) => th(`t${i + 1}`, `2026-11-0${(i % 6) + 3}`.replace('2026-11-09', '2026-11-04'), { messages: i % 3 === 0 ? 4 : 1 }));
const UNKNOWN = ['u1', 'u2', 'u3'].map((id) => th(id, '2026-11-05', { origin: { kind: 'unknown' } }));
const facts = (o = {}) => ({ source_system: 'inbox_import_SIM', method: 'aggregate_export', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', request_type: 'quote', complete: true,
  conversations: [...ATTRIBUTED, ...UNKNOWN], ...o });
const PLAN = { network: 'instagram', accountId: 'ig-9001', observationDays: 7, requestType: 'quote' };
const review = (raw, qualification, o = {}) => reviewInquiry({ inbox: normalizeInbox(raw).inbox, plan: PLAN, postId: 'test1', from: FROM, now: NOW, qualification, ...o });
const Q4 = { qualified: ['t1', 't2', 't3', 't4'] };

test('INB-1 the validation example: 12 unique conversations attributed, 4 confirmed qualified = 4 / 12 = 33.3 %; 3 conversations of unknown origin stay at account level; the other 8 are still to qualify', () => {
  const r = review(facts(), Q4);
  assert.deepEqual([r.state, r.counts.unique, r.counts.qualified, r.rate, r.counts.unreviewed, r.counts.byProvenance, r.accountLevel.conversations, r.accountLevel.unknownOrigin], ['COMPARABLE', 12, 4, 33.3, 8, { connection: 12, declared: 0 }, 15, 3]);
  assert.deepEqual([r.next.code, r.next.reason, r.incomplete, r.lowVolume], ['wait', 'QUALIFICATION_INCOMPLETE', true, false], 'the rate is shown, but the review waits until the 8 others are qualified');
  const done = review(facts(), { qualified: Q4.qualified, notQualified: ['t5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'] }); assert.deepEqual([done.counts.unreviewed, done.incomplete, done.next.reason], [0, false, 'NO_BASELINE'], 'threads alone give no comparable period');
  assert.deepEqual([r.window, r.rule, r.source, r.grain, r.sourceWindow], [{ start: FROM, end: '2026-11-10' }, 'growth-review-inbox.1', 'inbox_import_SIM', 'threads', { start: '2026-10-18', end: '2026-11-15' }]);
});

test('INB-2 several messages in one thread are ONE conversation; duplicate rows of an import are dropped and counted; a disagreement on the origin removes the attribution; sources of different grains are never added', () => {
  const dup = facts({ conversations: [...ATTRIBUTED, ...ATTRIBUTED.slice(0, 5), ...UNKNOWN, th('t6', '2026-11-04', { origin: { kind: 'unknown' } })] });
  const n = normalizeInbox(dup).inbox; assert.deepEqual([n.threads.length, n.duplicatesDropped, n.originConflicts], [15, 6, 1], '17 rows + 5 repeated = 15 threads; t6 disagrees (post vs unknown) -> unknown');
  const r = review(dup, Q4); assert.deepEqual([r.counts.unique, r.counts.multiMessage, r.accountLevel.duplicatesDropped, r.accountLevel.originConflicts, r.accountLevel.unknownOrigin], [11, 4, 6, 1, 4], 'the conflicting thread is NOT attributed to the post');
  // an aggregate row plus thread rows: the aggregate is NOT merged with the threads (the grain of the review is the threads')
  const mixed = normalizeInbox(facts({ publications: [{ post_id: 'test1', conversations_unique: 99, qualified_conversations: 50 }] })).inbox; assert.equal(readInbox(mixed).grain, 'threads');
});

test('INB-3 a real zero, an unavailable figure and a low volume are three different things', () => {
  const zero = review(facts({ conversations: [...UNKNOWN, th('x1', '2026-11-04', { origin: { kind: 'post', post_id: 'other-post', attribution: 'connection' } })] }), Q4); assert.deepEqual([zero.state, zero.counts.unique, zero.rate, zero.next.reason, zero.limits.length], ['ZERO', 0, null, 'ZERO_CONVERSATIONS', 0], 'the source covers the window and attributes nothing to the post: a real zero, no rate (denominator 0)');
  assert.equal(diagnoseInbox({ inbox: normalizeInbox(facts({ conversations: [], complete: true })).inbox }).status, 'ZERO'); assert.equal(diagnoseInbox({ inbox: normalizeInbox(facts({ conversations: [], complete: false })).inbox }).status, 'NO_DATA', 'an empty export that does not say it is complete is UNAVAILABLE, never a zero');
  const low = review(facts({ conversations: [th('a', '2026-11-04'), th('b', '2026-11-04'), th('c', '2026-11-05')] }), { qualified: ['a'], notQualified: ['b', 'c'] }); assert.deepEqual([low.state, low.rate, low.lowVolume, low.next.reason], ['COMPARABLE', 33.3, true, 'LOW_VOLUME']);
  const agg = review(facts({ conversations: [], publications: [{ post_id: 'test1', conversations_unique: 12, qualified_conversations: null }] })); assert.deepEqual([agg.state, agg.rate, agg.limits], ['LIMITED', null, ['QUALIFICATION_UNAVAILABLE']], 'conversations known, qualification unknown: unavailable, not 0 %');
  assert.equal(review(facts({ conversations: [], publications: [{ post_id: 'test1', conversations_unique: null, qualified_conversations: 4 }] })).limits[0], 'CONVERSATIONS_UNAVAILABLE');
  assert.equal(review(facts({ conversations: [], publications: [{ post_id: 'test1', conversations_unique: 3, qualified_conversations: 5 }] })).limits[0], 'INCONSISTENT_COUNTS');
});

test('INB-4 without attribution per publication: account level only, manual review, and the reason; the merchant can still attach conversations himself (declared provenance)', () => {
  const none = facts({ conversations: [...ATTRIBUTED, ...UNKNOWN].map((c) => ({ ...c, origin: { kind: 'unknown' } })) });
  const r = review(none, Q4); assert.deepEqual([r.state, r.limits, r.counts, r.accountLevel.conversations, r.accountLevel.unknownOrigin, r.next.reason], ['LIMITED', ['ATTRIBUTION_UNAVAILABLE'], null, 15, 15, 'ATTRIBUTION_UNAVAILABLE']);
  assert.equal(diagnoseInbox({ inbox: normalizeInbox(none).inbox }).status, 'ATTRIBUTION_UNAVAILABLE');
  const declared = review(none, { qualified: ['t1', 't2'], notQualified: ['t3'], declared: ['t1', 't2', 't3', 't4'] }); assert.deepEqual([declared.state, declared.counts.unique, declared.counts.byProvenance, declared.counts.qualifiedByProvenance, declared.rate], ['COMPARABLE', 4, { connection: 0, declared: 4 }, { connection: 0, declared: 2 }, 50], 'declared by the merchant, shown as such, never as the connection\'s attribution');
  const totals = review({ ...facts({ conversations: [] }), account_totals: { conversations_unique: 15, qualified_conversations: 4, qualified_requests: null } }); assert.deepEqual([totals.state, totals.limits[0], totals.accountLevel.conversations, totals.accountLevel.qualified, totals.accountLevel.requests], ['LIMITED', 'ATTRIBUTION_UNAVAILABLE', 15, 4, null]);
});

test('INB-5 a qualified request is counted once even when several qualified threads share it; null when the source does not distinguish requests', () => {
  const withReq = facts({ conversations: ATTRIBUTED.map((c, i) => ({ ...c, request_id: i < 2 ? 'req-A' : i < 4 ? 'req-B' : undefined })) });
  assert.equal(review(withReq, Q4).counts.requests, 2, 't1,t2 share req-A, t3,t4 share req-B'); assert.equal(review(facts(), Q4).counts.requests, null);
});

test('INB-6 a comparison only against publications observed over the SAME days (aggregate rows); the observed difference, repeat / adjust; the source\'s own qualification is overridden by the merchant', () => {
  const rows = [{ post_id: 'old1', conversations_unique: 10, qualified_conversations: 1, observation_days: 7 }, { post_id: 'old2', conversations_unique: 10, qualified_conversations: 1, observation_days: 7 }, { post_id: 'old3', conversations_unique: 50, qualified_conversations: 40, observation_days: 14 }];
  const all = { qualified: Q4.qualified, notQualified: ['t5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'] };
  const r = review(facts({ publications: rows }), all); assert.deepEqual([r.baseline.n, r.baseline.rate, r.difference.points, r.next.code], [2, 10, 23.3, 'repeat'], 'old3 (14 days) is not comparable and is left out');
  const worse = review(facts({ publications: [{ post_id: 'old1', conversations_unique: 10, qualified_conversations: 8, observation_days: 7 }] }), all); assert.deepEqual([worse.baseline.rate, worse.next.code], [80, 'adjust']);
  const src = facts({ conversations: ATTRIBUTED.map((c, i) => ({ ...c, qualified: i < 6 ? 'qualified' : 'not_qualified' })) });
  assert.equal(review(src, {}).counts.qualified, 6, 'the source\'s qualification counts when the merchant has not decided'); assert.equal(review(src, { notQualified: ['t1', 't2'] }).counts.qualified, 4, 'the merchant\'s decision wins');
});

test('INB-7 the period must be complete; another account or network, or an unavailable source, is a limit; a publication outside the window or a conversation outside the observation days is not counted', () => {
  assert.equal(review(facts({ window: { start: '2026-10-18', end: '2026-11-08' } }), Q4).limits[0], 'WINDOW_NOT_COMPLETE', 'the source stops before the observation window ends');
  assert.equal(reviewInquiry({ inbox: normalizeInbox(facts()).inbox, plan: PLAN, postId: 'test1', from: '2026-11-12', now: NOW }).limits[0], 'WINDOW_NOT_COMPLETE', 'the window ends after today');
  assert.equal(review({ ...facts(), account: { id: 'ig-OTHER' } }, Q4).limits[0], 'TARGET_MISMATCH'); assert.equal(reviewInquiry({ inbox: null, plan: PLAN, postId: 'test1', from: FROM, now: NOW }).limits[0], 'SOURCE_UNAVAILABLE');
  const out = review(facts({ conversations: [...ATTRIBUTED, th('late', '2026-11-12'), th('early', '2026-11-02')] }), Q4); assert.equal(out.counts.unique, 12, 'conversations outside [from, from + 7 days) are not part of this test');
  assert.equal(reviewInquiry({ inbox: normalizeInbox(facts()).inbox, plan: PLAN, postId: 'test1', from: null, now: NOW }).limits[0], 'PUBLICATION_DATE_MISSING');
});

test('INB-8 the sources: no connection still offers the test (manual statement); an unreadable source is unavailable, an invalid one is refused; the review source applies the merchant\'s ids and is tenant-fixed', async () => {
  const known = async () => [{ network: 'instagram', id: 'ig-9001', handle: '@atelier_sim', linkedTestId: 'social:instagram:ig-9001' }];
  const none = await createInboxSource({ loaders: {}, accounts: known, now: () => NOW, cacheMs: 0 })(); assert.deepEqual([none.state, none.accounts[0].state, none.accounts[0].missing, none.items.length, none.items[0].evidence.status, none.items[0].preparedAction.keyword, none.items[0].evidence.linkedTestId], ['NOT_CONNECTED', 'NOT_CONNECTED', ['INBOX_CONNECTION'], 1, 'NOT_CONNECTED', 'DEVIS', 'social:instagram:ig-9001']);
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try { const down = await createInboxSource({ loaders: { instagram: async () => { throw Object.assign(new Error('boom SECRET'), { code: 'CONNECTION_DOWN' }); } }, accounts: known, now: () => NOW, cacheMs: 0 })(); assert.deepEqual([down.accounts[0].state, down.accounts[0].reason, down.items.length], ['UNAVAILABLE', 'CONNECTION_DOWN', 1]); } finally { console.error = orig; }
  assert.ok(!errs.join('').includes('SECRET'));
  const bad = await createInboxSource({ loaders: { instagram: async () => ({ network: 'instagram' }) }, accounts: known, now: () => NOW, cacheMs: 0 })(); assert.deepEqual([bad.accounts[0].state, bad.items.length], ['INVALID', 0]);
  const ok = await createInboxSource({ loaders: { instagram: async () => facts() }, accounts: known, now: () => NOW, cacheMs: 0 })(); assert.deepEqual([ok.state, ok.accounts[0].diagnosis.status, ok.accounts[0].diagnosis.reading.conversations, ok.accounts[0].diagnosis.reading.unknownOrigin, ok.accounts[0].threads.length, ok.items[0].evidence.conversations], ['OK', 'ATTRIBUTED', 15, 3, 15, 15]);
  assert.ok(!JSON.stringify(ok).includes('"text"') && ok.accounts[0].threads.every((t) => Object.keys(t).every((k) => ['id', 'startedAt', 'messages', 'origin', 'source', 'requestId'].includes(k))), 'only opaque ids, days and counts');
  const rv = await createInboxReviewSource({ loaders: { instagram: async () => facts() }, now: () => NOW })({ id: 'test1', network: 'instagram', account: 'ig-9001', days: '7', from: FROM, type: 'quote', qualified: 't1,t2,t3,t4', notQualified: '', declared: '' }); assert.deepEqual([rv.state, rv.counts.qualified, rv.rate], ['COMPARABLE', 4, 33.3]);
  const other = await createInboxReviewSource({ loaders: { instagram: async () => facts() }, now: () => NOW })({ id: 'test1', network: 'instagram', account: 'ig-OTHER', days: '7', from: FROM, qualified: 't1' }); assert.equal(other.limits[0], 'TARGET_MISMATCH');
  const tiktok = await createInboxSource({ loaders: { tiktok: async () => ({ ...facts(), network: 'tiktok', account: { id: 'tt-7001' } }) }, accounts: async () => [], now: () => NOW, cacheMs: 0 })(); assert.deepEqual([tiktok.accounts.find((a) => a.network === 'tiktok').state, tiktok.items.find((i) => i.preparedAction.network === 'tiktok').preparedAction.network], ['OK', 'tiktok'], 'the same contract for TikTok');
});

test('INB-9 the test: one per account, the invitation keyword and the first-reply draft per type of request; nothing is sent by Nordla', () => {
  for (const [type, kw, draft] of [['quote', 'DEVIS', 'quoteFirstReply'], ['booking', 'RESERVER', 'bookingFirstReply'], ['other', 'INFO', 'otherFirstReply']]) {
    const [i] = inboxItems({ account: { network: 'instagram', id: 'ig-9001', handle: '@a' }, inbox: { requestType: type }, diagnosis: null }); assert.deepEqual([i.preparedAction.keyword, i.preparedAction.draft.code, i.kind, i.id, i.preparedAction.observationDays, i.preparedAction.code], [kw, draft, 'inquiryTest', 'inbox:instagram:ig-9001', 7, 'inquiryTest']);
  }
});
