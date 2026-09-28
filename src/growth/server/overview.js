// Growth > Vue d'ensemble - what the Overview may show today, and nothing else (owner decision 2026-09-28).
//
// Every figure has a named source:
//   - campaigns (active count, performing count, ROAS, campaign list, performance per channel): Campagnes is the ONE source of
//     truth -> derived from the same campaigns payload the Campagnes page shows (itself a demonstration dataset, badged "démo");
//   - store sales: the real figure of Croissance magasin's engine, added by the server as `real.store`;
//   - store footfall / visitors / conversion: NOT CONNECTED (no source exists);
//   - everything else (revenue influenced by Growth, opportunities, Nordla AI insights, items needing attention, social content
//     performance, channel reach / conversion, experiments): no Nordla engine produces it today -> `null` = "source non connectée".
// An unavailable figure is null - never 0, never a former demo value.

import { buildDemoCampaigns } from './demo-campaigns.js';

export function buildOverview(now = new Date()) {
  const camp = buildDemoCampaigns(now);
  const running = camp.campaigns.filter((c) => c.status === 'running');
  return {
    // The page still shows demonstration campaign figures (from Campagnes): the demo badge stays.
    demo: true,
    currency: camp.currency,
    generatedAt: now.toISOString(),
    period: camp.period,
    sources: { campaigns: 'demo', store: 'real', footfall: 'notConnected', attribution: 'notConnected', opportunities: 'notConnected', ai: 'notConnected', content: 'notConnected', experiments: 'notBuilt' },
    kpis: {
      revenueInfluenced: null,
      activeOpportunities: null,
      activeCampaigns: { value: running.length, performingWell: running.filter((c) => c.performance >= 1).length },
      roas: { value: camp.kpis.roas.value, deltaPct: Math.round((camp.kpis.roas.value / camp.kpis.roas.previous - 1) * 1000) / 1000 },
      experimentsRunning: null,
    },
    pulse: null,
    insights: null,
    attention: null,
    // Performance per channel = Campagnes' own per-channel figures; reach and conversion have no source.
    channels: camp.channels.map((c) => ({ id: c.id, name: c.name, revenue: c.revenue, reach: null, reachKind: null, conversion: null, roas: c.roas })),
    campaigns: running.slice().sort((a, b) => b.revenue - a.revenue || a.id.localeCompare(b.id)).slice(0, 5).map((c) => ({
      id: c.id, name: c.title, channel: c.channel, spend: c.spend, budget: c.budget,
      status: c.performance >= 1 ? 'performing' : c.performance < 0.9 ? 'watch' : 'active',
      roas: c.spend ? Math.round((c.revenue / c.spend) * 10) / 10 : null, newCustomers: c.newCustomers,
    })),
    content: null,
    store: { footfallConnected: false },
    opportunities: null,
    experiments: null,
  };
}
