import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import * as A from '../src/activation/index.js';
import * as P from '../src/provider-connections/index.js';
import * as CF from './channel-fixtures.js';
import {
  IG_ACCOUNT, M1, SECRETS, START, igRoutes, googleRoutes, makeBundle, makeRuntime, ttRoutes,
} from './provider-fixtures.js';

const W = CF.world();
const GBP_SCOPE = P.GOOGLE_MINIMUM_SCOPES[0];

/** The provider runtime knows the Activation fixtures' connectors (same merchant, same ids), with real credentials in the (fake) Vault. */
async function setup({ ig = {}, gbp = {}, routes } = {}) {
  const ctx = makeRuntime({ routes });
  for (const c of CF.CONNECTORS()) {
    ctx.db._tables.merchant_connectors.push({ id: c.id, merchant_id: c.merchantId, kind: c.kind, external_id: c.externalId, status: 'CONFIGURED', config: c.config, created_at: 'x', updated_at: 'x' });
  }
  const now = new Date(START);
  const bundle = (over) => makeBundle({ issuedAt: new Date(START - 10 * 86_400_000).toISOString(), ...over });
  if (ig !== null) await ctx.credentialStore.storeMerchantCredential({ merchantId: M1, connectorId: CF.IDS.IG, provider: 'instagram', tokens: bundle({ accessToken: SECRETS.igLong, scopes: ['instagram_business_basic', 'instagram_business_content_publish'], expiresAt: new Date(now.getTime() + 40 * 86_400_000).toISOString(), refreshable: true, ...ig }) });
  if (gbp !== null) await ctx.credentialStore.storeMerchantCredential({ merchantId: M1, connectorId: CF.IDS.GBP, provider: 'google_business_profile', tokens: bundle({ accessToken: SECRETS.googleAccess, refreshToken: SECRETS.googleRefresh, scopes: [GBP_SCOPE], expiresAt: new Date(now.getTime() + 3_000_000).toISOString(), ...gbp }) });
  return ctx;
}
const preflight = (ctx, over = {}, svcOver = {}) => {
  const svc = CF.services(W, { credentials: ctx.rt.activationCredentialProvider, ...svcOver });
  return A.evaluateChannelExecutionPreflight(CF.preflightInput(W, CF.orderOf(W), svc, over)).then((r) => ({ r, svc }));
};

test('The production credential resolver satisfies Activation: READY with real credentials, scopes and external_id flowing through', async () => {
  const ctx = await setup();
  const { r, svc } = await preflight(ctx); // 81
  assert.equal(r.status, 'READY');
  assert.equal(svc.http.raw.find((x) => x.url.endsWith('/me')).query.access_token.reveal(), SECRETS.igLong); // the Vault credential reached the provider call
  const narrow = await setup({ ig: { scopes: ['instagram_business_basic'] } }); // 82: the scopes of the stored credential decide the preflight
  const n = (await preflight(narrow)).r;
  assert.ok(n.deliveries.find((d) => d.provider === 'instagram').reason_codes.includes('SCOPE_MISSING'));
  const mismatch = await setup({ routes: [...igRoutes(), ...ttRoutes(), ...googleRoutes()] }); // 83: the connector's external_id is the account the provider must confirm
  const svc2 = CF.services(W, { credentials: mismatch.rt.activationCredentialProvider, routes: [...CF.igRoutes({ userId: '99999' }), ...CF.gbpRoutes(), ...CF.ttRoutes()] });
  const wrong = await A.evaluateChannelExecutionPreflight(CF.preflightInput(W, CF.orderOf(W), svc2));
  assert.deepEqual(wrong.deliveries.find((d) => d.provider === 'instagram').reason_codes, ['ACCOUNT_MISMATCH']);
  assert.equal(CF.CONNECTORS()[0].externalId, '17841400000000001');
  assert.equal(IG_ACCOUNT, CF.CONNECTORS()[0].externalId);
});

