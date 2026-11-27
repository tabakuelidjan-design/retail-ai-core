// Nordla Growth - A5 review: personal-data filter on every AI agent path. Sentinel values are planted at many depths and under many key names in every
// source an agent can read; the fake provider must never receive them, and every field an agent needs must still arrive. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AGENTS } from '../src/growth/agents/registry.js';
import { createAgentGateway, MAX_CONTEXT_CHARS } from '../src/growth/agents/gateway.js';
import { redactPersonalFields, priorityFocus, PRIVATE_FIELDS } from '../src/growth/agents/priority-ref.js';
import { createGrowthApp } from '../src/growth/server/app.js';

const SENT = ['SENTVAL-ACCTOBJ', 'SENTVAL-EMAIL', 'SENTVAL-PHONE', 'SENTVAL-HANDLE', 'SENTVAL-ACCT', 'SENTVAL-MSG', 'SENTVAL-FIRST', 'SENTVAL-CK', 'SENTVAL-ADDR', 'SENTVAL-IP'];
const dirty = (tag) => ({
  count: 3, status: 'OK', keepMarker: `KEEP-${tag}`, account: 'SENTVAL-ACCTOBJ', examples: [{ id: 'ex1', url: 'https://example.test/p/1', account: 'SENTVAL-ACCTOBJ', units: 6 }],
  customer_key: 'SENTVAL-CK', customerKey: 'SENTVAL-CK', email: 'SENTVAL-EMAIL', phone: 'SENTVAL-PHONE', handle: 'SENTVAL-HANDLE',
  accountId: 'SENTVAL-ACCT', account_id: 'SENTVAL-ACCT', text: 'SENTVAL-MSG', messages: [{ text: 'SENTVAL-MSG' }],
  threads: [{ handle: 'SENTVAL-HANDLE', messages: [{ text: 'SENTVAL-MSG' }], units: 5 }],
  customer: { firstName: 'SENTVAL-FIRST', email: 'SENTVAL-EMAIL', rows: [{ phone: 'SENTVAL-PHONE', units: 4 }] },
  rows: [{ customer: { email: 'SENTVAL-EMAIL' }, units: 2 }, { firstName: 'SENTVAL-FIRST', units: 1 }],
  entity: { type: 'socialAccount', id: 'SENTVAL-ACCT', title: 'SENTVAL-HANDLE' },
  items: [{ id: 'inbox:instagram:SENTVAL-ACCT', category: 'inbox', kind: 'inquiryTest', evidence: { handle: 'SENTVAL-HANDLE', network: 'instagram', grain: 'threads' } }],
  nested: { deep: { deeper: [{ address: 'SENTVAL-ADDR', ip: 'SENTVAL-IP', ok: 1 }] } },
});
const allGetters = (tag = 'G') => Object.fromEntries(['priorities', 'products', 'audience', 'content', 'social', 'store', 'dropoff', 'ads'].map((k) => [k, async () => dirty(`${tag}-${k}`)]));
const okProvider = (calls) => ({ name: 'fake', model: 'm', complete: async ({ user }) => { calls.push(user); return JSON.stringify({ draft: 'Brouillon de test.', reason: 'r', limits: [] }); } });

test('every agent: the provider receives only the sources of that agent, with personal fields removed at every depth, and keeps the fields it needs', async () => {
  for (const a of AGENTS) {
    const calls = [];
    const gw = createAgentGateway({ provider: okProvider(calls), getters: allGetters(a.id) });
    await gw.run({ agentId: a.id, scope: `s-${a.id}` });
    const user = calls[0];
    for (const s of SENT) assert.doesNotMatch(user, new RegExp(s), `${a.id}: ${s} reached the provider`);
    assert.doesNotMatch(user, /"entity"/, `${a.id}: the socialAccount entity reached the provider`);
    const ctx = JSON.parse(user).context;
    assert.deepEqual(Object.keys(ctx).sort(), [...a.sources, ...(a.goal ? ['goal'] : [])].sort(), `${a.id}: only its own sources (and the weekly target for the agents that use it)`);
    for (const k of a.sources) {
      assert.ok(JSON.stringify(ctx[k]).includes(`KEEP-${a.id}-${k}`), `${a.id}/${k}: the non-personal marker is kept`);
      assert.ok(JSON.stringify(ctx[k]).includes('"units":2'), `${a.id}/${k}: units still arrive`);
    }
  }
});

