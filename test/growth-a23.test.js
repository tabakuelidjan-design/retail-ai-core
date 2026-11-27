// Nordla Growth - A2 (conversation links from « Suivi commercial ») and A3 (Stratège drafts shown in Opportunités, with their state).
// Synthetic data only. No model call: the drafts here are stored strings written by the test, never produced by an agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createGrowthApp } from '../src/growth/server/app.js';
import { followUpKeyOk, followUpValueError } from '../src/growth/server/follow-up-store.js';

const SCOPE = 'a'.repeat(64);
const UI = new URL('../src/growth/ui/', import.meta.url);

test('A3 storage: the agent-draft key is accepted for its own merchant scope only, with no opportunity id', () => {
  assert.equal(followUpKeyOk(`nordla.growth.agent.v1:${SCOPE}`, SCOPE), true);
  assert.equal(followUpKeyOk(`nordla.growth.agent.v1:${SCOPE}:opp-1`, SCOPE), false, 'a draft key never carries an opportunity id');
  assert.equal(followUpKeyOk(`nordla.growth.agent.v1:${'b'.repeat(64)}`, SCOPE), false, 'another merchant scope is refused');
  assert.equal(followUpKeyOk(`nordla.growth.agent.v2:${SCOPE}`, SCOPE), false, 'unknown version refused');
});

test('A3 value: only { v: 1, drafts: [at most 10] } is accepted for an agent-draft key; anything else is VALUE_INVALID', () => {
  const key = `nordla.growth.agent.v1:${SCOPE}`;
  assert.equal(followUpValueError(key, { v: 1, drafts: [] }), null);
  assert.equal(followUpValueError(key, { v: 2, drafts: [] }), 'VALUE_INVALID');
  assert.equal(followUpValueError(key, { v: 1, drafts: 'x' }), 'VALUE_INVALID');
  assert.equal(followUpValueError(key, { v: 1, drafts: new Array(11).fill({}) }), 'VALUE_INVALID');
  assert.equal(followUpValueError(key, { v: 1, requests: {} }), 'VALUE_INVALID');
});

test('A2 source: the pipeline state lists the conversations with id, network, request type and status only (no handle, no text)', async () => {
  const inbox = async () => ({ state: 'OK', accounts: [], items: [{ id: 'inquiry:one', kind: 'inquiryTest', evidence: { network: 'instagram', requestType: 'quote', status: 'open', handle: '@private', text: 'secret message' } }] });
  const server = http.createServer(createGrowthApp({ inbox, productPotential: async () => ({ rows: [] }), merchantId: null }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await (await fetch(`${base}/api/growth/sources/pipeline`)).json();
    assert.equal(r.key, 'pipeline'); assert.equal(r.status, 'browser_only', 'local preview keeps the follow-up in this browser');
    assert.ok(Array.isArray(r.items), 'items present');
    assert.equal(r.items.length, 1, "the conversation is listed");
    {
      const it = r.items[0];
      assert.deepEqual(Object.keys(it).sort(), ['id', 'network', 'requestType', 'status']);
      assert.doesNotMatch(JSON.stringify(r), /@private|secret message/, 'no handle and no message text leave the server');
    }
  } finally { server.close(); }
});

test('A3 scope: the agents payload carries the merchant scope (a sha-256 of the merchant id), so the page keeps its drafts under the right key', async () => {
  const server = http.createServer(createGrowthApp({ merchantId: '00000000-0000-4000-8000-000000000001', agentProvider: null }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/growth/agents`)).json();
    assert.match(r.historyScope, /^[0-9a-f]{64}$/);
    assert.equal(r.configured, false, 'no provider: no draft can be produced');
  } finally { server.close(); }
});

test('A2 / A3 UI: the deep link and the drafts block exist in the three languages, and no draft is generated or simulated in the UI', async () => {
  const agents = await readFile(new URL('agents.js', UI), 'utf8');
  const inbox = await readFile(new URL('inbox.js', UI), 'utf8');
  const opp = await readFile(new URL('opportunities.js', UI), 'utf8');
  const app = await readFile(new URL('app.js', UI), 'utf8');
  assert.match(opp, /safe\(agentDraftsCard\)/);
  assert.match(inbox, /hashParam\('open'\)/);
  assert.match(app, /focusDeepLink\(\)/);
  // Drafts are stored only after the server answered with a checked draft; nothing else writes the key.
  assert.match(agents, /if \(res && res\.ok && res\.body && agentId === 'strategist'\) saveStrategistDraft/);
  assert.doesNotMatch(agents, /draft:\s*['"`]/, 'no literal draft text in the UI');
  assert.doesNotMatch(agents + inbox + opp, /innerHTML/);
  // every key the new blocks use exists in fr, nl and en
  const lang = await readFile(new URL('lang-agents.js', UI), 'utf8');
  const keys = [...new Set([...(agents + inbox + opp).matchAll(/t\('(gr\.(?:ag|src|inbox)\.[\w.]+)'/g)].map((m) => m[1]))];
  for (const l of ['fr', 'nl', 'en']) {
    const ctx = { window: {} };
    const { default: vm } = await import('node:vm');
    vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
    vm.runInNewContext(lang, ctx);
    for (const k of keys) assert.ok(ctx.window.NORDLA_DICTS[l][k], `${l}: missing ${k}`);
  }
});
