// The mandatory configuration preflight of every real-provider run: local, zero network, specific exit code, names the field to fix and never a secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPreflight, formatFailure, PREFLIGHT_EXIT_CODE } from '../benchmark/ask/lib/preflight.js';
import { spec as openaiSpec } from '../benchmark/ask/adapters/openai.js';
import { spec as anthropicSpec } from '../benchmark/ask/adapters/anthropic.js';
import { spec as kimiSpec } from '../benchmark/ask/adapters/kimi.js';
import * as openai from '../benchmark/ask/adapters/openai.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REAL_LOOKING_KEY = 'sk-proj-Zx8Qm2Lp7Vr4Nb9Tc3Wd6Hf1Jk5Sg0Ya';   // a fixture, matches no real account
const cfg = (over = {}) => ({ model: 'gpt-6-sol', reasoningEffort: 'high', apiKeyEnv: 'OPENAI_API_KEY', today: '2026-09-26', maxOutputTokens: 32000, timeoutMs: 120000, maxRetries: 2, maxFormatRetries: 1,
  pricing: { inputPerMTok: 2, outputPerMTok: 10 }, pricingSource: { url: 'https://example.test/pricing', retrievedOn: '2026-09-26' }, params: {}, ...over });
const base = (over = {}) => ({ spec: openaiSpec, config: cfg(), env: { OPENAI_API_KEY: REAL_LOOKING_KEY, NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1' },
  options: { smoke: true, repeats: null, repeatsGiven: false, maxRequests: 12, only: null }, smokePreset: { repeats: 1, maxRequests: 12, maxCostUsd: 1 },
  casesOk: true, casesSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64), nordla: { commit: 'c'.repeat(40), dirty: false }, adapter: { sha256: 'd'.repeat(64), uncommittedChanges: false }, today: new Date('2026-09-27'), ...over });
