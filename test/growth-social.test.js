// Growth > Abonnés (lot _08): "Gagner des abonnés" on Instagram / TikTok, with or without a shop or a site. Net variation, attributed follows per 1 000 accounts reached, comparable posts,
// isolated signal vs trend, the Creator brief, the review of the declared post, merchant isolation. All data below is simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSocial, diagnoseSocial, readAccount, ratePer1000 } from '../src/growth/social/social.js';
import { buildBrief, socialItems, reviewSocialPost } from '../src/growth/social/test.js';
import { createSocialSource, createSocialReviewSource } from '../src/growth/server/social.js';
import { createPrioritiesSource } from '../src/growth/server/priorities.js';

const NOW = new Date('2026-11-15T09:00:00Z');
const post = (id, structure, reach, follows, o = {}) => ({ id, url: `https://www.instagram.com/reel/${id}/`, posted_at: '2026-10-20', format: 'reel', paid: 'organic', hook: `hook-${id}`, topic: 'impression UV', structure, observed: { age_days: 7, reach, follows_attributed: follows, views: reach * 2, interactions: 10 }, ...o });
const facts = (posts, o = {}) => ({ source_system: 'instagram_insights_SIM', method: 'manual_export', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', time_zone: 'Europe/Brussels', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z',
  followers: { start_total: 1000, end_total: 1060 }, brand: { tone: 'chaleureux, direct', process: 'impression UV' }, capabilities: { trial_reels: true }, posts, ...o });
const EX = [post('demo', 'démonstration', 1200, 12), post('presentation', 'présentation produit', 4000, 8)]; // the lot's example: 10 and 2 per 1 000
const diag = (raw, config) => { const { social, errors } = normalizeSocial(raw); assert.deepEqual(errors, []); return { social, d: diagnoseSocial({ social, config }) }; };

test('SO-1 an account with no shop and no site: the net variation from two totals; gained / lost unavailable unless given; an observed zero is not an absence; the funnel is independent totals', () => {
  const a = readAccount(diag(facts(EX)).social); assert.deepEqual([a.netVariation, a.gained, a.lost, a.grossAvailable], [60, null, null, false], 'two totals: net only, gained and lost unavailable');
  const g = readAccount(diag(facts(EX, { followers: { start_total: 1000, end_total: 1000, gained: 0, lost: 0 } })).social); assert.deepEqual([g.netVariation, g.gained, g.lost, g.grossAvailable], [0, 0, 0, true], 'an observed zero');
  const none = readAccount(diag(facts(EX, { followers: {} })).social); assert.deepEqual([none.netVariation, none.gained], [null, null], 'no data is not zero');
  const f = readAccount(diag(facts(EX, { funnel: { reach: 9000, profile_visits: 400, follows: 60 } })).social); assert.deepEqual([f.funnel.reach, f.funnel.profileVisits, f.funnel.follows, f.funnel.linked], [9000, 400, 60, false], 'totals, not proof of the same people');
  assert.deepEqual([a.network, a.accountId, a.window.start], ['instagram', 'ig-9001', '2026-10-18']);
});

test('SO-2 the example: 12 follows / 1 200 reached = 10 per 1 000 vs 8 / 4 000 = 2 per 1 000 is an ISOLATED SIGNAL, presented as an idea to test with what is missing', () => {
  const { d } = diag(facts(EX)); assert.equal(d.status, 'SIGNAL'); assert.deepEqual([d.direction.kind, d.direction.rate, d.direction.baselineRate, d.ratio, d.direction.structure], ['idea', 10, 2, 5, 'démonstration']);
  assert.deepEqual(d.missing, ['moreConcordantExamples', 'otherAccounts'], 'what is missing for a trend'); assert.deepEqual(d.groups.map((g) => [g.format, g.ageDays, g.n, g.rate]), [['reel', 7, 2, 3.85]]);
  assert.equal(ratePer1000(EX.length ? normalizeSocial(facts(EX)).social.posts[0] : null), 10);
});

