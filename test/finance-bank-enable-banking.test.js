// Enable Banking as a read-only bank adapter: TEST DOUBLES ONLY (no network, no bank, no real key). The first real call is the owner's consent at the bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, randomBytes } from 'node:crypto';
import { createEnableBankingAdapter } from '../src/finance/bank-adapter-enable-banking.js';
import { assertReadOnlyAdapter } from '../src/finance/bank.js';
import { startApp } from './finance-dashboard-helpers.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }); const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const NOW = () => new Date('2026-11-17T09:00:00Z');
const ASPSP = { name: 'Belfius Bank', country: 'BE' };
const KEY = randomBytes(32);

const TX = (id, date, amount, dbit, extra = {}) => ({ entry_reference: id, booking_date: date, value_date: date, status: 'BOOK', credit_debit_indicator: dbit ? 'DBIT' : 'CRDT', transaction_amount: { amount, currency: 'EUR' },
  debtor: { name: 'Client Test' }, creditor: { name: 'Fournisseur Test' }, remittance_information: ['Facture 2026-0042'], ...extra });
/** A scripted Enable Banking: routes by method + path, records every request. `fail` makes the next transactions call answer 503 once. */
function bank(over = {}) {
  const seen = []; const state = { failOnce: false };
  const pages = over.pages ?? [[TX('e1', '2026-11-02', '100.00', false), TX('e2', '2026-11-03', '25.50', true, { remittance_information: ['+++123/4567/89012+++'] })], [TX('e3', '2026-11-04', '10.00', false)]];
  const fetchImpl = async (url, init) => {
    const u = new URL(url); seen.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
    if (init.method === 'POST' && u.pathname === '/auth') return reply(200, { url: 'https://bank.example.test/consent?x=1' });
    if (init.method === 'POST' && u.pathname === '/sessions') return reply(200, { session_id: 'sess-1', accounts: [{ uid: 'uid-1', account_id: { iban: 'BE68539007547034' }, name: 'Compte courant', currency: 'EUR' }], access: { valid_until: '2027-02-15T09:00:00Z' } });
    if (u.pathname.endsWith('/balances')) return reply(200, { balances: [{ balance_type: 'ITAV', balance_amount: { amount: '999.99', currency: 'EUR' }, reference_date: '2026-11-16' }, { balance_type: 'CLBD', balance_amount: { amount: '842.10', currency: 'EUR' }, reference_date: '2026-11-16' }] });
    if (u.pathname.endsWith('/transactions')) {
      if (state.failOnce) { state.failOnce = false; return reply(503, {}); }
      const i = u.searchParams.get('continuation_key') ? 1 : 0;
      return reply(200, { transactions: pages[i], ...(i + 1 < pages.length ? { continuation_key: 'k1' } : {}) });
    }
    if (init.method === 'DELETE') return reply(200, { message: 'OK' });
    return reply(404, {});
  };
  return { fetchImpl, seen, state };
}
const adapterOf = (b, o = {}) => createEnableBankingAdapter({ applicationId: 'app-123', privateKeyPem: PEM, aspsp: ASPSP, fetchImpl: b.fetchImpl, now: NOW, ...o });

test('EB-1 every request carries a JWT RS256 with the documented header and claims, verifiable with the public key; the adapter is read-only', async () => {
  const b = bank(); const a = adapterOf(b);
  assertReadOnlyAdapter(a);
  await a.beginConsent({ redirectUri: 'https://finance.example.test/' });
  const [h, c, s] = b.seen[0].headers.authorization.replace('Bearer ', '').split('.');
  const head = JSON.parse(Buffer.from(h, 'base64url')); const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual(head, { typ: 'JWT', alg: 'RS256', kid: 'app-123' });
  assert.equal(claims.iss, 'enablebanking.com'); assert.equal(claims.aud, 'api.enablebanking.com'); assert.equal(claims.exp - claims.iat, 3600); assert.equal(claims.iat, Math.floor(NOW().getTime() / 1000));
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(PUB, Buffer.from(s, 'base64url')));
  assert.equal(JSON.stringify(b.seen[0]).includes('PRIVATE KEY'), false, 'the private key never leaves the process');
});

