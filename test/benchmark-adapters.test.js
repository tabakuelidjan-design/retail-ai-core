import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestrator } from '../src/analytics-premium/server/ai/orchestrator.js';
import { EXPLANATION_SCHEMA, PLAN_SCHEMA } from '../src/analytics-premium/server/ai/contract.js';
import { createBenchmarkTools } from '../benchmark/ask/lib/dataset.js';
import { runBenchmark } from '../benchmark/ask/lib/benchmark.js';
import { collectMetadata } from '../benchmark/ask/lib/meta.js';
import { summarizeRuns } from '../benchmark/ask/lib/score.js';
import { AdapterError, retryAfterMs, scrub } from '../benchmark/ask/adapters/shared/http.js';
import { costOf } from '../benchmark/ask/adapters/shared/core.js';
import { PLAN_FUNCTION, EXPLAIN_FUNCTION, systemPrompt } from '../benchmark/ask/adapters/shared/prompt.js';
import * as openai from '../benchmark/ask/adapters/openai.js';
import * as anthropic from '../benchmark/ask/adapters/anthropic.js';
import * as kimi from '../benchmark/ask/adapters/kimi.js';

// Provider ADAPTERS (OpenAI GPT-6 Sol, Anthropic Claude Opus 5.5, Kimi K3), tested ONLY against mocked HTTP responses: no network, no key, no real call.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEYS = { OPENAI_API_KEY: 'sk-TESTOPENAIKEY1234567890', ANTHROPIC_API_KEY: 'sk-ant-TESTANTHROPICKEY123456', KIMI_API_KEY: 'sk-TESTKIMIKEY1234567890ab' };
const ALL = [['openai', openai, 'gpt-6-sol', 'OPENAI_API_KEY'], ['anthropic', anthropic, 'claude-opus-5-5', 'ANTHROPIC_API_KEY'], ['kimi', kimi, 'kimi-k3', 'KIMI_API_KEY']];
const PRICING = { inputPerMTok: 2, cachedInputPerMTok: 0.5, cacheWriteInputPerMTok: 2.5, outputPerMTok: 10 };
const cfg = (model, env, over = {}) => ({ model, reasoningEffort: 'high', apiKeyEnv: env, today: '2026-09-26', timeZone: 'Europe/Brussels', maxOutputTokens: 32000, timeoutMs: 2000, maxRetries: 2, maxFormatRetries: 1, pricing: PRICING, params: {}, ...over });

