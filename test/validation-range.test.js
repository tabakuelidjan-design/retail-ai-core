import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOrders, validationRange } from '../src/marketing/adapters/shopify-validation.js';

// Synthetic order rows. Shopify ids are made up.
const day = (n) => `2026-${n}T10:00:00Z`;
const live = (id, over = {}) => ({ id: `gid://shopify/Order/${id}`, test: false, channelInformation: { channelDefinition: { handle: 'pos' } }, customerJourneySummary: { lastVisit: null }, ...over });
const row = (id, ordered, over = {}) => ({ id: `u${id}`, source_id: `gid://shopify/Order/${id}`, is_test: false, ordered_at: ordered, channel_handle: 'pos', ...over });
const AVAILABLE = new Date('2026-07-23T00:00:00Z'); // the 60-day window start
const FULL = { completeFrom: '2026-01-12' };

// 71 real stored orders across the whole history; only the last 47 are inside the 60-day window.
const history = Array.from({ length: 71 }, (_, i) => row(i + 1, i < 24 ? day('06-15') : day('08-15')));

test('validation range: full history when a verified backfill exists, otherwise the available window', () => {
  assert.deepEqual(validationRange({ availableStart: AVAILABLE, coverage: FULL }), { since: '2026-01-12', basis: 'full_history' });
  assert.deepEqual(validationRange({ availableStart: AVAILABLE, coverage: null }), { since: '2026-07-23', basis: 'available_window' });
  assert.deepEqual(validationRange({ availableStart: AVAILABLE, coverage: { completeFrom: null } }), { since: '2026-07-23', basis: 'available_window' });
  assert.equal(validationRange({ availableStart: AVAILABLE, coverage: { completeFrom: 'garbage' } }).basis, 'available_window');
});

test('REGRESSION (read_all_orders): a fully synced database validates OK over the full-history range', () => {
  const liveAll = history.map((r) => live(r.source_id.split('/').pop()));
  const v = compareOrders({ live: liveAll, stored: history, attribution: [], range: validationRange({ availableStart: AVAILABLE, coverage: FULL }) });
  assert.equal(v.ok, true);
  assert.deepEqual([v.shopify_orders, v.stored_orders, v.missing_in_db, v.extra_in_db, v.channel_mismatches], [71, 71, 0, 0, 0]);
  assert.equal(v.range.basis, 'full_history');
});

test('REGRESSION: the old behaviour (live 60-day window vs ALL stored) is exactly what caused the false failure, and is no longer possible', () => {
  const liveRecent = history.filter((r) => r.ordered_at >= '2026-07-23').map((r) => live(r.source_id.split('/').pop()));
  assert.equal(liveRecent.length, 47);
  // Comparing the recent live set over the recent range: stored is restricted to the same range, so it agrees.
  const same = compareOrders({ live: liveRecent, stored: history, attribution: [], range: { since: '2026-07-23', basis: 'available_window' } });
  assert.deepEqual([same.shopify_orders, same.stored_orders, same.ok], [47, 47, true]);
  // The mismatched-range mistake is now visible as data, not silently accepted: recent live vs the full range reports the gap.
  const wrong = compareOrders({ live: liveRecent, stored: history, attribution: [], range: { since: '2026-01-12', basis: 'full_history' } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.extra_in_db, 24);
});

test('real problems are still caught inside the range: missing order, extra order, channel mismatch, source mismatch', () => {
  const liveAll = history.map((r) => live(r.source_id.split('/').pop()));
  const range = { since: '2026-01-12', basis: 'full_history' };
  const missing = compareOrders({ live: [...liveAll, live(999)], stored: history, attribution: [], range });
  assert.deepEqual([missing.ok, missing.missing_in_db], [false, 1]);
  const extra = compareOrders({ live: liveAll.slice(1), stored: history, attribution: [], range });
  assert.deepEqual([extra.ok, extra.extra_in_db], [false, 1]);
  const channel = compareOrders({ live: [live(1, { channelInformation: { channelDefinition: { handle: 'web' } } }), ...liveAll.slice(1)], stored: history, attribution: [], range });
  assert.deepEqual([channel.ok, channel.channel_mismatches], [false, 1]);
  const attr = compareOrders({ live: [live(1, { customerJourneySummary: { lastVisit: { source: 'google' } } }), ...liveAll.slice(1)], stored: history, attribution: [{ order_id: 'u1', source: 'bing' }], range });
  assert.deepEqual([attr.ok, attr.last_visit_source_mismatches], [false, 1]);
});

test('test orders are excluded on both sides, and stored orders before the range are ignored', () => {
  const stored = [...history, row(500, day('08-20'), { is_test: true }), row(501, '2025-12-01T10:00:00Z')];
  const liveAll = [...history.map((r) => live(r.source_id.split('/').pop())), live(500, { test: true })];
  const v = compareOrders({ live: liveAll, stored, attribution: [], range: { since: '2026-01-12', basis: 'full_history' } });
  assert.equal(v.ok, true);
  assert.deepEqual([v.shopify_orders, v.stored_orders], [71, 71]);
});

test('the marketing CLI validates over the shared range (no separate window for the live side)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/marketing/index.js', import.meta.url), 'utf8');
  assert.match(src, /created_at:>=\$\{range\.since\}/);
  assert.match(src, /compareOrders\(/);
  assert.match(src, /validationRange\(/);
});
