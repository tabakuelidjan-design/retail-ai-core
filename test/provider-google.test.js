import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as P from '../src/provider-connections/index.js';
import { resolveChannelCredential } from '../src/activation/credential-provider.js';
import {
  ENV, GBP_LOCATIONS, M1, SECRETS, START, allSecrets, connect, connectorRows, googleRoutes, igRoutes, makeRuntime, sessionRows, ttRoutes,
} from './provider-fixtures.js';

const acode = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected an error'); };
const oauth = async (promise) => { try { await promise; } catch (error) { return error.detail?.oauth ?? error.code; } return assert.fail('expected an error'); };
const google = (over) => makeRuntime({ routes: [...googleRoutes(over), ...igRoutes(), ...ttRoutes()] });
const LOCATION = 'accounts/111/locations/222';
const requests = (ctx, needle) => ctx.http.raw.filter((r) => r.url.includes(needle));

test('Google consent URL: business.manage only, offline access for a refresh token, S256 PKCE', async () => {
  const ctx = google();
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'google_business_profile' });
  const url = new URL(started.authorization_url); // 55, 56
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/business.manage'); // the only scope
  assert.deepEqual([...P.GOOGLE_MINIMUM_SCOPES], ['https://www.googleapis.com/auth/business.manage']);
  assert.deepEqual([url.searchParams.get('response_type'), url.searchParams.get('access_type'), url.searchParams.get('prompt'), url.searchParams.get('client_id')], ['code', 'offline', 'consent', ENV.GOOGLE_CLIENT_ID]);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), sessionRows(ctx)[0].pkce_challenge);
  assert.doesNotMatch(started.authorization_url, new RegExp(`${SECRETS.googleClientSecret}|code_verifier`));
  assert.ok(P.createGoogleBusinessOAuth({ http: () => {} }).descriptor.verified_against.every((u) => u.startsWith('https://developers.google.com/')));
});

test('Google code exchange is server side with the PKCE verifier from the secret store; the verifier is never in the session row', async () => {
  const ctx = google();
  const flow = await connect(ctx, 'google_business_profile');
  const exchange = requests(ctx, 'oauth2.googleapis.com/token')[0]; // 57
  assert.equal(exchange.method, 'POST');
  assert.deepEqual([exchange.form.grant_type, exchange.form.client_id, exchange.form.redirect_uri], ['authorization_code', ENV.GOOGLE_CLIENT_ID, ENV.GOOGLE_REDIRECT_URI]);
  assert.equal(exchange.form.client_secret.reveal(), SECRETS.googleClientSecret);
  const verifier = exchange.form.code_verifier.reveal();
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), sessionRows(ctx)[0].pkce_challenge); // S256(verifier) = the stored challenge
  assert.ok(!JSON.stringify([ctx.db._tables, ctx.logs]).includes(verifier));
  assert.equal(ctx.sessionSecrets._entries.has(`${M1}:${flow.started.session_ref}:PKCE_VERIFIER`), false); // consumed (read and destroyed) by the exchange
  assert.doesNotMatch(JSON.stringify(flow.callback), new RegExp(allSecrets().join('|')));
});

