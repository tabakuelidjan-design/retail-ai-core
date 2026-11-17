// Instagram READ-ONLY reader: the profile of the connected account and the figures of the latest publication, from SIMULATED Graph answers only (no network, no real credential).
// Every figure has one of four states: VALUE, ZERO (a measured zero), UNAVAILABLE (not returned: never shown as 0), PERMISSION_MISSING (the permission is named).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInstagramReader, FIGURE, PERMISSION } from '../src/provider-connections/instagram-reader.js';

const TOKEN = 'IGAA-TOKEN-VALUE-for-the-simulation-0001';
const BOTH = [PERMISSION.BASIC, PERMISSION.INSIGHTS];
const at = new Date('2026-11-17T15:00:00Z');
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const gerr = (code, message = 'x', extra = {}) => ({ error: { message, type: 'OAuthException', code, ...extra } });
const PROFILE = { user_id: '17841400000000001', username: 'habb.be', name: 'HABB', account_type: 'Business', followers_count: 128, follows_count: 40, media_count: 53 };
const MEDIA = [{ id: 'OLD', media_type: 'IMAGE', timestamp: '2026-10-01T09:00:00+0000', permalink: 'https://www.instagram.com/p/OLD/', caption: 'ancienne', like_count: 3, comments_count: 1 }, { id: 'M2', media_type: 'REELS', timestamp: '2026-11-10T09:00:00+0000', permalink: 'https://www.instagram.com/p/NEW/', caption: 'Coque personnalisée\n   à Namur', like_count: 12, comments_count: 0 }];
const ins = (obj) => ({ data: Object.entries(obj).map(([name, value]) => ({ name, period: 'lifetime', values: [{ value }] })) });

/** A Graph double: `handler({ path, query })` -> [status, body]. Records every call (method, path, whether a bearer was sent). */
function graph(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { const u = new URL(url); calls.push({ method: init.method, host: u.hostname, path: u.pathname, query: Object.fromEntries(u.searchParams), bearer: /^Bearer /.test(init.headers.authorization) }); const [status, body] = handler({ path: u.pathname, query: Object.fromEntries(u.searchParams) }); return reply(status, body); };
  return { fetchImpl, calls };
}
const reader = (g, over = {}) => createInstagramReader({ getAccessToken: async () => TOKEN, graphVersion: 'v25.0', grantedScopes: BOTH, fetchImpl: g.fetchImpl, now: () => at, ...over });
const stat = (r, name) => r.publication.item.stats.find((s) => s.name === name);

test('IR-1 a full read: the profile, the NEWEST publication and its figures, with the instant it was read; a zero is a ZERO, a missing figure is UNAVAILABLE', async () => {
  const g = graph(({ path }) => (path === '/v25.0/me' ? [200, PROFILE] : path === '/v25.0/me/media' ? [200, { data: MEDIA }] : [200, ins({ reach: 340, views: 0, likes: 12, comments: 0, shares: 2 })])); // `saved` is NOT returned
  const r = await reader(g).read();
  assert.equal(r.fetchedAt, '2026-11-17T15:00:00.000Z'); assert.equal(r.profile.state, 'OK');
  assert.deepEqual([r.profile.data.username, r.profile.data.name, r.profile.data.accountType], ['habb.be', 'HABB', 'Business']); assert.deepEqual([r.profile.data.followers.value, r.profile.data.follows.value, r.profile.data.mediaCount.value], [128, 40, 53]);
  assert.equal(r.publication.state, 'OK'); assert.equal(r.publication.item.id, 'M2', 'the newest one, whatever the order of the answer'); assert.equal(r.publication.item.postedAt, '2026-11-10T09:00:00.000Z'); assert.equal(r.publication.item.caption, 'Coque personnalisée à Namur');
  assert.deepEqual([stat(r, 'reach').state, stat(r, 'reach').value], [FIGURE.VALUE, 340]);
  assert.deepEqual([stat(r, 'views').state, stat(r, 'views').value], [FIGURE.ZERO, 0], 'Instagram said 0: a measured zero');
  assert.deepEqual([stat(r, 'comments').state, stat(r, 'comments').value], [FIGURE.ZERO, 0]);
  assert.deepEqual([stat(r, 'saved').state, stat(r, 'saved').value, stat(r, 'saved').reason], [FIGURE.UNAVAILABLE, null, 'NOT_RETURNED'], 'not returned is NOT zero');
  assert.ok(g.calls.every((c) => c.method === 'GET' && c.host === 'graph.instagram.com' && c.bearer), 'read-only: only GET calls to Instagram, with the token in the header');
  assert.ok(!JSON.stringify(r).includes(TOKEN), 'the token is never part of the result');
});

