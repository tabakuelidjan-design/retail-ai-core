// Growth > Où les visiteurs abandonnent (rule growth-dropoff.1): unavailable is never 0, personalizer steps only where personalisation exists, upload = technical statuses only,
// low volume is said, a low product is flagged only when it is not chance, recorded vs hypothesis, mobile vs desktop on one definition, merchant source states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDropoff, buildDropoff, analyseRow, binomialCdf, DROPOFF_CONFIG, STEPS } from '../src/growth/dropoff/dropoff.js';
import { createDropoffSource } from '../src/growth/server/dropoff.js';
import { createGrowthApp } from '../src/growth/server/app.js';

const NOW = new Date('2026-11-18T10:00:00Z'); const TZ = 'Europe/Brussels';
const c = (session, add_to_cart, checkout_start, purchase, extra = {}) => ({ session, add_to_cart, checkout_start, purchase, ...extra });
const raw = (rows, o = {}) => ({ source_system: 'shopify_analytics', time_zone: TZ, site_url: 'https://shop.example', retrieved_at: '2026-11-18T09:00:00Z', window: { start: '2026-10-19', end: '2026-11-18' }, rows, ...o });
const base = () => [
  { scope: 'shop', device: 'mobile', counts: c(300, 15, 6, 3) }, { scope: 'shop', device: 'desktop', counts: c(150, 12, 6, 3) },
  { scope: 'personalizable', device: 'mobile', basis: 'landing_page', counts: c(120, 6, 3, 1) }, { scope: 'personalizable', device: 'desktop', counts: c(40, 4, 2, 1) },
  { scope: 'product', product: 'case-a', title: 'Case A', device: 'all', personalizable: true, counts: c(60, 0, 0, 0) },
  { scope: 'product', product: 'case-b', title: 'Case B', device: 'all', personalizable: true, counts: c(8, 0, 0, 0) },
  { scope: 'product', product: 'mug', title: 'Mug', device: 'all', counts: c(100, 12, 5, 2) },
];
const build = (r, o) => { const { funnel, errors } = normalizeDropoff(r); assert.deepEqual(errors, []); return buildDropoff({ funnel, now: NOW, timeZone: TZ, ...o }); };
const step = (f, k) => f.steps.find((s) => s.key === k);

test('DO-1 a step the source does not give is UNAVAILABLE (never 0) and names the event to add; the others carry their source', () => {
  const d = build(raw(base())); const f = d.funnels.find((x) => x.scope === 'personalizable' && x.device === 'mobile');
  for (const k of ['product_view', 'personalizer_open', 'photo_upload', 'personalization_done', 'shipping', 'payment']) { const s = step(f, k); assert.equal(s.status, 'UNAVAILABLE', k); assert.equal(s.value, null); assert.ok(s.event?.event, k); }
  assert.equal(step(f, 'personalizer_open').event.event, 'habb_personalizer_opened'); assert.equal(step(f, 'photo_upload').event.event, 'habb_photo_upload_status');
  assert.equal(step(f, 'add_to_cart').value, 6); assert.equal(step(f, 'add_to_cart').source, 'shopify_analytics');
  assert.equal(step(f, 'add_to_cart').rate, 0.05); assert.deepEqual(step(f, 'add_to_cart').skipped.sort(), ['personalization_done', 'personalizer_open', 'photo_upload', 'product_view']);
});

test('DO-2 personalizer steps are NOT_APPLICABLE on the shop-wide funnel (not "missing")', () => {
  const f = build(raw(base())).funnels.find((x) => x.scope === 'shop' && x.device === 'mobile');
  for (const k of ['personalizer_open', 'photo_upload', 'personalization_done']) assert.equal(step(f, k).status, 'NOT_APPLICABLE');
  assert.ok(!f.findings.some((x) => x.code === 'STEPS_NOT_MEASURED' && x.constat.steps.includes('photo_upload')));
});

test('DO-3 recorded upload failures: counts and technical reasons only; low attempts do not conclude', () => {
  const r = base(); r[2].photo_upload = { ok: 14, failed: 6, reasons: { too_large: 4, network: 2, 'My Holiday.jpg': 9 } };
  const d = build(raw(r)); const f = d.funnels.find((x) => x.scope === 'personalizable' && x.device === 'mobile'); const u = f.findings.find((x) => x.code === 'UPLOAD_FAILURES');
  assert.equal(u.kind, 'recorded'); assert.deepEqual([u.constat.failed, u.constat.attempts, u.constat.rate], [6, 20, 0.3]); assert.deepEqual(u.constat.reasons, { too_large: 4, network: 2 }); // a file-name-like key is dropped
  assert.ok(!JSON.stringify(d).includes('Holiday'));
  r[2].photo_upload = { ok: 1, failed: 2, reasons: {} }; assert.equal(build(raw(r)).funnels.find((x) => x.scope === 'personalizable' && x.device === 'mobile').findings.find((x) => x.code.startsWith('UPLOAD')).code, 'UPLOAD_LOW_VOLUME');
});

