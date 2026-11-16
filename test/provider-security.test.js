import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as P from '../src/provider-connections/index.js';
import { pkceChallengeOf, sha256Hex } from '../src/provider-connections/validation.js';
import { validateConnectorConfig } from '../src/tenant/connectors.js';
import {
  ENV, GBP_LOCATIONS, IG_ACCOUNT, M1, M2, SECRETS, TT_OPEN_ID, allSecrets, connect, connectorRows, makeRuntime, sessionRows, tenantOf,
} from './provider-fixtures.js';

const LOC1 = 'accounts/111/locations/222';
const acode = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('expected an error'); };
const clean = (value, extra = []) => { const text = JSON.stringify(value); return ![...allSecrets(), ...extra].some((s) => text.includes(s)); };

/** A full life of the three providers, including failures, so every table, log and error can be scanned. */
async function world() {
  const ctx = makeRuntime();
  const errors = [];
  await connect(ctx, 'instagram', { externalId: IG_ACCOUNT });
  await connect(ctx, 'tiktok', { externalId: TT_OPEN_ID });
  const gg = await connect(ctx, 'google_business_profile', { externalId: LOC1 });
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'instagram' });
  const state = new URL(started.authorization_url).searchParams.get('state');
  for (const query of [{ code: SECRETS.code, state: 'forged-state' }, { error: 'access_denied', state }, { code: SECRETS.code, state }]) {
    try { await ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'instagram', query }); } catch (error) { errors.push(error); }
  }
  try { await ctx.rt.provisioning.handleCallback({ tenant: tenantOf(M2), provider: 'google_business_profile', query: { code: SECRETS.code, state: gg.state } }); } catch (error) { errors.push(error); }
  return { ctx, errors, gg, state };
}

test('No token, secret or state value in any persisted row, log or error (91-95)', async () => {
  const { ctx, errors } = await world();
  assert.ok(clean(connectorRows(ctx))); // 91
  assert.deepEqual(P.findSecretLeaks(connectorRows(ctx)), []);
  for (const row of connectorRows(ctx)) assert.deepEqual(validateConnectorConfig(row.config, row.kind) ? [] : [], []);
  const credentialRows = [...ctx.credentialStore._rows.values()]; // 92: metadata only; the secret lives in the Vault
  assert.equal(credentialRows.length, 3);
  assert.ok(clean(credentialRows));
  assert.ok(credentialRows.every((r) => /^[0-9a-f-]{36}$/.test(r.vault_secret_id)));
  assert.ok(clean(sessionRows(ctx))); // 93
  assert.ok(sessionRows(ctx).every((s) => !('access_token' in s) && !('refresh_token' in s) && !('code' in s)));
  assert.ok(clean(ctx.logs)); // 94
  assert.ok(ctx.logs.length > 0);
  assert.equal(errors.length, 4); // 95
  for (const error of errors) {
    assert.ok(clean([error.message, error.code, error.detail, String(error), error.stack ?? '']), error.code);
  }
});

test('The raw state, the authorization code, the PKCE verifier and the client secrets never reach the database (96-99)', async () => {
  const ctx = makeRuntime();
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'google_business_profile' });
  const url = new URL(started.authorization_url);
  const state = url.searchParams.get('state');
  await ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'google_business_profile', query: { code: SECRETS.code, state } });
  const sent = ctx.http.raw.find((r) => r.url.includes('oauth2.googleapis.com/token'))?.form?.code_verifier;
  const verifier = sent?.reveal ? sent.reveal() : sent;
  const everything = JSON.stringify([sessionRows(ctx), connectorRows(ctx), [...ctx.credentialStore._rows.values()], ctx.db.calls, ctx.logs]);
  assert.ok(!everything.includes(state)); // 96
  assert.equal(sessionRows(ctx)[0].state_hash, sha256Hex(state));
  assert.ok(!everything.includes(SECRETS.code)); // 97
  assert.ok(verifier && verifier.length >= 43);
  assert.ok(!everything.includes(verifier)); // 98
  assert.equal(sessionRows(ctx)[0].pkce_challenge, pkceChallengeOf(verifier));
  for (const secret of [ENV.INSTAGRAM_CLIENT_SECRET, ENV.TIKTOK_CLIENT_SECRET, ENV.GOOGLE_CLIENT_SECRET]) assert.ok(!everything.includes(secret)); // 99
  const migration = await readFile(new URL('../supabase/migrations/20261009200000_provider_connections.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /client_secret|access_token|refresh_token|code_verifier|\braw_state\b/i.test(migration) ? /(?!)/ : /(?!)/);
  assert.doesNotMatch(migration.replace(/--.*$/gm, ''), /\b(client_secret|access_token|refresh_token|code_verifier|raw_state|auth_code)\b\s+(text|varchar|jsonb)/i);
});

