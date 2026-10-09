// Shared fixtures for the Activation & Channel Execution tests. Synthetic data only; NO real credential, NO network:
// fake HTTP, fake credential provider, fake media transport, fake clock, strict in-memory job store.
import { randomUUID } from 'node:crypto';

import {
  buildChannelExecutionOrder, createChannelExecutionRepository, createChannelExecutor, createGoogleBusinessProfileAdapter, createInMemoryCredentialProvider, createInMemoryMediaTransport,
  createInstagramAdapter, createTikTokAdapter, getChannelCapability,
} from '../src/activation/index.js';
import { chainFor, M1, M2, B1, tenant } from './marketing-m4-fixtures.js';

export {
  M1, M2, B1, tenant,
};

export const NOW = '2026-10-13T09:00:00Z';
export const ORDER_EXPIRES = '2026-10-15T00:00:00Z';
export const IDS = {
  IG: 'a1111111-1111-4111-8111-111111111111',
  TT: 'a2222222-2222-4222-8222-222222222222',
  GBP: 'a3333333-3333-4333-8333-333333333333',
  IG2: 'a4444444-4444-4444-8444-444444444444',
  OTHER: 'a5555555-5555-4555-8555-555555555555',
};
export const TOKENS = { IG: 'IGAAtoken-secret-0001-abcdefghij', TT: 'act.tiktok-secret-0002-abcdefghij', GBP: 'ya29.google-secret-0003-abcdefghij' };
export const ASSETS = { IMAGE: ['asset://img-1'], TEXT: ['asset://copy-1', 'asset://caption-1', 'asset://cta-url-1', 'asset://event-title-1'] };
export const SCOPES = {
  instagram: ['instagram_business_basic', 'instagram_business_content_publish'],
  tiktok: ['video.publish'],
  google_business_profile: ['https://www.googleapis.com/auth/business.manage'],
};

export const connectorRow = ({
  id, kind, externalId, status = 'CONFIGURED', config = {}, merchantId = M1,
}) => ({
  id, merchantId, kind, externalId, externalDomain: null, status, config, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
});
export const CONNECTORS = () => [
  connectorRow({ id: IDS.IG, kind: 'instagram', externalId: '17841400000000001', config: { granted_scopes: SCOPES.instagram, account_state: 'Business' } }),
  connectorRow({ id: IDS.TT, kind: 'tiktok', externalId: 'tiktok-open-id-1', config: { granted_scopes: SCOPES.tiktok } }),
  connectorRow({ id: IDS.GBP, kind: 'google_business_profile', externalId: 'accounts/111/locations/222', config: { granted_scopes: SCOPES.google_business_profile } }),
];

/** A REAL chain (M1 -> M3 ActivationManifest) with channel-friendly assets, plus the M4 execution authorization. */
export function world(plan = 'TIME') {
  const c = chainFor(plan, { channels: ['SOCIAL'], assets: ASSETS });
  const byKind = (kind) => c.candidates.find((e) => e.candidate.content_kind === kind).candidate;
  const execAuth = (over = {}) => ({
    authorization_ref: 'exec-auth://1', decision_ref: 'decision://socle-2', activation_manifest_ref: c.activationManifest.activation_manifest_id, push_ref: c.push.push_id,
    scope: 'EXECUTE', status: 'APPROVED', authorized_at: '2026-10-11T09:00:00Z', expires_at: '2026-10-16T00:00:00Z', ...over,
  });
  return {
    ...c, imageRef: byKind('IMAGE').deliverable_ref, textRef: byKind('TEXT').deliverable_ref, execAuth, execAuthorization: execAuth(),
  };
}

export const imageDelivery = (w, over = {}) => ({
  manifest_delivery_ref: w.imageRef, connector_id: IDS.IG, provider: 'instagram', publish_mode: 'PUBLISH_NOW', provider_options: {}, ...over,
});
export const textDelivery = (w, over = {}) => ({
  manifest_delivery_ref: w.textRef, connector_id: IDS.GBP, provider: 'google_business_profile', publish_mode: 'PUBLISH_NOW', provider_options: { topic_type: 'STANDARD' }, ...over,
});
export const TIKTOK_OPTIONS = { privacy_level: 'SELF_ONLY', brand_content_toggle: false, brand_organic_toggle: false, is_aigc: false };

export const orderInputs = (w, deliveries, over = {}) => ({
  tenant: tenant(), push: w.push, activationManifest: w.activationManifest, authorization: w.execAuthorization, connectors: CONNECTORS(),
  deliveries, asOf: NOW, expires_at: ORDER_EXPIRES, ...over,
});
export const orderOf = (w, deliveries, over) => buildChannelExecutionOrder(orderInputs(w, deliveries ?? [imageDelivery(w), textDelivery(w)], over));

