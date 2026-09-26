import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFakeBankAdapter } from '../src/finance/bank.js';
import { startApp } from './finance-dashboard-helpers.js';

// "Connecter une banque": the button always opens a real workflow; nothing is ever simulated or marked connected without a real consent.
// SYNTHETIC only: an invented adapter and token.
const KEY = randomBytes(32);
const read = (f) => readFileSync(new URL(`../src/finance/ui/${f}`, import.meta.url), 'utf8');
const ws = read('views-workspace.js'); const appJs = read('app.js'); const html = read('index.html'); const bc = read('bank-connect.js');

/** Loads the DOM-free helpers out of the real source (never re-implemented in the test). */
function helpers() {
  // eslint-disable-next-line no-new-func
  return new Function(`${bc}\nreturn { safeAuthorizationUrl, bankConnectPlan, parseBankReturn, bankStateMatches, BANK_STATE_KEY };`)();
}

// ---------- server contract ----------
test('no provider configured: connect refuses, nothing is connected, no account exists, CSV import stays available, read-only', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const st = (await c.get('/api/bank/status')).data;
    assert.equal(st.adapter.configured, false); assert.equal(st.connected, false); assert.equal(st.state, 'NOT_CONNECTED');
    assert.equal(st.csvImportAvailable, true); assert.equal(st.readOnly, true); assert.equal(st.paymentInitiation, false);
    const r = await c.post('/api/bank/connect', {});
    assert.ok(r.status >= 400, 'no simulated connection'); assert.equal(r.data.error.code, 'BANK_NOT_CONFIGURED');
    const after = (await c.get('/api/bank/status')).data;
    assert.equal(after.state, 'NOT_CONNECTED'); assert.equal(after.connected, false); assert.deepEqual(after.counts, { NEW: 0, MATCHED: 0, IGNORED: 0 });
    assert.equal((await c.get('/api/treasury')).data.display.bank, null, 'no bank balance is shown without a bank');
    assert.equal((await c.get('/api/bank/transactions')).data.rows.length, 0);
    // a consent request without any connection attempt cannot create anything either
    const fake = await c.post('/api/bank/consent', { code: 'x', state: 'y' });
    assert.equal(fake.status, 409, 'a consent with no provider is a clean refusal, not a server error'); assert.equal(fake.data.error.code, 'BANK_NOT_CONFIGURED');
    assert.equal((await c.get('/api/bank/status')).data.connected, false);
  } finally { await a.close(); }
});

function spyAdapter(over = {}) {
  const seen = { redirectUris: [], consents: [] };
  const base = createFakeBankAdapter();
  const adapter = { ...base, async beginConsent({ redirectUri }) { seen.redirectUris.push(redirectUri); return over.begin ? over.begin(redirectUri) : base.beginConsent({ redirectUri }); },
    async completeConsent(payload) { seen.consents.push(payload); return over.complete ? over.complete(payload) : base.completeConsent(payload); } };
  return { adapter, seen };
}

