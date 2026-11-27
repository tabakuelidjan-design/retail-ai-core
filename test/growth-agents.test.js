// Nordla Growth - AI agents: registry, gateway (quota, limits, strict output), provider from the server environment, and the HTTP routes.
// Synthetic data and a FAKE provider only. No network call, no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AGENTS, AGENT_IDS, agentById } from '../src/growth/agents/registry.js';
import { createAgentGateway, parseDraft, sourceStatusOf, MAX_QUESTION } from '../src/growth/agents/gateway.js';
import { providerFromEnv, providerConfigState, agentConfigFromEnv } from '../src/growth/agents/provider.js';
import { createGrowthApp } from '../src/growth/server/app.js';

const FRESH = { priorities: { items: [{ id: 'fix:x', title: 'synthetic' }] }, store: { sales: 3 } };
const okText = (draft = 'Brouillon synthétique.') => JSON.stringify({ draft, reason: 'Basé sur les sources fournies.', limits: ['Période de test'] });
const fakeProvider = (text = okText(), seen = []) => ({ name: 'fake', model: 'test-model', complete: async (args) => { seen.push(args); return text; } });
const getters = (over = {}) => ({
  priorities: async () => FRESH.priorities, products: async () => ({ rows: [] }), audience: async () => ({ segments: [] }),
  content: async () => ({ checks: [] }), store: async () => FRESH.store, dropoff: async () => ({ steps: [] }),
  ads: async () => ({ status: 'NOT_CONNECTED' }), social: async () => ({ posts: [] }), ...over,
});

test('registry: eight specialised agents, unique ids, each with sources, a period, a system rule and human confirmations', () => {
  assert.equal(AGENTS.length, 8);
  assert.equal(new Set(AGENT_IDS).size, 8);
  for (const id of ['strategist', 'products', 'audience', 'content', 'store', 'conversion', 'ads', 'experiments']) assert.ok(agentById(id), id);
  for (const a of AGENTS) {
    assert.ok(a.sources.length >= 1, `${a.id} has sources`);
    assert.ok(a.system.includes('n’invente aucun chiffre'), `${a.id} carries the no-invention rule`);
    assert.ok(a.system.includes('Tu ne publies rien'), `${a.id} carries the no-action rule`);
    assert.ok(a.confirmations.length >= 1, `${a.id} names what needs a human confirmation`);
  }
  assert.equal(agentById('nope'), null);
});

test('gateway without a provider: NOT_CONFIGURED, nothing simulated, no provider name or key in the status', async () => {
  const g = createAgentGateway({ provider: null, getters: getters() });
  const st = g.status();
  assert.equal(st.configured, false); assert.equal(st.provider, null); assert.equal(st.model, null);
  assert.doesNotMatch(JSON.stringify(st), /api[-_]?key/i);
  await assert.rejects(() => g.run({ agentId: 'strategist' }), (e) => e.code === 'AI_NOT_CONFIGURED' && e.status === 503);
});

test('gateway run: strict input, draft with period, sources, limits and the confirmation flag; not-connected source is named, never zero', async () => {
  const seen = [];
  const g = createAgentGateway({ provider: fakeProvider(okText('Plan 1. Plan 2.'), seen), getters: getters() });
  const r = await g.run({ agentId: 'ads', question: 'Que lire ?', scope: 's1' });
  assert.equal(r.agent, 'ads'); assert.equal(r.period, 'custom'); assert.equal(r.requiresHumanConfirmation, true);
  assert.deepEqual(r.sources, [{ key: 'ads', status: 'not_connected' }]);
  assert.ok(r.limits.some((l) => l.includes('non connectée')), 'the limit names the missing connection');
  assert.equal(r.draft, 'Plan 1. Plan 2.');
  assert.ok(r.confirmations.includes('ads_spend'));
  // the provider receives the agent's own system rules and only its own source's data
  assert.equal(seen.length, 1); assert.ok(seen[0].system.includes('Tu es l’agent Publicités'));
  const userPayload = JSON.parse(seen[0].user);
  assert.deepEqual(Object.keys(userPayload.context), ['ads']);
});

