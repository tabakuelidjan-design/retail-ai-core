// Growth > revue: the before / after comparison of NET units (src/growth/review/compare.js) and its server source / endpoint. Simulated data, offline.
// Example used throughout: the action is applied on 2026-10-10, reviewed on 2026-11-07, computed on 2026-11-15, merchant zone Europe/Brussels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareNetUnits, reviewWindows } from '../src/growth/review/compare.js';
import { createReviewSource } from '../src/growth/server/review.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { localMidnight } from '../src/metrics/windows.js';

const TZ = 'Europe/Brussels';
const NOW = new Date('2026-11-15T12:00:00Z');
const at = (date, hh = 12) => `${date}T${String(hh).padStart(2, '0')}:00:00Z`; // mid-day UTC: unambiguous local date in Brussels
let seq = 0;
function dataset({ orders = [], refunds = [], refundLines = [], first = '2026-05-11T10:00:00Z' } = {}) {
  const lines = []; const os = [];
  for (const o of orders) { const id = `o${++seq}`; os.push({ id, ordered_at: o.at, is_test: !!o.test, status: o.status ?? 'PAID', cancelled_at: o.cancelled ?? null, lines_truncated: !!o.truncated });
    lines.push({ id: `l${seq}`, order_id: id, variant_id: o.variant ?? 'v-bleu', quantity: o.qty ?? 1 }); o.lineId = `l${seq}`; }
  return { products: [{ id: 'p1', source_id: 'gid://P/1', title: 'Casque' }, { id: 'p2', source_id: 'gid://P/2', title: 'Autre' }],
    variants: [{ id: 'v-bleu', product_id: 'p1', source_id: 'gid://V/bleu', title: 'Bleu' }, { id: 'v-mauve', product_id: 'p1', source_id: 'gid://V/mauve', title: 'Mauve' }, { id: 'v-x', product_id: 'p2', source_id: 'gid://V/x', title: 'X' }],
    orders: os, orderLines: lines, refunds, refundLines, firstOrderAt: first };
}
const P = { type: 'product', id: 'p1' };
const run = (data, target = P, over = {}) => compareNetUnits({ data, target, appliedDate: '2026-10-10', reviewDate: '2026-11-07', now: NOW, timeZone: TZ, ...over });
// 3 net units BEFORE [2026-09-12, 2026-10-10) and 5 AFTER [2026-10-11, 2026-11-08)
const sample = () => dataset({ orders: [{ at: at('2026-09-12') }, { at: at('2026-09-30') }, { at: at('2026-10-09') }, { at: at('2026-10-11') }, { at: at('2026-10-20'), qty: 2 }, { at: at('2026-11-02') }, { at: at('2026-11-07') }] });

test('CR-1 the two windows: application day excluded, same duration N, whole weeks from 7 days, review day included once over, today never; end excluded; merchant zone', () => {
  const w = reviewWindows({ appliedDate: '2026-10-10', reviewDate: '2026-11-07', now: NOW, timeZone: TZ });
  assert.equal(w.ok, true); assert.equal(w.days, 28); assert.equal(w.weekdaysBalanced, true);
  assert.deepEqual([w.before.localStart, w.before.localEnd, w.after.localStart, w.after.localEnd], ['2026-09-12', '2026-10-10', '2026-10-11', '2026-11-08']);
  assert.equal(w.before.end, localMidnight('2026-10-10', TZ).toISOString()); assert.equal(w.after.start, localMidnight('2026-10-11', TZ).toISOString());
  assert.equal(w.after.start, '2026-10-10T22:00:00.000Z', 'Brussels is UTC+2 on 11 Oct 2026'); assert.equal(w.after.end, '2026-11-07T23:00:00.000Z', 'Brussels is UTC+1 on 8 Nov 2026 (DST ended on 25 Oct)');
  // 33 days available -> cut to 28 (four whole weeks) so each weekday appears equally often on both sides
  const cut = reviewWindows({ appliedDate: '2026-10-10', reviewDate: '2026-11-12', now: NOW, timeZone: TZ }); assert.equal(cut.days, 28); assert.equal(cut.after.localEnd, '2026-11-08');
  // a review date far ahead: the comparison stops at the last COMPLETE day (today is partial)
  const open = reviewWindows({ appliedDate: '2026-10-10', reviewDate: '2026-12-20', now: NOW, timeZone: TZ }); assert.equal(open.after.localEnd, '2026-11-15'); assert.equal(open.days, 35);
  // fewer than 7 days: allowed but the weekdays are not balanced
  const short = reviewWindows({ appliedDate: '2026-11-10', reviewDate: '2026-11-13', now: NOW, timeZone: TZ }); assert.deepEqual([short.days, short.weekdaysBalanced, short.before.localStart, short.after.localStart], [3, false, '2026-11-07', '2026-11-11']);
  // nothing complete after the application day
  for (const d of ['2026-11-14', '2026-11-15', '2026-11-20']) assert.equal(reviewWindows({ appliedDate: d, reviewDate: '2026-11-30', now: NOW, timeZone: TZ }).limit, 'PERIOD_NOT_COMPLETE', d);
  assert.equal(reviewWindows({ appliedDate: 'x', reviewDate: '2026-11-07', now: NOW, timeZone: TZ }).limit, 'BAD_DATES');
});

