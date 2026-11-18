// Développement des ventes > Où les visiteurs abandonnent - server source for ONE tenant (the merchant is fixed by the server context; nothing in a request chooses it).
// Facts come from an injectable `load()`: the funnel import contract (docs/growth/DROPOFF_EVENTS.md), read from a local file or from the merchant's row of
// growth_funnel_snapshot. It READS only: no analytics API call, no change to any shop. Aggregates only.
//   no load / nothing to read -> NOT_CONNECTED;  facts that fail the contract -> INVALID (reasons);  unreadable -> UNAVAILABLE;  else OK.
import { readFile } from 'node:fs/promises';
import { normalizeDropoff, buildDropoff, DROPOFF_CONFIG, DROPOFF_RULE } from '../dropoff/dropoff.js';
import { summarizePersonalizer, PZ_RETENTION_DAYS } from '../dropoff/personalizer.js';

export const DROPOFF_FILE = 'data/local/marketing/shop-funnel.json';
export const fileDropoffLoader = (path = DROPOFF_FILE) => async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
/** Hosted: the merchant's snapshot row (service role, merchant from the server context). */
export const supabaseDropoffLoader = (supabase, merchantId, { table = 'growth_funnel_snapshot' } = {}) => async () => {
  const rows = await supabase.select(table, { select: 'payload', merchant_id: `eq.${merchantId}`, limit: '1' });
  return rows?.[0]?.payload ?? null;
};

export function createDropoffSource({ load = null, timeZone, now = () => new Date(), config = DROPOFF_CONFIG, cacheMs = 60_000, personalizerStore = null, provenance = 'draft_theme_tests' } = {}) {
  let cached = null; let cachedAt = 0;
  // The personalizer's technical events (docs/growth/DROPOFF_EVENTS.md): counts of DISTINCT attempts, read fresh on every answer (never cached with the snapshot). No store = not collected here (null).
  const withEvents = async (payload, t) => {
    if (!personalizerStore || typeof personalizerStore.list !== 'function') return { ...payload, personalizer: { status: 'INACTIVE', provenance } }; // this server does not receive the events
    const since = new Date(t.getTime() - PZ_RETENTION_DAYS * 86400000);
    try { return { ...payload, personalizer: { ...summarizePersonalizer(await personalizerStore.list({ since }), { since: since.toISOString(), until: t.toISOString() }), provenance } }; }
    catch (e) { console.error('growth personalizer events: read failed:', e?.message ?? e); return { ...payload, personalizer: { status: 'UNAVAILABLE', provenance } }; }
  };
  return async function dropoff() {
    const t = now(); if (cached && t.getTime() - cachedAt < cacheMs) return withEvents(cached, t);
    const base = { rule: DROPOFF_RULE, generatedAt: t.toISOString() }; let payload;
    if (typeof load !== 'function') payload = { ...base, state: 'NOT_CONNECTED', missing: ['SHOP_ANALYTICS_SNAPSHOT'] };
    else {
      let raw; try { raw = await load(); } catch (e) { console.error('growth dropoff: source unavailable:', e?.message ?? e); return withEvents({ ...base, state: 'UNAVAILABLE' }, t); }
      if (!raw) payload = { ...base, state: 'NOT_CONNECTED', missing: ['SHOP_ANALYTICS_SNAPSHOT'] };
      else { const { funnel, errors } = normalizeDropoff(raw); payload = funnel ? { ...base, ...buildDropoff({ funnel, now: t, timeZone, config }) } : { ...base, state: 'INVALID', errors }; }
    }
    cached = payload; cachedAt = t.getTime(); return withEvents(payload, t);
  };
}
