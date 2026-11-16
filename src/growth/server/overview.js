// Développement des ventes > Vue d'ensemble - real data or honest states only (owner decision 2026-09-28: no demonstration figure).
//
// Every indicator kept here has a named, real source (owner rule 2026-09-28: no decorative "Source non connectée" card):
//   - store sales: Croissance magasin's engine (`real.store`, its own 8-week window);
//   - priorities (to fix now / commercial opportunities / to watch): the Opportunités aggregator, i.e. the four real engines.
// Removed for this beta because no real source exists: revenue influenced (no attribution), sales pulse, Nordla AI insights,
// social content performance, store footfall / conversion. The Contenu engine measures listing quality, already shown here
// through the "À corriger maintenant" groups.
// Campagnes is not part of this version (no advertising connector): no campaign, ROAS or channel figure exists here.

/**
 * @param {{ now?: Date, store?: object|null, priorities?: object|null }} p
 *   store = Croissance magasin payload (or null), priorities = Opportunités payload (or null).
 */
export function buildOverview({ now = new Date(), store = null, priorities = null } = {}) {
  // A true zero is a computed zero. When NONE of the four engines could be read, nothing was computed: priorities = null (the page shows dashes, never 0).
  // When only some could not be read, the figures stand but are flagged partial and the missing sources are named (the UI says so).
  const states = priorities && priorities.sources ? Object.entries(priorities.sources) : [];
  const down = states.filter(([, v]) => v !== 'ok').map(([k]) => k);
  const allDown = states.length > 0 && down.length === states.length;
  const pr = priorities && priorities.sections && !allDown ? priorities : null;
  return {
    currency: (pr && pr.currency) || (store && store.currency) || 'EUR',
    generatedAt: now.toISOString(),
    sources: { store: store ? 'real' : 'unavailable', priorities: !pr ? 'unavailable' : down.length ? 'partial' : 'real' },
    ...(pr && down.length ? { unavailableSources: down } : {}),
    kpis: {
      fix: pr ? { value: pr.counts.fix, corrections: pr.counts.fixCorrections } : null,
      commercial: pr ? { value: pr.counts.commercial } : null,
      watch: pr ? { value: pr.counts.watch } : null,
    },
    // "À corriger maintenant" (first groups) and the commercial opportunities, straight from the aggregator.
    attention: pr ? pr.sections.fix.slice(0, 3) : null,
    fixState: pr ? (pr.fixState ?? 'CHECKED') : null, // why "À corriger" is empty: CHECKED (real zero) | NO_DATA | PARTIAL
    fixDownSources: pr ? (pr.fixDownSources ?? []) : [],
    opportunities: pr ? pr.sections.commercial.slice(0, 3) : null,
    waiting: pr ? pr.waiting : [],
    real: { store: storeSummary(store) },
  };
}

function storeSummary(s) {
  if (!s) return { mode: 'unavailable' };
  if (s.mode !== 'store') return { mode: 'noStore' };
  return { mode: 'store', net: s.kpis.storeNet.value, change: s.kpis.storeNet.change, orders: s.kpis.storeOrders.value, weekly: s.weekly.map((w) => w.storeNet), weeks: s.window.weeks, currency: s.currency };
}