// ---------- a mock of each provider's HTTP API ----------
const userTextOf = (kind, body) => (kind === 'openai' ? body.input[1].content : kind === 'anthropic' ? body.messages[0].content : body.messages[1].content);
const reminderOf = (kind, body) => (kind === 'openai' ? body.input[2]?.content : kind === 'anthropic' ? body.messages[1]?.content : body.messages[2]?.content) ?? null;
function envelope(kind, r) {
  const u = r.usage ?? { input: 1000, output: 300, cached: 200, cacheWrite: 0, reasoning: 100 };
  if (kind === 'openai') return { id: 'resp_1', model: 'gpt-6-sol-2026-09-01', status: r.incomplete ? 'incomplete' : 'completed', output: [{ type: 'reasoning', summary: [] }, ...(r.noCall ? [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] : [{ type: 'function_call', name: r.name, call_id: 'c1', arguments: r.badJson ? '{oops' : JSON.stringify(r.args) }])], usage: { input_tokens: u.input, output_tokens: u.output, input_tokens_details: { cached_tokens: u.cached, cache_write_tokens: u.cacheWrite ?? 0 }, output_tokens_details: { reasoning_tokens: u.reasoning } } };
  if (kind === 'anthropic') return { id: 'msg_1', model: 'claude-opus-5-5', stop_reason: r.incomplete ? 'max_tokens' : 'tool_use', content: [{ type: 'thinking', thinking: '...' }, ...(r.noCall ? [{ type: 'text', text: 'hello' }] : [{ type: 'tool_use', id: 't1', name: r.name, input: r.args }])], usage: { input_tokens: u.input - u.cached - (u.cacheWrite ?? 0), output_tokens: u.output, cache_read_input_tokens: u.cached, cache_creation_input_tokens: u.cacheWrite ?? 0 } };
  return { id: 'cmpl_1', model: 'kimi-k3', choices: [{ finish_reason: r.incomplete ? 'length' : 'tool_calls', message: { role: 'assistant', reasoning_content: '...', ...(r.noCall ? { content: 'hello' } : { tool_calls: [{ id: 'k1', type: 'function', function: { name: r.name, arguments: r.badJson ? '{oops' : JSON.stringify(r.args) } }] }) } }], usage: { prompt_tokens: u.input, completion_tokens: u.output, prompt_tokens_details: { cached_tokens: u.cached, cache_write_tokens: u.cacheWrite ?? 0 } } };
}
/** script({purpose, payload, reminder, attempt}) -> { args, name?, usage?, noCall?, status?, headers?, body?, hang?, incomplete?, badJson? } */
function mockApi(kind, script) {
  const requests = []; let n = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); const text = userTextOf(kind, body); const purpose = text.startsWith('PLAN request') ? 'plan' : 'explain';
    requests.push({ url, headers: init.headers, body, purpose }); n += 1;
    const facts = JSON.parse(/^facts: (.*)$/m.exec(text)?.[1] ?? 'null'); const catalog = JSON.parse(/^toolCatalog: (.*)$/m.exec(text)?.[1] ?? 'null');
    const r = await script({ purpose, text, facts, catalog, reminder: reminderOf(kind, body), attempt: n, body });
    if (r.hang) await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('AbortError'))));
    if (r.status && r.status !== 200) return { ok: false, status: r.status, headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null }, text: async () => r.body ?? '' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(envelope(kind, { name: purpose === 'plan' ? 'submit_plan' : 'submit_explanation', ...r })) };
  };
  return { fetch, requests };
}
const mk = (kind, mod, model, envName, script, over = {}, deps = {}) => { const api = mockApi(kind, script); const sleeps = []; const provider = mod.createProvider(cfg(model, envName, over), { fetch: api.fetch, sleep: async (ms) => { sleeps.push(ms); }, env: KEYS, ...deps }); return { provider, api, sleeps }; };
const PLAN_OK = { args: { premises: [], toolCalls: [{ tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } }] } };
const explainFrom = (facts) => { const f = facts.find((x) => x.ref === 'c1.values.net_sales_ex_tax'); return { args: { claims: [{ kind: 'fact', text: `Valeur : ${String(f.value).replace('.', ',')} €.`, factRefs: [f.ref], quantities: [{ kind: 'money', value: f.value, factRef: f.ref }] }] } }; };
const flow = async (script) => async () => {};
const planInput = { question: 'Quel est mon CA ?', lang: 'fr', history: [], catalog: [{ name: 'get_sales_metrics', description: 'x', inputSchema: { type: 'object' } }], selectedPeriod: null, turn: 1, previousCalls: [] };
void flow;

test('config: the model id, the reasoning effort, the key VARIABLE NAME, the reference date and the pricing all come from the config; a missing or unsafe value is refused', () => {
  for (const [kind, mod, model, envName] of ALL) {
    const ok = cfg(model, envName); assert.doesNotThrow(() => mod.createProvider(ok, { env: KEYS }), kind);
    for (const [label, bad, re] of [['no model', { model: undefined }, /config\.model is required/], ['no effort key', { reasoningEffort: undefined }, /reasoningEffort is required/], ['a key instead of a name', { apiKeyEnv: 'sk-abcdef123456' }, /NAME of an environment variable/],
      ['no date', { today: undefined }, /config\.today/], ['no pricing', { pricing: null }, /pricing/], ['nulls in pricing', { pricing: { inputPerMTok: null, outputPerMTok: null } }, /pricing/], ['foreign host', { baseUrl: 'https://evil.example.com/v1' }, /official host/], ['http', { baseUrl: 'http://api.openai.com/v1' }, /official host|https/], ['bad effort', { reasoningEffort: 'turbo' }, /reasoningEffort/]]) {
      assert.throws(() => mod.createProvider({ ...ok, ...bad }, { env: KEYS }), (e) => e instanceof AdapterError && e.code === 'BAD_CONFIG' && re.test(e.message), `${kind}: ${label}`);
    }
  }
  assert.throws(() => kimi.createProvider(cfg('kimi-k3', 'KIMI_API_KEY', { reasoningEffort: 'medium' }), { env: KEYS }), /low, high, max/); assert.throws(() => anthropic.createProvider(cfg('claude-opus-5-5', 'ANTHROPIC_API_KEY', { reasoningEffort: 'none' }), { env: KEYS }), /low, medium, high, xhigh, max/);
  assert.doesNotThrow(() => openai.createProvider(cfg('gpt-6-sol', 'OPENAI_API_KEY', { reasoningEffort: null }), { env: KEYS }), 'null effort = send none');
  for (const [, , , envName] of ALL) { const example = JSON.parse(readFileSync(path.join(ROOT, `benchmark/ask/adapters/configs/${ALL.find((a) => a[3] === envName)[0]}.example.json`), 'utf8')); assert.equal(example.apiKeyEnv, envName); assert.deepEqual(Object.values(example.pricing), [null, null, null, null], 'prices are left for the official price page'); }
});

