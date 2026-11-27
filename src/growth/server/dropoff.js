// Développement des ventes > Où les visiteurs abandonnent - server source for ONE tenant (the merchant is fixed by the server context; nothing in a request chooses it).
// Facts come from an injectable `load()`: the funnel import contract (docs/growth/DROPOFF_EVENTS.md), read from a local file or from the merchant's row of
// growth_funnel_snapshot. It READS only: no analytics API call, no change to any shop. Aggregates only.
//   no load / nothing to read -> NOT_CONNECTED;  facts that fail the contract -> INVALID (reasons);  unreadable -> UNAVAILABLE;  else OK.
import { readFile } from 'node:fs/promises';
import { normalizeDropoff, buildDropoff, DROPOFF_CONFIG, DROPOFF_RULE } from '../dropoff/dropoff.js';
import { summarizePersonalizer, splitByProvenance, PZ_RETENTION_DAYS } from '../dropoff/personalizer.js';
import { errorLabel } from './safe-log.js';

export const DROPOFF_FILE = 'data/local/marketing/shop-funnel.json';
export const fileDropoffLoader = (path = DROPOFF_FILE) => async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
/** Hosted: the merchant's snapshot row (service role, merchant from the server context). */
export const supabaseDropoffLoader = (supabase, merchantId, { table = 'growth_funnel_snapshot' } = {}) => async () => {
  const rows = await supabase.select(table, { select: 'payload', merchant_id: `eq.${merchantId}`, limit: '1' });
  return rows?.[0]?.payload ?? null;
};

export function createDropoffSource({ load = null, timeZone, now = () => new Date(), config = DROPOFF_CONFIG, cacheMs = 60_000, personalizerStore = null, provenance = 'draft_theme_tests', collect = null } = {}) {
  let cached = null; let cachedAt = 0;
  // The personalizer's technical events (docs/growth/DROPOFF_EVENTS.md): counts of DISTINCT attempts, read fresh on every answer (never cached with the snapshot). No store = not collected here (null).
  const withEvents = async (payload, t) => {
    const collectInfo = { liveEnabled: Boolean(collect && collect.live), testChannel: collect?.test ?? null }; // the test key is not a secret (it is in the draft theme's script); the live key is never exposed
    if (!personalizerStore || typeof personalizerStore.list !== 'function') return { ...payload, collect: collectInfo, personalizer: { status: 'INACTIVE', provenance } }; // this server does not receive the events
    const since = new Date(t.getTime() - PZ_RETENTION_DAYS * 86400000);
    try {
      // ONE filter for every view of the screen: the customer figures (card, events table, API field `personalizer`) count LIVE events only. Tests and unknown are counted apart, never added.
      const split = splitByProvenance(await personalizerStore.list({ since })); const win = { since: since.toISOString(), until: t.toISOString() };
      const unknownAttempts = new Set(split.unknown.map((r) => r.attempt_id)).size;
      return { ...payload, collect: collectInfo, personalizer: { ...summarizePersonalizer(split.live, win), provenance }, personalizerTests: summarizePersonalizer(split.test, win), personalizerUnknown: { events: split.unknown.length, attempts: unknownAttempts } };
    }
    catch (e) { console.error('growth personalizer events: read failed:', errorLabel(e)); return { ...payload, collect: collectInfo, personalizer: { status: 'UNAVAILABLE', provenance } }; }
  };
  return async function dropoff() {
    const t = now(); if (cached && t.getTime() - cachedAt < cacheMs) return withEvents(cached, t);
    const base = { rule: DROPOFF_RULE, generatedAt: t.toISOString() }; let payload;
    if (typeof load !== 'function') payload = { ...base, state: 'NOT_CONNECTED', missing: ['SHOP_ANALYTICS_SNAPSHOT'] };
    else {
      let raw; try { raw = await load(); } catch (e) { console.error('growth dropoff: source unavailable:', errorLabel(e)); return withEvents({ ...base, state: 'UNAVAILABLE' }, t); }
      if (!raw) payload = { ...base, state: 'NOT_CONNECTED', missing: ['SHOP_ANALYTICS_SNAPSHOT'] };
      else { const { funnel, errors } = normalizeDropoff(raw); payload = funnel ? { ...base, ...buildDropoff({ funnel, now: t, timeZone, config }) } : { ...base, state: 'INVALID', errors }; }
    }
    cached = payload; cachedAt = t.getTime(); return withEvents(payload, t);
  };
}
