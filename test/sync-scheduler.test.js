import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSchedule, schedule } from '../src/sync/scheduler.js';

test('scheduler configuration: 15 minutes and mode "all" by default, strictly validated', () => {
  assert.deepEqual(resolveSchedule({}), { intervalMinutes: 15, mode: 'all' });
  assert.deepEqual(resolveSchedule({ SYNC_INTERVAL_MINUTES: '30', SYNC_MODE: 'orders' }), { intervalMinutes: 30, mode: 'orders' });
  for (const bad of ['0', '4', 'x', '2000']) assert.throws(() => resolveSchedule({ SYNC_INTERVAL_MINUTES: bad }), /SYNC_INTERVAL_MINUTES/);
  assert.throws(() => resolveSchedule({ SYNC_MODE: 'rm -rf' }), /SYNC_MODE/);
});

test('scheduler: runs now, then start-to-start every interval, never overlapping; a failed run is retried at the next interval', async () => {
  const sleeps = []; const logs = []; let clock = 0; const codes = [0, 1, 0]; let i = 0;
  await schedule({ intervalMinutes: 15, mode: 'all', maxRuns: 3, log: (m) => logs.push(m), now: () => clock,
    run: async () => { clock += 3 * 60_000; return codes[i++]; }, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  assert.equal(i, 3);
  assert.deepEqual(sleeps, [12 * 60_000, 12 * 60_000], 'a 3-minute run leaves 12 minutes: 15 minutes start to start');
  assert.match(logs.join('\n'), /exit code 1 \(recorded in sync_runs; retrying at the next interval\)/);
});

test('scheduler: a run longer than the interval is followed by a short pause, not an immediate overlap', async () => {
  const sleeps = []; let clock = 0;
  await schedule({ intervalMinutes: 5, mode: 'all', maxRuns: 2, log: () => {}, now: () => clock, run: async () => { clock += 9 * 60_000; return 0; }, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  assert.deepEqual(sleeps, [30_000]);
});

test('scheduler: a run that throws is treated as a failed run and the loop continues', async () => {
  let n = 0;
  await schedule({ intervalMinutes: 15, mode: 'all', maxRuns: 2, log: () => {}, now: () => 0, run: async () => { n += 1; throw new Error('boom'); }, sleep: async () => {} });
  assert.equal(n, 2);
});