test('CR-2 a comparable review: 3 before · 5 after · +2 net units (+66,7 %), exact dates, the application day and the days around the windows left out', () => {
  const d = sample(); d.orders.push({ id: 'edge1', ordered_at: at('2026-10-10') }, { id: 'edge2', ordered_at: at('2026-11-08') }, { id: 'edge3', ordered_at: at('2026-09-11') }); // application day, day after the review, day before BEFORE
  for (const id of ['edge1', 'edge2', 'edge3']) d.orderLines.push({ id: `l-${id}`, order_id: id, variant_id: 'v-bleu', quantity: 7 });
  const r = run(d);
  assert.equal(r.state, 'COMPARABLE'); assert.deepEqual(r.limits, []);
  assert.deepEqual([r.before.units, r.after.units, r.difference.units, r.difference.pct], [3, 5, 2, 0.6667]);
  assert.deepEqual([r.before.localStart, r.before.localEnd, r.after.localStart, r.after.localEnd, r.before.days, r.after.days], ['2026-09-12', '2026-10-10', '2026-10-11', '2026-11-08', 28, 28]);
  assert.equal(r.windows.applicationDayExcluded, true); assert.equal(r.rule, 'growth-review.1'); assert.equal(r.calculatedAt, NOW.toISOString());
});

test('CR-3 a true zero before: the difference is in units, no percentage; a variant target counts only that variant, a product counts all its variants', () => {
  const zero = dataset({ orders: [{ at: at('2026-10-12') }, { at: at('2026-10-20') }, { at: at('2026-10-25') }, { at: at('2026-11-01') }, { at: at('2026-11-05') }] });
  const r = run(zero); assert.deepEqual([r.state, r.before.units, r.after.units, r.difference.units, r.difference.pct], ['COMPARABLE', 0, 5, 5, null]);
  const mix = dataset({ orders: [{ at: at('2026-09-20'), variant: 'v-mauve' }, { at: at('2026-09-21') }, { at: at('2026-10-15'), variant: 'v-mauve' }, { at: at('2026-10-16') }, { at: at('2026-10-17') }, { at: at('2026-10-18'), variant: 'v-x' }] });
  assert.deepEqual([run(mix).before.units, run(mix).after.units], [2, 3]); // p1 = bleu + mauve; the other product (v-x) is not counted
  const v = run(mix, { type: 'variant', id: 'gid://V/mauve' }, { minUnits: 1 }); assert.deepEqual([v.before.units, v.after.units, v.difference.units], [1, 1, 0]);
});

