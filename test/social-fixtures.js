// Fixtures for the chantier E (social publishing) tests. Synthetic data only; NO network, NO real credential.
import { createHash } from 'node:crypto';
import { createMemoryStore } from '../src/social/store.js';
import { createSocialService } from '../src/social/service.js';
import { createPublisher } from '../src/social/publisher.js';
import { createInstagramPublisher, createFacebookPagePublisher } from '../src/social/providers/meta.js';

export const OWNER = { id: 'owner:habb', role: 'owner' };
export const AGENT = { id: 'agent:chantier-d', role: 'agent' };
export const T0 = Date.parse('2026-10-17T08:00:00Z');
export const IG_ID = '17841400000000001';
export const PAGE_ID = '100000000000001';
export const TOKENS = { ig: 'IGAA-secret-token-0001-abcdefghij', fb: 'EAAB-secret-token-0002-abcdefghij' };
export const sha = (s) => createHash('sha256').update(s).digest('hex');

export const asset = (over = {}) => ({
  ref: 'asset://habb/coque-voyage', version: 1, sha256: sha('coque-voyage-v1'), content_type: 'image/jpeg', width: 1080, height: 1350, ...over,
});
export const postInput = (over = {}) => ({
  platform: 'instagram', format: 'IMAGE', subject: { kind: 'product', ref: 'shopify://product/coque-voyage', label: 'Coque voyage' },
  asset: asset(), caption: 'Une coque qui voyage avec vous. Fabriquée à Namur.', hashtags: ['habb', 'namur'], publish_at: '2026-10-17T17:00:00Z', ...over,
});

/** A scriptable fake HTTP. Records every request (sealed values serialize as [REDACTED]). */
export function createFakeHttp(handlers = {}) {
  const calls = [];
  const http = async (req) => {
    const path = new URL(req.url).pathname;
    calls.push({ method: req.method, path, query: req.query, body: req.body });
    for (const [key, handler] of Object.entries(handlers)) {
      const [method, suffix] = key.split(' ');
      if (method === req.method && path.endsWith(suffix)) {
        const r = typeof handler === 'function' ? await handler(req, calls) : handler;
        if (r instanceof Error) throw r;
        return r;
      }
    }
    return { status: 404, headers: {}, body: { error: { code: 100, message: 'no route' } } };
  };
  http.calls = calls;
  http.count = (method, suffix) => calls.filter((c) => c.method === method && c.path.endsWith(suffix)).length;
  return http;
}
export const ok = (body) => ({ status: 200, headers: {}, body });

export function igRoutes(over = {}) {
  return {
    'GET /me': ok({ user_id: IG_ID, username: 'habb.be', account_type: 'Business' }),
    'POST /media': ok({ id: 'container-1' }),
    'GET /container-1': ok({ status_code: 'FINISHED' }),
    [`POST /media_publish`]: ok({ id: 'media-1' }),
    'GET /media-1': ok({ id: 'media-1', permalink: 'https://www.instagram.com/p/ABC123/', timestamp: '2026-10-17T17:00:02+0000', media_type: 'IMAGE' }),
    ...over,
  };
}
export function fbRoutes(over = {}) {
  return {
    [`GET /${PAGE_ID}`]: ok({ id: PAGE_ID, name: 'HABB' }),
    [`POST /${PAGE_ID}/photos`]: ok({ id: 'photo-1', post_id: `${PAGE_ID}_9001` }),
    [`POST /${PAGE_ID}/feed`]: ok({ id: `${PAGE_ID}_9002` }),
    [`GET /${PAGE_ID}_9001`]: ok({ id: `${PAGE_ID}_9001`, is_published: false, scheduled_publish_time: Math.floor(Date.parse('2026-10-20T17:00:00Z') / 1000) }),
    [`DELETE /${PAGE_ID}_9001`]: ok({ success: true }),
    ...over,
  };
}

export const credentials = () => ({
  async resolve(platform) {
    if (platform === 'instagram') return { access_token: TOKENS.ig, account_id: IG_ID, expires_at: null };
    if (platform === 'facebook') return { access_token: TOKENS.fb, account_id: PAGE_ID, expires_at: null };
    return null;
  },
});
export const media = (over = {}) => ({
  calls: [],
  async resolve(a) { this.calls.push(a.ref); return { url: 'https://cdn.habb.be/media/coque-voyage.jpg', content_type: a.content_type, sha256: a.sha256, ...over }; },
});

/** A full runtime on an in-memory store and a manual clock. */
export function runtime({ ig = igRoutes(), fb = fbRoutes(), withFacebook = false, mediaOver = {}, config = {}, extraPublishers = {} } = {}) {
  const clock = { now: T0, tick(ms) { this.now += ms; } };
  const store = createMemoryStore();
  const igHttp = createFakeHttp(ig);
  const fbHttp = createFakeHttp(fb);
  const publishers = {
    instagram: createInstagramPublisher({ http: igHttp, graphVersion: 'v25.0', credentials: credentials(), timeoutMs: 1000, sleep: async () => {}, settleWaitMs: 0 }),
    ...(withFacebook ? { facebook: createFacebookPagePublisher({ http: fbHttp, graphVersion: 'v25.0', credentials: credentials(), timeoutMs: 1000 }) } : {}),
    ...extraPublishers,
  };
  const service = createSocialService({ store, publishers, clock: () => clock.now });
  const m = media(mediaOver);
  const logs = [];
  const publisher = createPublisher({ service, publishers, media: m, clock: () => clock.now, logger: (l) => logs.push(l), config });
  return { clock, store, service, publisher, publishers, igHttp, fbHttp, media: m, logs };
}

/** DRAFT -> READY -> APPROVED -> SCHEDULED, by the book. Returns the scheduled post. */
export async function scheduled(rt, over = {}) {
  const post = await rt.service.createPost(postInput(over), AGENT);
  await rt.service.act(post.id, 'submit', AGENT);
  const hash = rt.service.contentHashOf(await rt.service.get(post.id));
  await rt.service.act(post.id, 'approve', OWNER, { expected_hash: hash });
  return rt.service.act(post.id, 'schedule', OWNER, { expected_hash: hash });
}
