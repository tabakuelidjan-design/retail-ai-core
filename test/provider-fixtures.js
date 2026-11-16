// Shared fixtures for the Provider Provisioning tests. Synthetic data only: NO real credential, NO network - a fake OAuth/provider HTTP,
// a fake Vault (in-memory stores), a controllable clock and a strict in-memory Supabase that applies the same rules as the migration.
// A fake Vault is NOT proof of the production Vault: that is checked on a real Supabase Postgres by test/postgres/provider-connections.pg-smoke.mjs.
import { randomUUID } from 'node:crypto';

import { createConnectorRepository } from '../src/tenant/connectors.js';
import {
  createInMemoryCredentialStore, createInMemorySessionSecretStore, createProviderConnectionsRuntime, makeTokenBundle,
} from '../src/provider-connections/index.js';
import { createFakeHttp } from './channel-fixtures.js';

export const M1 = '11111111-1111-4111-8111-111111111111';
export const M2 = '22222222-2222-4222-8222-222222222222';
export const tenantOf = (merchantId = M1) => ({ merchantId, source: 'env' });
export const START = Date.parse('2026-10-13T09:00:00Z');

// synthetic secrets: unmistakable values the tests grep for in every output
export const SECRETS = {
  igClientSecret: 'IG-CLIENT-SECRET-VALUE-0001',
  ttClientSecret: 'TT-CLIENT-SECRET-VALUE-0002',
  googleClientSecret: 'GOOGLE-CLIENT-SECRET-VALUE-0003',
  igShort: 'IGshortlivedtoken0001abcdef',
  igLong: 'IGlonglivedtoken0001abcdef',
  igLong2: 'IGlonglivedtoken0002abcdef',
  ttAccess: 'act.tt-access-token-0001-abcdef',
  ttRefresh: 'rft.tt-refresh-token-0001-abcdef',
  ttAccess2: 'act.tt-access-token-0002-abcdef',
  ttRefresh2: 'rft.tt-refresh-token-0002-abcdef',
  googleAccess: 'ya29.google-access-token-0001-abcdef',
  googleRefresh: '1//google-refresh-token-0001-abcdef',
  googleAccess2: 'ya29.google-access-token-0002-abcdef',
  code: 'AUTH-CODE-VALUE-0001-abcdef',
};
export const allSecrets = () => Object.values(SECRETS);

export const ENV = {
  INSTAGRAM_CLIENT_ID: 'ig-app-id-1', INSTAGRAM_CLIENT_SECRET: SECRETS.igClientSecret, INSTAGRAM_REDIRECT_URI: 'https://nordla.example.test/oauth/callback/instagram', INSTAGRAM_GRAPH_API_VERSION: 'v25.0',
  TIKTOK_CLIENT_KEY: 'tt-client-key-1', TIKTOK_CLIENT_SECRET: SECRETS.ttClientSecret, TIKTOK_REDIRECT_URI: 'https://nordla.example.test/oauth/callback/tiktok',
  GOOGLE_CLIENT_ID: 'google-client-1.apps.example.test', GOOGLE_CLIENT_SECRET: SECRETS.googleClientSecret, GOOGLE_REDIRECT_URI: 'https://nordla.example.test/oauth/callback/google_business_profile',
};

