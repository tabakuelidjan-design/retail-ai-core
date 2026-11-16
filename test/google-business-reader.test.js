// Google Business Profile reader: read only, explicit period, last update, honest refusals. Test doubles only: no network, no token, no Google account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleBusinessReader, GBP_METRICS } from '../src/provider-connections/google-business-reader.js';

const LOC = 'accounts/123/locations/456';
const NOW = () => new Date('2026-11-17T08:00:00Z');
const double = (routes) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); const r = routes(url); return { ok: r.status < 400, status: r.status, json: async () => r.body }; }; f.calls = calls; return f; };
const reader = (f, token = async () => 'synthetic-access-token') => createGoogleBusinessReader({ getAccessToken: token, fetchImpl: f, now: NOW });

test('GBR-1 reviews: stars, comment, dates, replied flag, totals and the last update; author names are not kept; the call is a read (GET) with the bearer token only', async () => {
  const f = double(() => ({ status: 200, body: { averageRating: 4.7, totalReviewCount: 38, reviews: [
    { reviewId: 'r1', reviewer: { displayName: 'Une cliente' }, starRating: 'FIVE', comment: 'Super coque personnalisée', createTime: '2026-11-01T10:00:00Z', updateTime: '2026-11-02T09:00:00Z', reviewReply: { comment: 'Merci !' } },
    { reviewId: 'r2', starRating: 'THREE', createTime: '2026-11-10T10:00:00Z', updateTime: '2026-11-10T10:00:00Z' }] } }));
  const r = await reader(f).reviews({ location: LOC });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.headers.authorization, 'Bearer synthetic-access-token'); assert.match(f.calls[0].url, /\/v4\/accounts\/123\/locations\/456\/reviews\?pageSize=50/);
  assert.equal(r.averageRating, 4.7); assert.equal(r.totalReviewCount, 38); assert.equal(r.lastUpdate, '2026-11-10T10:00:00Z'); assert.equal(r.fetchedAt, '2026-11-17T08:00:00.000Z');
  assert.deepEqual(r.reviews.map((x) => [x.id, x.stars, x.replied]), [['r1', 5, true], ['r2', 3, false]]); assert.equal(r.reviews[1].comment, null);
  assert.ok(!JSON.stringify(r).includes('Une cliente'), 'no reviewer identity is kept');
});

test('GBR-2 indicators: summed over the explicit period, the last data day is reported, missing metrics are named (never zero)', async () => {
  const f = double(() => ({ status: 200, body: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
    { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 1 }, value: '3' }, { date: { year: 2026, month: 11, day: 2 }, value: '4' }] } },
    { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 2 } }] } }] }] } }));
  const r = await reader(f).indicators({ location: LOC, from: '2026-11-01', to: '2026-11-14' });
  assert.deepEqual(r.period, { from: '2026-11-01', to: '2026-11-14' }); assert.equal(r.totals.WEBSITE_CLICKS, 7); assert.equal(r.totals.CALL_CLICKS, 0); assert.equal(r.lastDataDay, '2026-11-02');
  assert.ok(r.missing.includes('BUSINESS_DIRECTION_REQUESTS') && !r.missing.includes('WEBSITE_CLICKS')); assert.equal(r.missing.length, GBP_METRICS.length - 2);
  assert.match(f.calls[0].url, /dailyRange\.startDate\.day=1&dailyRange\.endDate\.year=2026/);
});

test('GBR-3 refusals are explicit: access not granted (403/429), token rejected (401), unreachable, other errors; never an empty result', async () => {
  for (const [status, code] of [[403, 'ACCESS_NOT_GRANTED'], [429, 'ACCESS_NOT_GRANTED'], [401, 'TOKEN_REJECTED'], [500, 'SOURCE_ERROR']]) await assert.rejects(() => reader(double(() => ({ status, body: {} }))).reviews({ location: LOC }), (e) => e.code === code, String(status));
  await assert.rejects(() => reader(async () => { throw new Error('ECONNRESET'); }).reviews({ location: LOC }), (e) => e.code === 'SOURCE_UNREACHABLE');
});

test('GBR-4 inputs are validated before any call; no write method exists; the reader never touches a secret', async () => {
  const f = double(() => ({ status: 200, body: {} }));
  for (const loc of ['', 'locations/1', '../accounts/1/locations/2', 'accounts/1/locations/2/reviews']) await assert.rejects(() => reader(f).reviews({ location: loc }), (e) => e.code === 'LOCATION_INVALID');
  await assert.rejects(() => reader(f).indicators({ location: LOC, from: '2026-11-14', to: '2026-11-01' }), (e) => e.code === 'PERIOD_INVALID');
  await assert.rejects(() => reader(f).indicators({ location: LOC, from: 'x', to: '2026-11-01' }), (e) => e.code === 'PERIOD_INVALID');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(Object.keys(reader(f)).sort(), ['indicators', 'reviews']);
  assert.throws(() => createGoogleBusinessReader({}), TypeError);
});