test('the example configs hold only env-var NAMES and the exact model ids; using one unfilled is refused (pricing must be supplied)', () => {
  for (const [kind, mod, model, envName] of ALL) {
    const file = path.join(ROOT, `benchmark/ask/adapters/configs/${kind}.example.json`); const raw = readFileSync(file, 'utf8'); const c = JSON.parse(raw);
    assert.equal(c.model, model); assert.equal(c.reasoningEffort, 'high', 'the same effort level for the three providers'); assert.ok(!/sk-|Bearer|secret/i.test(raw.replace(/no key|never the key/gi, '')), `${kind}: no key`);
    assert.throws(() => mod.createProvider(c, { env: KEYS }), /pricing/);
    assert.equal(c.apiKeyEnv, envName);
  }
});

test('wire format per provider: endpoint, auth header, model and effort from the config, Nordla\'s JSON Schema as the function, forced call (OpenAI, Kimi) or auto (Opus 5.5 refuses forced)', async () => {
  const seen = {};
  for (const [kind, mod, model, envName] of ALL) {
    const { provider, api } = mk(kind, mod, model, envName, async () => PLAN_OK); await provider.plan({ ...planInput, signal: new AbortController().signal }); seen[kind] = api.requests[0];
  }
  const o = seen.openai; assert.equal(o.url, 'https://api.openai.com/v1/responses'); assert.equal(o.headers.authorization, `Bearer ${KEYS.OPENAI_API_KEY}`); assert.equal(o.body.model, 'gpt-6-sol'); assert.deepEqual(o.body.reasoning, { effort: 'high' }); assert.equal(o.body.max_output_tokens, 32000); assert.equal(o.body.store, false);
  assert.deepEqual(o.body.tools, [{ type: 'function', name: 'submit_plan', description: PLAN_FUNCTION.description, parameters: PLAN_SCHEMA, strict: false }]); assert.deepEqual(o.body.tool_choice, { type: 'function', name: 'submit_plan' }); assert.equal(o.body.input[0].role, 'system');
  const a = seen.anthropic; assert.equal(a.url, 'https://api.anthropic.com/v1/messages'); assert.equal(a.headers['x-api-key'], KEYS.ANTHROPIC_API_KEY); assert.equal(a.headers['anthropic-version'], '2023-06-01'); assert.equal(a.body.model, 'claude-opus-5-5'); assert.deepEqual(a.body.output_config, { effort: 'high' }); assert.equal(a.body.max_tokens, 32000);
  assert.deepEqual(a.body.tools, [{ name: 'submit_plan', description: PLAN_FUNCTION.description, input_schema: PLAN_SCHEMA }]); assert.deepEqual(a.body.tool_choice, { type: 'auto' }, 'Opus 5.5 rejects a forced tool'); assert.ok(!('thinking' in a.body), 'thinking is always on, effort is the control');
  const k = seen.kimi; assert.equal(k.url, 'https://api.moonshot.ai/v1/chat/completions'); assert.equal(k.headers.authorization, `Bearer ${KEYS.KIMI_API_KEY}`); assert.equal(k.body.model, 'kimi-k3'); assert.equal(k.body.reasoning_effort, 'high'); assert.equal(k.body.max_completion_tokens, 32000); assert.ok(!('max_tokens' in k.body));
  assert.deepEqual(k.body.tools, [{ type: 'function', function: { name: 'submit_plan', description: PLAN_FUNCTION.description, parameters: PLAN_SCHEMA } }]); assert.deepEqual(k.body.tool_choice, { type: 'function', function: { name: 'submit_plan' } });
  for (const r of Object.values(seen)) for (const forbidden of ['temperature', 'top_p', 'top_k']) assert.ok(!(forbidden in r.body), `${forbidden} is never sent unless the config passes it`);
  // nothing hardcoded: another model / effort / limit in the config changes the request
  const { provider, api } = mk('openai', openai, 'gpt-6-sol', 'OPENAI_API_KEY', async () => PLAN_OK, { model: 'another-model', reasoningEffort: 'low', maxOutputTokens: 999, params: { temperature: 0.3 } }); await provider.plan(planInput);
  assert.deepEqual([api.requests[0].body.model, api.requests[0].body.reasoning.effort, api.requests[0].body.max_output_tokens, api.requests[0].body.temperature], ['another-model', 'low', 999, 0.3]);
  const sources = ALL.map(([kind]) => readFileSync(path.join(ROOT, `benchmark/ask/adapters/${kind}.js`), 'utf8').replace(/\/\/.*$/gm, '')); for (const s of sources) assert.ok(!/gpt-6|opus-5|kimi-k3/.test(s), 'no model id in the code (comments aside)');
  // the explanation function
  const e = mk('kimi', kimi, 'kimi-k3', 'KIMI_API_KEY', async ({ purpose }) => (purpose === 'plan' ? PLAN_OK : { args: { claims: [{ text: 'x', factRefs: ['c1.values.a'] }] } })); await e.provider.explain({ question: 'q', lang: 'fr', facts: [], calls: [], premises: [], rules: [] });
  assert.deepEqual(e.api.requests[0].body.tools[0].function.parameters, EXPLANATION_SCHEMA); assert.equal(e.api.requests[0].body.tools[0].function.name, 'submit_explanation'); assert.equal(EXPLAIN_FUNCTION.name, 'submit_explanation');
});