test('DO-4 low volume is said and no hypothesis is produced; the hypothesis needs enough mobile coque visits and a rate below the shop reference', () => {
  const low = build(raw(base())).funnels.find((x) => x.scope === 'personalizable' && x.device === 'desktop'); assert.ok(low.lowVolume); assert.ok(low.findings.some((x) => x.code === 'LOW_VOLUME'));
  const r = base(); r[2].counts = c(200, 4, 2, 1); const f = build(raw(r)).funnels.find((x) => x.scope === 'personalizable' && x.device === 'mobile');
  const h = f.findings.find((x) => x.kind === 'hypothesis'); assert.equal(h.code, 'PHONE_MODEL_HARD_TO_FIND'); assert.ok(f.findings.filter((x) => x.kind === 'recorded').length >= 1);
  r[2].counts = c(200, 30, 10, 5); assert.ok(!build(raw(r)).funnels.find((x) => x.scope === 'personalizable' && x.device === 'mobile').findings.some((x) => x.kind === 'hypothesis'));
});

test('DO-5 mobile vs desktop uses ONE definition (visits with a cart / visits) and says when the volume is limited', () => {
  const d = build(raw(base())); const s = d.comparison.find((x) => x.scope === 'shop'); assert.deepEqual([s.mobile.rate, s.desktop.rate, s.gapPoints, s.state], [0.05, 0.08, -3, 'OK']);
  assert.equal(d.comparison.find((x) => x.scope === 'personalizable').state, 'LOW_VOLUME');
});

test('DO-6 products: flagged only when the low cart count is not plausible chance (exact binomial); small volumes are said, never ranked as bad', () => {
  const d = build(raw(base())); const by = Object.fromEntries(d.products.list.map((p) => [p.product, p]));
  assert.equal(by['case-a'].status, 'LOW_ADD_TO_CART'); assert.ok(by['case-a'].chance < 0.1); assert.equal(by['case-b'].status, 'LOW_VOLUME'); assert.equal(by.mug.status, 'NOT_DISTINCT');
  assert.ok(Math.abs(binomialCdf(0, 16, 0.054) - 0.4) < 0.02); assert.equal(binomialCdf(3, 3, 0.5), 1);
});

test('DO-7 contract: bad rows refused with reasons; counts above sessions refused; the window must be over and in the merchant time zone', () => {
  assert.ok(normalizeDropoff(raw([{ scope: 'shop', device: 'mobile', counts: c(10, 11, 0, 0) }])).errors.some((e) => e.includes('larger than sessions')));
  assert.ok(normalizeDropoff(raw([{ scope: 'shop', device: 'phone', counts: c(10, 1, 0, 0) }])).errors.length);
  assert.ok(normalizeDropoff(raw([{ scope: 'shop', device: 'mobile', counts: c(10, -1, 0, 0) }])).errors.length);
  assert.ok(normalizeDropoff(raw([])).errors.length); assert.ok(normalizeDropoff(null).errors.length);
  assert.equal(build(raw(base(), { window: { start: '2026-11-10', end: '2026-11-25' } })).state, 'INCOMPLETE_PERIOD');
  assert.equal(build(raw(base(), { time_zone: 'UTC' })).state, 'INCOMPLETE_PERIOD');
  assert.deepEqual(STEPS.length, 10);
});

test('DO-8 the screen says what it measures: the optional question is a second step and no photo / file field exists in the payload', () => {
  const d = build(raw(base())); assert.equal(d.optionalQuestion.state, 'NOT_ASKED'); assert.ok(d.events.find((e) => e.step === 'photo_upload' && !e.measured));
  assert.ok(!/file_?name|filename|photo_url|image/i.test(JSON.stringify(d)));
});

test('DO-9 source states: NOT_CONNECTED without a loader / without data, INVALID with reasons, UNAVAILABLE when unreadable, OK with data; one merchant per server', async () => {
  const mk = (load) => createDropoffSource({ load, timeZone: TZ, now: () => NOW, cacheMs: 0 })();
  assert.equal((await mk(null)).state, 'NOT_CONNECTED'); assert.equal((await mk(async () => null)).state, 'NOT_CONNECTED');
  const inv = await mk(async () => ({ source_system: 'x' })); assert.equal(inv.state, 'INVALID'); assert.ok(inv.errors.length);
  const orig = console.error; console.error = () => {}; try { assert.equal((await mk(async () => { throw new Error('boom'); })).state, 'UNAVAILABLE'); } finally { console.error = orig; }
  assert.equal((await mk(async () => raw(base()))).state, 'OK');
});

test('DO-10 route /api/growth/dropoff: 503 without a source, the payload with one, GET only', async () => {
  const call = async (app, method = 'GET') => { let status; let body = ''; await app({ method, url: '/api/growth/dropoff', headers: {} }, { writeHead: (s) => { status = s; }, end: (b) => { body = String(b ?? ''); } }); return { status, body: body ? JSON.parse(body) : null }; };
  assert.equal((await call(createGrowthApp({}))).status, 503);
  const app = createGrowthApp({ dropoff: createDropoffSource({ load: async () => raw(base()), timeZone: TZ, now: () => NOW, cacheMs: 0 }) });
  const r = await call(app); assert.equal(r.status, 200); assert.equal(r.body.state, 'OK'); assert.equal((await call(app, 'POST')).status, 405);
});