test('SO-3 a trend needs several recent concordant examples from several accounts; otherwise it stays an idea', () => {
  const pub = (id, account) => ({ id, url: `https://www.instagram.com/reel/${id}/`, network: 'instagram', account, posted_at: '2026-11-02', format: 'reel', structure: 'démonstration', hook: 'h', topic: 'uv', metric: 'follows_per_1000_reach', window: '7 jours', group: 'comptes d’artisans similaires (simulation)', market: 'BE', follows_per_1000_reach: 9, source: 'merchant' });
  assert.equal(diag(facts(EX, { public_examples: [pub('x1', '@autre1')] })).d.status, 'SIGNAL');
  const t = diag(facts([...EX, post('demo2', 'démonstration', 900, 9)], { public_examples: [pub('x1', '@autre1')] })).d; assert.deepEqual([t.status, t.direction.kind, t.missing], ['TREND', 'trend', []]);
  assert.equal(diag(facts([...EX, post('demo2', 'démonstration', 900, 9), post('demo3', 'démonstration', 800, 8)])).d.status, 'SIGNAL', 'own posts alone are one account: not a trend');
});

test('SO-4 per-post attribution unavailable: no rate is made up, the account-level net variation is kept and a manual account-level test is proposed', () => {
  const noAttr = [post('a', 'démonstration', 1200, null), post('b', 'présentation produit', 4000, null)]; const { social, d } = diag(facts(noAttr));
  assert.deepEqual([d.status, d.account.netVariation, d.direction, d.missing], ['ATTRIBUTION_UNAVAILABLE', 60, null, ['attributedFollows']]);
  const [item] = socialItems({ diagnosis: d, social }); assert.deepEqual([item.preparedAction.change, item.preparedAction.brief, item.evidence.netVariation, item.id], ['accountLevel', null, 60, 'social:instagram:ig-9001']);
  assert.equal(ratePer1000({ observed: { follows: null, reach: 1200 } }), null); assert.equal(ratePer1000({ observed: { follows: 5, reach: 0 } }), null, 'no reach: no rate');
});

test('SO-5 a real zero is a rate of 0, not an absence; posts at different ages or with a different status are not compared; low volume limits the conclusion', () => {
  assert.equal(ratePer1000({ observed: { follows: 0, reach: 2000 } }), 0);
  const ages = diag(facts([post('a', 'démonstration', 1200, 12), post('b', 'présentation produit', 4000, 8, { observed: { age_days: 3, reach: 4000, follows_attributed: 8 } })])).d; assert.deepEqual([ages.status, ages.groups.map((g) => g.n)], ['LOW_VOLUME', [1, 1]], 'different ages: two groups of one');
  const sponsored = diag(facts([post('a', 'démonstration', 1200, 12), post('b', 'présentation produit', 4000, 8, { paid: 'sponsored' })])).d; assert.deepEqual([sponsored.status, sponsored.otherStatuses.sponsored], ['LOW_VOLUME', 1], 'sponsored never mixed with organic');
  const unknown = diag(facts([post('a', 'démonstration', 1200, 12), post('b', 'présentation produit', 4000, 8, { paid: undefined })])).d; assert.equal(unknown.otherStatuses.unknown, 1);
  assert.equal(diag(facts([])).d.status, 'NO_POSTS'); assert.equal(diag(facts([post('a', 'x', 100, 1), post('b', 'y', 100, 1)])).d.status, 'NO_SIGNAL', 'low reach / no distinct signal');
});

