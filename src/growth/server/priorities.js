// Développement des ventes > Opportunités - server source. Reuses the four existing engine sources (Produits Potentiels, Audience,
// Croissance magasin, Contenu: each already scoped to the tenant and cached) and hands their payloads to the pure aggregator
// (priorities/priorities.js). Read-only: it calls the sources, nothing else. A failing source is reported as unavailable, the
// others still count. Nothing is stored: the priorities are recomputed from the engines on every request.
import { buildPriorities } from '../priorities/priorities.js';

/**
 * @param {{ productPotential?: Function|null, audience?: Function|null, content?: Function|null, store?: Function|null, now?: () => Date }} p
 * @returns {null | (() => Promise<object>)} null when no source is configured (no tenant): the route answers TENANT_NOT_CONFIGURED.
 */
export function createPrioritiesSource({ productPotential = null, audience = null, content = null, store = null, now = () => new Date() } = {}) {
  if (!productPotential && !audience && !content && !store) return null;
  const call = async (name, f) => {
    if (!f) return null;
    try { return await f(); } catch (e) { console.error(`growth priorities: ${name} unavailable:`, e?.message ?? e); return null; }
  };
  return async () => {
    const [products, aud, ct, st] = await Promise.all([call('products', productPotential), call('audience', audience), call('content', content), call('store', store)]);
    return buildPriorities({ products, audience: aud, content: ct, store: st, now: now() });
  };
}