test('same prompt for all three: the system text, the two function definitions and the user message are identical; only the wire format differs', async () => {
  const sys = []; const users = []; const fp = [];
  for (const [kind, mod, model, envName] of ALL) {
    const { provider, api } = mk(kind, mod, model, envName, async () => PLAN_OK); await provider.plan(planInput);
    const b = api.requests[0].body; sys.push(kind === 'anthropic' ? b.system : kind === 'openai' ? b.input[0].content : b.messages[0].content); users.push(userTextOf(kind, b)); fp.push(provider.metadata().promptSha256);
  }
  assert.equal(new Set(sys).size, 1); assert.equal(new Set(users).size, 1); assert.equal(new Set(fp).size, 1, 'the prompt fingerprint recorded in the results is the same');
  assert.equal(sys[0], systemPrompt({ today: '2026-09-26', timeZone: 'Europe/Brussels' })); assert.match(sys[0], /Today is 2026-09-26/); assert.match(sys[0], /"premises": ALWAYS present/); assert.match(sys[0], /NEVER compute/);
  for (const w of ['submit_plan', 'submit_explanation', 'clarification', 'cannotAnswer', 'trend', 'ranking', 'level', 'custom']) assert.ok(sys[0].includes(w), w);
  assert.ok(!/gpt|claude|kimi|moonshot|openai|anthropic/i.test(sys[0]), 'the prompt names no provider and favours none');
  assert.notEqual(systemPrompt({ today: '2027-01-01', timeZone: 'Europe/Brussels' }), sys[0]);
});

for (const [kind, mod, model, envName] of ALL) {
  test(`${kind}: parses plans exactly as the model wrote them - one tool, several tools, clarification, refusal, and NEVER invents premises`, async () => {
    const plans = [
      { premises: [], toolCalls: [{ tool: 'get_sales_metrics', args: {} }] },
      { premises: [{ kind: 'trend', metric: 'sales', direction: 'decrease', period: { period: 'last_30_days' } }], toolCalls: [{ tool: 'get_sales_metrics', args: {} }, { tool: 'get_top_products', args: { limit: 3 } }, { tool: 'get_channels', args: {} }], more: true },
      { premises: [], clarification: { text: 'Quelle période ?' } }, { premises: [], cannotAnswer: { gaps: ['traffic'] } }, { premises: [], done: true },
    ];
    let i = 0; const { provider } = mk(kind, mod, model, envName, async () => ({ args: plans[i++] }));
    for (const p of plans) assert.deepEqual(await provider.plan(planInput), p);
    const missing = { toolCalls: [{ tool: 'get_sales_metrics', args: {} }] };
    const { provider: p2 } = mk(kind, mod, model, envName, async () => ({ args: missing })); assert.deepEqual(await p2.plan(planInput), missing, 'a plan without premises stays without premises: the adapter never fills the mandatory field');
  });

  test(`${kind}: through the REAL orchestrator - a plan without \`premises\` is refused (and recorded), with \`premises: []\` the whole plan -> tools -> explain -> verify flow works`, async () => {
    const { tools } = await createBenchmarkTools(); const diag = [];
    const noPremises = mk(kind, mod, model, envName, async () => ({ args: { toolCalls: [{ tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } }] } }));
    const r0 = await createOrchestrator({ provider: noPremises.provider, tools, onDiagnostic: (d) => diag.push(d) })({ question: 'Quel est mon CA ?' });
    assert.deepEqual([r0.status, r0.code], ['PLAN_FAILED', 'PLAN_INVALID']); assert.ok(diag.some((d) => d.type === 'PREMISES_MISSING'));
    const good = mk(kind, mod, model, envName, async ({ purpose, facts }) => (purpose === 'plan' ? PLAN_OK : explainFrom(facts)));
    const r = await createOrchestrator({ provider: good.provider, tools })({ question: 'Quel est mon CA ?' });
    assert.equal(r.status, 'OK'); assert.equal(r.explanation.status, 'VERIFIED'); assert.match(r.answer.text, /489,25/); assert.deepEqual(good.api.requests.map((x) => x.purpose), ['plan', 'explain']);
    const cl = mk(kind, mod, model, envName, async () => ({ args: { premises: [], clarification: { text: 'Quelle période ?' } } })); assert.equal((await createOrchestrator({ provider: cl.provider, tools })({ question: 'Les chiffres' })).status, 'CLARIFICATION');
    const multi = mk(kind, mod, model, envName, async ({ purpose, facts }) => (purpose === 'plan' ? { args: { premises: [], toolCalls: [PLAN_OK.args.toolCalls[0], { tool: 'get_top_products', args: { limit: 3 } }, { tool: 'get_channels', args: {} }] } } : explainFrom(facts)));
    const rm = await createOrchestrator({ provider: multi.provider, tools })({ question: 'Ventes, produits et canaux' }); assert.equal(rm.status, 'OK'); assert.equal(rm.toolCalls.length, 3);
  });
}