test('provider configured: connect returns the real https authorizationUrl and the state; the redirect URI is the app root without a fragment', async () => {
  const { adapter, seen } = spyAdapter();
  const a = await startApp({ bankAdapter: adapter, bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const r = await c.post('/api/bank/connect', {});
    assert.equal(r.status, 200); assert.match(r.data.authorizationUrl, /^https:\/\/bank\.example\.test\/authorize\?/); assert.equal(r.data.state, 'st-1');
    assert.deepEqual(Object.keys(r.data).sort(), ['authorizationUrl', 'state'], 'nothing else (no token) leaves the server');
    assert.match(seen.redirectUris[0], /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.ok(!seen.redirectUris[0].includes('#'));
    assert.equal((await c.get('/api/bank/status')).data.connected, false, 'starting a connection is not being connected');
  } finally { await a.close(); }
});

test('hosted (HTTPS): the redirect URI uses https', async () => {
  const { adapter, seen } = spyAdapter();
  const a = await startApp({ bankAdapter: adapter, bankVaultKey: KEY, deps: { secureCookie: true } });
  try { await (await a.authed()).post('/api/bank/connect', {}); assert.match(seen.redirectUris[0], /^https:\/\//); } finally { await a.close(); }
});

test('an authorization URL that is not a well-formed https URL is never handed to the browser', async () => {
  for (const bad of ['javascript:alert(1)', 'http://bank.example.test/x', '/relative', '', undefined, 'data:text/html,x']) {
    const { adapter } = spyAdapter({ begin: () => ({ authorizationUrl: bad, state: 's' }) });
    const a = await startApp({ bankAdapter: adapter, bankVaultKey: KEY });
    try {
      const c = await a.authed(); const r = await c.post('/api/bank/connect', {});
      assert.equal(r.status, 502, String(bad)); assert.equal(r.data.error.code, 'BANK_PROVIDER_INVALID_AUTHORIZATION_URL');
      assert.equal((await c.get('/api/bank/status')).data.connected, false);
    } finally { await a.close(); }
  }
});

test('consent success: connected only now, no token in any response, accounts appear only after a valid consent and a sync', async () => {
  const { adapter, seen } = spyAdapter();
  const a = await startApp({ bankAdapter: adapter, bankVaultKey: KEY });
  try {
    const c = await a.authed();
    await c.post('/api/bank/connect', {});
    assert.equal((await c.get('/api/treasury')).data.display.bank, null, 'no account before consent');
    const ok = await c.post('/api/bank/consent', { code: 'auth-code', state: 'st-1' });
    assert.equal(ok.status, 200); assert.equal(ok.data.connected, true); assert.equal(ok.data.state, 'ACTIVE');
    assert.deepEqual(seen.consents[0], { code: 'auth-code', state: 'st-1' });
    assert.ok(!JSON.stringify(ok.data).includes('synthetic-read-only-token'), 'the token never reaches the browser');
    assert.equal((await c.get('/api/bank/status')).data.readOnly, true);
  } finally { await a.close(); }
});

test('consent error / refusal: nothing is connected and nothing is stored', async () => {
  const { adapter } = spyAdapter({ complete: () => { throw new Error('provider rejected the code'); } });
  const a = await startApp({ bankAdapter: adapter, bankVaultKey: KEY });
  try {
    const c = await a.authed(); await c.post('/api/bank/connect', {});
    const r = await c.post('/api/bank/consent', { code: 'bad', state: 'st-1' });
    assert.ok(r.status >= 400); assert.ok(!JSON.stringify(r.data).includes('synthetic-read-only-token'));
    const st = (await c.get('/api/bank/status')).data;
    assert.equal(st.connected, false); assert.equal(st.state, 'NOT_CONNECTED'); assert.deepEqual(st.counts, { NEW: 0, MATCHED: 0, IGNORED: 0 });
    assert.equal((await c.get('/api/treasury')).data.display.bank, null);
  } finally { await a.close(); }
});

test('a consent request with no code or no state is refused before the provider is called', async () => {
  const { adapter, seen } = spyAdapter();
  const a = await startApp({ bankAdapter: adapter, bankVaultKey: KEY });
  try {
    const c = await a.authed();
    for (const body of [{}, { code: 'x' }, { state: 'y' }, { code: '', state: '' }]) { const r = await c.post('/api/bank/consent', body); assert.equal(r.status, 422); }
    assert.equal(seen.consents.length, 0); assert.equal((await c.get('/api/bank/status')).data.connected, false);
  } finally { await a.close(); }
});

test('the consent endpoints need a session', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try { const anon = a.client(); assert.equal((await anon.post('/api/bank/connect', {})).status, 401); assert.equal((await anon.post('/api/bank/consent', { code: 'x', state: 'y' })).status, 401); } finally { await a.close(); }
});

test('the CSV import still works with no bank connection (the path offered by the connect window)', async () => {
  const a = await startApp({ bankVaultKey: KEY });
  try {
    const c = await a.authed();
    const r = await c.post('/api/bank/import-csv', { csv: 'date;montant;libelle\n2026-09-10;100,00;Client A\n' });
    assert.equal(r.status, 200); assert.equal(r.data.created, 1);
    assert.equal((await c.get('/api/bank/status')).data.connected, false, 'an imported statement is not a bank connection');
  } finally { await a.close(); }
});

// ---------- DOM-free helpers (real source) ----------
test('authorization URL guard: https only', () => {
  const { safeAuthorizationUrl } = helpers();
  assert.equal(safeAuthorizationUrl('https://bank.example.test/authorize?x=1'), 'https://bank.example.test/authorize?x=1');
  for (const bad of ['javascript:alert(1)', 'http://bank.example.test', '/x', '', null, undefined, 'https://', 'data:text/html,x']) assert.equal(safeAuthorizationUrl(bad), null, String(bad));
});

test('connect window plan: automatic only when a provider is configured; CSV import always; never "connected" from the plan itself', () => {
  const { bankConnectPlan } = helpers();
  assert.deepEqual({ ...bankConnectPlan({ adapter: { configured: false }, csvImportAvailable: true, state: 'NOT_CONNECTED' }) }, { automatic: false, csvImport: true, connected: false });
  assert.deepEqual({ ...bankConnectPlan({ adapter: { configured: true }, csvImportAvailable: true, state: 'NOT_CONNECTED' }) }, { automatic: true, csvImport: true, connected: false });
  assert.equal(bankConnectPlan(null).automatic, false); assert.equal(bankConnectPlan(null).csvImport, true);
  assert.equal(bankConnectPlan({ adapter: { configured: true }, state: 'ACTIVE' }).connected, true);
});

test('return from the bank: success candidate, refusal, cancellation, malformed - fixed categories only, provider text never displayed', () => {
  const { parseBankReturn, bankStateMatches } = helpers();
  assert.equal(parseBankReturn(''), null); assert.equal(parseBankReturn('?foo=bar'), null);
  assert.deepEqual({ ...parseBankReturn('?code=abc&state=st-1') }, { kind: 'callback', code: 'abc', state: 'st-1' });
  assert.deepEqual({ ...parseBankReturn('?error=access_denied&error_description=<script>') }, { kind: 'cancelled' });
  assert.deepEqual({ ...parseBankReturn('?error=user_cancelled') }, { kind: 'cancelled' });
  assert.deepEqual({ ...parseBankReturn('?error=server_error') }, { kind: 'error' });
  assert.deepEqual({ ...parseBankReturn('?code=abc') }, { kind: 'error' }); assert.deepEqual({ ...parseBankReturn('?state=s') }, { kind: 'error' });
  assert.equal(parseBankReturn('?code=' + 'a'.repeat(900) + '&state=s').code.length, 500);
  assert.equal(bankStateMatches('st-1', 'st-1'), true);
  for (const [a, b] of [[null, 'st-1'], ['', ''], ['st-1', 'other'], [undefined, undefined]]) assert.equal(bankStateMatches(a, b), false);
});

// ---------- UI wiring (source guards - this codebase has no DOM harness; the click flow was also verified in the browser) ----------
test('the "Connecter une banque" button is never disabled and opens the connect window', () => {
  const i = ws.indexOf("tt('Connect a bank')"); assert.ok(i > 0);
  const btn = ws.slice(ws.lastIndexOf("h('button'", i), i);
  assert.doesNotMatch(btn, /disabled/, 'the button is always clickable');
  assert.match(btn, /openBankConnectModal\(st/);
  assert.doesNotMatch(ws, /console\.log\(r\.authorizationUrl\)/, 'the old dead end (URL only logged to the console) is gone');
  assert.doesNotMatch(ws, /disabled: !st\.adapter\.configured/);
});

test('the connect window offers the automatic connection state, the CSV import and a way to cancel', () => {
  const m = ws.slice(ws.indexOf('function openBankConnectModal'), ws.indexOf('async function processBankReturn'));
  for (const k of ["tt('Automatic connection')", "tt('No banking service is configured yet for this company.')", "tt('Bank statement import')", "tt('Import a CSV statement')", "tt('Cancel')", "tt('Connect with my bank')"]) assert.ok(m.includes(k), k);
  assert.match(m, /plan\.automatic\s*\?/, 'the automatic button only exists when a provider is configured');
  assert.match(m, /safeAuthorizationUrl/); assert.match(m, /location\.assign\(url\)/);
  assert.match(m, /close\(\); const f = getCsvField\(\)/, 'the CSV button closes the window and focuses the existing CSV field');
  assert.doesNotMatch(m, /\/api\/bank\/consent/, 'the window itself never completes a consent');
});

test('the return from the bank is captured, stripped from the address bar, checked against the saved state, and success is only claimed after the backend says connected', () => {
  assert.match(appJs, /pendingBankReturn = parseBankReturn\(location\.search\)/);
  assert.match(appJs, /history\.replaceState\(null, '', location\.pathname \+ '#\/bank'\)/);
  assert.ok(appJs.indexOf('pendingBankReturn = parseBankReturn') < appJs.indexOf('async function route()'));
  assert.match(appJs, /if \(pendingBankReturn\) \{[^}]*processBankReturn\(ret\)/);
  const p = ws.slice(ws.indexOf('async function processBankReturn'), ws.indexOf('async function viewBank'));
  assert.match(p, /bankStateMatches\(saved, ret\.state\)/);
  assert.match(p, /'\/api\/bank\/consent', \{ code: ret\.code, state: ret\.state \}/);
  assert.match(p, /r && r\.connected/, 'connected is claimed only from the backend answer');
  assert.ok(p.indexOf('bankStateMatches') < p.indexOf('/api/bank/consent'), 'nothing is sent before the state is checked');
});

test('provider-neutral and secret-safe: no provider name, no token handling in the browser code', () => {
  const all = [bc, ws, appJs].join('\n');
  assert.doesNotMatch(all, /plaid|gocardless|nordigen|tink\b|saltedge|salt edge|yapily|truelayer|ponto/i);
  assert.doesNotMatch(bc, /token/i);
  assert.doesNotMatch(ws.slice(ws.indexOf('function openBankConnectModal'), ws.indexOf('async function viewBank')), /token|localStorage/i);
  assert.equal(helpers().BANK_STATE_KEY, 'nordla.bank.state');
});

test('the helper script is served and loaded before app.js', async () => {
  assert.ok(html.indexOf('/bank-connect.js') > 0 && html.indexOf('/bank-connect.js') < html.indexOf('/app.js'));
  const a = await startApp();
  try { const r = await fetch(`${a.base}/bank-connect.js`, { headers: { Host: `127.0.0.1:${a.port}` } }); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/); } finally { await a.close(); }
});