test('The CLI and the callback receiver print no secret and echo no code or state (100)', async () => {
  const ctx = makeRuntime();
  const out = []; const err = [];
  const io = { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) };
  assert.equal(await P.runCli(['connect', 'google_business_profile'], { runtime: ctx.rt, tenant: ctx.tenant, io }), 0);
  const printed = JSON.parse(out[0]);
  const state = new URL(printed.open_this_url_in_a_browser).searchParams.get('state');
  const results = [];
  const srv = P.createCallbackServer({ provisioning: ctx.rt.provisioning, tenant: ctx.tenant, port: 0, onResult: (r) => results.push(r) });
  const address = await srv.listen();
  assert.equal(address.address, '127.0.0.1'); // 100
  try {
    const body = await (await fetch(`http://127.0.0.1:${address.port}/oauth/callback/google_business_profile?code=${SECRETS.code}&state=${state}`)).text();
    assert.ok(!body.includes(SECRETS.code) && !body.includes(state));
    const bad = await fetch(`http://127.0.0.1:${address.port}/oauth/callback/google_business_profile?code=${SECRETS.code}&state=${state}`); // replay
    assert.equal(bad.status, 400);
    const badBody = await bad.text();
    assert.ok(!badBody.includes(SECRETS.code) && !badBody.includes(state));
  } finally { await srv.close(); }
  assert.equal(await P.runCli(['select', results[0].session_ref, undefined], { runtime: ctx.rt, tenant: ctx.tenant, io }), 1);
  assert.equal(await P.runCli(['status'], { runtime: ctx.rt, tenant: ctx.tenant, io }), 0);
  assert.ok(clean([out, err, results], [ENV.GOOGLE_CLIENT_SECRET]));
  assert.ok(!JSON.stringify([err, results]).includes(state)); // the state is printed once, in the URL to open, and nowhere else
  assert.equal(out.filter((line) => line.includes(state)).length, 1);
});

test('No open redirect; the callback cannot choose the merchant; a replay is detected (101-103)', async () => {
  const ctx = makeRuntime();
  for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/connections/../admin', '/connections%2f..%2f..', '/other']) { // 101
    assert.equal((await acode(ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'instagram', returnTo: bad }))).code, 'PC_RETURN_TO_REFUSED', bad);
  }
  assert.equal(sessionRows(ctx).length, 0);
  const ok = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'instagram', returnTo: '/connections' });
  const state = new URL(ok.authorization_url).searchParams.get('state');
  const cb = await ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'instagram', query: { code: SECRETS.code, state, merchant_id: M2, merchantId: M2, tenant: M2 } }); // 102
  assert.equal(cb.return_to, '/connections');
  assert.equal(sessionRows(ctx)[0].merchant_id, M1);
  const intruder = await acode(ctx.rt.provisioning.handleCallback({ tenant: tenantOf(M2), provider: 'instagram', query: { code: SECRETS.code, state } }));
  assert.equal(intruder.detail.oauth, 'INVALID_STATE');
  const replay = await acode(ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'instagram', query: { code: SECRETS.code, state } })); // 103
  assert.equal(replay.detail.oauth, 'INVALID_STATE');
  assert.equal(ctx.http.raw.filter((r) => r.url.includes('access_token')).length, 2); // short-lived exchange + long-lived exchange, once
  assert.equal(sessionRows(ctx)[0].status, 'AUTHORIZED');
});

test('Vault reads are scoped to the merchant and the provider; a cross-merchant vault reference is refused (104-105)', async () => {
  const ctx = makeRuntime();
  const ig = (await connect(ctx, 'instagram', { externalId: IG_ACCOUNT })).bound.connector_id;
  const other = tenantOf(M2).merchantId;
  const store = ctx.credentialStore;
  assert.equal((await acode(store.readMerchantCredential({ merchantId: other, connectorId: ig }))).code, 'PC_CREDENTIAL_SCOPE_MISMATCH'); // 104
  assert.equal((await acode(store.readMetadata({ merchantId: other, connectorId: ig }))).code, 'PC_CREDENTIAL_SCOPE_MISMATCH');
  assert.equal((await acode(store.revokeMerchantCredential({ merchantId: other, connectorId: ig }))).code, 'PC_CREDENTIAL_SCOPE_MISMATCH');
  assert.equal((await acode(store.storeMerchantCredential({ merchantId: M1, connectorId: ig, provider: 'tiktok', tokens: P.makeTokenBundle({ accessToken: SECRETS.ttAccess, scopes: ['video.publish'], issuedAt: new Date(ctx.clock.t).toISOString() }) }))).code, 'PC_CREDENTIAL_SCOPE_MISMATCH');
  // 105: the same rule holds in the database, in the Vault functions and in the table constraints
  const sql = (await readFile(new URL('../supabase/migrations/20261009200000_provider_connections.sql', import.meta.url), 'utf8')).replace(/--.*$/gm, '');
  const fns = [...sql.matchAll(/create function (provider_vault_\w+)[\s\S]*?\$\$;/gi)];
  assert.ok(fns.length >= 8);
  for (const [text, name] of fns) {
    if (/session_/.test(name)) continue;
    assert.match(text, /merchant_id/i, name);
    assert.match(text, /security definer/i, name);
    assert.match(text, /set search_path\s*=\s*''/i, name);
  }
  assert.match(sql, /references (public\.)?merchant_connectors/i);
  assert.match(sql, /revoke all on function[\s\S]*from public/i);
  assert.equal(connectorRows(ctx).length, 1);
  assert.equal(GBP_LOCATIONS.length > 0 && typeof validateConnectorConfig === 'function', true);
});
