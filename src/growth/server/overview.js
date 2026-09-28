// Développement des ventes > Vue d'ensemble - real data or honest states only (owner decision 2026-09-28: no demonstration figure).
//
// Every figure has a named, real source:
//   - store sales: Croissance magasin's engine (`real.store`, its own 8-week window);
//   - priorities (to fix now / commercial opportunities / to watch): the Opportunités aggregator, i.e. the four real engines;
//   - everything no Nordla engine produces (revenue influenced by sales actions, Nordla AI insights, social content performance,
//     store footfall / conversion): `null` = "Source non connectée" - never 0, never an invented value.
// Campagnes is not part of this version (no advertising connector): no campaign, ROAS or channel figure exists here.

/**
 * @param {{ now?: Date, store?: object|null, priorities?: object|null }} p
 *   store = Croissance magasin payload (or null), priorities = Opportunités payload (or null).
 */
export function buildOverview({ now = new Date(), store = null, priorities = null } = {}) {
  const pr = priorities && priorities.sections ? priorities : null;
  return {
    currency: (pr && pr.currency) || (store && store.currency) || 'EUR',
    generatedAt: now.toISOString(),
    sources: {
      store: store ? 'real' : 'unavailable', priorities: pr ? 'real' : 'unavailable',
      footfall: 'notConnected', attribution: 'notConnected', ai: 'notConnected', content: 'notConnected',
    },
    kpis: {
      revenueInfluenced: null,
      fix: pr ? { value: pr.counts.fix, elements: pr.counts.fixElements } : null,
      commercial: pr ? { value: pr.counts.commercial } : null,
      watch: pr ? { value: pr.counts.watch } : null,
    },
    pulse: null,
    insights: null,
    // "À corriger maintenant" (first groups) and the commercial opportunities, straight from the aggregator.
    attention: pr ? pr.sections.fix.slice(0, 3) : null,
    opportunities: pr ? pr.sections.commercial.slice(0, 3) : null,
    waiting: pr ? pr.waiting : [],
    content: null,
    real: { store: storeSummary(store) },
  };
}

function storeSummary(s) {
  if (!s) return { mode: 'unavailable' };
  if (s.mode !== 'store') return { mode: 'noStore' };
  return { mode: 'store', net: s.kpis.storeNet.value, change: s.kpis.storeNet.change, orders: s.kpis.storeOrders.value, weekly: s.weekly.map((w) => w.storeNet), weeks: s.window.weeks, currency: s.currency };
}