test('the filter removes the named keys at any depth and any array level, and keeps every other value', () => {
  const out = redactPersonalFields({ a: [{ b: { handle: 'x', c: [{ accountId: 'y', units: 1, text: 'z', keep: 'ok' }] } }], email: 'e', units: 7 });
  assert.deepEqual(out, { a: [{ b: { c: [{ units: 1, keep: 'ok' }] } }], units: 7 });
  for (const k of ['handle', 'accountId', 'account_id', 'text', 'messages', 'threads', 'customer', 'customer_key', 'customerKey', 'email', 'phone', 'firstName', 'lastName', 'first_name', 'last_name', 'address', 'ip', 'ipAddress']) assert.ok(PRIVATE_FIELDS.has(k), k);
});

test('a source that fails is unavailable and its error never reaches the provider or the log', async () => {
  const calls = []; const lines = [];
  const getters = allGetters('E'); getters.store = async () => { throw new Error('SENTVAL-EMAIL inside the database error'); };
  const gw = createAgentGateway({ provider: okProvider(calls), getters, log: (m) => lines.push(m) });
  const r = await gw.run({ agentId: 'store', scope: 'e1' });
  assert.deepEqual(r.sources, [{ key: 'store', status: 'unavailable' }]);
  assert.equal(calls.length, 1); assert.doesNotMatch(calls[0], /SENTVAL/);
  assert.equal(lines.some((l) => /SENTVAL/.test(l)), false);
});

test('a provider error never carries the provider body, the personal values or the key into the error or the log', async () => {
  const lines = [];
  const bad = { name: 'fake', model: 'm', complete: async () => { throw Object.assign(new Error('provider body SENTVAL-EMAIL sk-test-key'), { code: 'X' }); } };
  const gw = createAgentGateway({ provider: bad, getters: allGetters('P'), log: (m) => lines.push(m) });
  await assert.rejects(() => gw.run({ agentId: 'audience', scope: 'p1' }), (e) => {
    assert.equal(e.code, 'AI_PROVIDER_ERROR'); assert.doesNotMatch(String(e.message), /SENTVAL|sk-test/); return true;
  });
  assert.equal(lines.some((l) => /SENTVAL|sk-test/.test(l)), false);
});

test('a priority reaches the provider as opaque, without account identifiers; the server keeps the real id for the reference', async () => {
  const calls = [];
  const item = { id: 'inbox:instagram:SENTVAL-ACCT', kind: 'inquiryTest', category: 'inbox', sourcePage: 'inbox', title: { code: 'inbox.title', params: {} }, explanation: { code: 'inbox.ZERO.why', params: {} }, reliability: 'limited', evidence: { network: 'instagram', requestType: 'quote', status: 'ZERO', handle: 'SENTVAL-HANDLE', accountId: 'SENTVAL-ACCT', grain: 'threads' } };
  const app = createGrowthApp({ merchantId: '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5', agentProvider: okProvider(calls), productPotential: async () => ({ rows: [] }), inbox: async () => ({ state: 'OK', accounts: [], items: [item] }) });
  const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/growth/agents/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'strategist', priorityId: 'inbox:instagram:SENTVAL-ACCT' }) });
    const body = await r.json();
    assert.equal(r.status, 200); assert.equal(body.priorityRef.id, 'inbox:instagram:SENTVAL-ACCT', 'the reference is the real priority id (merchant-scoped)');
    for (const s2 of SENT) assert.doesNotMatch(calls[0], new RegExp(s2), `${s2} reached the provider through the priority`);
    assert.match(JSON.stringify(JSON.parse(calls[0]).priority.id), /ref:[0-9a-f]{16}/);
    const focus = priorityFocus(item);
    assert.equal(focus.evidence.handle, undefined); assert.equal(focus.evidence.accountId, undefined); assert.equal(focus.evidence.network, 'instagram');
  } finally { s.close(); }
});

test('the bounded context: an oversized source is truncated and marked; no personal field survives inside the truncated text either', async () => {
  const calls = [];
  const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, email: 'SENTVAL-EMAIL', units: i })) };
  const getters = allGetters('B'); getters.priorities = async () => big;
  const gw = createAgentGateway({ provider: okProvider(calls), getters });
  const r = await gw.run({ agentId: 'strategist', scope: 'b1' });
  assert.ok(r.truncated.includes('priorities'));
  assert.doesNotMatch(calls[0], /SENTVAL/);
  assert.ok(calls[0].length < MAX_CONTEXT_CHARS * 2, 'the context stays bounded');
});