test('gateway refuses bad input before any call: unknown agent, oversize or control-character question', async () => {
  let calls = 0;
  const g = createAgentGateway({ provider: { name: 'f', complete: async () => { calls++; return okText(); } }, getters: getters() });
  await assert.rejects(() => g.run({ agentId: 'zzz' }), (e) => e.code === 'BAD_AGENT');
  await assert.rejects(() => g.run({ agentId: 'store', question: 'x'.repeat(MAX_QUESTION + 1) }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(() => g.run({ agentId: 'store', question: 'a\u0007b' }), (e) => e.code === 'BAD_REQUEST');
  assert.equal(calls, 0);
});

test('gateway output is strict: anything but the JSON contract is refused and never echoed', async () => {
  for (const bad of ['pas du json', JSON.stringify({ draft: 'x' }), JSON.stringify({ draft: 'x', reason: 'y', limits: 'z' }), JSON.stringify({ draft: 'x'.repeat(9000), reason: 'y', limits: [] })]) {
    const g = createAgentGateway({ provider: fakeProvider(bad), getters: getters() });
    await assert.rejects(() => g.run({ agentId: 'store' }), (e) => e.code === 'AI_BAD_OUTPUT' && e.status === 502);
  }
  assert.deepEqual(parseDraft(okText('D')).draft, 'D');
});

test('gateway quota: a daily limit per merchant scope; another merchant is not blocked by it', async () => {
  let day = '2026-11-26';
  const g = createAgentGateway({ provider: fakeProvider(), getters: getters(), dailyLimit: 1, now: () => new Date(`${day}T10:00:00Z`) });
  await g.run({ agentId: 'store', scope: 'A' });
  await assert.rejects(() => g.run({ agentId: 'store', scope: 'A' }), (e) => e.code === 'AI_QUOTA_EXCEEDED' && e.status === 429);
  await g.run({ agentId: 'store', scope: 'B' });
  day = '2026-11-27'; // a new day resets the count
  await g.run({ agentId: 'store', scope: 'A' });
});

test('gateway timeout and provider failure: coded errors, no provider body or key in the message', async () => {
  const slow = createAgentGateway({ provider: { name: 'f', complete: () => new Promise(() => {}) }, getters: getters(), timeoutMs: 20 });
  await assert.rejects(() => slow.run({ agentId: 'store' }), (e) => e.code === 'AI_TIMEOUT' && e.status === 504);
  const broken = createAgentGateway({ provider: { name: 'f', complete: async () => { throw new Error('secret-key-123 body'); } }, getters: getters() });
  await assert.rejects(() => broken.run({ agentId: 'store' }), (e) => { assert.equal(e.code, 'AI_PROVIDER_ERROR'); assert.equal(String(e.message).includes('secret'), false); return true; });
});

test('gateway context: a source that fails is unavailable (never zero); an oversize source is truncated and named', async () => {
  const big = { rows: Array.from({ length: 20000 }, (_, i) => ({ i, t: 'synthetic' })) };
  const g = createAgentGateway({ provider: fakeProvider(), getters: getters({ store: async () => { throw new Error('db down'); }, priorities: async () => big }) });
  const r = await g.run({ agentId: 'strategist' });
  assert.deepEqual(r.sources.find((s) => s.key === 'store'), { key: 'store', status: 'unavailable' });
  assert.ok(r.truncated.includes('priorities'));
  assert.equal(sourceStatusOf(null), 'unavailable'); assert.equal(sourceStatusOf({ connected: false }), 'not_connected'); assert.equal(sourceStatusOf({ items: [] }), 'available');
});

test('provider from the server environment: all three variables, nothing guessed, names only when missing, no value leaked', async () => {
  assert.deepEqual(providerConfigState({}).missing, ['GROWTH_AI_PROVIDER']);
  assert.deepEqual(providerConfigState({ GROWTH_AI_PROVIDER: 'anthropic' }).missing, ['GROWTH_AI_API_KEY', 'GROWTH_AI_MODEL']);
  assert.equal(providerFromEnv({ GROWTH_AI_PROVIDER: 'anthropic', GROWTH_AI_API_KEY: 'k' }), null);
  assert.deepEqual(agentConfigFromEnv({ GROWTH_AI_PROVIDER: 'other' }), { missing: [], unknownProvider: true });
  assert.equal(providerFromEnv({ GROWTH_AI_PROVIDER: 'other', GROWTH_AI_API_KEY: 'k', GROWTH_AI_MODEL: 'm' }), null);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'hello' }] }) }; };
  const p = providerFromEnv({ GROWTH_AI_PROVIDER: 'anthropic', GROWTH_AI_API_KEY: 'test-key-xyz', GROWTH_AI_MODEL: 'test-model' }, { fetchImpl });
  assert.equal(p.name, 'anthropic'); assert.equal(p.model, 'test-model'); assert.equal(JSON.stringify(p).includes('test-key-xyz'), false);
  assert.equal(await p.complete({ system: 's', user: 'u' }), 'hello');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key-xyz');
  const bad = providerFromEnv({ GROWTH_AI_PROVIDER: 'anthropic', GROWTH_AI_API_KEY: 'k', GROWTH_AI_MODEL: 'm' }, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await assert.rejects(() => bad.complete({ system: 's', user: 'u' }), (e) => e.code === 'AI_PROVIDER_ERROR' && !String(e.message).includes('k'));
});

