// Growth > Campagnes publicitaires (lot _06): the diagnosis of an ad campaign from the facts the ad source provides. A missing figure is never zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseAds, adsItems } from '../src/growth/ads/ads.js';
import { createAdsSource } from '../src/growth/server/ads.js';
import { createPrioritiesSource } from '../src/growth/server/priorities.js';
import { normalizeAds } from '../src/marketing/paid.js';

const NOW = new Date('2026-11-15T09:00:00Z'); const TZ = 'UTC';
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
const rows = (id, name, n, f, from = '2026-10-18') => days(from, n).map((date, i) => ({ date, campaign_id: id, campaign_name: name, impressions: 100, clicks: 4, cost: 3, ...f(i) }));
const facts = (r, o = {}) => ({ source_system: 'meta_ads', platform: 'meta_ads', account_ref: 'act_SIM', currency: 'EUR', conversion_objective: 'purchase', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', rows: r, ...o });
const diag = (r, o = {}, shop = null) => { const f = facts(r, o); const ads = normalizeAds(f).ads; ads.conversion_objective = f.conversion_objective ?? null; return diagnoseAds({ ads, now: NOW, timeZone: TZ, shopOrdersByCampaign: shop }); };
const one = (d, id) => d.campaigns.find((c) => c.campaignId === id);

test('AD-1 a real zero: complete mature period, spend above the minimum, enough clicks, conversions reported as 0 -> NO_CONVERSION with its exact facts', () => {
  const zero = () => rows('c-zero', 'Coques été', 28, () => ({ conversions: 0 }));
  const d = diag(zero());
  const c = one(d, 'c-zero'); assert.equal(c.status, 'NO_CONVERSION'); assert.deepEqual([d.matureEnd, c.matureDays, c.lagDays], ['2026-11-08', 21, 7], 'only the days older than the conversion lag count');
  assert.deepEqual([c.evidence.spend, c.evidence.clicks, c.evidence.conversions, c.currency, c.channel, c.objective], [63, 84, 0, 'EUR', 'meta_ads', 'purchase']);
  assert.equal(c.evidence.action, 'reviewLanding', 'no order recorded by the shop for this campaign: examine the landing page');
  const track = one(diag(zero(), {}, new Map([['c-zero', 3]])), 'c-zero'); assert.equal(track.evidence.action, 'checkTracking', 'the shop saw orders the platform did not: the tracking first');
  const [item] = adsItems(d); assert.deepEqual([item.id, item.kind, item.preparedAction.code, item.preparedAction.check, item.measurement.start, item.measurement.end, item.evidence.currency], ['ad:meta_ads:c-zero', 'adCampaign', 'adCheck', 'landing', '2026-10-18', '2026-11-08', 'EUR']);
});

test('AD-2 unknown conversions are NEVER zero: a missing figure on any mature day -> CONVERSIONS_UNKNOWN (check the tracking), not NO_CONVERSION', () => {
  const all = one(diag(rows('c-unk', 'Reels', 28, () => ({}))), 'c-unk'); assert.equal(all.status, 'CONVERSIONS_UNKNOWN'); assert.equal(all.evidence.conversions, null);
  const some = one(diag(rows('c-part', 'Reels 2', 28, (i) => (i < 10 ? { conversions: 0 } : {}))), 'c-part'); assert.equal(some.status, 'CONVERSIONS_UNKNOWN'); assert.deepEqual([some.evidence.rowsWithConversions, some.evidence.rows], [10, 21], 'zeros on some days do not make the rest zero');
  assert.equal(adsItems(diag(rows('c-unk', 'Reels', 28, () => ({}))))[0].preparedAction.check, 'tracking');
  assert.equal(one(diag(rows('c-cost', 'X', 28, (i) => ({ conversions: 0, cost: i === 3 ? null : 3 }))), 'c-cost').status, 'SPEND_UNKNOWN', 'a missing cost is not a zero spend either');
});

test('AD-3 incomplete or immature periods give no conclusion: days missing, conversion lag not elapsed, low spend, low traffic', () => {
  assert.equal(one(diag(rows('c-gap', 'Gap', 12, () => ({ conversions: 0 }))), 'c-gap').status, 'INCOMPLETE_PERIOD', '12 of the 21 mature days have data');
  const recent = diag(rows('c-new', 'New', 10, () => ({ conversions: 0 }), '2026-11-05'), { window: { start: '2026-11-05', end: '2026-11-15' } }); const n = one(recent, 'c-new');
  assert.deepEqual([n.status, n.matureDays, n.evidence.minMatureDays], ['NOT_MATURE', 3, 7], 'conversions of the last 7 days are not reported yet'); assert.equal(adsItems(recent).length, 0);
  assert.equal(one(diag(rows('c-low', 'Low', 28, () => ({ conversions: 0, cost: 0.5 }))), 'c-low').status, 'LOW_SPEND');
  assert.equal(one(diag(rows('c-tr', 'Traffic', 28, () => ({ conversions: 0, clicks: 1 }))), 'c-tr').status, 'LOW_TRAFFIC');
  assert.equal(one(diag(rows('c-d', 'NoDate', 5, () => ({ conversions: 0 })).concat([{ campaign_id: 'c-d', impressions: 1, clicks: 1, cost: 1, conversions: 0 }])), 'c-d').status, 'SPEND_UNKNOWN');
});

test('AD-4 a campaign without anomaly produces no item; a mix of campaigns is diagnosed one by one with its own figures', () => {
  const r = [...rows('c-ok', 'Bon', 28, () => ({ conversions: 1 })), ...rows('c-zero', 'Zéro', 28, () => ({ conversions: 0 })), ...rows('c-unk', 'Inconnu', 28, () => ({}))];
  const d = diag(r); assert.deepEqual(d.campaigns.map((c) => [c.campaignId, c.status]).sort(), [['c-ok', 'OK'], ['c-unk', 'CONVERSIONS_UNKNOWN'], ['c-zero', 'NO_CONVERSION']]);
  assert.deepEqual(adsItems(d).map((i) => i.id).sort(), ['ad:meta_ads:c-unk', 'ad:meta_ads:c-zero']); assert.equal(one(d, 'c-ok').evidence.conversions, 21);
  assert.equal(diag([]).campaigns.length, 0, 'no rows: no campaign, no invented zero');
});

test('AD-5 source: NOT_CONNECTED without a connection (nothing invented), INVALID facts are refused with the reasons, a changed source is re-evaluated', async () => {
  const none = await createAdsSource({ timeZone: TZ, now: () => NOW })(); assert.deepEqual([none.state, none.missing, none.items.length, none.campaigns.length], ['NOT_CONNECTED', 'AD_ACCOUNT_CONNECTION', 0, 0]);
  const bad = await createAdsSource({ timeZone: TZ, now: () => NOW, load: async () => ({ rows: [{ campaign_id: 'x' }] }) })(); assert.equal(bad.state, 'INVALID'); assert.ok(bad.errors.length > 0);
  const down = await createAdsSource({ timeZone: TZ, now: () => NOW, load: async () => { throw new Error('boom'); } })(); assert.equal(down.state, 'UNAVAILABLE');
  let conv = 0; const src = createAdsSource({ timeZone: TZ, now: () => NOW, cacheMs: 0, load: async () => facts(rows('c1', 'C1', 28, () => ({ conversions: conv }))) });
  assert.equal((await src()).items.length, 1); conv = 2; const after = await src(); assert.deepEqual([after.items.length, after.campaigns[0].status], [0, 'OK'], 'the suggestion disappears when the source now reports conversions');
});

test('AD-6 priorities: the ads block exists only when an ad source is wired; it never enters the commercial ranking', async () => {
  const wire = (ads) => createPrioritiesSource({ productPotential: async () => null, audience: async () => null, content: async () => null, store: async () => null, ads, now: () => NOW });
  assert.equal(Object.hasOwn(await wire(null)(), 'ads'), false);
  const src = createAdsSource({ timeZone: TZ, now: () => NOW, load: async () => facts(rows('c-zero', 'Z', 28, () => ({ conversions: 0 }))) }); const p = await wire(src)();
  assert.deepEqual([p.ads.state, p.ads.items.length, p.sections.commercial.length, p.weekly.items.length], ['OK', 1, 0, 0]);
});