// ------------------------------------------------------------------ fakes
export function createFakeHttp(routes) {
  const raw = []; const counters = new Map();
  async function http(request) {
    raw.push(request);
    const route = routes.find((r) => r.method === request.method && request.url.includes(r.url));
    if (!route) return { status: 404, body: { error: { message: 'no route' } } };
    const n = (counters.get(route) ?? 0) + 1; counters.set(route, n);
    const out = typeof route.respond === 'function' ? route.respond(request, n) : route.respond;
    if (out instanceof Error) throw out;
    return out;
  }
  http.raw = raw;
  http.calls = (needle) => raw.filter((r) => (needle ? r.url.includes(needle) : true));
  return http;
}
const ok = (body, headers = {}) => ({ status: 200, headers, body });

export const igRoutes = ({ statuses = ['FINISHED'], accountType = 'Business', userId = '17841400000000001' } = {}) => [
  { method: 'GET', url: '/me', respond: ok({ user_id: userId, username: 'brand', account_type: accountType }) },
  { method: 'POST', url: '/17841400000000001/media_publish', respond: ok({ id: 'ig-media-1' }) },
  { method: 'POST', url: '/17841400000000001/media', respond: ok({ id: 'container-1' }) },
  { method: 'GET', url: '/container-1', respond: (_r, n) => ok({ status_code: statuses[Math.min(n, statuses.length) - 1] }) },
];
export const ttRoutes = ({ options = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE'], statuses = ['PUBLISH_COMPLETE'], publicIds = ['7000000000001'] } = {}) => [
  { method: 'POST', url: '/creator_info/query/', respond: ok({ data: { creator_nickname: 'brand', privacy_level_options: options }, error: { code: 'ok' } }) },
  { method: 'POST', url: '/v2/post/publish/content/init/', respond: ok({ data: { publish_id: 'p_pub_url~v2.1' }, error: { code: 'ok' } }) },
  { method: 'POST', url: '/v2/post/publish/video/init/', respond: ok({ data: { publish_id: 'p_pub_url~v2.2' }, error: { code: 'ok' } }) },
  { method: 'POST', url: '/status/fetch/', respond: (_r, n) => ok({ data: { status: statuses[Math.min(n, statuses.length) - 1], publicaly_available_post_id: publicIds }, error: { code: 'ok' } }) },
];
export const gbpRoutes = ({ state = 'LIVE' } = {}) => [
  { method: 'POST', url: '/localPosts', respond: ok({ name: 'accounts/111/locations/222/localPosts/9', state, createTime: '2026-10-13T09:00:05Z', searchUrl: 'https://search.google.com/local/posts?q=1' }) },
  { method: 'GET', url: '/localPosts/9', respond: ok({ name: 'accounts/111/locations/222/localPosts/9', state: 'LIVE', createTime: '2026-10-13T09:00:05Z' }) },
  { method: 'GET', url: '/localPosts', respond: ok({ localPosts: [] }) },
];

export const credentialProvider = (over = {}) => createInMemoryCredentialProvider({
  [`${M1}:${IDS.IG}`]: { access_token: TOKENS.IG, granted_scopes: SCOPES.instagram, expires_at: '2026-12-01T00:00:00Z' },
  [`${M1}:${IDS.TT}`]: { access_token: TOKENS.TT, granted_scopes: SCOPES.tiktok, expires_at: '2026-12-01T00:00:00Z' },
  [`${M1}:${IDS.GBP}`]: { access_token: TOKENS.GBP, granted_scopes: SCOPES.google_business_profile, expires_at: '2026-12-01T00:00:00Z' },
  ...over,
});
const media = (extra = {}) => ({
  transport_mode: 'PUBLIC_URL', ephemeral_location: 'https://media.example.test/img-1.jpg?sig=SIGNEDSECRET', content_type: 'image/jpeg', byte_length: 1000,
  expires_at: '2026-10-14T00:00:00Z', domain_verified: true, ...extra,
});
export const mediaTransport = (over = {}, opts) => createInMemoryMediaTransport({
  'instagram:asset://img-1': media(),
  'tiktok:asset://img-1': media(),
  'google_business_profile:asset://img-1': media(),
  'asset://copy-1': { text: 'Venez découvrir la nouvelle collection en boutique.' },
  'asset://caption-1': { text: 'Nouveauté en boutique' },
  'asset://cta-url-1': { text: 'https://shop.example.test/collection' },
  'asset://event-title-1': { text: 'Soirée de lancement' },
  ...over,
}, opts);

/** Adapters on one fake http (routes of the three providers merged). */
export function services(w, {
  routes = [...igRoutes(), ...ttRoutes(), ...gbpRoutes()], credentials, transport, clientAudited = true, timeoutMs,
} = {}) {
  const http = createFakeHttp(routes);
  const clock = () => Date.parse(NOW) + 5000;
  return {
    http,
    credentialProvider: credentials ?? credentialProvider(),
    mediaTransport: transport ?? mediaTransport(),
    adapters: {
      instagram: createInstagramAdapter({ http, graphVersion: 'v25.0', now: clock, timeoutMs }),
      tiktok: createTikTokAdapter({ http, clientAudited, now: clock, timeoutMs }),
      google_business_profile: createGoogleBusinessProfileAdapter({ http, now: clock, timeoutMs }),
    },
  };
}

export const activationOf = (w) => ({
  finding: w.finding, decisionPackage: w.decisionPackage, authorization: w.createAuthorization, brandContext: w.brandContext, brief: w.brief, candidates: w.candidates,
});
export const preflightInput = (w, order, svc, over = {}) => ({
  tenant: tenant(), order, push: w.push, activationManifest: w.activationManifest, authorization: w.execAuthorization, connectors: CONNECTORS(),
  activation: activationOf(w), services: { credentialProvider: svc.credentialProvider, mediaTransport: svc.mediaTransport, adapters: svc.adapters }, asOf: NOW, ...over,
});

// ------------------------------------------------------------------ strict in-memory job store (the SQL rules)
export function createJobStore({ merchants = [M1, M2], connectors = CONNECTORS() } = {}) {
  const rows = []; const calls = [];
  const TERMINAL = ['PUBLISHED', 'FAILED_FINAL', 'CANCELLED'];
  const matches = (row, params) => Object.entries(params).every(([key, value]) => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return true;
    const m = /^eq\.(.*)$/.exec(value);
    return m ? String(row[key] ?? '') === m[1] : true;
  });
  const store = {
    _rows: rows,
    calls,
    async select(table, params) {
      calls.push({ m: 'select', table });
      let out = rows.filter((r) => matches(r, params)).map((r) => ({ ...r }));
      if (params.order) { const [col, dir] = params.order.split('.'); out.sort((a, b) => ((a[col] ?? '') > (b[col] ?? '') ? 1 : -1) * (dir === 'desc' ? -1 : 1)); }
      if (params.limit) out = out.slice(0, Number(params.limit));
      return out;
    },
    async insert(table, newRows) {
      calls.push({ m: 'insert', table });
      const created = [];
      for (const r of newRows) {
        if (!merchants.includes(r.merchant_id)) throw new Error('HTTP 409 23503');
        const connector = connectors.find((c) => c.id === r.connector_id);
        if (!connector || connector.merchantId !== r.merchant_id) throw new Error('HTTP 409 23000 connector does not belong to the merchant');
        if (rows.some((e) => e.merchant_id === r.merchant_id && e.activation_manifest_ref === r.activation_manifest_ref && e.manifest_delivery_ref === r.manifest_delivery_ref && e.connector_id === r.connector_id)) throw new Error('HTTP 409 23505');
        if (rows.some((e) => e.merchant_id === r.merchant_id && e.idempotency_key === r.idempotency_key)) throw new Error('HTTP 409 23505');
        const row = {
          id: randomUUID(), state: 'PLANNED', attempt_count: 0, status_poll_count: 0, created_at: NOW, updated_at: NOW, safe_metadata: {}, provider_submission_id: null, provider_post_id: null,
          next_attempt_at: null, published_at: null, last_error_code: null, last_error_class: null, ...r,
        };
        rows.push(row); created.push({ ...row });
      }
      return created;
    },
    async update(table, filter, patch) {
      calls.push({ m: 'update', table, filter, keys: Object.keys(patch) });
      const hit = rows.filter((r) => matches(r, filter)); // atomic: filter + write in one step
      const out = [];
      for (const row of hit) {
        if (TERMINAL.includes(row.state)) throw new Error('HTTP 409 terminal job cannot change');
        for (const immutable of ['merchant_id', 'connector_id', 'activation_manifest_ref', 'manifest_delivery_ref', 'provider', 'idempotency_key', 'request_fingerprint']) {
          if (immutable in patch && patch[immutable] !== row[immutable]) throw new Error('HTTP 409 immutable');
        }
        Object.assign(row, patch);
        out.push({ ...row });
      }
      return out;
    },
  };
  return store;
}

export const capabilityOf = getChannelCapability;

/** A complete runtime: order + preflight input + store + repository + executor on a controllable clock. Nothing real is called. */
export async function runtime(w, {
  deliveries, routes, clientAudited, credentials, transport, orderOver, enqueue = true, store = createJobStore(), timeoutMs,
} = {}) {
  const svc = services(w, {
    routes, clientAudited, credentials, transport, timeoutMs,
  });
  const order = orderOf(w, deliveries, orderOver);
  const clock = { t: Date.parse(NOW) };
  const logs = [];
  const repo = createChannelExecutionRepository({ supabase: store });
  const input = preflightInput(w, order, svc);
  const executor = createChannelExecutor({
    repository: repo, clock: () => clock.t, logger: (line) => logs.push(line), loadContext: async () => ({ ...input }),
  });
  const enq = enqueue ? await executor.enqueueChannelExecutionOrder({ ...input, asOf: NOW }) : null;
  return {
    w, svc, order, repo, store, executor, clock, logs, enq, input,
  };
}
export const advance = (rt, ms) => { rt.clock.t += ms; };
export const jobOf = (rt, provider) => rt.store._rows.find((r) => r.provider === provider);