// ---- HTTP routes (local app; the hosted gate is covered by its own tests) ----
const appSources = (over = {}) => {
  const g = getters(over);
  return { productPotential: g.products, audience: g.audience, content: g.content, store: g.store, dropoff: g.dropoff, ads: g.ads, social: g.social, ...over };
};
async function boot(opts = {}) {
  const app = createGrowthApp({ merchantId: null, ...opts });
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, { method = 'GET', body, type = 'application/json' } = {}) => {
    const r = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': type }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch { /* not json */ }
    return { status: r.status, json };
  };
  return { req, close: () => new Promise((r) => s.close(r)) };
}

test('routes: registry and admin state are readable, the run route needs a configured provider and returns a draft only', async () => {
  const srv = await boot({ agentProvider: null, agentConfig: { missing: ['GROWTH_AI_API_KEY'], unknownProvider: false }, ...appSources() });
  try {
    const st = await srv.req('/api/growth/agents');
    assert.equal(st.status, 200); assert.equal(st.json.configured, false); assert.equal(st.json.agents.length, 8);
    assert.deepEqual(st.json.configuration.missing, ['GROWTH_AI_API_KEY']);
    const adm = await srv.req('/api/growth/admin');
    assert.equal(adm.status, 200); assert.equal(adm.json.goals, undefined, "goals are read from the merchant follow-up, not from the admin payload");
    assert.ok(adm.json.sources.every((s) => ['available', 'not_connected', 'unavailable'].includes(s.status)));
    const off = await srv.req('/api/growth/agents/run', { method: 'POST', body: { agentId: 'store' } });
    assert.equal(off.status, 503); assert.equal(off.json.error.code, 'AI_NOT_CONFIGURED');
  } finally { await srv.close(); }

  const seen = [];
  const on = await boot({ agentProvider: fakeProvider(okText('Brouillon de test.'), seen), ...appSources() });
  try {
    const ok = await on.req('/api/growth/agents/run', { method: 'POST', body: { agentId: 'store', question: 'Idée ?' } });
    assert.equal(ok.status, 200); assert.equal(ok.json.draft, 'Brouillon de test.'); assert.equal(ok.json.requiresHumanConfirmation, true);
    const wrongType = await on.req('/api/growth/agents/run', { method: 'POST', body: 'a=1', type: 'text/plain' });
    assert.equal(wrongType.status, 400);
    const bad = await on.req('/api/growth/agents/run', { method: 'POST', body: { agentId: 'nope' } });
    assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'BAD_AGENT');
    const big = await on.req('/api/growth/agents/run', { method: 'POST', body: JSON.stringify({ agentId: 'store', question: 'x'.repeat(20000) }) });
    assert.equal(big.status, 413);
    const get = await on.req('/api/growth/agents/run');
    assert.equal(get.status, 404);
    const put = await on.req('/api/growth/agents', { method: 'POST', body: { agentId: 'store' } });
    assert.equal(put.status, 405);
  } finally { await on.close(); }
});
