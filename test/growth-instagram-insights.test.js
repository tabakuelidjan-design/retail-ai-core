// The read-only Instagram reader (Instagram API with Instagram Login) on a SIMULATED Graph API: what it asks, what it returns in the Growth contract, what stays unavailable, and that it never leaks a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramInsightsLoader, fetchHttp, InsightsError } from '../src/growth/server/instagram-insights.js';
import { instagramLoaderFromEnv } from '../src/growth/server/instagram-env.js';
import { normalizeSocial } from '../src/growth/social/social.js';
import { createSocialSource } from '../src/growth/server/social.js';
import { createInstagramOAuth, INSTAGRAM_MINIMUM_SCOPES, INSTAGRAM_INSIGHTS_SCOPE } from '../src/provider-connections/providers/instagram-oauth.js';

const NOW = new Date('2026-11-15T12:00:00Z'); const TOKEN = 'IGQV-SECRET-TOKEN-123';
const media = [
  { id: 'm1', permalink: 'https://www.instagram.com/reel/AAA/', timestamp: '2026-11-08T10:00:00+0000', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Du plateau vide au cadeau fini\n#uv' },
  { id: 'm2', permalink: 'https://www.instagram.com/p/BBB/', timestamp: '2026-11-08T10:00:00+0000', media_product_type: 'FEED', media_type: 'IMAGE', caption: null },
  { id: 'm3', permalink: 'https://www.instagram.com/stories/x/', timestamp: '2026-11-14T10:00:00+0000', media_product_type: 'STORY', media_type: 'IMAGE' },
  { id: 'm4', permalink: 'https://www.instagram.com/p/OLD/', timestamp: '2026-08-01T10:00:00+0000', media_product_type: 'FEED', media_type: 'IMAGE' },
];
function graph({ me = { user_id: '1784', username: 'habb.be', account_type: 'BUSINESS', followers_count: 1060 }, denyInsights = false, status = 200 } = {}) {
  const calls = [];
  const http = async (url) => {
    calls.push(url); const u = new URL(url); const path = u.pathname.split('/').slice(2).join('/');
    if (status !== 200) return { status, body: { error: { code: 190 } } };
    if (path === 'me') return { status: 200, body: me };
    if (path.endsWith('/insights') && denyInsights) return { status: 400, body: { error: { code: 10, message: `(#10) Application does not have permission for token ${TOKEN}` } } };
    if (path === '1784/insights') return { status: 200, body: { data: [{ name: 'reach', total_value: { value: 3400 } }] } };
    if (path === '1784/media') return { status: 200, body: { data: media } };
    if (path === 'm1/insights') return { status: 200, body: { data: [{ name: 'reach', values: [{ value: 1500 }] }, { name: 'views', values: [{ value: 2600 }] }] } };
    if (path === 'm2/insights') return { status: 200, body: { data: [{ name: 'reach', values: [{ value: 400 }] }, { name: 'follows', values: [{ value: 3 }] }] } }; // no `views`: an empty / absent metric
    return { status: 404, body: {} };
  };
  return { http, calls };
}
const make = (g, o = {}) => createInstagramInsightsLoader({ http: g.http, getToken: () => TOKEN, graphVersion: 'v25.0', now: () => NOW, ...o });

test('IGI-1 reads the account and the publications, only with GET on graph.instagram.com, and returns the Growth contract', async () => {
  const g = graph(); const raw = await make(g)(); assert.ok(raw);
  assert.ok(g.calls.every((u) => u.startsWith('https://graph.instagram.com/v25.0/')), g.calls.join('\n'));
  assert.deepEqual([raw.network, raw.account.id, raw.account.handle, raw.followers.end_total, raw.funnel.reach, raw.window], ['instagram', '1784', '@habb.be', 1060, 3400, { start: '2026-10-18', end: '2026-11-15' }]);
  const { social, errors } = normalizeSocial(raw); assert.deepEqual(errors, []); assert.equal(social.posts.length, 2, 'the story and the post older than the window are left out');
  const reel = social.posts.find((p) => p.id === 'm1'); const feed = social.posts.find((p) => p.id === 'm2');
  assert.deepEqual([reel.format, reel.hook, reel.observed.ageDays, reel.observed.reach, reel.observed.views, reel.observed.follows, reel.paid], ['reel', 'Du plateau vide au cadeau fini', 7, 1500, 2600, null, 'unknown']);
  assert.equal(feed.observed.follows, 3); assert.equal(feed.observed.views, null, 'a metric Meta does not return is unavailable, never 0');
  const reelCall = g.calls.find((u) => u.includes('/m1/insights')); assert.ok(new URL(reelCall).searchParams.get('metric') === 'reach,views', 'follows is not requested for a Reel (not available at the source)');
});

test('IGI-2 the follower total is current only: no net variation on the first reading, then from our own snapshot', async () => {
  let saved = []; const snapshots = { read: async () => saved, write: async (l) => { saved = l; } };
  const a = normalizeSocial(await make(graph(), { snapshots })()).social; assert.deepEqual([a.followers.startTotal, a.followers.endTotal], [null, 1060]); assert.equal(saved.length, 1);
  saved = [{ date: '2026-10-20', total: 1000 }]; const b = normalizeSocial(await make(graph(), { snapshots })()).social; assert.deepEqual([b.followers.startTotal, b.followers.endTotal], [1000, 1060]);
  assert.deepEqual([b.followers.gained, b.followers.lost], [null, null], 'gained and lost are not derived');
});

test('IGI-3 no token is NOT_CONNECTED; a missing insights permission is a named state, a bad token another, and neither leaks the token', async () => {
  assert.equal(await createInstagramInsightsLoader({ http: graph().http, getToken: () => null, graphVersion: 'v25.0' })(), null);
  await assert.rejects(make(graph({ denyInsights: true }))(), (e) => e instanceof InsightsError && e.code === 'INSIGHTS_PERMISSION_MISSING' && !String(e.message + e.stack).includes(TOKEN));
  await assert.rejects(make(graph({ status: 401 }))(), (e) => e.code === 'TOKEN_INVALID_OR_EXPIRED');
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try { const src = createSocialSource({ now: () => NOW, cacheMs: 0, loaders: { instagram: make(graph({ denyInsights: true })) } }); const s = await src(); const ig = s.accounts.find((x) => x.network === 'instagram');
    assert.deepEqual([ig.state, ig.reason, ig.missing], ['UNAVAILABLE', 'INSIGHTS_PERMISSION_MISSING', ['instagram_business_manage_insights']]); assert.equal(JSON.stringify(s).includes(TOKEN), false); } finally { console.error = orig; }
  assert.equal(errs.join('\n').includes(TOKEN), false, 'nothing logged carries the token');
});

test('IGI-4 through Growth: a published account with no organic status and no attribution on Reels gives the account reading, never an invented signal', async () => {
  const src = createSocialSource({ now: () => NOW, cacheMs: 0, loaders: { instagram: make(graph()) } }); const s = await src(); const ig = s.accounts.find((x) => x.network === 'instagram');
  assert.equal(ig.state, 'OK'); assert.deepEqual([ig.diagnosis.status, s.items.length], ['LOW_VOLUME', 0], 'status unknown + 1 rated post: not enough to recommend');
});

test('IGI-5 the transport refuses any other host; the env builds the loader only with a token and a version; the insights scope is requested separately from publishing', async () => {
  await assert.rejects(fetchHttp(async () => { throw new Error('must not be called'); })('https://evil.example/x'), (e) => e.code === 'HOST_REFUSED');
  assert.equal(instagramLoaderFromEnv({}), null); assert.equal(instagramLoaderFromEnv({ SOCIAL_INSTAGRAM_TOKEN: 't' }), null); assert.equal(typeof instagramLoaderFromEnv({ SOCIAL_INSTAGRAM_TOKEN: 't', INSTAGRAM_GRAPH_API_VERSION: 'v25.0' }), 'function');
  const oauth = createInstagramOAuth({ http: async () => ({}) }); const cfg = { clientId: 'c', redirectUri: 'https://x.test/cb', graphVersion: 'v25.0' };
  const scopeOf = (w) => new URL(oauth.buildAuthorizationRequest({ appConfig: cfg, state: 's', withInsights: w })).searchParams.get('scope');
  assert.equal(scopeOf(false), INSTAGRAM_MINIMUM_SCOPES.join(',')); assert.equal(scopeOf(true), [...INSTAGRAM_MINIMUM_SCOPES, INSTAGRAM_INSIGHTS_SCOPE].join(','));
});
