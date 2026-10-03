import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFacts } from '../src/metrics/sales.js';
import { inWindow } from '../src/metrics/windows.js';

// Phase 0 benchmark, Level 1 serving optimization (measured need: a 1 100-day period took 87 s at 100k orders because every day rescanned the whole
// ledger six times). windowFacts keeps its exact contract (same elements, same ORIGINAL order, half-open [start, end)); it just stops scanning
// everything. SYNTHETIC data only.
const prng = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; };
const DAY = 86_400_000;
function ledgerOf(n, rnd, base = Date.parse('2024-01-01T00:00:00Z')) {
  const at = () => new Date(base + Math.floor(rnd() * 900) * DAY / 3); // many identical timestamps, unsorted
  return {
    orders: Array.from({ length: n }, (_, i) => ({ id: `o${i}`, orderedAt: at() })),
    lineFacts: Array.from({ length: n * 2 }, (_, i) => ({ orderLineId: `l${i}`, orderedAt: at() })),
    refundFacts: Array.from({ length: n / 4 | 0 }, (_, i) => ({ refundId: `r${i}`, refundedAt: at() })),
    refundTotals: Array.from({ length: n / 4 | 0 }, (_, i) => ({ refundId: `r${i}`, refundedAt: at() })),
    shippingFacts: Array.from({ length: n }, (_, i) => ({ orderId: `o${i}`, orderedAt: at() })),
    shippingRefundFacts: Array.from({ length: n / 8 | 0 }, (_, i) => ({ refundId: `s${i}`, refundedAt: at() })),
  };
}
const naive = (ledger, window) => ({
  shipping: ledger.shippingFacts.filter((x) => inWindow(x.orderedAt, window)), shippingRefunds: ledger.shippingRefundFacts.filter((x) => inWindow(x.refundedAt, window)),
  orders: ledger.orders.filter((o) => inWindow(o.orderedAt, window)), lines: ledger.lineFacts.filter((l) => inWindow(l.orderedAt, window)),
  refunds: ledger.refundFacts.filter((r) => inWindow(r.refundedAt, window)), refundTotals: ledger.refundTotals.filter((r) => inWindow(r.refundedAt, window)),
});

test('W1. identical to the plain filter (same elements, same original order, half-open bounds) on random windows', () => {
  const rnd = prng(3); const ledger = ledgerOf(400, rnd);
  for (let t = 0; t < 300; t += 1) {
    const a = Date.parse('2023-12-01T00:00:00Z') + Math.floor(rnd() * 1000) * DAY / 3; const b = a + Math.floor(rnd() * 400) * DAY / 3;
    const window = { start: new Date(a), end: new Date(b) };
    assert.deepEqual(windowFacts(ledger, window), naive(ledger, window), `window ${t}`);
  }
  const exact = ledger.orders[0].orderedAt; // a boundary that equals an element: start inclusive, end exclusive
  assert.deepEqual(windowFacts(ledger, { start: exact, end: new Date(exact.getTime() + 1) }).orders.map((o) => o.id), ledger.orders.filter((o) => o.orderedAt.getTime() === exact.getTime()).map((o) => o.id));
  assert.equal(windowFacts(ledger, { start: new Date(exact.getTime() + 1), end: exact }).orders.length, 0, 'an empty or inverted window is empty');
});

test('W2. elements with an invalid date are never in a window; missing optional arrays are fine', () => {
  const ledger = { orders: [{ id: 'a', orderedAt: new Date('invalid') }, { id: 'b', orderedAt: new Date('2026-01-01T00:00:00Z') }], lineFacts: [], refundFacts: [], refundTotals: [] };
  const w = windowFacts(ledger, { start: new Date('2025-01-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') });
  assert.deepEqual(w.orders.map((o) => o.id), ['b']); assert.deepEqual([w.shipping, w.shippingRefunds], [[], []]);
});

test('W3. an array that grew after the first call is re-indexed (never a stale answer)', () => {
  const ledger = { orders: [{ id: 'a', orderedAt: new Date('2026-01-01T00:00:00Z') }], lineFacts: [], refundFacts: [], refundTotals: [] };
  const win = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') };
  assert.equal(windowFacts(ledger, win).orders.length, 1);
  ledger.orders.push({ id: 'b', orderedAt: new Date('2026-01-15T00:00:00Z') });
  assert.deepEqual(windowFacts(ledger, win).orders.map((o) => o.id), ['a', 'b']);
});

test('W4. 1 100 day windows over a 250k-line ledger no longer rescan the ledger every day (it took 87 s)', () => {
  const rnd = prng(5); const ledger = ledgerOf(100000, rnd, Date.parse('2023-10-01T00:00:00Z'));
  windowFacts(ledger, { start: new Date('2023-10-01T00:00:00Z'), end: new Date('2023-10-02T00:00:00Z') }); // first call builds the index
  const t0 = performance.now(); let n = 0;
  for (let d = 0; d < 1100; d += 1) { const s = Date.parse('2023-10-01T00:00:00Z') + d * DAY; n += windowFacts(ledger, { start: new Date(s), end: new Date(s + DAY) }).lines.length; }
  const ms = performance.now() - t0; assert.ok(n > 0); assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});
