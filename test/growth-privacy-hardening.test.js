// Nordla Growth - privacy hardening of the AI path (review of A5): the merchant's free question, the public-example web addresses, the model's answer,
// the provider's failures and every log line. Marker values are planted and must never reach the provider, a stored draft, a log or a response.
// Detection covers HIGH-CONFIDENCE formats only. A person's NAME is not detected: the tests document that limit instead of hiding it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAgentGateway } from '../src/growth/agents/gateway.js';
import { detectPersonalData, reduceUrl, PERSONAL_KINDS } from '../src/growth/agents/privacy.js';
import { providerFromEnv } from '../src/growth/agents/provider.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { errorLabel } from '../src/growth/server/safe-log.js';
import { AGENTS } from '../src/growth/agents/registry.js';

const MARK = { email: 'marqueur.courriel@example.test', phone: '+32 470 12 34 56', phoneNat: '0470 12 34 56', iban: 'BE68 5390 0754 7034', url: 'https://www.instagram.com/pseudo_marqueur/p/ABC123/?igsh=MARKERTOKEN', secret: 'MARKER-SECRET-KEY-123', body: 'MARKER-PROVIDER-BODY' };
const ALL_MARKERS = [MARK.email, MARK.phone, MARK.phoneNat, MARK.iban, 'pseudo_marqueur', 'MARKERTOKEN', MARK.secret, MARK.body];
const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';

const okText = (draft = 'Brouillon de test synthétique.', reason = 'Raison de test.', limits = ['limite de test']) => JSON.stringify({ draft, reason, limits });
const providerReturning = (text, calls = []) => ({ name: 'fake', model: 'm', complete: async (a) => { calls.push(a.user); return text; } });
const sourcesWith = (extra = {}) => ({ priorities: async () => ({ items: [] }), ...extra });

/** Everything written by the code under test while fn runs: console output including stacks. */
async function captured(fn) {
  const out = []; const keep = { e: console.error, l: console.log, w: console.warn, i: console.info };
  const put = (...a) => out.push(a.map((x) => (x && x.stack ? x.stack : String(x))).join(' '));
  console.error = put; console.log = put; console.warn = put; console.info = put;
  try { await fn(); } finally { console.error = keep.e; console.log = keep.l; console.warn = keep.w; console.info = keep.i; }
  return out.join('\n');
}
async function serve(app) {
  const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const post = async (body, path = '/api/growth/agents/run') => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } return { status: r.status, json, raw }; };
  return { post, close: () => new Promise((r) => s.close(r)) };
}
const noMarker = (text, label) => { for (const m of ALL_MARKERS) assert.ok(!String(text).includes(m), `${label}: a marker reached it`); };

// ---- 1. the free question ----
test('question: high-confidence personal formats are refused before any provider call; the answer names the kind only, never the value', async () => {
  for (const [label, q] of [['email', `écris à ${MARK.email}`], ['phone', `appelle ${MARK.phone}`], ['national phone', `tél ${MARK.phoneNat}`], ['iban', `vire sur ${MARK.iban}`], ['link with parameters', `regarde ${MARK.url}`]]) {
    const calls = [];
    const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: providerReturning(okText(), calls), ...sourcesWith() }));
    const logs = await captured(async () => {
      const r = await srv.post({ agentId: 'strategist', question: q });
      assert.equal(r.status, 400, label); assert.equal(r.json.error.code, 'QUESTION_PERSONAL_DATA', label);
      assert.ok(Array.isArray(r.json.error.details) && r.json.error.details.every((k) => PERSONAL_KINDS.includes(k)), `${label}: kinds only`);
      noMarker(r.raw, `${label} response`);
    });
    assert.equal(calls.length, 0, `${label}: nothing sent to the provider`);
    noMarker(logs, `${label} logs`);
    await srv.close();
  }
});
test('question: a benign question reaches the provider unchanged; a name is NOT detected (documented limit)', async () => {
  assert.deepEqual(detectPersonalData('Quelles priorités retenir cette semaine ?'), []);
  assert.deepEqual(detectPersonalData('Jean Dupont a acheté deux coques'), [], 'names are not detected reliably: this is a limit, not a protection');
  const calls = [];
  const gw = createAgentGateway({ provider: providerReturning(okText(), calls), getters: {} });
  await gw.run({ agentId: 'store', question: 'Quelles priorités retenir cette semaine ?', scope: 'q1' });
  assert.equal(JSON.parse(calls[0]).question, 'Quelles priorités retenir cette semaine ?');
});