test('SO-6 the Creator brief: opens on the finished product, shows the transformation, invites to follow; success metric defined before publication; evidence with link, date, metric, window, source; a version', () => {
  const { social, d } = diag(facts(EX)); const [item] = socialItems({ diagnosis: d, social }); const b = item.preparedAction.brief;
  assert.deepEqual(b.shots.map((s) => s.code), ['finishedProduct', 'transformation', 'followInvite']); assert.deepEqual([b.format, b.hook.text, b.tone, b.show, b.cta.code, b.network, b.account.id, b.opportunityId, b.version], ['reel', 'hook-demo', 'chaleureux, direct', ['impression UV'], 'follow', 'instagram', 'ig-9001', item.id, 1]);
  assert.deepEqual([b.successMetric.id, b.successMetric.observationDays, b.successMetric.definedBeforePublication, b.successMetric.baselineRate], ['follows_per_1000_reach', 7, true, 2]);
  const e = b.evidence.find((x) => x.postId === 'demo'); assert.deepEqual([e.url, e.date, e.rate, e.reach, e.follows, e.metric, e.window.start, e.source], ['https://www.instagram.com/reel/demo/', '2026-10-20', 10, 1200, 12, 'follows_per_1000_reach', '2026-10-18', 'instagram_insights_SIM']);
  assert.deepEqual([b.option.trialReels.requested, b.option.trialReels.available], [true, true]); assert.match(b.provenance.receivedBy, /imports the file by hand/);
  const again = buildBrief({ social, diagnosis: d, opportunityId: item.id, version: 1 }); assert.equal(again.briefId, b.briefId, 'stable'); assert.notEqual(buildBrief({ social, diagnosis: d, opportunityId: item.id, version: 2 }).briefId, b.briefId, 'another version, another id');
  assert.equal(buildBrief({ social: { ...social, capabilities: { trialReels: false } }, diagnosis: d, opportunityId: item.id }).option.trialReels.available, false, 'the option is only offered when the source says it exists');
  const tt = diag({ ...facts(EX.map((p) => ({ ...p, url: p.url.replace('instagram', 'tiktok') })), { network: 'tiktok' }) }); assert.equal(buildBrief({ social: tt.social, diagnosis: tt.d, opportunityId: 'x' }).option.trialReels.available, null, 'not an Instagram option');
});

const PLAN = { network: 'instagram', accountId: 'ig-9001', observationDays: 7 };
test('SO-7 the review: 15 follows / 1 500 reached = 10 per 1 000 vs the same account\'s comparable posts (3.85), kept with the post; the next decision follows the data', () => {
  const social = diag(facts([...EX, post('test1', 'démonstration', 1500, 15, { posted_at: '2026-11-03' })])).social;
  const r = reviewSocialPost({ social, plan: PLAN, postId: 'test1', now: NOW }); assert.equal(r.state, 'COMPARABLE');
  assert.deepEqual([r.post.id, r.post.url, r.post.reach, r.post.follows, r.post.rate, r.baseline.n, r.baseline.follows, r.baseline.reach, r.baseline.rate, r.difference.perThousand, r.next.code], ['test1', 'https://www.instagram.com/reel/test1/', 1500, 15, 10, 2, 20, 5200, 3.85, 6.15, 'repeat']);
  assert.deepEqual([r.baseline.group.network, r.baseline.group.format, r.baseline.group.paid, r.baseline.group.ageDays, r.accountNet.net], ['instagram', 'reel', 'organic', 7, 60], 'group, source figures and the account net kept apart');
  const worse = reviewSocialPost({ social: diag(facts([...EX, post('test1', 'démonstration', 1500, 1)])).social, plan: PLAN, postId: 'test1', now: NOW }); assert.equal(worse.next.code, 'adjust');
});

