// /api/inbox computes the merchant's civil date ONCE per request, not once per purchase (each computation builds an
// Intl formatter: ~0.6 ms per row on large lists). Fixed injected clock: never depends on the real time. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './finance-dashboard-helpers.js';

const NOW = '2026-09-26T22:30:00.000Z'; // 00:30 on 27/09 in Brussels: the merchant's day, not the server's (UTC) one
const withCountingClock = async (fn) => {
  const clock = { calls: 0, now() { this.calls += 1; return NOW; }, today: () => '2026-09-26' };
  const a = await startApp({ timeZone: 'Europe/Brussels', deps: { clock: { now: () => clock.now(), today: clock.today } } });
  try { await fn({ c: await a.authed(), clock }); } finally { await a.close(); }
};
const purchase = (i) => ({ supplierName: `Fournisseur ${i} SRL`, invoiceNumber: `T1-${i}`, issueDate: '2026-09-10', dueDate: '2026-10-07', net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR' });
const clockCallsFor = async (c, clock, path) => { const before = clock.calls; const r = await c.get(path); assert.equal(r.status, 200); return { calls: clock.calls - before, rows: r.data.rows }; };

test('GET /api/inbox reads the clock the same number of times for 1 purchase and for 6 (today computed once per request)', () => withCountingClock(async ({ c, clock }) => {
  await c.post('/api/inbox/manual', purchase(0));
  const one = await clockCallsFor(c, clock, '/api/inbox');
  for (let i = 1; i < 6; i++) await c.post('/api/inbox/manual', purchase(i));
  const six = await clockCallsFor(c, clock, '/api/inbox');
  assert.equal(one.rows.length, 1); assert.equal(six.rows.length, 6);
  assert.ok(six.calls >= 1, 'today is still computed');
  assert.equal(six.calls, one.calls, `clock reads must not grow with the number of purchases (1 row: ${one.calls}, 6 rows: ${six.calls})`);
}));

test('the shared date gives every row the same, correct merchant-day values as the single-item view', () => withCountingClock(async ({ c }) => {
  for (let i = 0; i < 3; i++) await c.post('/api/inbox/manual', purchase(i));
  const { rows } = (await c.get('/api/inbox')).data;
  // due 07/10, merchant day 27/09 (Brussels, not the server's 26/09 UTC): 10 days left, on every row
  for (const r of rows) assert.deepEqual([r.dueDate, r.due.daysRemaining, r.due.origin], ['2026-10-07', 10, rows[0].due.origin]);
  const single = (await c.get(`/api/inbox/${rows[0].id}`)).data;
  assert.deepEqual(single.due, rows[0].due, 'the list and the single-item view give the same due view');
}));
