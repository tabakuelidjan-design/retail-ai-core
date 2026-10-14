import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBudget } from '../benchmark/ask/lib/budget-guard.js';
import { collectMetadata, redact } from '../benchmark/ask/lib/meta.js';
import { runBenchmark } from '../benchmark/ask/lib/benchmark.js';
import { summarizeRuns } from '../benchmark/ask/lib/score.js';
import { findKeyFragments, scrubSecrets } from '../benchmark/ask/lib/secrets.js';
import { scrub } from '../benchmark/ask/adapters/shared/http.js';
import * as openai from '../benchmark/ask/adapters/openai.js';
import * as anthropic from '../benchmark/ask/adapters/anthropic.js';
import * as kimi from '../benchmark/ask/adapters/kimi.js';

// Instrumentation fixes: the exact endpoint, an honest request counter, and secret redaction that leaves no usable piece of a key. FAKE keys only, mocked HTTP only.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REALISTIC = {   // realistic SHAPES (vendor prefix, length, charset) - random, not real
  openai: ['OPENAI_API_KEY', 'sk-proj-tG4vX8nQ2mLpR7wZ1cJhY9bFdKs3UaEoN6iTyVxCgHz5MqWr0LlBkPjA_Xk9Q'],
  anthropic: ['ANTHROPIC_API_KEY', 'sk-ant-api03-Qw3Er7TyUi9OpAs2DfGh5JkLz8XcVb1NmQw4Er6TyUi0OpAs3DfGh7JkLz9XcVb2NmAA_Rt7Q'],
  kimi: ['KIMI_API_KEY', 'sk-Kq8Ws2Ed5Rf7Tg1Yh3Uj9Ik4Ol6Pa0ZxCvBnMmAsDfGhJkLqWeRtYuIoPz8Vb4'],
};
const MODS = { openai, anthropic, kimi };
const MODELS = { openai: 'gpt-6-sol', anthropic: 'claude-opus-5-5', kimi: 'kimi-k3' };
const URLS = { openai: 'https://api.openai.com/v1/responses', anthropic: 'https://api.anthropic.com/v1/messages', kimi: 'https://api.moonshot.ai/v1/chat/completions' };
const cfg = (kind, over = {}) => ({ model: MODELS[kind], reasoningEffort: 'high', apiKeyEnv: REALISTIC[kind][0], today: '2026-09-26', maxOutputTokens: 32000, timeoutMs: 2000, maxRetries: 2, pricing: { inputPerMTok: 2, outputPerMTok: 10 }, ...over });
const planInput = { question: 'Quel est mon CA ?', lang: 'fr', history: [], catalog: [], selectedPeriod: null, turn: 1, previousCalls: [] };
const errResponse = (status, body, headers = {}) => ({ ok: false, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => body });
const make = (kind, fetch, over = {}) => MODS[kind].createProvider(cfg(kind, over), { fetch, sleep: async () => {}, env: { [REALISTIC[kind][0]]: REALISTIC[kind][1] } });
/** every piece of `key` a person could use: the key, each prefix from 9 characters, each suffix from 4 */
const pieces = (key) => { const out = [key]; for (let k = 9; k < key.length; k += 1) out.push(key.slice(0, k)); for (let k = 4; k < key.length; k += 1) out.push(key.slice(key.length - k)); return out; };
const leaks = (text, key) => pieces(key).filter((p) => text.includes(p));

test('endpoint: the recorded endpoint is EXACTLY the URL that is called, for the three providers', async () => {
  for (const kind of Object.keys(MODS)) {
    let called; const p = make(kind, async (url) => { called = url; return errResponse(401, 'no'); }); await p.plan(planInput).catch(() => {});
    assert.equal(called, URLS[kind]); assert.equal(p.metadata().endpoint, URLS[kind], `${kind}: metadata.endpoint === the URL called`);
  }
  assert.equal(URLS.openai, 'https://api.openai.com/v1/responses');
  const custom = make('openai', async (url) => { custom.url = url; return errResponse(401, 'no'); }, { baseUrl: 'https://api.openai.com/v1/' }); await custom.plan(planInput).catch(() => {}); assert.equal(custom.metadata().endpoint, custom.url, 'a trailing slash in baseUrl changes nothing');
});