test('usage and cost: tokens (input incl. cache, output incl. reasoning/thinking, cached, cache-write, reasoning) are read per provider and priced from the config; drainUsage returns the calls since the last drain', async () => {
  const cases = { openai: { usage: { input: 1000, output: 300, cached: 200, cacheWrite: 100, reasoning: 100 }, expect: { inputTokens: 1000, outputTokens: 300, cachedTokens: 200, cacheWriteTokens: 100, reasoningTokens: 100, cost: (700 * 2 + 200 * 0.5 + 100 * 2.5 + 300 * 10) / 1e6 } },
    anthropic: { usage: { input: 1000, output: 300, cached: 700, cacheWrite: 50, reasoning: 0 }, expect: { inputTokens: 1000, outputTokens: 300, cachedTokens: 700, cacheWriteTokens: 50, reasoningTokens: 0, cost: (250 * 2 + 700 * 0.5 + 50 * 2.5 + 300 * 10) / 1e6 } },
    kimi: { usage: { input: 1000, output: 300, cached: 400, cacheWrite: 100, reasoning: 0 }, expect: { inputTokens: 1000, outputTokens: 300, cachedTokens: 400, cacheWriteTokens: 100, reasoningTokens: 0, cost: (500 * 2 + 400 * 0.5 + 100 * 2.5 + 300 * 10) / 1e6 } } };
  for (const [kind, mod, model, envName] of ALL) {
    const c = cases[kind]; const { provider } = mk(kind, mod, model, envName, async () => ({ ...PLAN_OK, usage: c.usage }));
    assert.equal(provider.drainUsage(), null, 'nothing before the first call'); await provider.plan(planInput);
    const u = provider.drainUsage(); assert.deepEqual([u.inputTokens, u.outputTokens, u.cachedTokens, u.cacheWriteTokens, u.reasoningTokens], [c.expect.inputTokens, c.expect.outputTokens, c.expect.cachedTokens, c.expect.cacheWriteTokens, c.expect.reasoningTokens], kind);
    assert.equal(u.costUsd, Math.round(c.expect.cost * 1e8) / 1e8, `${kind} cost`); assert.equal(provider.drainUsage(), null, 'drained');
    await provider.plan(planInput); await provider.plan(planInput); assert.equal(provider.drainUsage().inputTokens, 2000, 'two calls accumulate until drained'); assert.equal(provider.metadata().usageTotals.inputTokens, 3000, 'totals never reset');
  }
  assert.equal(costOf({ input: 1_000_000, output: 1_000_000 }, { inputPerMTok: 3, outputPerMTok: 15 }), 18); assert.equal(costOf({ input: 100, output: 0, cached: 100 }, { inputPerMTok: 4, cachedInputPerMTok: 1, outputPerMTok: 0 }), 0.0001);
});

