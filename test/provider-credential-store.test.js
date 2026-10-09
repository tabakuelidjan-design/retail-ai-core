import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import * as P from '../src/provider-connections/index.js';
import { resolveChannelCredential } from '../src/activation/credential-provider.js';
import { findSecretPaths } from '../src/tenant/connectors.js';
import {
  IG_ACCOUNT, M1, M2, SECRETS, START, allSecrets, connect, connectorRows, makeBundle, makeRuntime, tenantOf,
} from './provider-fixtures.js';

const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const MIGRATION = (await readFile(new URL('../supabase/migrations/20261009200000_provider_connections.sql', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
const SQL = MIGRATION.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const tableColumns = (name) => {
  const body = new RegExp(`create table ${name} \\(([\\s\\S]*?)\\n\\);`).exec(SQL)[1];
  return body.split('\n').map((l) => /^\s{2}([a-z_]+)\s/.exec(l)?.[1]).filter((c) => c && !['constraint'].includes(c));
};
const SECRET_COLUMN = /(access|refresh)_?token|^secret$|password|client_secret|authorization_code|^code$|code_verifier|pkce_verifier|raw_state|^state$/;

async function bound(provider = 'instagram', externalId = IG_ACCOUNT, over) {
  const ctx = makeRuntime(over);
  const result = await connect(ctx, provider, { externalId });
  return { ctx, connectorId: result.bound.connector_id, result };
}

test('Credential store schema: no plaintext secret column, the Vault id is metadata, reads are sealed, connector config is secret-free', async () => {
  const columns = [...tableColumns('connector_credentials'), ...tableColumns('provider_oauth_sessions')]; // 1
  assert.ok(columns.includes('vault_secret_id') && columns.includes('state_hash') && columns.length > 20);
  assert.deepEqual(columns.filter((c) => SECRET_COLUMN.test(c)), []);
  const { ctx, connectorId } = await bound();
  const metadata = await ctx.credentialStore.readMetadata({ merchantId: M1, connectorId }); // 2
  assert.match(metadata.vault_secret_id, /^[0-9a-f]{8}-/);
  assert.deepEqual(Object.keys(metadata).filter((k) => SECRET_COLUMN.test(k)), []);
  assert.ok(!allSecrets().some((s) => JSON.stringify(metadata).includes(s)));
  assert.equal(JSON.stringify(Object.keys(ctx.credentialStore._rows.get(connectorId))).includes('token'), false);
  const read = await ctx.credentialStore.readMerchantCredential({ merchantId: M1, connectorId }); // 3
  assert.ok(read.tokens.access_token instanceof P.SealedSecret);
  assert.equal(JSON.stringify(read.tokens), JSON.stringify(JSON.parse(JSON.stringify(read.tokens))));
  assert.doesNotMatch(JSON.stringify(read), new RegExp(SECRETS.igLong));
  assert.equal(String(read.tokens.access_token), '[REDACTED]');
  assert.equal(read.tokens.access_token.reveal(), SECRETS.igLong);
  const config = connectorRows(ctx)[0].config; // 4
  assert.deepEqual(findSecretPaths(config), []);
  assert.deepEqual(P.findSecretLeaks(connectorRows(ctx)), []);
  assert.ok(!allSecrets().some((s) => JSON.stringify(config).includes(s)));
  assert.deepEqual(Object.keys(config).sort(), ['account_state', 'display_name', 'granted_scopes', 'last_verified_at', 'provisioned_via']);
});

test('Credential lifecycle: rotation is versioned, revocation destroys the secret, expiry forces re-consent', async () => {
  const { ctx, connectorId } = await bound();
  const before = ctx.credentialStore._rows.get(connectorId);
  const rotated = await ctx.credentialStore.updateMerchantCredential({ merchantId: M1, connectorId, tokens: makeBundle({ accessToken: SECRETS.igLong2 }), expectedVersion: before.rotation_version }); // 5
  assert.deepEqual([rotated.rotation_version, rotated.connector_id, rotated.vault_secret_id], [before.rotation_version + 1, connectorId, before.vault_secret_id]); // identity unchanged
  assert.equal((await ctx.credentialStore.readMerchantCredential({ merchantId: M1, connectorId })).tokens.access_token.reveal(), SECRETS.igLong2);
  assert.equal(await ctx.credentialStore.updateMerchantCredential({ merchantId: M1, connectorId, tokens: makeBundle(), expectedVersion: before.rotation_version }), null); // a stale writer loses
  const revoked = await ctx.credentialStore.revokeMerchantCredential({ merchantId: M1, connectorId }); // 6
  assert.equal(revoked.status, 'REVOKED');
  assert.ok(revoked.revoked_at);
  assert.equal(ctx.credentialStore._secrets.size, 0); // the secret is destroyed, the metadata stays as history
  assert.equal((await ctx.credentialStore.readMerchantCredential({ merchantId: M1, connectorId })).tokens, null);
  assert.equal(await acode(ctx.rt.tokenManager.getValidCredential({ merchantId: M1, connectorId, provider: 'instagram' })), 'PC_CREDENTIAL_REVOKED');
  const fresh = await bound();
  await fresh.ctx.credentialStore.markExpired({ merchantId: M1, connectorId: fresh.connectorId }); // 7
  assert.equal((await fresh.ctx.credentialStore.readMetadata({ merchantId: M1, connectorId: fresh.connectorId })).status, 'EXPIRED');
  assert.equal(P.decideCredential(await fresh.ctx.credentialStore.readMetadata({ merchantId: M1, connectorId: fresh.connectorId }), START, P.REFRESH_POLICY.instagram), 'REAUTH');
  assert.equal(await acode(fresh.ctx.rt.tokenManager.getValidCredential({ merchantId: M1, connectorId: fresh.connectorId, provider: 'instagram' })), 'PC_REAUTH_REQUIRED');
});

test('No credential value is ever logged: access token, refresh token, client secret, authorization code', async () => {
  const ig = await bound();
  const tt = await bound('tiktok', 'tiktok-open-id-1');
  const gg = await bound('google_business_profile', 'accounts/111/locations/222');
  for (const { ctx, connectorId, provider } of [{ ...ig, provider: 'instagram' }, { ...tt, provider: 'tiktok' }, { ...gg, provider: 'google_business_profile' }]) {
    await ctx.rt.tokenManager.forceRefresh({ merchantId: M1, connectorId, provider });
    await ctx.rt.provisioning.disconnectConnection({ tenant: tenantOf(M1), connectorId });
  }
  for (const { ctx } of [ig, tt, gg]) {
    const output = JSON.stringify([ctx.logs, ctx.db.calls.map((c) => c.args ?? c.keys)]);
    const accessTokens = [SECRETS.igShort, SECRETS.igLong, SECRETS.igLong2, SECRETS.ttAccess, SECRETS.ttAccess2, SECRETS.googleAccess, SECRETS.googleAccess2];
    const refreshTokens = [SECRETS.ttRefresh, SECRETS.ttRefresh2, SECRETS.googleRefresh];
    const clientSecrets = [SECRETS.igClientSecret, SECRETS.ttClientSecret, SECRETS.googleClientSecret];
    for (const value of accessTokens) assert.ok(!output.includes(value), 'access token'); // 8
    for (const value of refreshTokens) assert.ok(!output.includes(value), 'refresh token'); // 9
    for (const value of clientSecrets) assert.ok(!output.includes(value), 'client secret'); // 10
    assert.ok(!output.includes(SECRETS.code));
    assert.ok(ctx.logs.length > 0 && ctx.logs.every((line) => typeof line.event === 'string'));
  }
});

test('Credential isolation: another merchant or another provider can never read, write or rotate a connector credential', async () => {
  const { ctx, connectorId } = await bound();
  const tokens = makeBundle();
  assert.equal(await acode(ctx.credentialStore.storeMerchantCredential({ merchantId: M2, connectorId, provider: 'instagram', tokens })), 'PC_CREDENTIAL_SCOPE_MISMATCH'); // 11
  assert.equal(await acode(ctx.credentialStore.readMerchantCredential({ merchantId: M2, connectorId })), 'PC_CREDENTIAL_SCOPE_MISMATCH');
  assert.equal(await acode(ctx.credentialStore.revokeMerchantCredential({ merchantId: M2, connectorId })), 'PC_CREDENTIAL_SCOPE_MISMATCH');
  assert.equal(await acode(ctx.rt.provisioning.disconnectConnection({ tenant: tenantOf(M2), connectorId })), 'PC_CONNECTOR_NOT_FOUND');
  const other = makeRuntime();
  const second = await connect(other, 'tiktok', { externalId: 'tiktok-open-id-1' });
  await other.credentialStore.revokeMerchantCredential({ merchantId: M1, connectorId: second.bound.connector_id });
  assert.equal(await acode(other.credentialStore.storeMerchantCredential({ merchantId: M1, connectorId: second.bound.connector_id, provider: 'instagram', tokens })), 'PC_CREDENTIAL_SCOPE_MISMATCH'); // 12: a TikTok connector never carries an Instagram credential
  assert.equal(await acode(ctx.credentialStore.storeMerchantCredential({ merchantId: M1, connectorId, provider: 'instagram', tokens })), 'PC_SESSION_STATE_CONFLICT'); // already has one: rotate instead
});

test('Stores: the fake is only a fake, the Vault adapter speaks to the narrow functions only and fails closed, Activation can use the store', async () => {
  const { ctx, connectorId } = await bound();
  assert.equal(ctx.credentialStore.kind, 'in-memory-fake'); // 13
  const calls = [];
  const rpcOnly = { rpc: async (fn, args) => { calls.push({ fn, args }); return fn === 'provider_vault_metadata' ? null : { id: 'c1', merchant_id: M1, connector_id: connectorId, provider: 'instagram', vault_secret_id: '00000000-0000-4000-8000-000000000001', credential_kind: 'OAUTH_TOKENS', status: 'ACTIVE', scopes: [], rotation_version: 1, created_at: 'x', updated_at: 'x' }; } };
  const vault = P.createVaultCredentialStore({ supabase: rpcOnly });
  assert.equal(vault.kind, 'supabase-vault');
  await vault.storeMerchantCredential({ merchantId: M1, connectorId, provider: 'instagram', tokens: makeBundle() });
  await vault.readMetadata({ merchantId: M1, connectorId });
  assert.ok(calls.every((c) => c.fn.startsWith('provider_vault_'))); // only the narrow SECURITY DEFINER functions: no table, no vault.* access
  assert.ok(String(calls[0].args.p_secret).includes(SECRETS.igLong)); // the secret travels to the Vault function (TLS), and nowhere else
  const broken = P.createVaultCredentialStore({ supabase: { rpc: async () => { throw new Error(`leaked ${SECRETS.igLong}`); } } });
  const failure = await broken.storeMerchantCredential({ merchantId: M1, connectorId, provider: 'instagram', tokens: makeBundle() }).catch((e) => e);
  assert.equal(failure.code, 'PC_VAULT_UNAVAILABLE'); // fail closed: nothing else is written, and the message does not echo the cause
  assert.doesNotMatch(JSON.stringify([failure.message, failure.detail]), new RegExp(SECRETS.igLong));
  const down = makeRuntime({ vaultDown: true });
  assert.equal(await acode(down.rt.provisioning.startConnection({ tenant: down.tenant, provider: 'google_business_profile' })), 'PC_VAULT_UNAVAILABLE'); // PKCE verifier cannot be stored: no fallback
  assert.equal(down.db._tables.provider_oauth_sessions.length, 1);
  const resolved = await resolveChannelCredential(ctx.rt.activationCredentialProvider, { merchantId: M1, connectorId, provider: 'instagram', purpose: 'PUBLISH', asOf: new Date(START).toISOString() }).catch((e) => e); // 14
  assert.ok(resolved.access_token instanceof P.SealedSecret);
  assert.deepEqual([...resolved.granted_scopes], ['instagram_business_basic', 'instagram_business_content_publish']);
});

test('The Vault is reachable only through the service role: no front-end code reads vault secrets, the functions are revoked from anon and authenticated', async () => {
  const walk = async (dir) => (await readdir(dir, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [e.name]));
  for (const dir of ['../src/provider-connections/', '../src/provider-connections/providers/', '../src/activation/']) {
    for (const file of await walk(new URL(dir, import.meta.url))) {
      const text = await readFile(new URL(`${dir}${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(text.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n'), /decrypted_secrets|vault\.secrets|pgsodium/, file); // 15
    }
  }
  const bodies = [...SQL.matchAll(/create function (provider_\w+)\([\s\S]*?\nend \$\$;/g)].filter((m) => m[1] !== 'provider_oauth_sessions_guard'); // the Vault access functions, not the trigger
  assert.ok(bodies.length >= 12);
  assert.equal([...SQL.matchAll(/decrypted_secrets/g)].length, bodies.filter((m) => m[0].includes('decrypted_secrets')).length); // only inside the function bodies
  for (const [, name] of bodies) assert.ok(SQL.includes('security definer'), name);
  assert.equal([...SQL.matchAll(/security definer set search_path = ''/g)].length, bodies.length); // fixed search_path on every function
  assert.match(SQL, /revoke all on function %s from public/);
  assert.match(SQL, /array\['anon', 'authenticated'\]/);
  assert.match(SQL, /grant execute on function %s to service_role/);
  assert.doesNotMatch(SQL, /pgsodium/);
  assert.match(MIGRATION, /enable row level security/);
  assert.equal(M2.length, 36);
});