test('Activation keeps working with its own connection view and health check on the production credentials', async () => {
  const ctx = await setup();
  const connector = A.normalizeChannelConnector(CF.CONNECTORS()[0], { merchantId: M1 });
  const view = A.buildChannelConnectionView({ connector }); // 84: the Activation view, untouched
  const center = (await ctx.rt.connectionCenter.listConnections({ tenant: ctx.tenant })).find((c) => c.connector_id === CF.IDS.IG);
  for (const key of Object.keys(view)) assert.ok(key in center, key); // the Connection Center view extends it, it does not replace it
  const svc = CF.services(W, { credentials: ctx.rt.activationCredentialProvider });
  const health = await A.verifyChannelConnection({ connector: CF.CONNECTORS()[0], adapter: svc.adapters.instagram, credentialProvider: ctx.rt.activationCredentialProvider, asOf: CF.NOW });
  assert.deepEqual([health.status, health.persist_status], ['CONFIGURED', 'CONFIGURED']);
  assert.doesNotMatch(JSON.stringify([view, center, health]), new RegExp(`${SECRETS.igLong}|${SECRETS.googleAccess}|${SECRETS.googleRefresh}`));
});

test('An expiring token is refreshed before Activation uses it; a refresh failure or a revoked connector blocks safely, without any provider call', async () => {
  const expiring = await setup({ ig: { expiresAt: new Date(START + 2 * 86_400_000).toISOString() } }); // 85: inside Instagram's 7-day refresh window, older than 24 h
  const { r, svc } = await preflight(expiring);
  assert.equal(r.status, 'READY');
  const used = svc.http.raw.find((x) => x.url.endsWith('/me')).query.access_token.reveal();
  assert.equal(used, SECRETS.igLong2); // the NEW token was used
  assert.equal(expiring.http.raw.filter((x) => x.url.includes('refresh_access_token')).length, 1);
  assert.equal((await expiring.credentialStore.readMetadata({ merchantId: M1, connectorId: CF.IDS.IG })).rotation_version, 2);
  const broken = await setup({ gbp: { expiresAt: new Date(START - 60_000).toISOString() }, routes: [{ method: 'POST', url: 'oauth2.googleapis.com/token', respond: { status: 400, headers: {}, body: { error: 'invalid_grant' } } }, ...igRoutes(), ...ttRoutes(), ...googleRoutes()] }); // 86
  const failed = await preflight(broken);
  assert.equal(failed.r.status, 'BLOCKED');
  assert.ok(failed.r.deliveries.find((d) => d.provider === 'google_business_profile').reason_codes.includes('CREDENTIAL_EXPIRED'));
  assert.equal(failed.svc.http.raw.filter((x) => x.url.includes('localPosts')).length, 0);
  assert.equal((await broken.credentialStore.readMetadata({ merchantId: M1, connectorId: CF.IDS.GBP })).status, 'EXPIRED');
  const revoked = await setup(); // 87
  await revoked.rt.provisioning.disconnectConnection({ tenant: revoked.tenant, connectorId: CF.IDS.IG });
  const blocked = await preflight(revoked);
  assert.equal(blocked.r.status, 'BLOCKED');
  assert.ok(blocked.r.deliveries.find((d) => d.provider === 'instagram').reason_codes.includes('CREDENTIAL_MISSING') || blocked.r.deliveries.find((d) => d.provider === 'instagram').reason_codes.includes('CONNECTOR_NOT_CONFIGURED') || blocked.r.deliveries.find((d) => d.provider === 'instagram').reason_codes.includes('CREDENTIAL_NOT_FOUND'));
  const outage = await setup(); // a Vault outage is UNAVAILABLE (temporary), not a misconfiguration
  outage.credentialStore.readMerchantCredential = async () => { throw new P.ProvisioningError(P.PC_ERROR.VAULT_UNAVAILABLE, 'down'); };
  const temp = await preflight(outage);
  assert.equal(temp.r.deliveries.find((d) => d.provider === 'instagram').status, 'UNAVAILABLE');
});

test('Activation and Marketing are untouched: neither imports Provider Provisioning, the credential interface is the existing one', async () => {
  const sources = async (dir) => {
    const out = [];
    const walk = async (d) => { for (const e of await readdir(new URL(d, import.meta.url), { withFileTypes: true })) { if (e.isDirectory()) await walk(`${d}${e.name}/`); else out.push(`${d}${e.name}`); } };
    await walk(dir);
    return out;
  };
  for (const file of [...await sources('../src/activation/'), ...await sources('../src/marketing/')]) { // 88, 90
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), /provider-connections|provider_connections|connector_credentials/, file);
  }
  assert.deepEqual(Object.keys(P.createActivationCredentialProvider({ tokenManager: {} })).sort(), ['kind', 'resolve']);
  assert.equal(typeof A.createInMemoryCredentialProvider({}).resolve, 'function'); // the same `resolve({ merchant_id, connector_id, provider, purpose })` contract
  // 89: the Activation test suites are executed, unchanged, by the dedicated workflow
});