test('Google refreshability is represented: a refresh token makes it refreshable, none means re-consent when the access token ends', async () => {
  const withRefresh = google();
  const a = await connect(withRefresh, 'google_business_profile', { externalId: LOCATION }); // 58
  const meta = await withRefresh.credentialStore.readMetadata({ merchantId: M1, connectorId: a.bound.connector_id });
  assert.deepEqual([meta.refreshable, meta.expires_at], [true, new Date(START + 3599_000).toISOString()]);
  const noRefresh = google({ refresh: false });
  const b = await connect(noRefresh, 'google_business_profile', { externalId: LOCATION });
  const metaB = await noRefresh.credentialStore.readMetadata({ merchantId: M1, connectorId: b.bound.connector_id });
  assert.equal(metaB.refreshable, false);
  noRefresh.clock.t += 3600_000;
  assert.equal(await acode(noRefresh.rt.tokenManager.getValidCredential({ merchantId: M1, connectorId: b.bound.connector_id, provider: 'google_business_profile' })), 'PC_REAUTH_REQUIRED');
  assert.equal(P.decideCredential(meta, START + 3500_000, P.REFRESH_POLICY.google_business_profile), 'REFRESH'); // inside the 5-minute window
  assert.equal(P.decideCredential(meta, START + 60_000, P.REFRESH_POLICY.google_business_profile), 'VALID');
  withRefresh.clock.t += 3500_000;
  const refreshed = await withRefresh.rt.tokenManager.getValidCredential({ merchantId: M1, connectorId: a.bound.connector_id, provider: 'google_business_profile' });
  assert.deepEqual([refreshed.refreshed, refreshed.tokens.refresh_token.reveal(), refreshed.tokens.access_token.reveal()], [true, SECRETS.googleRefresh, SECRETS.googleAccess2]); // the refresh token is kept when Google does not rotate it
});

test('Google discovery lists every account and every location, the merchant picks ONE location, and an account alone is never a target', async () => {
  const ctx = google();
  const flow = await connect(ctx, 'google_business_profile');
  const accounts = new Set(flow.targets.targets.map((t) => t.safe_metadata.account_name)); // 59
  assert.deepEqual([...accounts].sort(), ['accounts/111', 'accounts/444']);
  assert.deepEqual(flow.targets.targets.map((t) => t.external_id).sort(), GBP_LOCATIONS.map((l) => `${l.account}/${l.location}`).sort()); // 60
  assert.ok(flow.targets.targets.every((t) => t.location_name.startsWith('locations/') && t.eligibility.eligible));
  const sessionRef = flow.started.session_ref;
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef })), 'PC_TARGET_REQUIRED'); // 61: the first location is NEVER picked
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef, externalId: 'accounts/111' })), 'PC_TARGET_NOT_FOUND'); // an account is not a publication target
  assert.equal(await acode(ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef, externalId: 'locations/222' })), 'PC_TARGET_NOT_FOUND');
  assert.equal(connectorRows(ctx).length, 0);
  const bound = await ctx.rt.connectionCenter.selectTarget({ tenant: ctx.tenant, sessionRef, externalId: 'accounts/444/locations/555' });
  assert.equal(connectorRows(ctx)[0].external_id, 'accounts/444/locations/555'); // 62: the external_id IS the location resource
  assert.match(connectorRows(ctx)[0].external_id, /^accounts\/[^/]+\/locations\/[^/]+$/);
  assert.equal(connectorRows(ctx)[0].config.location_name, 'locations/555');
  assert.equal(bound.verification.state, 'CONFIGURED');
});

