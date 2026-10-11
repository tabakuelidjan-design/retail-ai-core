import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createQwenDirectorPort, DIRECTOR_TIMEOUT_CAP_MS, REVISION_DIRECTOR_TIMEOUT_MS } from '../src/marketing-creative/alibaba/qwen-director-port.js';
import { SpendGuard } from '../src/marketing-creative/alibaba/budget.js';

// The Creative / revision Director completion (`// DT-N` markers): a dedicated, bounded timeout for the revision Director; the lane's default is unchanged for everyone else; no retry.

const config = (over = {}) => ({
  apiKey: 'sk-test-1234567890abcdef', workspaceId: 'ws0123456789abcd', region: 'eu-central-1', textModel: 'qwen3.8-max', imageModel: 'qwen-image-3.0-pro', videoModel: 'wan3.0-video', requestTimeoutMs: 120000, ...over,
});
const hangs = (counter) => (url, init) => {
  counter.n += 1;
  return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

// returns when the call settled, after ticking the (mocked) clock by the given amounts; reports whether it had settled before the last tick
async function abortAfter(t, port, ticks) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = null;
  const call = port({ system: 's', user: 'u' }).then((v) => { settled = { value: v }; }, (e) => { settled = { error: e }; });
  await flush();
  const states = [];
  for (const ms of ticks) { t.mock.timers.tick(ms); await flush(); states.push(settled !== null); }
  // a call that never settles is a failure of the test, not a hang (the clock is mocked, so no real timer can be used here)
  for (let i = 0; i < 50 && settled === null; i += 1) await flush();
  assert.notEqual(settled, null, 'the call never settled');
  return { states, error: settled.error };
}
const make = (over = {}, cfg = config(), counter = { n: 0 }) => ({
  counter,
  port: createQwenDirectorPort({ config: cfg, budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0 }), fetchImpl: hangs(counter), ...over }),
});

test('DT-1 the revision Director has its own bounded timeout: above the 120 s default, aborted exactly at it, classified TIMEOUT, called once', async (t) => {
  assert.equal(REVISION_DIRECTOR_TIMEOUT_MS, 240_000);
  assert.equal(DIRECTOR_TIMEOUT_CAP_MS, 300_000);
  const { port, counter } = make({ timeoutMs: REVISION_DIRECTOR_TIMEOUT_MS });
  assert.equal(port.timeout_ms, 240_000);
  const { states, error } = await abortAfter(t, port, [120_000, 119_999, 1]);
  assert.deepEqual(states, [false, false, true]); // still waiting past the old 120 s, aborted at 240 s
  assert.equal(error.code, 'TIMEOUT');
  assert.equal(error.requestId, null);
  assert.equal(counter.n, 1, 'no retry');
});

test('DT-2 without a dedicated value the lane keeps its configured timeout (the initial Director is unchanged)', async (t) => {
  const { port } = make();
  assert.equal(port.timeout_ms, 120_000);
  const { states, error } = await abortAfter(t, port, [119_999, 1]);
  assert.deepEqual(states, [false, true]);
  assert.equal(error.code, 'TIMEOUT');
});

test('DT-3 the timeout is bounded: a hard cap, a floor at the lane value, and nothing out of range', async (t) => {
  assert.throws(() => make({ timeoutMs: DIRECTOR_TIMEOUT_CAP_MS + 1 }), RangeError);
  assert.throws(() => make({ timeoutMs: 500 }), RangeError);
  assert.throws(() => make({ timeoutMs: 1.5 * 1000 + 0.5 }), RangeError);
  // never below the lane's configured value
  assert.equal(make({ timeoutMs: 60_000 }, config({ requestTimeoutMs: 120_000 })).port.timeout_ms, 120_000);
  // a lane configured above the cap is clamped to the cap
  const { port } = make({ timeoutMs: 240_000 }, config({ requestTimeoutMs: 900_000 }));
  assert.equal(port.timeout_ms, 300_000);
  const { states } = await abortAfter(t, port, [299_999, 1]);
  assert.deepEqual(states, [false, true]);
});

test('DT-4 a successful completion journals its usage and latency (evidence of thinking tokens and of the real duration), and never a secret', async () => {
  const journal = []; const events = [];
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 5000, completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 900 } } }) });
  const port = createQwenDirectorPort({ config: config(), budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0 }), journal: { append: async (e) => { journal.push(e); events.push(e.event); } }, fetchImpl, timeoutMs: REVISION_DIRECTOR_TIMEOUT_MS });
  const reply = await port({ system: 's', user: 'u' });
  assert.equal(reply.request_id, 'chatcmpl-1');
  assert.deepEqual(events, ['RESERVED', 'SUCCEEDED']);
  const done = journal.find((e) => e.event === 'SUCCEEDED');
  assert.equal(done.usage.completion_tokens_details.reasoning_tokens, 900);
  assert.equal(typeof done.latency_ms, 'number');
  assert.doesNotMatch(JSON.stringify(journal), /sk-test/);
});

test('DT-5 the revision script uses the dedicated timeout for the revision Director only', async () => {
  const revision = (await readFile(new URL('../scripts/run-c3-revision.mjs', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.match(revision, /createRevisionDirector\(\{ ledger, complete: createQwenDirectorPort\(\{ config, budget, journal, timeoutMs: REVISION_DIRECTOR_TIMEOUT_MS \}\)/);
  const initial = (await readFile(new URL('../scripts/run-c2-habb-creative.mjs', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(initial, /timeoutMs/);
});