// ---- 2. web addresses ----
test('URL: a web address in an agent context keeps its host and an opaque reference only; its path, query and any account name never leave', () => {
  const r = reduceUrl(MARK.url);
  assert.equal(r.host, 'instagram.com'); assert.match(r.ref, /^url:[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(r), /pseudo_marqueur|MARKERTOKEN|igsh/);
  assert.equal(reduceUrl('/relative/path'), null); assert.equal(reduceUrl(42), null);
  assert.deepEqual(reduceUrl(['https://a.example.test/x?y=1', 'nope']).map((x) => x && x.host), ['a.example.test', null]);
});
test('URL: public examples reach the provider reduced, in the real agent path (social -> content agent)', async () => {
  const calls = [];
  const social = async () => ({ examples: [{ id: 'ex1', url: MARK.url, network: 'instagram', format: 'reel', units: 4 }], posts: [{ id: 'p1', url: `https://www.tiktok.com/@pseudo_marqueur/video/1`, units: 2 }] });
  const gw = createAgentGateway({ provider: providerReturning(okText(), calls), getters: { content: async () => ({ checks: [] }), social } });
  await gw.run({ agentId: 'content', scope: 'u1' });
  assert.doesNotMatch(calls[0], /pseudo_marqueur|MARKERTOKEN|igsh|tiktok\.com\/@/);
  const ctx = JSON.parse(calls[0]).context.social.data;
  assert.equal(ctx.examples[0].url.host, 'instagram.com'); assert.equal(ctx.examples[0].format, 'reel', 'the useful fields stay');
  assert.equal(ctx.posts[0].units, 2);
});

// ---- 3. the model's answer ----
test('model output: a draft, reason or limit with a personal format is NOT kept; the answer is neutral and names the kind only', async () => {
  for (const [label, text] of [
    ['email in draft', okText(`Écrivez à ${MARK.email}`)],
    ['phone in reason', okText('Brouillon.', `Appeler ${MARK.phone}`)],
    ['iban in limits', okText('Brouillon.', 'Raison.', [`compte ${MARK.iban}`])],
    ['link with parameters in draft', okText(`Voir ${MARK.url}`)],
  ]) {
    const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: providerReturning(text), ...sourcesWith() }));
    const logs = await captured(async () => {
      const r = await srv.post({ agentId: 'strategist' });
      assert.equal(r.status, 422, label); assert.equal(r.json.error.code, 'AI_OUTPUT_BLOCKED', label);
      assert.equal(r.json.draft, undefined, label); assert.equal(r.json.priorityRef, undefined, label);
      noMarker(r.raw, `${label} response`);
    });
    noMarker(logs, `${label} logs`);
    await srv.close();
  }
});
test('model output: a benign draft is kept; the output check does not change the normal answer', async () => {
  const gw = createAgentGateway({ provider: providerReturning(okText('Proposez 3 coques populaires.', 'Ventes récentes.', ['aucune limite'])), getters: {} });
  const r = await gw.run({ agentId: 'store', scope: 'o1' });
  assert.equal(r.draft, 'Proposez 3 coques populaires.');
});

