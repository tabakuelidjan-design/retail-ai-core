// Développement des ventes > Abonnés - server sources for ONE tenant (the merchant is fixed by the server context). One entry per connected social account (Instagram, TikTok).
// The facts come from an injectable `load()` per network (today: an import file data/local/marketing/social-<network>.json from an insights export; later a connector). READ ONLY: nothing is
// published, no account is changed. Aggregates and public post identifiers only.
//   - no loader / no file: NOT_CONNECTED for that network (the missing connection is named, nothing is invented)
//   - facts failing the contract: INVALID;  unreadable: UNAVAILABLE;  otherwise OK: the reading, the comparable groups, the direction and the items.
import { readFile } from 'node:fs/promises';
import { normalizeSocial, diagnoseSocial, SOCIAL_CONFIG, SOCIAL_RULE, NETWORKS } from '../social/social.js';
import { socialItems, reviewSocialPost } from '../social/test.js';

export const socialFile = (network) => `data/local/marketing/social-${network}.json`;
export const fileSocialLoader = (network, path = socialFile(network)) => async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };

async function read(load, network) {
  if (typeof load !== 'function') return { state: 'NOT_CONNECTED' };
  let raw = null; try { raw = await load(); } catch (e) { const reason = typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : null; console.error(`growth social (${network}): source unavailable:`, reason ?? 'unreadable'); return { state: 'UNAVAILABLE', reason }; }
  if (!raw) return { state: 'NOT_CONNECTED' };
  const { social, errors } = normalizeSocial(raw);
  if (!social) return { state: 'INVALID', errors };
  if (social.network !== network) return { state: 'INVALID', errors: [`network: expected ${network}`] };
  return { state: 'OK', social };
}

/** @param {{ loaders?: Record<string, Function>, now?: () => Date, config?: object, cacheMs?: number }} p loaders: { instagram: load, tiktok: load } */
export function createSocialSource({ loaders = {}, now = () => new Date(), config = SOCIAL_CONFIG, cacheMs = 5 * 60_000, merchantId = null, publications = null } = {}) {
  let cached = null; let cachedAt = 0;
  // the state in Publication sociale is read FRESH at each call (a validation or a publication must show at once); the facts of the network stay cached
  const withPublications = async (c) => { if (!publications) return c; const m = await publications(c.items); return { ...c, items: c.items.map((i) => (m.has(i.id) ? { ...i, publication: m.get(i.id) } : i)) }; };
  return async function social() {
    const t = now(); if (cached && t.getTime() - cachedAt < cacheMs) return withPublications(cached);
    const accounts = []; const items = [];
    for (const network of NETWORKS) {
      const r = await read(loaders[network], network);
      if (r.state !== 'OK') { accounts.push({ network, state: r.state, ...(r.reason ? { reason: r.reason } : {}), ...(r.reason === 'INSIGHTS_PERMISSION_MISSING' ? { missing: ['instagram_business_manage_insights'] } : {}), ...(r.errors ? { errors: r.errors } : {}), ...(r.state === 'NOT_CONNECTED' ? { missing: ['SOCIAL_INSIGHTS_CONNECTION'] } : {}) }); continue; }
      const d = diagnoseSocial({ social: r.social, config }); accounts.push({ network, state: 'OK', accountId: r.social.account.id, handle: r.social.account.handle, source: r.social.source, market: r.social.market, window: r.social.window, retrievedAt: r.social.retrievedAt, diagnosis: d });
      items.push(...socialItems({ diagnosis: d, social: r.social, merchantId }));
    }
    cached = { rule: SOCIAL_RULE, generatedAt: t.toISOString(), state: accounts.some((a) => a.state === 'OK') ? 'OK' : 'NOT_CONNECTED', accounts, items };
    cachedAt = t.getTime(); return withPublications(cached);
  };
}

/** GET /api/growth/review?type=post: the review of the declared post (id, planned network / account / observation days). */
export function createSocialReviewSource({ loaders = {}, now = () => new Date(), config = SOCIAL_CONFIG } = {}) {
  return async function socialReview({ id, network, account, days }) {
    const r = await read(loaders[network], network);
    return reviewSocialPost({ social: r.state === 'OK' ? r.social : null, plan: { network, accountId: account, observationDays: Number(days) }, postId: id, now: now(), config });
  };
}