// ------------------------------------------------------------------ strict in-memory Supabase
export function createProvisioningDb({ merchants = [M1, M2] } = {}) {
  const tables = { merchants: merchants.map((id) => ({ id, name: `Synthetic ${id.slice(0, 4)}`, vertical: 'general_retail', source_system: 'manual', source_id: id })), merchant_connectors: [], provider_oauth_sessions: [] };
  const calls = [];
  const conflict = (what) => new Error(`Supabase REST HTTP 409: {"code":"23505","message":"${what}"}`);
  const match = (row, params) => Object.entries(params).every(([key, value]) => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return true;
    const eq = /^eq\.(.*)$/.exec(value);
    if (eq) return String(row[key] ?? '') === eq[1];
    const list = /^in\.\((.*)\)$/.exec(value);
    if (list) return list[1].split(',').includes(String(row[key]));
    const lt = /^lt\.(.*)$/.exec(value);
    if (lt) return String(row[key] ?? '') < lt[1];
    return true;
  });
  const api = {
    _tables: tables,
    calls,
    async select(table, params = {}) {
      calls.push({ m: 'select', table });
      let rows = (tables[table] ?? []).filter((r) => match(r, params)).map((r) => ({ ...r }));
      if (params.order) rows.sort((a, b) => (String(a.created_at) > String(b.created_at) ? 1 : -1));
      if (params.limit) rows = rows.slice(0, Number(params.limit));
      return rows;
    },
    async insert(table, newRows) {
      calls.push({ m: 'insert', table });
      const out = [];
      for (const r of newRows) {
        if (table === 'merchant_connectors') {
          if (!tables.merchants.some((m) => m.id === r.merchant_id)) throw conflict('merchant fk');
          if (r.external_id != null && tables.merchant_connectors.some((c) => c.kind === r.kind && c.external_id === r.external_id)) throw conflict('merchant_connectors_kind_external_uq');
          const row = { id: randomUUID(), status: 'NOT_CONFIGURED', config: {}, external_domain: null, created_at: new Date(START).toISOString(), updated_at: new Date(START).toISOString(), ...r };
          tables.merchant_connectors.push(row); out.push({ ...row });
        } else if (table === 'provider_oauth_sessions') {
          if (!tables.merchants.some((m) => m.id === r.merchant_id)) throw conflict('merchant fk');
          if (tables.provider_oauth_sessions.some((s) => s.state_hash === r.state_hash)) throw conflict('state_hash unique');
          const row = { id: randomUUID(), status: 'PENDING', authorized_at: null, completed_at: null, bound_connector_id: null, failure_code: null, ...r };
          tables.provider_oauth_sessions.push(row); out.push({ ...row });
        } else throw new Error(`unknown table ${table}`);
      }
      return out;
    },
    async update(table, filter, patch) {
      calls.push({ m: 'update', table, keys: Object.keys(patch) });
      const hit = (tables[table] ?? []).filter((r) => match(r, filter)); // filter + write in one step: atomic
      const out = [];
      for (const row of hit) {
        if (table === 'provider_oauth_sessions') {
          for (const immutable of ['merchant_id', 'provider', 'state_hash', 'redirect_uri', 'created_at', 'expires_at']) if (immutable in patch && patch[immutable] !== row[immutable]) throw conflict('immutable');
          if (['BOUND', 'FAILED', 'EXPIRED'].includes(row.status)) throw conflict('finished session');
        }
        if (table === 'merchant_connectors') {
          for (const immutable of ['merchant_id', 'kind', 'external_id']) if (immutable in patch && patch[immutable] !== row[immutable]) throw conflict('immutable');
          row.updated_at = new Date(START).toISOString();
        }
        Object.assign(row, patch);
        out.push({ ...row });
      }
      return out;
    },
    async delete(table, filter) {
      calls.push({ m: 'delete', table });
      const keep = []; const gone = [];
      for (const r of tables[table] ?? []) (match(r, filter) ? gone : keep).push(r);
      tables[table] = keep; return gone;
    },
    async rpc(fn, args) { calls.push({ m: 'rpc', fn, args }); return fn === 'provider_oauth_cleanup' ? 0 : null; },
  };
  return api;
}

// ------------------------------------------------------------------ fake providers
const ok = (body, headers = {}) => ({ status: 200, headers, body });
const bad = (status, body) => ({ status, headers: {}, body });
const formOf = (request) => request.form ?? {};
const reveal = (v) => (v && typeof v.reveal === 'function' ? v.reveal() : v);

export const IG_ACCOUNT = '17841400000000001';
export const TT_OPEN_ID = 'tiktok-open-id-1';
export const GBP_LOCATIONS = [
  { account: 'accounts/111', location: 'locations/222', title: 'HABB Namur' },
  { account: 'accounts/111', location: 'locations/333', title: 'HABB Liege' },
  { account: 'accounts/444', location: 'locations/555', title: 'Other Business' },
];