test('CR-4 net is not gross: refunds known at the calculation date are deducted once, cancelled and test orders count 0, and the evidence says so', () => {
  const d = dataset({ orders: [{ at: at('2026-09-15') }, { at: at('2026-09-16') }, { at: at('2026-09-17') }, { at: at('2026-10-12'), qty: 4 }, { at: at('2026-10-13'), qty: 2, status: 'CANCELLED', cancelled: '2026-10-14T10:00:00Z' }, { at: at('2026-10-14'), qty: 9, test: true }, { at: at('2026-10-15') }, { at: at('2026-10-16') }] });
  const refundedLine = d.orderLines.find((l) => l.quantity === 4);
  d.refunds = [{ id: 'r1', order_id: refundedLine.order_id, refunded_at: '2026-10-20T10:00:00Z' }, { id: 'r2', order_id: refundedLine.order_id, refunded_at: '2026-12-31T10:00:00Z' }]; // r2 is dated after the calculation: unknown
  d.refundLines = [{ id: 'rl1', refund_id: 'r1', order_line_id: refundedLine.id, quantity: 1 }, { id: 'rl1', refund_id: 'r1', order_line_id: refundedLine.id, quantity: 1 }, { id: 'rl2', refund_id: 'r2', order_line_id: refundedLine.id, quantity: 3 }];
  const r = run(d);
  assert.deepEqual([r.after.units, r.after.gross, r.after.refunded, r.after.cancelled], [5, 8, 1, 2]); // 4 ordered - 1 refunded + 1 + 1 = 5 net; gross 4 + 2 + 1 + 1 = 8
  assert.deepEqual([r.before.units, r.difference.units], [3, 2]); assert.notEqual(r.after.units, r.after.gross);
});

test('CR-5 the limits: period not complete, target not found, history too short, incomplete synchronisation, low volume - the numbers stay, the state is LIMITED', () => {
  const d = sample();
  const notComplete = run(d, P, { appliedDate: '2026-11-14' }); assert.deepEqual([notComplete.state, notComplete.limits, notComplete.before, notComplete.after], ['LIMITED', ['PERIOD_NOT_COMPLETE'], null, null]);
  const missing = run(d, { type: 'product', id: 'nope' }); assert.deepEqual([missing.state, missing.limits], ['LIMITED', ['TARGET_NOT_FOUND']]);
  assert.deepEqual(run(d, { type: 'variant', id: 'gid://V/none' }).limits, ['TARGET_NOT_FOUND']);
  const tooShort = sample(); tooShort.firstOrderAt = '2026-09-20T10:00:00Z'; const hs = run(tooShort); assert.deepEqual([hs.state, hs.limits, hs.before.units, hs.after.units], ['LIMITED', ['HISTORY_TOO_SHORT'], 3, 5]);
  assert.deepEqual(run({ ...sample(), firstOrderAt: null }).limits, ['HISTORY_TOO_SHORT']);
  const sync = sample(); sync.orders[0].lines_truncated = true; assert.deepEqual(run(sync).limits, ['SYNC_INCOMPLETE']);
  const outside = sample(); outside.orders.push({ id: 'far', ordered_at: at('2026-08-01'), lines_truncated: true }); outside.orderLines.push({ id: 'lf', order_id: 'far', variant_id: 'v-bleu', quantity: 1 }); assert.equal(run(outside).state, 'COMPARABLE', 'a truncated order outside both periods does not matter');
  const low = dataset({ orders: [{ at: at('2026-09-20') }, { at: at('2026-10-20') }] }); const l = run(low); assert.deepEqual([l.state, l.limits, l.before.units, l.after.units], ['LIMITED', ['LOW_VOLUME'], 1, 1]);
});