test('request counter: EVERY request really sent is counted - 200, 400, 401, 429, 5xx, timeouts, network errors - and it always equals the budget guard\'s count; a refused request is not counted', async () => {
  const behaviours = {
    '401 (no retry)': () => errResponse(401, '{"error":"bad key"}'), '400 (no retry)': () => errResponse(400, 'bad request'), '403': () => errResponse(403, 'forbidden'),
    '429 x3 (2 retries)': () => errResponse(429, 'slow', { 'retry-after': '0' }), '503 x3 (2 retries)': () => errResponse(503, 'down'), '529 x3': () => errResponse(529, 'overloaded'),
    'network error x3': () => { throw new Error('ECONNRESET'); },
  };
  const expected = { '401 (no retry)': 1, '400 (no retry)': 1, '403': 1, '429 x3 (2 retries)': 3, '503 x3 (2 retries)': 3, '529 x3': 3, 'network error x3': 3 };
  for (const kind of Object.keys(MODS)) for (const [label, respond] of Object.entries(behaviours)) {
    const budget = createBudget({ maxRequests: 50 }); const p = budget.track(make(kind, budget.wrapFetch(async () => respond())));
    await p.plan(planInput).catch(() => {});
    assert.equal(p.metadata().callCounts.requests, expected[label], `${kind} ${label}`); assert.equal(budget.snapshot().requests, p.metadata().callCounts.requests, `${kind} ${label}: adapter and guard agree`);
  }
  // successes count too, and a timeout counts as a sent request
  const okBody = { id: 'r', model: 'gpt-6-sol', status: 'completed', output: [{ type: 'function_call', name: 'submit_plan', arguments: JSON.stringify({ premises: [], done: true }) }], usage: { input_tokens: 10, output_tokens: 5 } };
  const b2 = createBudget({ maxRequests: 50 }); const p2 = b2.track(make('openai', b2.wrapFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(okBody) })))); await p2.plan(planInput); await p2.plan(planInput);
  assert.equal(p2.metadata().callCounts.requests, 2); assert.equal(b2.snapshot().requests, 2);
  const b3 = createBudget({ maxRequests: 50 }); const p3 = b3.track(make('anthropic', b3.wrapFetch((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))), { timeoutMs: 30 })); await p3.plan(planInput).catch(() => {});
  assert.deepEqual([p3.metadata().callCounts.requests, b3.snapshot().requests, p3.metadata().callCounts.timeouts], [1, 1, 1]);
  // a request the guard refuses is never sent: neither counted by the guard nor by the adapter
  const b4 = createBudget({ maxRequests: 2 }); const p4 = b4.track(make('kimi', b4.wrapFetch(async () => errResponse(503, 'down')))); await p4.plan(planInput).catch(() => {}); await p4.plan(planInput).catch((e) => e);
  assert.equal(p4.metadata().callCounts.requests, 2); assert.equal(b4.snapshot().requests, 2); assert.equal(b4.snapshot().exceeded.reason, 'MAX_REQUESTS');
});

