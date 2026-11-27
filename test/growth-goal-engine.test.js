// Nordla Growth - the REAL store engine's weekly rows carry their end and their completeness, and the server's comparison reads them.
// Built from the shared synthetic store fixture (no real data). No network, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStore } from '../src/growth/store/store.js';
import { storeFacts } from '../src/growth/store/facts.js';
import { localMidnight } from '../src/metrics/windows.js';
import { compareWeeklyTarget } from '../src/growth/goal/compare.js';
import { makeStoreData, FULL, NOW, TZ, CONFIG } from './fixtures/store-sample.js';

const build = (historyStart) => {
  const facts = storeFacts({ data: makeStoreData(FULL), now: NOW, timeZone: TZ, config: CONFIG });
  const hs = historyStart === undefined ? facts.historyStart : historyStart;
  return buildStore({ ...facts, historyStart: hs, potential: new Map(), config: CONFIG });
};
const dayAfter = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('engine rows: 8 weeks, each with start, end (seven days, inclusive) and a boolean completeness', () => {
  const p = build();
  assert.equal(p.weekly.length, 8);
  for (const r of p.weekly) {
    assert.equal(r.end, dayAfter(r.start, 6), r.start);
    assert.equal(typeof r.complete, 'boolean');
  }
});

test('engine: with the history covering every week, every row is complete and the comparison uses the last one', () => {
  const p = build(new Date('2000-01-01T00:00:00Z'));
  assert.ok(p.weekly.every((r) => r.complete === true));
  const c = compareWeeklyTarget({ target: 1000000, store: p });
  assert.equal(c.status, 'computed');
  assert.deepEqual(c.period, { start: p.weekly[7].start, end: p.weekly[7].end });
});

test('engine: no history start -> no row is complete -> the comparison is refused (NO_COMPLETE_WEEK)', () => {
  const p = build(null);
  assert.ok(p.weekly.every((r) => r.complete === false));
  assert.equal(compareWeeklyTarget({ target: 1000, store: p }).reason, 'NO_COMPLETE_WEEK');
});

test('engine: history starting in the middle of the last week -> that week is partial (incomplete); the coverage is contiguous, so no earlier week is complete either and the comparison is refused (NO_COMPLETE_WEEK)', () => {
  const p = build(null);
  const last = p.weekly[7].start;
  const midWeek = new Date(localMidnight(last, TZ).getTime() + 2 * 86400000);
  const q = build(midWeek);
  assert.equal(q.weekly[7].complete, false, 'the last week is partial');
  assert.equal(compareWeeklyTarget({ target: 1000, store: q }).reason, 'NO_COMPLETE_WEEK');
});
