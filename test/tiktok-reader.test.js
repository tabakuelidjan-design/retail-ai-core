// TikTok read-only reader: test doubles only (no account, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTikTokReader, createTikTokReaderFor } from '../src/provider-connections/tiktok-reader.js';

const NOW = () => new Date('2026-11-17T09:00:00Z');
const double = (routes) => { const calls = []; const f = async (url, init) => { const u = new URL(url); calls.push({ url: u.pathname, query: Object.fromEntries(u.searchParams), init }); const r = routes(u, init, calls.length); return { ok: r.status < 400, status: r.status, json: async () => r.body }; }; f.calls = calls; return f; };
const reader = (f) => createTikTokReader({ getAccessToken: async () => 'synthetic-tiktok-token', fetchImpl: f, now: NOW });

test('TTR-1 account statistics: the four documented figures, the read date, a GET with the bearer token; a figure TikTok does not return stays null (never 0)', async () => {
  const f = double(() => ({ status: 200, body: { data: { user: { open_id: 'oid-1', display_name: 'habb', follower_count: 120, likes_count: 3400, video_count: 14 } }, error: { code: 'ok' } } }));
  const r = await reader(f).accountStats();
  assert.deepEqual([f.calls[0].init.method, f.calls[0].url, f.calls[0].query.fields], ['GET', '/v2/user/info/', 'open_id,display_name,follower_count,following_count,likes_count,video_count']); assert.equal(f.calls[0].init.headers.authorization, 'Bearer synthetic-tiktok-token');
  assert.deepEqual([r.followers, r.likes, r.videos, r.following, r.displayName, r.fetchedAt], [120, 3400, 14, null, 'habb', '2026-11-17T09:00:00.000Z']);
});

test('TTR-2 public videos: figures per video, newest first, pages of at most 20 followed with the cursor, the date of the last post, public videos only; a hidden figure is null', async () => {
  const video = (i, extra = {}) => ({ id: `v${i}`, title: `Vidéo ${i}`, create_time: 1763300000 + i * 3600, duration: 20, view_count: 100 + i, like_count: 5, comment_count: 1, share_count: 0, ...extra });
  const f = double((u, init, n) => (n === 1 ? { status: 200, body: { data: { videos: [video(2), video(1)], cursor: 1763000000000, has_more: true }, error: { code: 'ok' } } } : { status: 200, body: { data: { videos: [video(0, { view_count: undefined })], cursor: 1762000000000, has_more: false }, error: { code: 'ok' } } }));
  const r = await reader(f).videos({ limit: 3 });
  assert.equal(f.calls[0].init.method, 'POST'); assert.equal(f.calls[0].url, '/v2/video/list/'); assert.equal(f.calls[0].query.fields, 'id,title,create_time,duration,view_count,like_count,comment_count,share_count');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { max_count: 3 }); assert.deepEqual(JSON.parse(f.calls[1].init.body), { max_count: 1, cursor: 1763000000000 });
  assert.deepEqual(r.videos.map((v) => [v.id, v.views]), [['v2', 102], ['v1', 101], ['v0', null]]); assert.equal(r.publicOnly, true); assert.equal(r.moreAvailable, false); assert.equal(r.fetchedAt, '2026-11-17T09:00:00.000Z'); assert.equal(r.lastPostedAt, new Date(1763300000 * 1000 + 2 * 3600 * 1000).toISOString());
  const empty = await reader(double(() => ({ status: 200, body: { data: { videos: [], has_more: false }, error: { code: 'ok' } } }))).videos(); assert.deepEqual([empty.videos.length, empty.lastPostedAt], [0, null]);
});

test('TTR-3 honest refusals: 401 = renew, missing scope, rate limit, other errors, unreachable; and the reader of a connector takes its token from the token manager', async () => {
  const mk = (status, code) => reader(double(() => ({ status, body: { error: { code } } })));
  await assert.rejects(() => mk(401, 'access_token_invalid').accountStats(), (e) => e.code === 'TOKEN_REJECTED');
  await assert.rejects(() => mk(403, 'scope_not_authorized').accountStats(), (e) => e.code === 'SCOPE_MISSING');
  await assert.rejects(() => mk(429, 'rate_limit_exceeded').videos(), (e) => e.code === 'RATE_LIMITED');
  await assert.rejects(() => mk(500, 'internal_error').accountStats(), (e) => e.code === 'SOURCE_ERROR');
  await assert.rejects(() => createTikTokReader({ getAccessToken: async () => 't', fetchImpl: async () => { throw new Error('x'); } }).accountStats(), (e) => e.code === 'SOURCE_UNREACHABLE');
  const asked = []; const tokenManager = { async getValidCredential(a) { asked.push(a); return { tokens: { access_token: { reveal: () => 'token-from-manager' } } }; } };
  const f = double(() => ({ status: 200, body: { data: { user: {} }, error: { code: 'ok' } } }));
  await createTikTokReaderFor({ tokenManager, merchantId: 'm-1', connectorId: 'c-1', fetchImpl: f, now: NOW }).accountStats();
  assert.deepEqual(asked, [{ merchantId: 'm-1', connectorId: 'c-1', provider: 'tiktok' }]); assert.equal(f.calls[0].init.headers.authorization, 'Bearer token-from-manager');
  assert.throws(() => createTikTokReaderFor({ tokenManager, merchantId: '', connectorId: 'c' }), TypeError);
});