test('redaction of provider error echoes: whole key, masked key ("sk-proj-****abcd"), ellipsis, prefix-only, suffix-only, header echoes - no usable prefix or suffix survives anywhere', async () => {
  for (const kind of Object.keys(MODS)) {
    const [, key] = REALISTIC[kind]; const suffix = key.slice(-4); const stars = '*'.repeat(Math.max(8, key.length - 12));
    const bodies = [
      `{"error":{"message":"Incorrect API key provided: ${key.slice(0, 8)}${stars}${key.slice(-4)}. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}`,
      `{"error":{"message":"Incorrect API key provided: ${key}."}}`, `{"error":{"message":"Invalid API key: ${key.slice(0, 14)}...${suffix}"}}`,
      `{"error":{"message":"The key starting with ${key.slice(0, 18)} was rejected"}}`, `{"error":{"message":"your key ending in ...${suffix} was rejected"}}`,
      `x-api-key: ${key} rejected`, `{"error":"Authorization: Bearer ${key}"}`, `Incorrect API key provided: TA_VRAIE*******ENAI.`,
    ];
    for (const body of bodies) {
      const p = make(kind, async () => errResponse(401, body)); let thrown; await p.plan(planInput).catch((e) => { thrown = e; });
      assert.equal(thrown.status, 401); const md = p.metadata();
      const everything = JSON.stringify({ message: thrown.message, events: thrown.events, md, usage: p.drainUsage() });
      assert.deepEqual(leaks(everything, key), [], `${kind}: nothing usable survives for: ${body.slice(0, 60)}`);
      assert.ok(!/\*{3,}/.test(everything), `${kind}: no masked-key echo left`); assert.ok(md.recentErrors[0].message.length > 10, 'the error message stays readable');
      assert.match(thrown.message, /HTTP 401/);
      // and the report level: the metadata that ends up in a result file
      const meta = collectMetadata({ provider: p, config: cfg(kind), repeatMetadata: [{ repeat: 1, ...md }], repeats: 1, startedAt: new Date(), finishedAt: new Date(), casesFile: path.join(ROOT, 'benchmark/ask/cases.json'), referenceDate: '2026-09-26' });
      assert.deepEqual(leaks(JSON.stringify(meta), key), [], `${kind}: the result metadata`); assert.deepEqual(findKeyFragments(JSON.stringify(meta), key), []);
    }
  }
});

test('a whole benchmark report built from a provider that keeps rejecting the key holds no key fragment (checked with the strictest piece-by-piece scan)', async () => {
  const cases = JSON.parse(readFileSync(path.join(ROOT, 'benchmark/ask/cases.json'), 'utf8')); const [, key] = REALISTIC.openai;
  const body = `{"error":{"message":"Incorrect API key provided: ${key.slice(0, 8)}${'*'.repeat(50)}${key.slice(-4)}. You can find your API key at https://platform.openai.com/account/api-keys."}}`;
  const { runs, provider, repeatMetadata, datasetFile } = await runBenchmark({ cases, only: ['S01', 'M03', 'P01'], repeats: 1, createProvider: () => make('openai', async () => errResponse(401, body)) });
  const meta = collectMetadata({ provider, config: cfg('openai', { note: `debug ${key}` }), repeatMetadata, repeats: 1, startedAt: new Date(), finishedAt: new Date(), casesFile: path.join(ROOT, 'benchmark/ask/cases.json'), datasetFile, referenceDate: '2026-09-26' });
  const report = JSON.stringify({ meta, ...summarizeRuns(runs, {}) });
  assert.deepEqual(leaks(report, key), []); assert.deepEqual(findKeyFragments(report, key), []); assert.match(report, /HTTP 401/); assert.match(report, /\[redacted\]/);
});

test('scrubber units: exact value, long prefix/suffix, standalone short suffix/prefix, masked and ellipsis echoes, vendor key shapes, headers - and ordinary text is left alone', () => {
  const key = REALISTIC.openai[1];
  assert.ok(!scrubSecrets(`error for ${key}`, [key]).includes(key.slice(9))); assert.equal(scrubSecrets('key ending in ...Xk9Q', [key]), 'key ending in ...[redacted]');
  assert.equal(scrubSecrets('Incorrect API key provided: sk-proj-****abcd. Try again', []), 'Incorrect API key provided: [redacted] Try again'); assert.equal(scrubSecrets('token sk-ant-api03-AbCdEfGhIjKlMnOp here', []), 'token [redacted] here');
  assert.equal(scrubSecrets('Authorization: Bearer abcdefghijklmnop and x-api-key: zzz111222', ['zzz111222']), 'Authorization: [redacted] and x-api-key: [redacted]');
  for (const ordinary of ['HTTP 429 rate limit reached, retry in 2 s', 'model gpt-6-sol returned no function call', 'Xk9Qzzz stays', 'ask-benchmark and task-list are fine', 'the cache_write_tokens field']) assert.equal(scrubSecrets(ordinary, [key]), ordinary, ordinary);
  assert.equal(scrub, scrubSecrets, 'the adapters use the same scrubber');
  assert.deepEqual(redact({ msg: 'x sk-proj-tG4vX8nQ2mLpR7wZ1cJh y', model: 'gpt-6-sol', n: 3, tokens: { in: 5 }, inputTokens: 7 }), { msg: 'x [redacted] y', model: 'gpt-6-sol', n: 3, tokens: { in: 5 }, inputTokens: 7 }, 'inside any string, counts untouched');
  assert.deepEqual(findKeyFragments('nothing here', key), []); assert.ok(findKeyFragments(`last chars ${key.slice(-8)}`, key).length); assert.ok(findKeyFragments(`a ${key.slice(0, 12)}b`, key).length); assert.ok(findKeyFragments('abc****xyz', key).includes('a masked-key echo'));
});