export const igRoutes = ({ accountType = 'Business', permissions = 'instagram_business_basic,instagram_business_content_publish', refreshBody } = {}) => [
  { method: 'POST', url: 'api.instagram.com/oauth/access_token', respond: ok({ data: [{ access_token: SECRETS.igShort, user_id: Number(IG_ACCOUNT), permissions }] }) },
  { method: 'GET', url: 'graph.instagram.com/access_token', respond: ok({ access_token: SECRETS.igLong, token_type: 'bearer', expires_in: 5183944 }) },
  { method: 'GET', url: 'graph.instagram.com/refresh_access_token', respond: refreshBody ?? ok({ access_token: SECRETS.igLong2, token_type: 'bearer', expires_in: 5183944 }) },
  { method: 'GET', url: '/me', respond: ok({ user_id: IG_ACCOUNT, username: 'habb.be', account_type: accountType }) },
];
export const ttRoutes = ({ scope = 'video.publish', refreshRespond, exchangeRespond, creatorRespond } = {}) => [
  {
    method: 'POST',
    url: '/v2/oauth/token/',
    respond: (request, n) => (formOf(request).grant_type === 'refresh_token'
      ? (refreshRespond?.(request, n) ?? ok({ open_id: TT_OPEN_ID, scope, access_token: SECRETS.ttAccess2, expires_in: 86400, refresh_token: SECRETS.ttRefresh2, refresh_expires_in: 31536000, token_type: 'Bearer' }))
      : (exchangeRespond?.(request, n) ?? ok({ open_id: TT_OPEN_ID, scope, access_token: SECRETS.ttAccess, expires_in: 86400, refresh_token: SECRETS.ttRefresh, refresh_expires_in: 31536000, token_type: 'Bearer' }))),
  },
  { method: 'POST', url: '/v2/post/publish/creator_info/query/', respond: creatorRespond ?? ok({ data: { creator_nickname: 'habb', privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] }, error: { code: 'ok' } }) },
  { method: 'POST', url: '/v2/oauth/revoke/', respond: ok({}) },
];
export const googleRoutes = ({ scope = 'https://www.googleapis.com/auth/business.manage', refresh = true, refreshRespond, locations = GBP_LOCATIONS } = {}) => [
  {
    method: 'POST',
    url: 'oauth2.googleapis.com/token',
    respond: (request, n) => (formOf(request).grant_type === 'refresh_token'
      ? (refreshRespond?.(request, n) ?? ok({ access_token: SECRETS.googleAccess2, expires_in: 3599, scope, token_type: 'Bearer' }))
      : ok({ access_token: SECRETS.googleAccess, expires_in: 3599, ...(refresh ? { refresh_token: SECRETS.googleRefresh } : {}), scope, token_type: 'Bearer' })),
  },
  { method: 'POST', url: 'oauth2.googleapis.com/revoke', respond: ok({}) },
  { method: 'GET', url: 'mybusinessaccountmanagement.googleapis.com/v1/accounts', respond: ok({ accounts: [...new Set(locations.map((l) => l.account))].map((name) => ({ name, accountName: `Account ${name}`, type: 'PERSONAL' })) }) },
  {
    method: 'GET',
    url: 'mybusinessbusinessinformation.googleapis.com/v1/',
    respond: (request) => {
      const account = /v1\/(accounts\/[^/]+)\/locations/.exec(request.url)?.[1];
      return ok({ locations: locations.filter((l) => l.account === account).map((l) => ({ name: l.location, title: l.title })) });
    },
  },
];
export const allRoutes = (over = {}) => [...igRoutes(over.ig), ...ttRoutes(over.tt), ...googleRoutes(over.google)];

// ------------------------------------------------------------------ runtime
/** The full provisioning graph on fakes. `clock.t` is advanced by the tests. */
export function makeRuntime({ routes = allRoutes(), env = ENV, merchants, vaultDown = false, tenant = tenantOf(M1) } = {}) {
  const db = createProvisioningDb({ merchants });
  const http = createFakeHttp(routes);
  const clock = { t: START };
  const logs = [];
  const lookupConnector = (id) => { const c = db._tables.merchant_connectors.find((x) => x.id === id); return c ? { merchantId: c.merchant_id, kind: c.kind } : null; };
  const credentialStore = createInMemoryCredentialStore({ lookupConnector, clock: () => clock.t, failWith: vaultDown ? 'down' : null });
  const sessionSecrets = createInMemorySessionSecretStore({ clock: () => clock.t, failWith: vaultDown ? 'down' : null });
  const runtime = createProviderConnectionsRuntime({
    supabase: db, http, env, clock: () => clock.t, logger: (line) => logs.push(line), credentialStore, sessionSecrets,
  });
  // the token manager waits with a real (immediate) macrotask so concurrent refreshes interleave
  return {
    rt: runtime, db, http, clock, logs, credentialStore, sessionSecrets, tenant, lookupConnector,
  };
}

/** Runs the whole consent flow for a provider against the fakes and returns what each step produced. */
export async function connect(ctx, provider, { externalId, callbackQuery = {}, tenant = ctx.tenant } = {}) {
  const { rt } = ctx;
  const started = await rt.connectionCenter.startConnect({ tenant, provider, returnTo: '/connections' });
  const url = new URL(started.authorization_url);
  const state = url.searchParams.get('state');
  const callback = await rt.provisioning.handleCallback({ tenant, provider, query: { code: SECRETS.code, state, ...callbackQuery } });
  const targets = await rt.connectionCenter.listTargets({ tenant, sessionRef: started.session_ref });
  const bound = externalId ? await rt.connectionCenter.selectTarget({ tenant, sessionRef: started.session_ref, externalId }) : null;
  return {
    started, url, state, callback, targets, bound,
  };
}

export const connectorRows = (ctx) => ctx.db._tables.merchant_connectors;
export const sessionRows = (ctx) => ctx.db._tables.provider_oauth_sessions;
export const makeBundle = (over = {}) => makeTokenBundle({
  accessToken: SECRETS.igLong, expiresAt: new Date(START + 5_000_000_000).toISOString(), scopes: ['instagram_business_basic', 'instagram_business_content_publish'], issuedAt: new Date(START - 7 * 86_400_000).toISOString(), ...over,
});
export { createConnectorRepository, createFakeHttp };
