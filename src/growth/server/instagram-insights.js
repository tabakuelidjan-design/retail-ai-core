// Développement des ventes > Abonnés: the READ-ONLY Instagram reader (Instagram API with Instagram Login, graph.instagram.com). It returns the raw facts of the Growth social contract
// (src/growth/social/social.js#normalizeSocial) so everything downstream (diagnosis, brief, review) is unchanged.
//
// Verified against the Meta documentation on 2026-11-15 (developers.facebook.com/docs/instagram-platform/...):
//   /me?fields=user_id,username,account_type,followers_count         instagram_business_basic
//   /<ig-user>/insights  (reach, views, ...) and /<media>/insights   instagram_business_basic AND instagram_business_manage_insights   <- NOT in Nordla's publishing scopes
//   account metrics are daily totals (metric_type=total_value, since/until); follows_and_unfollows and demographics need >= 100 followers; data may lag 48 h; no data = an EMPTY set, never 0
//   media metrics: reach, views for FEED and REELS; `follows` for FEED and STORY ONLY (NOT REELS): an attributed-follows rate per Reel does not exist at the source
//   Instagram gives the CURRENT follower total only (no history): the start total comes from our own earlier readings (snapshots), so a first reading has no net variation
// What this file never does: write, publish, change the account, print or log a token. Only GET requests, one allow-listed host, the token never leaves the Authorization query of the request.
//
// Every figure not returned by Meta is null (unavailable), never 0. Paid status is not exposed by these endpoints: posts are `unknown` unless `paidStatus(media)` says otherwise.
const HOST = 'https://graph.instagram.com';
export const INSIGHTS_SCOPES = Object.freeze(['instagram_business_basic', 'instagram_business_manage_insights']);
const day = (ms) => 86_400_000 * ms;
const isoDate = (d) => d.toISOString().slice(0, 10);
export class InsightsError extends Error { constructor(code, status = null) { super(code); this.code = code; this.status = status; } } // the message is a code: never a body, never a token

const FORMAT = (m) => (m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : m.media_type === 'IMAGE' ? 'image' : null);
const total = (res) => { const v = res?.data?.[0]?.total_value?.value; return Number.isFinite(v) ? v : null; };
const valueOf = (res) => { const d = res?.data?.[0]; const v = d?.values?.[0]?.value ?? d?.total_value?.value; return Number.isFinite(v) ? v : null; };

/**
 * @param {{ http: (url: string) => Promise<{ status: number, body: any }>, getToken: () => string|null, graphVersion: string, now?: () => Date, windowDays?: number,
 *   snapshots?: { read: () => Promise<Array<{date: string, total: number}>>, write: (list) => Promise<void> }, paidStatus?: (media) => 'organic'|'sponsored'|'unknown', maxPosts?: number }} p
 * @returns {() => Promise<object|null>} a Growth social `load()`: null when there is no token (NOT_CONNECTED)
 */
export function createInstagramInsightsLoader({ http, getToken, graphVersion, now = () => new Date(), windowDays = 28, snapshots = null, paidStatus = () => 'unknown', maxPosts = 25 }) {
  if (typeof http !== 'function') throw new TypeError('an http function is required');
  if (!/^v\d+\.\d+$/.test(String(graphVersion))) throw new TypeError('graphVersion like v25.0 is required');
  const get = async (path, query, token) => {
    const url = new URL(`${HOST}/${graphVersion}/${path}`); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v)); url.searchParams.set('access_token', token);
    let r; try { r = await http(url.toString()); } catch { throw new InsightsError('NETWORK'); } // the error of the transport may echo the URL: never kept
    if (r.status === 401 || r.body?.error?.code === 190) throw new InsightsError('TOKEN_INVALID_OR_EXPIRED', r.status);
    if (r.status === 403 || [10, 200, 3].includes(r.body?.error?.code)) throw new InsightsError('INSIGHTS_PERMISSION_MISSING', r.status);
    if (r.status >= 400) throw new InsightsError('PROVIDER_ERROR', r.status);
    return r.body;
  };
  return async function load() {
    const token = getToken(); if (!token) return null;
    const t = now(); const end = isoDate(t); const start = isoDate(new Date(t.getTime() - day(windowDays)));
    const me = await get('me', { fields: 'user_id,username,account_type,followers_count' }, token);
    if (!me?.user_id && !me?.id) throw new InsightsError('ACCOUNT_NOT_READ');
    const accountId = String(me.user_id ?? me.id); const followersNow = Number.isFinite(me.followers_count) ? me.followers_count : null;
    // account level: reach (daily totals over the window). A permission error here is the signal that insights were never authorised.
    const range = { since: Math.floor((t.getTime() - day(windowDays)) / 1000), until: Math.floor(t.getTime() / 1000) };
    const reach = total(await get(`${accountId}/insights`, { metric: 'reach', metric_type: 'total_value', period: 'day', ...range }, token));
    // follower snapshots: our own history (Instagram returns only today's total)
    let list = []; if (snapshots) { try { list = await snapshots.read(); } catch { list = []; } }
    if (snapshots && followersNow !== null && !list.some((s) => s.date === end)) { list = [...list, { date: end, total: followersNow }].filter((s) => s.date >= isoDate(new Date(t.getTime() - day(120)))).sort((a, b) => a.date.localeCompare(b.date)); try { await snapshots.write(list); } catch { /* a convenience: the reading stands without it */ } }
    const first = list.find((s) => s.date >= start && s.date < end);
    // publications of the account (aggregates and public identifiers only)
    const media = await get(`${accountId}/media`, { fields: 'id,permalink,timestamp,media_product_type,media_type,caption', limit: maxPosts }, token);
    const posts = [];
    for (const m of (media?.data ?? [])) {
      const format = FORMAT(m); if (!format || m.media_product_type === 'STORY' || !m.timestamp) continue;
      const ageDays = Math.floor((t.getTime() - new Date(m.timestamp).getTime()) / day(1)); if (ageDays < 0 || ageDays > windowDays) continue;
      const metrics = m.media_product_type === 'REELS' ? 'reach,views' : 'reach,views,follows'; // `follows` does not exist for Reels
      let ins = null; try { ins = await get(`${m.id}/insights`, { metric: metrics }, token); } catch (e) { if (e.code !== 'PROVIDER_ERROR') throw e; } // one media without insights (album child, too recent) never hides the others
      const by = Object.fromEntries((ins?.data ?? []).map((d) => [d.name, valueOf({ data: [d] })]));
      posts.push({ id: String(m.id), url: m.permalink ?? null, posted_at: String(m.timestamp).slice(0, 10), format, paid: paidStatus(m), hook: m.caption ? String(m.caption).split('\n')[0].slice(0, 120) : null, topic: null, structure: null,
        observed: { age_days: ageDays, reach: by.reach ?? null, follows_attributed: by.follows ?? null, views: by.views ?? null } });
    }
    return { source_system: 'instagram_api_insights', method: 'graph.instagram.com read-only', network: 'instagram', account: { id: accountId, handle: me.username ? `@${me.username}` : null }, market: null,
      window: { start, end }, retrieved_at: t.toISOString(), account_type: me.account_type ?? null,
      followers: { start_total: first ? first.total : null, end_total: followersNow }, funnel: reach === null ? null : { reach }, posts, public_examples: [], capabilities: { trial_reels: false } };
  };
}

/** a minimal GET-only transport on the global fetch: it refuses anything but https://graph.instagram.com */
export const fetchHttp = (fetchImpl = fetch) => async (url) => {
  if (!url.startsWith(`${HOST}/`)) throw new InsightsError('HOST_REFUSED');
  const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