const withEnv = (env) => base({ env: { NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1', ...env } });
const fields = (r) => r.failures.map((f) => f.field);

test('a correct configuration passes, and the summary is safe: no key, no value of it', () => {
  const r = runPreflight(base()); assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.deepEqual(r.summary, { Provider: 'openai', Model: 'gpt-6-sol', Endpoint: 'https://api.openai.com/v1/responses', 'Reasoning effort': 'high', Repeats: 1, 'API key': 'present', 'Provider calls': 'enabled', Pricing: 'configured (retrieved 2026-09-26)', Preflight: 'PASS' });
  assert.ok(!JSON.stringify(r).includes(REAL_LOOKING_KEY) && !JSON.stringify(r).includes(REAL_LOOKING_KEY.slice(0, 10)) && !JSON.stringify(r).includes(REAL_LOOKING_KEY.slice(-6)));
  for (const [s, model, effort] of [[anthropicSpec, 'claude-opus-5-5', 'high'], [kimiSpec, 'kimi-k3', 'max']]) assert.equal(runPreflight(base({ spec: s, config: cfg({ model, reasoningEffort: effort, apiKeyEnv: 'X_PROVIDER_KEY' }), env: { X_PROVIDER_KEY: REAL_LOOKING_KEY, NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1' } })).ok, true, s.provider);
});

test('key: absent, empty, blank, a placeholder, or too short - each is refused, naming the VARIABLE only', () => {
  for (const [label, env] of [['absent', {}], ['empty', { OPENAI_API_KEY: '' }], ['blank', { OPENAI_API_KEY: '   ' }], ['TA_VRAIE_CLE', { OPENAI_API_KEY: 'TA_VRAIE_CLE' }], ['YOUR_API_KEY', { OPENAI_API_KEY: 'YOUR_API_KEY' }], ['CHANGEME', { OPENAI_API_KEY: 'CHANGEME' }],
    ['sk-your-key-here', { OPENAI_API_KEY: 'sk-your-key-here-aaaaaaaaaaaaaaaa' }], ['too short', { OPENAI_API_KEY: 'sk-abc' }], ['quoted', { OPENAI_API_KEY: `"${REAL_LOOKING_KEY}"` }]]) {
    const r = runPreflight(withEnv(env)); assert.equal(r.ok, false, label); assert.ok(fields(r).includes('OPENAI_API_KEY'), label);
    const text = formatFailure(r); assert.match(text, /^PREFLIGHT FAILED — OPENAI_API_KEY is missing or/); assert.match(text, /No request was sent\./);
    for (const v of Object.values(env)) if (v.length > 3) assert.ok(!text.includes(v.trim().replace(/"/g, '')), `${label}: the value is never echoed`);
  }
  assert.ok(fields(runPreflight(base({ config: cfg({ apiKeyEnv: undefined }) }))).includes('config.apiKeyEnv'), 'no variable name configured');
  assert.ok(fields(runPreflight(base({ config: cfg({ apiKeyEnv: REAL_LOOKING_KEY }) }))).includes('config.apiKeyEnv'), 'a key where the NAME belongs');
  assert.ok(!formatFailure(runPreflight(base({ config: cfg({ apiKeyEnv: REAL_LOOKING_KEY }) }))).includes(REAL_LOOKING_KEY.slice(0, 12)), 'and it is not echoed either');
});

test('model: missing, empty, placeholder, malformed', () => {
  for (const m of [undefined, '', '   ', 'YOUR_MODEL', 'ton-modele-ici', '<model>', 'model with spaces', 'x']) { const r = runPreflight(base({ config: cfg({ model: m }) })); assert.ok(fields(r).includes('config.model'), String(m)); }
  assert.equal(runPreflight(base({ config: cfg({ model: 'claude-opus-5-5' }) })).ok, true);
});

test('endpoint: an incorrect host, a non-HTTPS URL, a wrong path or a malformed URL are refused; the official one (with or without /v1) passes', () => {
  for (const u of ['http://api.openai.com/v1', 'https://evil.example.com/v1', 'https://api.openai.com/v2', 'not a url', 'https://api.openai.com.evil.test/v1']) assert.ok(fields(runPreflight(base({ config: cfg({ baseUrl: u }) }))).includes('config.baseUrl'), u);
  assert.equal(runPreflight(base({ config: cfg({ baseUrl: 'https://api.openai.com/v1' }) })).ok, true);
  assert.ok(fields(runPreflight(base({ config: cfg({ baseUrl: 'https://api.openai.com' }) }))).includes('config.baseUrl'), 'without /v1 it would not reach the adapter\'s endpoint');
});

test('parameters: invalid effort, unsupported / controlled / unknown parameters, unknown config keys - nothing is silently ignored', () => {
  assert.ok(fields(runPreflight(base({ config: cfg({ reasoningEffort: 'turbo' }) }))).includes('config.reasoningEffort'));
  assert.ok(fields(runPreflight(base({ config: cfg({ reasoningEffort: undefined }) }))).includes('config.reasoningEffort'));
  assert.equal(runPreflight(base({ config: cfg({ reasoningEffort: null }) })).ok, true, 'null = send none');
  assert.ok(fields(runPreflight(base({ spec: kimiSpec, config: cfg({ model: 'kimi-k3', reasoningEffort: 'xhigh' }) }))).includes('config.reasoningEffort'), 'xhigh exists for Claude, not for Kimi');
  for (const p of ['temperature', 'top_p']) assert.ok(fields(runPreflight(base({ config: cfg({ params: { [p]: 0.2 } }) }))).includes(`config.params.${p}`), `openai ${p}`);
  assert.ok(fields(runPreflight(base({ spec: anthropicSpec, config: cfg({ model: 'claude-opus-5-5', params: { temperature: 0 } }) }))).includes('config.params.temperature'));
  assert.ok(fields(runPreflight(base({ config: cfg({ params: { model: 'other' } }) }))).includes('config.params.model'), 'a controlled field cannot be overridden');
  assert.ok(fields(runPreflight(base({ config: cfg({ params: { frequency_penalty: 1 } }) }))).includes('config.params.frequency_penalty'), 'an unknown parameter is refused, not forwarded unchecked');
  assert.ok(fields(runPreflight(base({ config: cfg({ temprature: 0.2 }) }))).includes('config.temprature'), 'a misspelt top-level key would be silently ignored');
  assert.equal(runPreflight(base({ config: cfg({ _comment: 'free text' }) })).ok, true, 'underscore keys are comments');
  assert.equal(runPreflight(base({ config: cfg({ params: { service_tier: 'default' } }) })).ok, true, 'a declared parameter passes');
  assert.ok(fields(runPreflight(base({ spec: anthropicSpec, config: cfg({ model: 'claude-opus-5-5', toolChoice: 'forced' }) }))).includes('config.toolChoice'), 'Opus 5.5 rejects a forced tool');
});

test('benchmark: repeats, provider calls explicitly authorised, request cap, cases/dataset/commit/adapter identifiable', () => {
  const full = (over = {}) => base({ options: { smoke: false, repeats: 3, repeatsGiven: true, maxRequests: 700, only: null }, ...over });
  assert.equal(runPreflight(full()).ok, true);
  for (const bad of [0, 11, 1.5, NaN, -2]) assert.ok(fields(runPreflight(full({ options: { smoke: false, repeats: bad, repeatsGiven: true, maxRequests: 10, only: null } }))).includes('--repeats'), String(bad));
  const noOptIn = runPreflight(base({ env: { OPENAI_API_KEY: REAL_LOOKING_KEY } })); assert.equal(noOptIn.ok, false); assert.match(formatFailure(noOptIn), /Refusing to call a real provider/); assert.ok(fields(noOptIn).includes('NORDLA_BENCH_ALLOW_PROVIDER_CALLS'));
  assert.ok(fields(runPreflight(base({ env: { OPENAI_API_KEY: REAL_LOOKING_KEY, NORDLA_BENCH_ALLOW_PROVIDER_CALLS: 'true' } }))).includes('NORDLA_BENCH_ALLOW_PROVIDER_CALLS'), 'exactly "1"');
  assert.ok(fields(runPreflight(full({ options: { smoke: false, repeats: 1, repeatsGiven: false, maxRequests: null, only: null } }))).includes('--max-requests'));
  assert.ok(fields(runPreflight(base({ options: { smoke: true, repeats: null, repeatsGiven: true, maxRequests: 12, only: null } }))).includes('--smoke'), '--smoke with --repeats');
  assert.ok(fields(runPreflight(base({ options: { smoke: true, repeats: null, repeatsGiven: false, maxRequests: 13, only: null } }))).includes('--max-requests'), 'above the smoke cap');
  assert.ok(fields(runPreflight(base({ casesOk: false }))).includes('cases')); assert.ok(fields(runPreflight(base({ datasetSha256: null }))).includes('dataset'));
  assert.ok(fields(runPreflight(base({ nordla: { commit: null, dirty: null } }))).includes('nordla')); assert.ok(fields(runPreflight(base({ adapter: null }))).includes('adapter'));
  assert.ok(fields(runPreflight(base({ spec: null }))).includes('adapter'), 'adapter not loaded / provider not identifiable');
  assert.equal(runPreflight(base({ nordla: { commit: 'c'.repeat(40), dirty: true } })).ok, true, 'a dirty tree is a warning, not a failure'); assert.equal(runPreflight(base({ nordla: { commit: 'c'.repeat(40), dirty: true } })).warnings.length > 0, true);
});

test('cost: a full benchmark needs dated, sourced pricing; a smoke without it is a warning and the cost stays null', () => {
  const full = (config) => base({ config, options: { smoke: false, repeats: 3, repeatsGiven: true, maxRequests: 700, only: null } });
  for (const [label, c] of [['none', cfg({ pricing: undefined })], ['nulls', cfg({ pricing: { inputPerMTok: null, outputPerMTok: null } })], ['undated', cfg({ pricingSource: undefined })], ['not https', cfg({ pricingSource: { url: 'http://x.test', retrievedOn: '2026-09-26' } })], ['bad date', cfg({ pricingSource: { url: 'https://x.test', retrievedOn: 'yesterday' } })]]) {
    assert.equal(runPreflight(full(c)).ok, false, `full: ${label}`); const s = runPreflight(base({ config: c })); assert.equal(s.ok, true, `smoke: ${label}`); assert.ok(s.warnings.some((w) => w.area === 'cost'), `smoke warns: ${label}`); assert.equal(s.priced, false); assert.match(s.summary.Pricing, /cost = null/);
  }
  assert.ok(runPreflight(base({ config: cfg({ pricingSource: { url: 'https://x.test', retrievedOn: '2026-01-01' } }) })).warnings.some((w) => /older than/.test(w.message)), 'stale pricing is flagged');
});

test('through the runner: an unpriced smoke reports cost null (never 0, never estimated); adapter cost is null without pricing', async () => {
  const { createProvider } = openai; const c = cfg(); delete c.pricing; delete c.pricingSource;
  const body = { id: 'r1', model: 'gpt-6-sol', output: [{ type: 'function_call', name: 'submit_plan', arguments: '{}' }], usage: { input_tokens: 100, output_tokens: 20 } };
  const p = createProvider(c, { env: { OPENAI_API_KEY: REAL_LOOKING_KEY }, fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }), sleep: async () => {} });
  await p.plan({ question: 'q', history: [] }).catch(() => {});
  const u = p.drainUsage(); assert.equal(u.costUsd, null); assert.equal(u.inputTokens, 100); assert.equal(p.metadata().usageTotals.costUsd, null); assert.equal(p.metadata().pricing, null);
});

// --- zero network on failure: proved in a child process whose fetch, sockets and DNS all record any attempt ---
test('a failing preflight sends NO request: the child process traps fetch, net, tls, dns and http(s) and none of them is ever called; exit code 6; the key is not printed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-')); const marker = path.join(dir, 'network-attempt.txt');
  const trap = path.join(dir, 'trap.mjs');
  writeFileSync(trap, `import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import http from 'node:http'; import https from 'node:https'; import { appendFileSync } from 'node:fs';
const hit = (what) => { appendFileSync(${JSON.stringify(marker)}, what + '\\n'); throw new Error('NETWORK ATTEMPT: ' + what); };
globalThis.fetch = (...a) => hit('fetch');
net.Socket.prototype.connect = function () { return hit('net.connect'); }; net.connect = () => hit('net.connect'); net.createConnection = () => hit('net.createConnection'); tls.connect = () => hit('tls.connect');
dns.lookup = () => hit('dns.lookup'); dns.resolve = () => hit('dns.resolve'); http.request = () => hit('http.request'); https.request = () => hit('https.request'); http.get = () => hit('http.get'); https.get = () => hit('https.get');
`);
  const adapter = path.join(ROOT, 'benchmark/ask/adapters/openai.js');
  const conf = (over) => { const f = path.join(dir, `c-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(cfg(over))); return f; };
  const run = (config, env, extra = ['--smoke']) => spawnSync(process.execPath, ['--import', pathToFileURL(trap).href, path.join(ROOT, 'benchmark/ask/run.js'), '--provider', adapter, '--config', config, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  const ALLOW = { NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1' };
  const cases = [
    ['key absent', conf({}), { ...ALLOW }, /OPENAI_API_KEY is missing or/],
    ['key placeholder', conf({}), { ...ALLOW, OPENAI_API_KEY: 'TA_VRAIE_CLE' }, /OPENAI_API_KEY is missing or appears to contain a placeholder\. No request was sent/],
    ['model absent', conf({ model: undefined }), { ...ALLOW, OPENAI_API_KEY: REAL_LOOKING_KEY }, /config\.model is missing/],
    ['endpoint not https', conf({ baseUrl: 'http://api.openai.com/v1' }), { ...ALLOW, OPENAI_API_KEY: REAL_LOOKING_KEY }, /config\.baseUrl must use https/],
    ['invalid effort', conf({ reasoningEffort: 'turbo' }), { ...ALLOW, OPENAI_API_KEY: REAL_LOOKING_KEY }, /config\.reasoningEffort is not valid/],
    ['unsupported parameter', conf({ params: { temperature: 0.2 } }), { ...ALLOW, OPENAI_API_KEY: REAL_LOOKING_KEY }, /config\.params\.temperature is not supported/],
    ['provider calls not authorised', conf({}), { OPENAI_API_KEY: REAL_LOOKING_KEY }, /Refusing to call a real provider/],
  ];
  for (const [label, config, env, re] of cases) {
    const r = run(config, env); assert.equal(r.status, PREFLIGHT_EXIT_CODE, `${label}: exit code\n${r.stderr}`); assert.match(r.stderr, /^PREFLIGHT FAILED — /, label); assert.match(r.stderr, re, label);
    assert.ok(!r.stdout.includes('Preflight: PASS'), label); assert.ok(!(r.stdout + r.stderr).includes(REAL_LOOKING_KEY.slice(0, 10)), `${label}: the key is never printed`);
  }
  const badRepeats = run(conf({}), { ...ALLOW, OPENAI_API_KEY: REAL_LOOKING_KEY }, ['--max-requests', '5', '--repeats', '11']); assert.equal(badRepeats.status, PREFLIGHT_EXIT_CODE); assert.match(badRepeats.stderr, /--repeats must be an integer from 1 to 10/);
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, 'utf8') : '');
});

test('a passing preflight prints the safe summary; the only network attempt is then the adapter\'s own, which the trap stops (proving preflight itself made none)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-ok-')); const marker = path.join(dir, 'attempt.txt'); const trap = path.join(dir, 'trap.mjs');
  writeFileSync(trap, `import { appendFileSync } from 'node:fs'; globalThis.fetch = async (u) => { appendFileSync(${JSON.stringify(marker)}, 'fetch ' + new URL(u).hostname + '\\n'); throw new Error('blocked by the test trap'); };\n`);
  const f = path.join(dir, 'c.json'); writeFileSync(f, JSON.stringify(cfg({ maxRetries: 0 })));
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(trap).href, path.join(ROOT, 'benchmark/ask/run.js'), '--provider', path.join(ROOT, 'benchmark/ask/adapters/openai.js'), '--config', f, '--smoke', '--out', path.join(dir, 'o.json')],
    { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NORDLA_BENCH_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: REAL_LOOKING_KEY } });
  for (const line of ['Provider: openai', 'Model: gpt-6-sol', 'Endpoint: https://api.openai.com/v1/responses', 'Reasoning effort: high', 'Repeats: 1', 'API key: present', 'Provider calls: enabled', 'Preflight: PASS']) assert.ok(r.stdout.includes(line), `summary line: ${line}\n${r.stdout}`);
  assert.ok(!(r.stdout + r.stderr).includes(REAL_LOOKING_KEY) && !(r.stdout + r.stderr).includes(REAL_LOOKING_KEY.slice(-8)), 'the key is never printed');
  assert.ok(existsSync(marker) && readFileSync(marker, 'utf8').split('\n')[0] === 'fetch api.openai.com', 'the trap caught the run\'s own first request (after the PASS)');
  const out = JSON.parse(readFileSync(path.join(dir, 'o.json'), 'utf8')); assert.equal(out.meta.run.budget.requests <= 12, true);
});