test('IR-2 a metric Instagram does not support for this media is UNAVAILABLE on its own; the others keep their values; a hidden like count is not a zero', async () => {
  const g = graph(({ path, query }) => {
    if (path === '/v25.0/me') return [200, PROFILE];
    if (path === '/v25.0/me/media') return [200, { data: [{ ...MEDIA[1], like_count: undefined, comments_count: undefined }] }]; // like / comment counts hidden
    if (query.metric.includes(',')) return [400, gerr(100, 'The following metrics are not supported for this media')]; // the whole request is refused
    return query.metric === 'views' || query.metric === 'likes' ? [400, gerr(100, 'metric not supported')] : [200, ins({ [query.metric]: 7 })];
  });
  const r = await reader(g).read();
  assert.deepEqual([stat(r, 'reach').state, stat(r, 'reach').value], [FIGURE.VALUE, 7]); assert.deepEqual([stat(r, 'views').state, stat(r, 'views').reason], [FIGURE.UNAVAILABLE, 'METRIC_NOT_SUPPORTED']);
  assert.equal(stat(r, 'likes').state, FIGURE.UNAVAILABLE, 'no insight and no like_count: unavailable, never 0'); assert.equal(stat(r, 'likes').value, null);
  const g2 = graph(({ path, query }) => (path === '/v25.0/me' ? [200, PROFILE] : path === '/v25.0/me/media' ? [200, { data: [{ ...MEDIA[1], like_count: 0 }] }] : query.metric.includes(',') ? [400, gerr(100)] : query.metric === 'likes' ? [400, gerr(100)] : [200, ins({ [query.metric]: 1 })]));
  const r2 = await reader(g2).read(); assert.deepEqual([stat(r2, 'likes').state, stat(r2, 'likes').value], [FIGURE.ZERO, 0], 'like_count 0 from the media itself backs up the missing insight');
});

test('IR-3 a MISSING PERMISSION is named and never faked: without the insights permission no insight is requested; without the basic one nothing is requested; a refusal from the provider says the same', async () => {
  const g = graph(({ path }) => (path === '/v25.0/me' ? [200, PROFILE] : [200, { data: MEDIA }]));
  const r = await reader(g, { grantedScopes: [PERMISSION.BASIC] }).read();
  assert.equal(r.profile.state, 'OK'); assert.ok(r.publication.item.stats.every((s) => s.state === FIGURE.PERMISSION_MISSING && s.permission === PERMISSION.INSIGHTS && s.value === null && s.name !== undefined));
  assert.ok(!g.calls.some((c) => c.path.includes('insights')), 'no insight call without the permission');
  const g0 = graph(() => [200, {}]); const r0 = await reader(g0, { grantedScopes: [] }).read();
  assert.deepEqual([r0.profile.state, r0.profile.permission, r0.publication.state, r0.publication.permission], ['PERMISSION_MISSING', PERMISSION.BASIC, 'PERMISSION_MISSING', PERMISSION.BASIC]); assert.equal(g0.calls.length, 0);
  const g3 = graph(({ path }) => (path === '/v25.0/me' ? [200, PROFILE] : path === '/v25.0/me/media' ? [200, { data: MEDIA }] : [403, gerr(10, 'Application does not have permission for this action')])); // scopes unknown (null): the provider decides
  const r3 = await reader(g3, { grantedScopes: null }).read(); assert.ok(r3.publication.item.stats.every((s) => s.state === FIGURE.PERMISSION_MISSING && s.permission === PERMISSION.INSIGHTS));
  const g4 = graph(() => [403, gerr(10, 'permission denied')]); const r4 = await reader(g4, { grantedScopes: null }).read(); assert.deepEqual([r4.profile.state, r4.profile.permission], ['PERMISSION_MISSING', PERMISSION.BASIC]);
});

test('IR-4 a whole read that cannot happen is an explicit error (token refused, rate limit, Instagram unreachable), never an empty answer; no media is NONE', async () => {
  const codeOf = async (g) => { try { await reader(g).read(); } catch (e) { return e.code; } return null; };
  assert.equal(await codeOf(graph(() => [400, gerr(190, 'Invalid OAuth access token')])), 'TOKEN_REJECTED'); assert.equal(await codeOf(graph(() => [401, {}])), 'TOKEN_REJECTED');
  assert.equal(await codeOf(graph(() => [429, {}])), 'RATE_LIMITED'); assert.equal(await codeOf(graph(() => [400, gerr(4, 'Application request limit reached')])), 'RATE_LIMITED');
  assert.equal(await codeOf(graph(() => [503, {}])), 'SOURCE_UNREACHABLE'); assert.equal(await codeOf({ fetchImpl: async () => { throw new Error('offline'); } }), 'SOURCE_UNREACHABLE');
  const none = await reader(graph(({ path }) => (path === '/v25.0/me' ? [200, PROFILE] : [200, { data: [] }]))).read(); assert.deepEqual([none.profile.state, none.publication.state, none.publication.item], ['OK', 'NONE', null]);
  const sparse = await reader(graph(({ path }) => (path === '/v25.0/me' ? [200, { user_id: '1', username: 'x' }] : [200, { data: [] }]))).read(); assert.deepEqual([sparse.profile.data.followers.state, sparse.profile.data.followers.value], [FIGURE.UNAVAILABLE, null], 'a count that is not returned is not 0');
});

test('IR-5 the reader can only READ: it builds no POST / DELETE, asks no publish permission, and holds no secret', () => {
  const src = readFileSync(new URL('../src/provider-connections/instagram-reader.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /method:\s*'(POST|PUT|PATCH|DELETE)'/); assert.doesNotMatch(src, /content_publish|media_publish|manage_messages|manage_comments|client_secret|refresh_token/); assert.match(src, /instagram_business_manage_insights/);
  assert.throws(() => createInstagramReader({ getAccessToken: async () => TOKEN, graphVersion: 'latest' }), /graphVersion/); assert.throws(() => createInstagramReader({ graphVersion: 'v25.0' }), /getAccessToken/);
});