test('last line of defence in the runner: if a key fragment ever slips into a report, the report is WITHHELD (exit 5, nothing written); a properly redacted error echo still runs to the end', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'secret-net-')); const key = REALISTIC.openai[1]; const conf = path.join(dir, 'c.json');
  writeFileSync(conf, JSON.stringify({ model: 'm-1', reasoningEffort: 'high', apiKeyEnv: 'NET_TEST_KEY', today: '2026-09-26', pricing: { inputPerMTok: 1, outputPerMTok: 1 }, pricingSource: { url: 'https://example.test/pricing', retrievedOn: '2026-09-26' } }));
  const oracleUrl = new URL('../benchmark/ask/lib/oracle-provider.js', import.meta.url).href; const casesUrl = new URL('../benchmark/ask/cases.json', import.meta.url).href;
  const adapter = (metaExpr) => { const f = path.join(dir, `a-${Math.random().toString(36).slice(2)}.mjs`); writeFileSync(f, `import { readFileSync } from 'node:fs';
import { createOracleProvider } from '${oracleUrl}';
export const spec = { provider: 'fake', allowedHosts: ['api.example.test'], defaultBaseUrl: 'https://api.example.test/v1', path: '/x', endpoint: 'https://api.example.test/v1/x', efforts: ['high'], supportedParams: [], unsupportedParams: {}, toolChoices: ['forced'], controlledFields: [], configKeys: ['model', 'reasoningEffort', 'apiKeyEnv', 'today', 'pricing', 'pricingSource', 'params'] };
export function createProvider() { const cases = JSON.parse(readFileSync(new URL('${casesUrl}'), 'utf8')); const p = createOracleProvider({ cases }); return { ...p, name: 'net-test', metadata: () => (${metaExpr}) }; }
`); return f; };
  const run = (file, out) => spawnSync(process.execPath, [path.join(ROOT, 'benchmark/ask/run.js'), '--provider', file, '--config', conf, '--only', 'S01', '--max-requests', '5', '--out', out], { encoding: 'utf8', env: { ...process.env, NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1', NET_TEST_KEY: key } });
  const leaky = path.join(dir, 'leaky.json'); const r1 = run(adapter(`{ model: 'm', debug: 'last chars ${key.slice(-8)}' }`), leaky);
  assert.equal(r1.status, 5, r1.stderr); assert.match(r1.stderr, /REPORT WITHHELD/); assert.match(r1.stderr, /suffix/); assert.equal(existsSync(leaky), false, 'nothing was written');
  const echoed = path.join(dir, 'echoed.json'); const r2 = run(adapter(`{ model: 'm', lastError: 'Incorrect API key provided: ${key.slice(0, 8)}****${key.slice(-4)}.' }`), echoed);
  assert.equal(r2.status, 0, r2.stderr); const written = readFileSync(echoed, 'utf8'); assert.deepEqual(leaks(written, key), []); assert.doesNotMatch(written, /\*{3,}/);
  const clean = path.join(dir, 'clean.json'); assert.equal(run(adapter(`{ model: 'm' }`), clean).status, 0); assert.ok(existsSync(clean));
});