test('timeout: a provider that never answers becomes PROVIDER_TIMEOUT within the configured time (and through the orchestrator a clean PLAN_FAILED)', async () => {
  for (const [kind, mod, model, envName] of ALL) {
    const { provider } = mk(kind, mod, model, envName, async () => ({ hang: true }), { timeoutMs: 40 }); const t0 = Date.now();
    await assert.rejects(provider.plan(planInput), (e) => e.code === 'PROVIDER_TIMEOUT'); assert.ok(Date.now() - t0 < 1500, kind); assert.equal(provider.metadata().callCounts.timeouts, 1);
    const { tools } = await createBenchmarkTools(); const s = mk(kind, mod, model, envName, async () => ({ hang: true }), { timeoutMs: 40 });
    assert.deepEqual(await createOrchestrator({ provider: s.provider, tools })({ question: 'x' }), { status: 'PLAN_FAILED', code: 'PROVIDER_TIMEOUT', turns: 0 });
    const ac = new AbortController(); const { provider: p3 } = mk(kind, mod, model, envName, async () => ({ hang: true }), { timeoutMs: 5000 }); const pending = p3.plan({ ...planInput, signal: ac.signal }); setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending, (e) => e.code === 'PROVIDER_TIMEOUT', 'the orchestrator\'s own abort signal is honoured');
  }
});

test('rate limits and server errors: 429/5xx/529 are retried honouring retry-after (else exponential backoff), counted, and end as RATE_LIMIT / HTTP_ERROR; 4xx are not retried', async () => {
  for (const [kind, mod, model, envName] of ALL) {
    let n = 0; const a = mk(kind, mod, model, envName, async () => (++n === 1 ? { status: 429, headers: { 'retry-after': '2' }, body: 'slow down' } : PLAN_OK));
    assert.deepEqual(await a.provider.plan(planInput), PLAN_OK.args); assert.deepEqual(a.sleeps, [2000]); assert.equal(a.provider.metadata().callCounts.rateLimited, 1); assert.equal(a.api.requests.length, 2);
    n = 0; const b = mk(kind, mod, model, envName, async () => (++n <= 2 ? { status: kind === 'anthropic' ? 529 : 503, body: 'overloaded' } : PLAN_OK)); await b.provider.plan(planInput); assert.deepEqual(b.sleeps, [500, 1000], 'exponential backoff without retry-after'); assert.equal(b.provider.metadata().callCounts.serverErrors, 2);
    const c = mk(kind, mod, model, envName, async () => ({ status: 429, body: 'quota' })); await assert.rejects(c.provider.plan(planInput), (e) => e.code === 'RATE_LIMIT' && e.status === 429); assert.equal(c.api.requests.length, 3, '1 try + maxRetries (2)'); assert.equal(c.provider.metadata().callCounts.failures, 1);
    const d = mk(kind, mod, model, envName, async () => ({ status: 400, body: 'bad request' })); await assert.rejects(d.provider.plan(planInput), (e) => e.code === 'HTTP_ERROR' && e.status === 400); assert.equal(d.api.requests.length, 1, 'a 400 is not retried'); assert.deepEqual(d.sleeps, []);
    const { tools } = await createBenchmarkTools(); const e = mk(kind, mod, model, envName, async () => ({ status: 500, body: 'boom' })); assert.deepEqual(await createOrchestrator({ provider: e.provider, tools })({ question: 'x' }), { status: 'PLAN_FAILED', code: 'PROVIDER_ERROR', turns: 0 });
  }
  assert.equal(retryAfterMs('3'), 3000); assert.equal(retryAfterMs('Wed, 01 Jan 2031 00:00:10 GMT', Date.parse('2031-01-01T00:00:00Z')), 10000); assert.equal(retryAfterMs(null), null); assert.equal(retryAfterMs('abc'), null);
});

test('the response is not a valid function call: one corrective retry (same rule for every provider), then INVALID_RESPONSE; a truncated answer is INCOMPLETE', async () => {
  for (const [kind, mod, model, envName] of ALL) {
    let n = 0; const a = mk(kind, mod, model, envName, async ({ reminder }) => (++n === 1 ? { noCall: true } : (assert.match(reminder, /did not call submit_plan/), PLAN_OK)));
    assert.deepEqual(await a.provider.plan(planInput), PLAN_OK.args); assert.equal(a.api.requests.length, 2); assert.equal(a.provider.metadata().callCounts.formatRetries, 1);
    const b = mk(kind, mod, model, envName, async () => ({ noCall: true })); await assert.rejects(b.provider.plan(planInput), (e) => e.code === 'INVALID_RESPONSE'); assert.equal(b.api.requests.length, 2, 'exactly one corrective retry');
    if (kind !== 'anthropic') { const c = mk(kind, mod, model, envName, async () => ({ badJson: true, args: {} })); await assert.rejects(c.provider.plan(planInput), (e) => e.code === 'INVALID_RESPONSE', 'arguments that are not JSON'); }
    const d = mk(kind, mod, model, envName, async () => ({ noCall: true, incomplete: true })); await assert.rejects(d.provider.plan(planInput), (e) => e.code === 'INCOMPLETE');
    const w = mk(kind, mod, model, envName, async () => ({ name: 'something_else', args: {} })); await assert.rejects(w.provider.plan(planInput), (e) => e.code === 'INVALID_RESPONSE');
  }
});

