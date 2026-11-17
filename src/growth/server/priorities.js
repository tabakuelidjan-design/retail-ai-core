// Développement des ventes > Opportunités - server source. Reuses the four existing engine sources (Produits Potentiels, Audience,
// Croissance magasin, Contenu: each already scoped to the tenant and cached) and hands their payloads to the pure aggregator
// (priorities/priorities.js). Read-only: it calls the sources, nothing else. A failing source is reported as unavailable, the
// others still count. Nothing is stored: the priorities are recomputed from the engines on every request.
import { buildPriorities } from '../priorities/priorities.js';
import { orientWithGeneral } from './general-orientation.js';
import { prepareOpportunityAction } from '../priorities/actions.js';
import { rankWeeklyActions, prerequisitesOf } from '../priorities/weekly.js';
import { targetOf } from '../priorities/targets.js';

/**
 * @param {{ productPotential?: Function|null, audience?: Function|null, content?: Function|null, store?: Function|null, now?: () => Date }} p
 * @returns {null | (() => Promise<object>)} null when no source is configured (no tenant): the route answers TENANT_NOT_CONFIGURED.
 */
export function createPrioritiesSource({ productPotential = null, audience = null, content = null, store = null, ads = null, site = null, social = null, inbox = null, general = null, now = () => new Date() } = {}) {
  if (!productPotential && !audience && !content && !store) return null;
  const call = async (name, f) => {
    if (!f) return null;
    try { return await f(); } catch (e) { console.error(`growth priorities: ${name} unavailable:`, e?.message ?? e); return null; }
  };
  return async () => {
    const [products, aud, ct, st] = await Promise.all([call('products', productPotential), call('audience', audience), call('content', content), call('store', store)]);
    const result = buildPriorities({ products, audience: aud, content: ct, store: st, now: now() });
    const sources = { potential: products, storeGrowth: st, audience: aud };
    const productRows = new Map((products?.rows ?? []).map((row) => [row.id, row]));
    for (const item of result.sections.commercial) {
      const source = sources[item.sourcePage];
      item.measurement = {
        start: source?.window?.start ?? null,
        end: source?.window?.end ?? null,
        calculatedAt: source?.generatedAt ?? null,
      };
      item.preparedAction = prepareOpportunityAction(item, productRows.get(item.entity.id), products?.variantWindow, products?.window);
      item.target = targetOf(item, { productRow: productRows.get(item.entity.id), audience: aud, store: st });
      item.prerequisites = prerequisitesOf(item.preparedAction);
    }
    result.weekly = rankWeeklyActions(result.sections.commercial, { sources: result.sources });
    orientWithGeneral(result, general ? await call('general', general) : null); // context from Paramètres > Général (read only, additive): featured offers are flagged, nothing is re-ranked
    // Ad campaigns (lot _06): present only when an ad source is wired (connected or explicitly NOT_CONNECTED). They are NOT commercial candidates (never ranked with
    // sales actions): their own block, with the same follow-up. Without the `ads` source the payload is exactly what it was.
    if (ads) result.ads = await call('ads', ads) ?? { state: 'UNAVAILABLE', channel: null, campaigns: [], items: [] };
    if (site) result.site = await call('site', site) ?? { state: 'UNAVAILABLE', pages: [], items: [] }; // lot _07: the independent-site block, present only when a site source is wired
    if (social) result.social = await call('social', social) ?? { state: 'UNAVAILABLE', accounts: [], items: [] }; // lot _08: the social-followers block, present only when a social source is wired
    if (inbox) result.inbox = await call('inbox', inbox) ?? { state: 'UNAVAILABLE', accounts: [], items: [] }; // lot _10: the conversations / qualified requests block, present only when an inbox source is wired
    return result;
  };
}
