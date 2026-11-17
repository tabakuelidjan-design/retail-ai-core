// TikTok, READ ONLY: the account statistics and the statistics of the PUBLIC videos of ONE connected account, with the date they were read.
// Built from the official pages (consulted 2026-11-17): developers.tiktok.com/doc/tiktok-api-v2-get-user-info, /tiktok-api-v2-video-list, /tiktok-api-v2-video-object, /tiktok-api-scopes.
//   GET  https://open.tiktokapis.com/v2/user/info/?fields=...      scopes user.info.basic (open_id, display_name), user.info.stats (follower_count, following_count, likes_count, video_count)
//   POST https://open.tiktokapis.com/v2/video/list/?fields=...     scope video.list, body { max_count <= 20, cursor }, PUBLIC videos only, newest first, response { data: { videos, cursor, has_more } }
//   Video object fields: id, title, create_time (s), duration, view_count, like_count, comment_count, share_count
// It never posts, uploads or deletes. The access token is supplied by the Provider Token Manager through getAccessToken(): this file never sees a refresh token or a secret.
// NOT TESTED AGAINST THE REAL SERVICE (doubles only): the first real read (the owner's consent) must re-check the shapes. Missing figures stay null, never 0.
const BASE = 'https://open.tiktokapis.com';
const err = (code, message, status) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const MAX_PAGES = 5; const PAGE = 20;

/** @param {{ getAccessToken: () => Promise<string>, fetchImpl?: Function, now?: () => Date }} o */
export function createTikTokReader({ getAccessToken, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
  async function call(method, path, { query, body } = {}) {
    const token = await getAccessToken();
    const url = new URL(path, BASE); for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res;
    try { res = await fetchImpl(url.toString(), { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw err('SOURCE_UNREACHABLE', 'TikTok could not be reached'); }
    let json = null; try { json = await res.json(); } catch { /* below */ }
    const code = json?.error?.code;
    if (res.status === 401 || code === 'access_token_invalid') throw err('TOKEN_REJECTED', 'the connection must be renewed', 401);
    if (code === 'scope_not_authorized' || code === 'scope_permission_missed') throw err('SCOPE_MISSING', 'the connection does not carry the scope this read needs', res.status);
    if (res.status === 429 || code === 'rate_limit_exceeded') throw err('RATE_LIMITED', 'TikTok asked to slow down', 429);
    if (!res.ok || (code && code !== 'ok')) throw err('SOURCE_ERROR', `TikTok answered ${res.status}${code ? ` (${code})` : ''}`, res.status);
    return json ?? {};
  }
  return Object.freeze({
    /** Account figures. A figure TikTok does not return (scope not granted, hidden) is null. */
    async accountStats() {
      const j = await call('GET', '/v2/user/info/', { query: { fields: 'open_id,display_name,follower_count,following_count,likes_count,video_count' } });
      const u = j.data?.user ?? {};
      return { account: u.open_id ?? null, displayName: u.display_name ?? null, followers: num(u.follower_count), following: num(u.following_count), likes: num(u.likes_count), videos: num(u.video_count), fetchedAt: now().toISOString() };
    },
    /** The newest public videos with their figures (at most `limit`, pages of 20, 5 pages maximum). */
    async videos({ limit = 20 } = {}) {
      const want = Math.max(1, Math.min(Number(limit) || 20, PAGE * MAX_PAGES)); const out = []; let cursor = null; let hasMore = false;
      for (let page = 0; page < MAX_PAGES && out.length < want; page += 1) {
        const j = await call('POST', '/v2/video/list/', { query: { fields: 'id,title,create_time,duration,view_count,like_count,comment_count,share_count' }, body: { max_count: Math.min(PAGE, want - out.length), ...(cursor != null ? { cursor } : {}) } });
        for (const v of j.data?.videos ?? []) out.push({ id: String(v.id), title: v.title ?? null, postedAt: v.create_time ? new Date(Number(v.create_time) * 1000).toISOString() : null, durationSeconds: num(v.duration), views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count) });
        hasMore = Boolean(j.data?.has_more); cursor = j.data?.cursor ?? null; if (!hasMore || cursor == null) break;
      }
      return { videos: out.slice(0, want), moreAvailable: hasMore && out.length >= want, publicOnly: true, fetchedAt: now().toISOString(), lastPostedAt: out.length ? out.map((v) => v.postedAt).filter(Boolean).sort().at(-1) ?? null : null };
    },
  });
}

/** The reader of one connector, its token supplied by the Provider Token Manager (a missing or revoked credential surfaces the manager's own error: never an empty answer). */
export function createTikTokReaderFor({ tokenManager, merchantId, connectorId, fetchImpl, now }) {
  if (!tokenManager?.getValidCredential) throw new TypeError('tokenManager is required');
  if (!merchantId || !connectorId) throw new TypeError('merchantId and connectorId are required');
  return createTikTokReader({ getAccessToken: async () => (await tokenManager.getValidCredential({ merchantId, connectorId, provider: 'tiktok' })).tokens.access_token.reveal(), ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}) });
}