// ---- 4. provider failures and error text ----
test('provider failure: the HTTP body and the key are never in the error, the response or the log', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => `${MARK.body} ${MARK.email} ${MARK.secret}` });
  const provider = providerFromEnv({ GROWTH_AI_PROVIDER: 'anthropic', GROWTH_AI_API_KEY: MARK.secret, GROWTH_AI_MODEL: 'm' }, { fetchImpl });
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: provider, ...sourcesWith() }));
  const logs = await captured(async () => {
    const r = await srv.post({ agentId: 'strategist' });
    assert.equal(r.status, 502); assert.equal(r.json.error.code, 'AI_PROVIDER_ERROR');
    noMarker(r.raw, 'response');
  });
  noMarker(logs, 'logs');
  await srv.close();
});
test('provider throw with personal values in its message: a coded error only; the message is not logged', async () => {
  const bad = { name: 'fake', model: 'm', complete: async () => { throw new Error(`${MARK.email} ${MARK.body}`); } };
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: bad, ...sourcesWith() }));
  const logs = await captured(async () => { const r = await srv.post({ agentId: 'strategist' }); assert.equal(r.status, 502); noMarker(r.raw, 'response'); });
  noMarker(logs, 'logs');
  await srv.close();
});
test('engine error with personal values in its message: the source is unavailable and only its code or name is logged', async () => {
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: providerReturning(okText()), inbox: async () => { throw Object.assign(new Error(`${MARK.email} row`), { code: 'INBOX_READ' }); }, productPotential: async () => ({ rows: [] }) }));
  const logs = await captured(async () => { await srv.post({ agentId: 'strategist' }); });
  noMarker(logs, 'logs');
  await srv.close();
  assert.equal(errorLabel(Object.assign(new Error(MARK.email), { code: 'INBOX_READ' })), 'INBOX_READ');
  assert.equal(errorLabel(new Error(MARK.email)), 'Error');
  assert.equal(errorLabel(Object.assign(new TypeError(MARK.email), {})), 'TypeError');
  assert.equal(errorLabel(Object.assign(new Error('x'), { code: 'bad code with spaces ' + MARK.email })), 'Error');
});

// ---- 5. sweep: every agent, every planted value, every path ----
test('sweep: for every agent, no marker value reaches the provider, a stored draft, a log or a response, through the real route', async () => {
  for (const a of AGENTS) {
    const calls = [];
    const poison = { id: 'inbox:instagram:acct-1', kind: 'inquiryTest', category: 'inbox', evidence: { handle: MARK.email, accountId: 'acct-1', text: MARK.body } };
    const getters = {};
    for (const k of a.sources) getters[k] = async () => ({ rows: [{ customer: { email: MARK.email }, phone: MARK.phone, units: 2, note: `ok ${MARK.iban}` }], examples: [{ url: MARK.url, account: MARK.email }], items: [poison] });
    const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: providerReturning(okText('Brouillon neutre.'), calls), productPotential: async () => ({ rows: [] }), inbox: async () => ({ state: 'OK', accounts: [], items: [poison] }), ...getters }));
    const logs = await captured(async () => {
      const r = await srv.post({ agentId: a.id, question: 'Question neutre sans coordonnée.' });
      noMarker(r.raw, `${a.id} response`);
    });
    noMarker(logs, `${a.id} logs`);
    await srv.close();
    for (const c of calls) noMarker(c, `${a.id} provider`);
  }
});
test('sweep: the provider input of every agent carries no marker even when the source returns them (gateway level)', async () => {
  for (const a of AGENTS) {
    const calls = [];
    const getters = {};
    for (const k of a.sources) getters[k] = async () => ({ rows: [{ email: MARK.email, phone: MARK.phone, customer_key: MARK.secret, note: MARK.iban, units: 3 }], examples: [{ url: MARK.url, account: MARK.email }] });
    const gw = createAgentGateway({ provider: providerReturning(okText(), calls), getters });
    await gw.run({ agentId: a.id, scope: `sw-${a.id}` });
    noMarker(calls[0], `${a.id} provider`);
    assert.ok(calls[0].includes('"units":3'), `${a.id}: the useful number still arrives`);
  }
});

test('free text in a context: each high-confidence format is masked, the rest of the sentence and its numbers are kept', async () => {
  const { maskPersonal } = await import('../src/growth/agents/privacy.js');
  const s = maskPersonal(`Vente de 3 coques, contact ${MARK.email}, tél ${MARK.phone}, compte ${MARK.iban}, voir ${MARK.url} et prix 25,00 €`);
  assert.equal(s, 'Vente de 3 coques, contact [courriel], tél [téléphone], compte [iban], voir [lien] et prix 25,00 €');
  assert.equal(maskPersonal('Commande #1065 du 27/11/2026, 12 unités'), 'Commande #1065 du 27/11/2026, 12 unités');
});