test('NO SECRET anywhere: not in errors, diagnostics, metadata, usage, results - even when the provider echoes the key in an error body; a missing variable is reported by NAME only', async () => {
  for (const [kind, mod, model, envName] of ALL) {
    const key = KEYS[envName];
    const echo = mk(kind, mod, model, envName, async () => ({ status: 401, body: `{"error":"invalid key ${key}","headers":{"authorization":"Bearer ${key}","x-api-key":"${key}"}}` }));
    let thrown; try { await echo.provider.plan(planInput); } catch (e) { thrown = e; } assert.equal(thrown.code, 'HTTP_ERROR'); assert.equal(thrown.status, 401);
    const md = echo.provider.metadata(); const all = JSON.stringify([thrown.message, thrown.events, md, echo.provider.drainUsage()]);
    assert.ok(!all.includes(key), `${kind}: the key never appears`); assert.ok(!/Bearer [A-Za-z0-9]{8,}/.test(all)); assert.ok(md.recentErrors.length === 1 && md.recentErrors[0].status === 401 && md.recentErrors[0].message.includes('[redacted]'));
    assert.equal(md.apiKeyEnv, envName, 'the variable NAME is recorded'); assert.ok(!('apiKey' in md));
    const noEnv = mod.createProvider(cfg(model, envName), { fetch: async () => { throw new Error('must not be called'); }, env: {} }); await assert.rejects(noEnv.plan(planInput), (e) => e.code === 'MISSING_API_KEY' && e.message.includes(envName) && !e.message.includes('sk-'));
    const meta = collectMetadata({ provider: echo.provider, config: cfg(model, envName), repeatMetadata: [{ repeat: 1, ...md }], repeats: 1, startedAt: new Date(), finishedAt: new Date(), casesFile: path.join(ROOT, 'benchmark/ask/cases.json'), referenceDate: '2026-09-26' });
    assert.ok(!JSON.stringify(meta).includes(key)); assert.equal(meta.provider.model, model); assert.equal(meta.provider.repeatMetadata[0].usageTotals.inputTokens, 0);
  }
  assert.equal(scrub('Authorization: Bearer abcdefghijklmnop and x-api-key: zzz111222', ['zzz111222']), 'Authorization: [redacted] and x-api-key: [redacted]');
});