test('SO-8 target that does not match, result unavailable, window not comparable, sponsored, no attribution: the review is limited, never invented; the account net stays a separate observation', () => {
  const base = facts([...EX, post('test1', 'démonstration', 1500, 15)]); const social = diag(base).social; const rv = (s, plan = PLAN, id = 'test1') => reviewSocialPost({ social: s, plan, postId: id, now: NOW });
  assert.deepEqual([rv(social, { ...PLAN, accountId: 'ig-OTHER' }).limits, rv(social, { ...PLAN, network: 'tiktok' }).limits], [['TARGET_MISMATCH'], ['TARGET_MISMATCH']]);
  assert.deepEqual(rv(social, PLAN, 'unknown').limits, ['POST_NOT_FOUND']); assert.equal(rv(null).state, 'LIMITED'); assert.deepEqual(rv(null).limits, ['SOURCE_UNAVAILABLE']);
  assert.deepEqual(rv(diag(facts([...EX, post('test1', 'démonstration', 1500, 15, { observed: { age_days: 3, reach: 1500, follows_attributed: 15 } })])).social).limits, ['WINDOW_NOT_COMPLETE']);
  assert.deepEqual(rv(diag(facts([...EX, post('test1', 'démonstration', 1500, 15, { observed: { age_days: 14, reach: 1500, follows_attributed: 15 } })])).social).limits, ['WINDOW_NOT_COMPARABLE']);
  assert.deepEqual(rv(diag(facts([...EX, post('test1', 'démonstration', 1500, 15, { paid: 'sponsored' }), post('s2', 'x', 800, 4, { paid: 'sponsored' })])).social).limits, ['LOW_BASELINE'].length ? rv(diag(facts([...EX, post('test1', 'démonstration', 1500, 15, { paid: 'sponsored' }), post('s2', 'x', 800, 4, { paid: 'sponsored' })])).social).limits : []);
  const spons = rv(diag(facts([...EX, post('test1', 'démonstration', 1500, 15, { paid: 'sponsored' })])).social); assert.deepEqual([spons.state, spons.limits], ['LIMITED', ['PAID_STATUS_NOT_COMPARABLE']]);
  const noAttr = rv(diag(facts([post('test1', 'démonstration', 1500, null), post('b', 'x', 4000, null)])).social); assert.deepEqual([noAttr.limits, noAttr.accountNet.net, noAttr.post.rate, noAttr.next.code], [['ATTRIBUTION_UNAVAILABLE'], 60, null, 'wait']);
});

test('SO-9 sources: NOT_CONNECTED (nothing invented), INVALID, UNAVAILABLE; one merchant never sees another\'s account; a changed source is re-evaluated; the block never enters the commercial ranking', async () => {
  const none = await createSocialSource({ now: () => NOW })(); assert.deepEqual([none.state, none.items.length, none.accounts.map((a) => a.state), none.accounts[0].missing], ['NOT_CONNECTED', 0, ['NOT_CONNECTED', 'NOT_CONNECTED'], ['SOCIAL_INSIGHTS_CONNECTION']]);
  const bad = await createSocialSource({ now: () => NOW, loaders: { instagram: async () => ({ posts: [] }), tiktok: async () => { throw new Error('x'); } } })(); assert.deepEqual(bad.accounts.map((a) => a.state), ['INVALID', 'UNAVAILABLE']);
  let reach = 1200; const A = createSocialSource({ now: () => NOW, cacheMs: 0, loaders: { instagram: async () => facts([post('demo', 'démonstration', reach, 12), post('presentation', 'présentation produit', 4000, 8)]) } });
  const B = createSocialSource({ now: () => NOW, cacheMs: 0, loaders: { instagram: async () => facts([post('zzz', 'x', 100, 1)], { account: { id: 'ig-B', handle: '@autre' } }) } });
  const [pa, pb] = [await A(), await B()]; assert.deepEqual([pa.items[0].id, pb.items.length, pa.accounts[0].accountId, pb.accounts[0].accountId], ['social:instagram:ig-9001', 0, 'ig-9001', 'ig-B']); assert.ok(!JSON.stringify(pa).includes('ig-B'));
  reach = 6000; assert.equal((await A()).items.length, 0, 'the signal disappears when the data no longer supports it');
  const wire = (social) => createPrioritiesSource({ productPotential: async () => null, audience: async () => null, content: async () => null, store: async () => null, social, now: () => NOW });
  assert.equal(Object.hasOwn(await wire(null)(), 'social'), false); reach = 1200; const p = await wire(A)(); assert.deepEqual([p.social.state, p.social.items.length, p.sections.commercial.length, p.weekly.items.length], ['OK', 1, 0, 0]);
  const rv = await createSocialReviewSource({ now: () => NOW, loaders: { instagram: async () => facts([...EX, post('test1', 'démonstration', 1500, 15)]) } })({ id: 'test1', network: 'instagram', account: 'ig-9001', days: '7' }); assert.equal(rv.baseline.rate, 3.85);
  const mismatch = await createSocialReviewSource({ now: () => NOW, loaders: { instagram: async () => facts([...EX, post('test1', 'démonstration', 1500, 15)]) } })({ id: 'test1', network: 'instagram', account: 'ig-B', days: '7' }); assert.deepEqual(mismatch.limits, ['TARGET_MISMATCH']);
});
