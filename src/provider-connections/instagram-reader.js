// Instagram, READ ONLY: the profile of ONE connected professional account and the figures of its most recent publication, with the date they were read.
// Instagram API with Instagram Login (graph.instagram.com), official pages consulted 2026-11-17: /docs/instagram-platform/instagram-api-with-instagram-login (me, me/media, fields) and /docs/instagram-platform/insights
// (permissions instagram_business_basic + instagram_business_manage_insights; GET /<media-id>/insights?metric=...).
//   GET <base>/<version>/me?fields=user_id,username,name,account_type,followers_count,follows_count,media_count       needs instagram_business_basic
//   GET <base>/<version>/me/media?fields=id,media_type,timestamp,permalink,caption,like_count,comments_count&limit=N    needs instagram_business_basic (newest first)
//   GET <base>/<version>/<media-id>/insights?metric=reach,views,likes,comments,saved,shares                             needs instagram_business_manage_insights
// It never posts, edits, comments or deletes. The access token is supplied by the Provider Token Manager through getAccessToken(): this file never sees a refresh token or a client secret.
// NOT TESTED AGAINST THE REAL SERVICE (doubles only): the first real read (the owner's consent) must re-check the shapes.
//
// EVERY figure carries one of FOUR states, never a bare number:
//   VALUE               a measured value above zero
//   ZERO                Instagram returned 0: a measured zero (not "unknown")
//   UNAVAILABLE         Instagram did not return it (metric not supported for this media type, hidden, too old...): said as such, never shown as 0
//   PERMISSION_MISSING  the connection does not carry the permission this figure needs: the permission is NAMED
export const PERMISSION = Object.freeze({ BASIC: 'instagram_business_basic', INSIGHTS: 'instagram_business_manage_insights' });
export const FIGURE = Object.freeze({ VALUE: 'VALUE', ZERO: 'ZERO', UNAVAILABLE: 'UNAVAILABLE', PERMISSION_MISSING: 'PERMISSION_MISSING' });
const BASE = 'https://graph.instagram.com';
const METRICS = Object.freeze([['reach', 'Personnes atteintes'], ['views', 'Vues'], ['likes', 'J’aime'], ['comments', 'Commentaires'], ['saved', 'Enregistrements'], ['shares', 'Partages']]);
const err = (code, message, status) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
const asNumber = (v) => (v == null || v === '' || typeof v === 'object' || Number.isNaN(Number(v)) ? null : Number(v));
const figure = (name, label, value, { missing = null, reason = null } = {}) => {
  if (missing) return { name, label, state: FIGURE.PERMISSION_MISSING, value: null, permission: missing, reason: 'PERMISSION' };
  const n = asNumber(value);
  if (n == null) return { name, label, state: FIGURE.UNAVAILABLE, value: null, reason: reason ?? 'NOT_RETURNED' };
  return { name, label, state: n === 0 ? FIGURE.ZERO : FIGURE.VALUE, value: n, reason: null };
};