test('reproducibility: metadata exposes provider, exact model, the version the API returned, reasoning effort, parameters, endpoint, pricing, token totals, call counts and the prompt fingerprint', async () => {
  const expectVersion = { openai: 'gpt-6-sol-2026-09-01', anthropic: 'claude-opus-5-5', kimi: 'kimi-k3' };
  for (const [kind, mod, model, envName] of ALL) {
    const { provider } = mk(kind, mod, model, envName, async ({ purpose, facts }) => (purpose === 'plan' ? PLAN_OK : explainFrom(facts)), { params: { seed: 7 } });
    assert.equal(provider.metadata().modelVersion, null, 'unknown until the API answers'); await provider.plan(planInput);
    const m = provider.metadata(); assert.deepEqual([m.provider, m.model, m.modelVersion, m.reasoningEffort], [kind, model, expectVersion[kind], 'high']);
    assert.equal(m.params.maxOutputTokens, 32000); assert.equal(m.params.seed, 7); assert.equal(m.params.toolChoice, kind === 'anthropic' ? 'auto' : 'forced'); assert.equal(m.temperature, null, 'the provider default: none is sent');
    assert.match(m.endpoint, /^https:\/\/api\.(openai|anthropic|moonshot)\.(com|ai)\//); assert.deepEqual(m.pricing, PRICING); assert.match(m.promptSha256, /^[0-9a-f]{64}$/); assert.equal(m.callCounts.plan, 1); assert.equal(m.callCounts.requests, 1); assert.equal(m.today, '2026-09-26');
    assert.ok(m.usageTotals.inputTokens > 0 && m.usageTotals.costUsd > 0);
  }
});

test('inside the benchmark: an adapter is created anew for every repetition, its usage feeds the scores, and each repetition\'s metadata is kept', async () => {
  const cases = JSON.parse(readFileSync(path.join(ROOT, 'benchmark/ask/cases.json'), 'utf8')); const made = [];
  const script = async ({ purpose, facts, text }) => {
    if (purpose === 'explain') return explainFrom(facts.length ? facts : [{ ref: 'c1.values.net_sales_ex_tax', value: 1 }]);
    return /Donne-moi les chiffres/.test(text) ? { args: { premises: [], clarification: { text: 'Quels chiffres ?' } } } : { args: { premises: [], toolCalls: [{ tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } }] } };
  };
  const { runs, repeatMetadata } = await runBenchmark({ cases, repeats: 2, only: ['S01', 'C01'], createProvider: () => { const m = mk('anthropic', anthropic, 'claude-opus-5-5', 'ANTHROPIC_API_KEY', script); made.push(m); return m.provider; } });
  assert.equal(made.length, 2); assert.equal(repeatMetadata.length, 2); assert.deepEqual(repeatMetadata.map((m) => m.repeat), [1, 2]); assert.ok(repeatMetadata.every((m) => m.usageTotals.inputTokens > 0 && m.provider === 'anthropic'));
  const s01 = runs[0][0]; assert.equal(s01.pass, true); assert.deepEqual(s01.usage, { inputTokens: 2000, outputTokens: 600, costUsd: 0.0094 }, 'plan + explain, priced from the config'); assert.equal(s01.latency.providerCalls, 2);
  const rep = summarizeRuns(runs, {}); assert.equal(rep.subScores.averageCostPerQuestionUsd, 0.00705, 'cost per question over the 4 case-runs (C01 needs no explanation)'); assert.equal(rep.subScores.tokens.input, 6000);
});

test('SAFETY of the adapters: import never touches the network; the only network call is the injected fetch; only the three official hosts; no key, no secret value in any file', async () => {
  const realFetch = globalThis.fetch; let calls = 0; globalThis.fetch = () => { calls += 1; throw new Error('network is forbidden in tests'); };
  try { await import('../benchmark/ask/adapters/openai.js?again'); await import('../benchmark/ask/adapters/anthropic.js?again'); await import('../benchmark/ask/adapters/kimi.js?again'); } finally { globalThis.fetch = realFetch; }
  assert.equal(calls, 0, 'importing an adapter does nothing');
  const files = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } }; walk(path.join(ROOT, 'benchmark/ask/adapters'));
  const allowedHosts = ['api.openai.com', 'api.anthropic.com', 'api.moonshot.ai', 'developers.openai.com', 'platform.claude.com', 'platform.kimi.ai'];
  for (const f of files) {
    const s = readFileSync(f, 'utf8'); const code = s.replace(/\/\/.*$/gm, '');
    for (const h of s.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) assert.ok(allowedHosts.includes(h[1]), `${path.basename(f)}: unexpected host ${h[1]}`);
    assert.ok(!/\bsk-[A-Za-z0-9-]{12,}|Bearer [A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}/.test(s), `${path.basename(f)}: no key material`);
    if (f.endsWith('.js')) { assert.ok(!/\bglobalThis\.fetch\(|[^.\w]fetch\(|require\(['"]https?['"]\)|node:https?|XMLHttpRequest|WebSocket/.test(code), `${path.basename(f)}: no direct network call`); assert.ok(!/process\.env\.[A-Z_]*(KEY|TOKEN|SECRET)/.test(code), 'no hardcoded env access to a key'); }
  }
  const http = readFileSync(path.join(ROOT, 'benchmark/ask/adapters/shared/http.js'), 'utf8'); assert.ok(/fetchImpl\(url/.test(http), 'the one call site uses the injected fetch');
  const gi = readFileSync(path.join(ROOT, '.gitignore'), 'utf8'); assert.ok(gi.includes('benchmark/ask/adapters/configs/*.local.json') && gi.includes('benchmark/ask/results/'));
  for (const name of ['openai.js', 'anthropic.js', 'kimi.js']) { const s = readFileSync(path.join(ROOT, 'benchmark/ask/adapters', name), 'utf8'); assert.ok(!/orchestrator|ai\/premise|ai\/verify/.test(s.replace(/\/\/.*$/gm, '')), `${name}: the Nordla orchestrator is not touched to accommodate a provider`); }
});