test('Google re-verifies the location before binding and on every check; a removed location or a revoked grant is handled', async () => {
  let locations = GBP_LOCATIONS; let grant = 'ok';
  const routes = [
    { method: 'POST', url: 'oauth2.googleapis.com/token', respond: (r) => (r.form.grant_type === 'refresh_token' ? (grant === 'revoked' ? { status: 400, headers: {}, body: { error: 'invalid_grant' } } : { status: 200, headers: {}, body: { access_token: SECRETS.googleAccess2, expires_in: 3599, scope: P.GOOGLE_MINIMUM_SCOPES[0] } }) : { status: 200, headers: {}, body: { access_token: SECRETS.googleAccess, expires_in: 3599, refresh_token: SECRETS.googleRefresh, scope: P.GOOGLE_MINIMUM_SCOPES[0] } }) },
    { method: 'GET', url: 'mybusinessaccountmanagement.googleapis.com/v1/accounts', respond: () => ({ status: 200, headers: {}, body: { accounts: [...new Set(locations.map((l) => l.account))].map((name) => ({ name })) } }) },
    { method: 'GET', url: 'mybusinessbusinessinformation.googleapis.com/v1/', respond: (r) => ({ status: 200, headers: {}, body: { locations: locations.filter((l) => r.url.includes(`${l.account}/locations`)).map((l) => ({ name: l.location, title: l.title })) } }) },
    { method: 'POST', url: 'oauth2.googleapis.com/revoke', respond: { status: 200, headers: {}, body: {} } },
    ...igRoutes(), ...ttRoutes(),
  ];
  const ctx = makeRuntime({ routes });
  const flow = await connect(ctx, 'google_business_profile', { externalId: LOCATION }); // 63
  const listCalls = requests(ctx, 'mybusinessaccountmanagement').length;
  assert.ok(listCalls >= 3); // discovery, discovery again at bind time (re-verified), verification
  locations = GBP_LOCATIONS.filter((l) => l.location !== 'locations/222'); // the location is removed from the merchant's authorization
  const gone = await ctx.rt.connectionCenter.verify({ tenant: ctx.tenant, connectorId: flow.bound.connector_id });
  assert.deepEqual([gone.state, gone.persist_status, connectorRows(ctx)[0].status], ['MISCONFIGURED', 'MISCONFIGURED', 'MISCONFIGURED']);
  locations = GBP_LOCATIONS;
  grant = 'revoked'; // 65: the merchant revoked the grant at Google
  ctx.clock.t += 3500_000;
  const v = await ctx.rt.connectionCenter.verify({ tenant: ctx.tenant, connectorId: flow.bound.connector_id });
  assert.deepEqual([v.state, v.persist_status, v.view.review_signals.includes('REAUTH_REQUIRED')], ['REAUTH_REQUIRED', null, true]);
  assert.equal((await ctx.credentialStore.readMetadata({ merchantId: M1, connectorId: flow.bound.connector_id })).status, 'EXPIRED');
  const credential = await resolveChannelCredential(ctx.rt.activationCredentialProvider, { merchantId: M1, connectorId: flow.bound.connector_id, provider: 'google_business_profile', purpose: 'PUBLISH', asOf: new Date(ctx.clock.t).toISOString() }).catch((e) => e);
  assert.equal(credential.code, 'CREDENTIAL_EXPIRED'); // Activation sees an expired grant, not a misconfigured connector
});

test('Google scope and the absence of any posting: a missing business.manage grant is refused; no LocalPost is ever created', async () => {
  const ctx = google({ scope: 'openid email' }); // 64
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: ctx.tenant, provider: 'google_business_profile' });
  const state = new URL(started.authorization_url).searchParams.get('state');
  assert.equal(await oauth(ctx.rt.provisioning.handleCallback({ tenant: ctx.tenant, provider: 'google_business_profile', query: { code: SECRETS.code, state } })), 'SCOPE_MISSING');
  assert.equal(connectorRows(ctx).length, 0);
  const good = google();
  const flow = await connect(good, 'google_business_profile', { externalId: LOCATION });
  await good.rt.connectionCenter.verify({ tenant: good.tenant, connectorId: flow.bound.connector_id });
  const disconnected = await good.rt.connectionCenter.disconnect({ tenant: good.tenant, connectorId: flow.bound.connector_id });
  const urls = good.http.raw.map((r) => `${r.method} ${r.url}`); // 66
  assert.doesNotMatch(urls.join('\n'), /localPosts|mybusiness\.googleapis\.com\/v4/);
  assert.deepEqual(urls.filter((u) => u.startsWith('GET')).every((u) => /accounts|locations/.test(u)), true);
  assert.equal(good.http.raw.filter((r) => r.method === 'POST').every((r) => /oauth2\.googleapis\.com/.test(r.url)), true);
  assert.equal(disconnected.remote_revoked, true);
  assert.equal(requests(good, 'oauth2.googleapis.com/revoke')[0].form.token.reveal(), SECRETS.googleRefresh);
});