/** @param {{ getAccessToken: () => Promise<string>, graphVersion: string, grantedScopes?: string[]|null, fetchImpl?: Function, now?: () => Date }} o grantedScopes null = unknown (the provider decides) */
export function createInstagramReader({ getAccessToken, graphVersion, grantedScopes = null, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
  if (!/^v\d+\.\d+$/.test(String(graphVersion ?? ''))) throw new TypeError('graphVersion must look like v25.0');
  const has = (permission) => grantedScopes == null || grantedScopes.includes(permission);

  /** One Graph call. Whole-read failures throw (token refused, rate limit, source unreachable); an answer about THIS figure is returned as { ok:false, kind }. */
  async function graph(path, query) {
    const token = await getAccessToken();
    const url = new URL(`/${graphVersion}${path}`, BASE); for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res;
    try { res = await fetchImpl(url.toString(), { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }); }
    catch { throw err('SOURCE_UNREACHABLE', 'Instagram could not be reached'); }
    let json = null; try { json = await res.json(); } catch { /* below */ }
    if (res.ok && !json?.error) return { ok: true, body: json ?? {} };
    const e = json?.error ?? {}; const code = Number(e.code); const sub = Number(e.error_subcode);
    if (res.status === 401 || code === 190) throw err('TOKEN_REJECTED', 'the connection must be renewed', 401);
    if (res.status === 429 || [4, 17, 32, 613].includes(code)) throw err('RATE_LIMITED', 'Instagram asked to slow down', 429);
    if (res.status >= 500) throw err('SOURCE_UNREACHABLE', `Instagram answered ${res.status}`, res.status);
    if (code === 10 || (code >= 200 && code <= 299) || (e.type === 'OAuthException' && /permission/i.test(String(e.message ?? '')) && code !== 100)) return { ok: false, kind: 'PERMISSION' };
    if (code === 100 || sub === 2108006 || sub === 2207024) return { ok: false, kind: 'UNSUPPORTED' }; // metric / field not supported for this media, or the media pre-dates the professional account
    return { ok: false, kind: 'ERROR', providerCode: Number.isFinite(code) ? code : null };
  }

  async function profile() {
    if (!has(PERMISSION.BASIC)) return { state: 'PERMISSION_MISSING', permission: PERMISSION.BASIC, data: null };
    const r = await graph('/me', { fields: 'user_id,username,name,account_type,followers_count,follows_count,media_count' });
    if (!r.ok) return r.kind === 'PERMISSION' ? { state: 'PERMISSION_MISSING', permission: PERMISSION.BASIC, data: null } : { state: 'ERROR', problem: r.kind === 'UNSUPPORTED' ? 'FIELD_NOT_SUPPORTED' : 'SOURCE_ERROR', data: null };
    const b = r.body;
    return { state: 'OK', data: { account: String(b.user_id ?? b.id ?? '') || null, username: b.username ?? null, name: b.name ?? null, accountType: b.account_type ?? null,
      followers: figure('followers', 'Abonnés', b.followers_count), follows: figure('follows', 'Abonnements', b.follows_count), mediaCount: figure('mediaCount', 'Publications', b.media_count) } };
  }

  async function insightsOf(mediaId) {
    if (!has(PERMISSION.INSIGHTS)) return METRICS.map(([n, l]) => figure(n, l, null, { missing: PERMISSION.INSIGHTS }));
    const names = METRICS.map(([n]) => n);
    const first = await graph(`/${encodeURIComponent(mediaId)}/insights`, { metric: names.join(',') });
    const valuesOf = (body) => { const m = new Map(); for (const d of body.data ?? []) m.set(d.name, asNumber(d.values?.[0]?.value ?? d.total_value?.value)); return m; };
    if (first.ok) { const m = valuesOf(first.body); return METRICS.map(([n, l]) => figure(n, l, m.get(n))); }
    if (first.kind === 'PERMISSION') return METRICS.map(([n, l]) => figure(n, l, null, { missing: PERMISSION.INSIGHTS }));
    // one unsupported metric refuses the whole request: ask one by one so each figure keeps its OWN state
    const out = [];
    for (const [n, l] of METRICS) {
      const one = await graph(`/${encodeURIComponent(mediaId)}/insights`, { metric: n });
      if (one.ok) out.push(figure(n, l, valuesOf(one.body).get(n)));
      else if (one.kind === 'PERMISSION') out.push(figure(n, l, null, { missing: PERMISSION.INSIGHTS }));
      else out.push(figure(n, l, null, { reason: one.kind === 'UNSUPPORTED' ? 'METRIC_NOT_SUPPORTED' : 'SOURCE_ERROR' }));
    }
    return out;
  }

  async function latestPublication() {
    if (!has(PERMISSION.BASIC)) return { state: 'PERMISSION_MISSING', permission: PERMISSION.BASIC, item: null };
    const r = await graph('/me/media', { fields: 'id,media_type,timestamp,permalink,caption,like_count,comments_count', limit: '5' });
    if (!r.ok) return r.kind === 'PERMISSION' ? { state: 'PERMISSION_MISSING', permission: PERMISSION.BASIC, item: null } : { state: 'ERROR', problem: 'SOURCE_ERROR', item: null };
    const items = (r.body.data ?? []).filter((m) => m && m.id).sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
    if (!items.length) return { state: 'NONE', item: null };
    const m = items[0]; const stats = await insightsOf(String(m.id));
    // like_count / comments_count come with the media itself: they back up the insight when it is unavailable (a hidden like count is NOT zero)
    const fill = (name, label, v) => { const i = stats.findIndex((s) => s.name === name); if (i >= 0 && stats[i].state === FIGURE.UNAVAILABLE && asNumber(v) != null) stats[i] = figure(name, label, v); };
    fill('likes', 'J’aime', m.like_count); fill('comments', 'Commentaires', m.comments_count);
    return { state: 'OK', item: { id: String(m.id), type: m.media_type ?? null, postedAt: m.timestamp ? new Date(m.timestamp).toISOString() : null, permalink: typeof m.permalink === 'string' && /^https:\/\//.test(m.permalink) ? m.permalink : null, caption: typeof m.caption === 'string' ? m.caption.replace(/\s+/g, ' ').trim().slice(0, 80) : null, stats } };
  }

  return Object.freeze({
    /** The whole read. `fetchedAt` says WHEN Nordla really asked Instagram. */
    async read() {
      const p = await profile(); const pub = await latestPublication();
      return { fetchedAt: now().toISOString(), profile: p, publication: pub };
    },
  });
}

/** The reader of one connector, its token supplied by the Provider Token Manager (a missing or revoked credential surfaces the manager's own error: never an empty answer). */
export function createInstagramReaderFor({ tokenManager, merchantId, connectorId, graphVersion, grantedScopes, fetchImpl, now }) {
  if (!tokenManager?.getValidCredential) throw new TypeError('tokenManager is required');
  if (!merchantId || !connectorId) throw new TypeError('merchantId and connectorId are required');
  return createInstagramReader({ getAccessToken: async () => (await tokenManager.getValidCredential({ merchantId, connectorId, provider: 'instagram' })).tokens.access_token.reveal(), graphVersion, grantedScopes, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}) });
}