test('EB-2 consent: POST /auth with the bank, the redirect, a state and a 90 day validity; the session keeps accounts; accounts/balances/transactions are read as signed cents; revoke closes the session', async () => {
  const b = bank(); const a = adapterOf(b);
  const { authorizationUrl, state } = await a.beginConsent({ redirectUri: 'https://finance.example.test/' });
  assert.match(authorizationUrl, /^https:\/\/bank\.example\.test\//); assert.ok(state);
  const auth = b.seen[0].body; assert.deepEqual(auth.aspsp, ASPSP); assert.equal(auth.redirect_url, 'https://finance.example.test/'); assert.equal(auth.state, state); assert.equal(auth.psu_type, 'business'); assert.equal(auth.access.valid_until, '2027-02-15T09:00:00.000Z');
  const { token, expiresAt, accountIds } = await a.completeConsent({ code: 'code-1', state });
  assert.equal(b.seen[1].path, '/sessions'); assert.deepEqual(b.seen[1].body, { code: 'code-1' }); assert.equal(expiresAt, '2027-02-15T09:00:00Z'); assert.deepEqual(accountIds, ['uid-1']);
  assert.deepEqual(await a.accounts(token), [{ id: 'uid-1', iban: 'BE68539007547034', name: 'Compte courant', currency: 'EUR' }]);
  const bal = await a.balances(token, 'uid-1'); assert.equal(bal.balanceCents, 84210, 'the booked closing balance (CLBD) is preferred to the available one'); assert.equal(bal.currency, 'EUR');
  const tx = await a.transactions(token, 'uid-1', { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(tx.map((t) => [t.id, t.amountCents]), [['e1', 10000], ['e2', -2550], ['e3', 1000]], 'two pages followed; debit negative');
  assert.equal(tx[1].counterpartyName, 'Fournisseur Test'); assert.equal(tx[0].counterpartyName, 'Client Test'); assert.equal(tx[1].structuredReference, '+++123/4567/89012+++'); assert.equal(tx[0].structuredReference, null);
  const q = b.seen.filter((r) => r.path.endsWith('/transactions'))[0].query; assert.deepEqual([q.date_from, q.date_to, q.transaction_status], ['2026-11-01', '2026-11-30', 'BOOK']);
  assert.ok(b.seen.every((r) => ['GET', 'POST', 'DELETE'].includes(r.method)) && !b.seen.some((r) => /payment/i.test(r.path)), 'no payment endpoint is ever called');
  await a.revoke(token); assert.deepEqual(b.seen.at(-1).method + ' ' + b.seen.at(-1).path, 'DELETE /sessions/sess-1');
});

test('EB-3 honest refusals: not configured, 401/403 = consent to renew, 429, 5xx, unreachable, a transaction without id/date/amount stops the whole read (never skipped, never guessed)', async () => {
  await assert.rejects(() => createEnableBankingAdapter({}).beginConsent({ redirectUri: 'https://x.test/' }), /BANK_NOT_CONFIGURED/);
  assert.equal(createEnableBankingAdapter({}).configured, false);
  const mk = (status) => adapterOf({ fetchImpl: async () => ({ status, ok: status < 400, json: async () => ({}) }) });
  const token = JSON.stringify({ sid: 's', accounts: [{ uid: 'u' }] });
  await assert.rejects(() => mk(401).balances(token, 'u'), /BANK_CONSENT_REJECTED/); await assert.rejects(() => mk(403).balances(token, 'u'), /BANK_CONSENT_REJECTED/);
  await assert.rejects(() => mk(429).balances(token, 'u'), /BANK_PROVIDER_RATE_LIMITED/); await assert.rejects(() => mk(503).balances(token, 'u'), /BANK_PROVIDER_ERROR/);
  await assert.rejects(() => adapterOf({ fetchImpl: async () => { throw new Error('socket'); } }).balances(token, 'u'), /BANK_PROVIDER_UNREACHABLE/);
  await assert.rejects(() => adapterOf(bank()).balances('not-a-token', 'u'), /BANK_CONSENT_REJECTED/);
  const noId = bank({ pages: [[TX(undefined, '2026-11-02', '1.00', false)]] });
  await assert.rejects(() => adapterOf(noId).transactions(token, 'u', { from: '2026-11-01', to: '2026-11-30' }), /BANK_PROVIDER_ERROR/);
});

test('EB-4 through the REAL Finance app (doubles at the bank): connect, consent, first import, second pass without duplicates, retry after a failure; the token never reaches the browser', async () => {
  const b = bank(); const a = adapterOf(b);
  const app = await startApp({ bankAdapter: a, bankVaultKey: KEY, today: '2026-11-17' });
  try {
    const c = await app.authed();
    const conn = await c.post('/api/bank/connect', {}); assert.equal(conn.status, 200); assert.match(conn.data.authorizationUrl ?? '', /^https:\/\/bank\.example\.test\//);
    const ok = await c.post('/api/bank/consent', { code: 'code-1', state: conn.data.state }); assert.equal(ok.status, 200); assert.equal(ok.data.connected, true);
    const count = async () => (await c.get('/api/bank/transactions')).data.rows.length;
    const first = await c.post('/api/bank/sync', {}); assert.equal(first.status, 200); assert.equal(await count(), 3, 'first import');
    const second = await c.post('/api/bank/sync', {}); assert.equal(second.status, 200); assert.equal(await count(), 3, 'second pass adds nothing');
    b.state.failOnce = true; const failed = await c.post('/api/bank/sync', {}); assert.ok(failed.status >= 400, 'a provider failure is reported'); assert.equal(await count(), 3, 'a failed pass changes nothing');
    const retry = await c.post('/api/bank/sync', {}); assert.equal(retry.status, 200); assert.equal(await count(), 3, 'the retry succeeds without duplicates');
    const everything = JSON.stringify([conn.data, ok.data, first.data, (await c.get('/api/bank/status')).data, (await c.get('/api/bank/transactions')).data]);
    assert.ok(!everything.includes('sess-1') && !everything.includes('PRIVATE KEY'), 'no session id, token or key in any response');
  } finally { await app.close(); }
});