test('CR-6 a short period is flagged, not hidden; the boundaries are exact (start included, end excluded, local midnights)', () => {
  const d = dataset({ orders: [{ at: at('2026-11-06') }, { at: at('2026-11-08') }, { at: at('2026-11-12') }, { at: at('2026-11-13') }] });
  const r = run(d, P, { appliedDate: '2026-11-10', reviewDate: '2026-11-13', minUnits: 1 });
  assert.deepEqual(r.limits, ['SHORT_PERIOD']); assert.equal(r.state, 'COMPARABLE'); assert.deepEqual([r.before.days, r.before.units, r.after.units], [3, 1, 2]);
  const b = dataset({ orders: [{ at: localMidnight('2026-10-11', TZ).toISOString() }, { at: new Date(localMidnight('2026-11-08', TZ).getTime() - 1000).toISOString() }, { at: localMidnight('2026-11-08', TZ).toISOString() }, { at: new Date(localMidnight('2026-10-10', TZ).getTime() - 1000).toISOString() }, { at: localMidnight('2026-10-10', TZ).toISOString() }, { at: localMidnight('2026-09-12', TZ).toISOString() }] });
  const e = run(b, P, { minUnits: 1 }); assert.deepEqual([e.before.units, e.after.units], [2, 2], 'before: 12 Sep 00:00 and 9 Oct 23:59:59; after: 11 Oct 00:00 and 7 Nov 23:59:59; 10 Oct 00:00 and 8 Nov 00:00 are outside');
});

// ---- the server source and the endpoint ----
test('CR-7 the source reads only the active merchant (fixed at creation), loads from the start of BEFORE, caches, and reads nothing when there is nothing complete to compare', async () => {
  const calls = []; const supabase = { marker: 'sb' };
  const source = createReviewSource({ supabase, merchantId: 'merchant-A', timeZone: TZ, now: () => NOW, load: async (sb, merchant, opts) => { calls.push([sb, merchant, opts.since.toISOString()]); return sample(); } });
  const q = { type: 'product', id: 'p1', applied: '2026-10-10', review: '2026-11-07' };
  const r = await source(q); assert.equal(r.state, 'COMPARABLE'); assert.deepEqual(calls, [[supabase, 'merchant-A', '2026-09-11T22:00:00.000Z']]);
  await source(q); assert.equal(calls.length, 1, 'cached');
  const none = await source({ ...q, applied: '2026-11-14' }); assert.deepEqual(none.limits, ['PERIOD_NOT_COMPLETE']); assert.equal(calls.length, 1, 'no read');
  assert.throws(() => createReviewSource({ supabase, merchantId: '', timeZone: TZ }), TypeError); assert.throws(() => createReviewSource({ supabase, merchantId: 'm', timeZone: '' }), { code: 'TIMEZONE_NOT_CONFIGURED' });
});

test('CR-8 endpoint: no merchant parameter (ignored), strict parameters, typed errors, not configured = 503', async () => {
  const seen = [];
  const handler = createGrowthApp({ now: () => NOW, review: async (q) => { seen.push(q); return { state: 'COMPARABLE', echoed: q }; } });
  const get = async (url, h = handler) => { let status; let body; await h({ method: 'GET', url }, { writeHead(c) { status = c; }, end(j) { body = JSON.parse(j); } }); return [status, body]; };
  const ok = await get('/api/growth/review?type=variant&id=gid%3A%2F%2Fshopify%2FProductVariant%2F1&applied=2026-10-10&review=2026-11-07&merchant=OTHER&merchantId=OTHER');
  assert.equal(ok[0], 200); assert.deepEqual(seen[0], { type: 'variant', id: 'gid://shopify/ProductVariant/1', applied: '2026-10-10', review: '2026-11-07' }, 'only the four parameters reach the source: the merchant never comes from the request');
  for (const bad of ['type=segment&id=a&applied=2026-10-10&review=2026-11-07', 'type=product&applied=2026-10-10&review=2026-11-07', 'type=product&id=a&applied=10/10/2026&review=2026-11-07', `type=product&id=${'x'.repeat(201)}&applied=2026-10-10&review=2026-11-07`]) assert.equal((await get(`/api/growth/review?${bad}`))[0], 400, bad);
  const down = createGrowthApp({ now: () => NOW, review: async () => { throw new Error('db'); } }); assert.deepEqual(await get('/api/growth/review?type=product&id=a&applied=2026-10-10&review=2026-11-07', down), [503, { error: { code: 'DATA_UNAVAILABLE' } }]);
  assert.equal((await get('/api/growth/review?type=product&id=a&applied=2026-10-10&review=2026-11-07', createGrowthApp({ now: () => NOW })))[0], 503);
});
