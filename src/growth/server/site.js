// Développement des ventes > Site indépendant - server sources for ONE tenant (the merchant is fixed by the server context; nothing in a request chooses it).
// The facts come from an injectable `load()` (today: the site-funnel import contract, e.g. a GA4 export at data/local/marketing/site-funnel.json; later a GA4 / Search Console
// connector). It READS only: no analytics API call, no change to any site. Aggregates only.
//   - no `load` / nothing to read: NOT_CONNECTED (the missing connection is named, nothing is invented);
//   - facts that fail the contract: INVALID with the reasons;  - unreadable: UNAVAILABLE;  - otherwise OK: one diagnosis per page + the items for Opportunités.
import { readFile } from 'node:fs/promises';
import { normalizeSiteFunnel, diagnoseSite, siteItems, SITE_CONFIG, SITE_RULE } from '../site/site.js';
import { compareFormRate } from '../site/compare.js';

export const SITE_FILE = 'data/local/marketing/site-funnel.json';
/** Default loader: the import file when it exists (null = no site connected). */
export const fileSiteLoader = (path = SITE_FILE) => async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };

async function read(load) {
  if (typeof load !== 'function') return { state: 'NOT_CONNECTED' };
  let raw = null; try { raw = await load(); } catch (e) { console.error('growth site: source unavailable:', e?.message ?? e); return { state: 'UNAVAILABLE' }; }
  if (!raw) return { state: 'NOT_CONNECTED' };
  const { site, errors, issues } = normalizeSiteFunnel(raw);
  return site ? { state: 'OK', site, issues } : { state: 'INVALID', errors };
}

export function createSiteSource({ load = null, timeZone, now = () => new Date(), config = SITE_CONFIG, cacheMs = 5 * 60_000 } = {}) {
  let cached = null; let cachedAt = 0;
  return async function site() {
    const t = now(); if (cached && t.getTime() - cachedAt < cacheMs) return cached;
    const base = { rule: SITE_RULE, source: 'ga4', generatedAt: t.toISOString() }; const r = await read(load); let payload;
    if (r.state === 'NOT_CONNECTED') payload = { ...base, state: 'NOT_CONNECTED', missing: ['GA4_PROPERTY', 'SEARCH_CONSOLE_PROPERTY'], pages: [], items: [] };
    else if (r.state !== 'OK') payload = { ...base, state: r.state, errors: r.errors ?? [], pages: [], items: [] };
    else { const pages = diagnoseSite({ site: r.site, now: t, timeZone, config }); payload = { ...base, state: 'OK', propertyId: r.site.propertyId, siteUrl: r.site.siteUrl, timeZone: r.site.timeZone, window: r.site.window, retrievedAt: r.site.retrievedAt, issues: r.issues, hasSearchConsole: !!r.site.search, pages, items: siteItems(pages) }; }
    cached = payload; cachedAt = t.getTime(); return payload;
  };
}

/** The before / after comparison of an applied page action (GET /api/growth/review?type=page). */
export function createSiteReviewSource({ load = null, timeZone, now = () => new Date(), config = SITE_CONFIG } = {}) {
  return async function siteReview({ id, applied, review }) {
    const t = now(); const r = await read(load);
    return compareFormRate({ site: r.state === 'OK' ? r.site : null, path: id, appliedDate: applied, reviewDate: review, now: t, timeZone, config });
  };
}
