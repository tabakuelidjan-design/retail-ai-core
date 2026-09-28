// TEST FIXTURE (moved from src/growth/server/demo-overview.js, 2026-09-28): a CONNECTED Overview payload example, used only to test
// that the Overview cards render correctly once real sources exist. Never served: the server builds server/overview.js.
// Growth Overview - DEMONSTRATION data only (`demo: true`). No Growth source is connected yet (ad platforms,
// social accounts, store counters, experiments), so every figure below is an illustrative example chosen to be
// internally consistent (channel revenues add up to the influenced revenue, ROAS = paid revenue / spend, the
// daily series add up to the 30-day totals). It is deterministic (no randomness) and generic: no retailer name.
// When real sources exist, this file is replaced by a deterministic builder over synced data - the payload
// shape stays the same so the UI does not change.
//
// Deep audit 2026-09-28 (P1-2 / P1-3): no demo value may contradict a real Growth page or show a capability Nordla does not have.
//   - store footfall, store visitors and store conversion: NOT CONNECTED (no source exists) - no value at all;
//   - store sales: never a demo value - the server adds the real figure (`real.store`, Croissance magasin's own engine);
//   - experiments: the Expériences page is not built - no running experiment is shown;
//   - campaigns and opportunities: counts, ROAS and lists are DERIVED from the Campagnes / Opportunités demos (one source).

import { buildDemoCampaigns } from '../../src/growth/server/demo-campaigns.js';
import { buildDemoOpportunities } from './growth-opportunities-sample.js';

const L = (fr, nl, en) => ({ fr, nl, en });
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);

/** Deterministic daily series of `n` points: weekly rhythm (weekends higher) + gentle trend, scaled to `total`. */
function series(n, total, { trend = 0, weekend = 0.3, wave = 0.08, phase = 0, dates, integer = true }) {
  const raw = dates.map((d, i) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const wk = dow === 6 ? 1 + weekend : dow === 0 ? 1 + weekend * 0.55 : 1;
    return wk * (1 + trend * (i / (n - 1) - 0.5)) * (1 + wave * Math.sin((i + phase) * 1.7));
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  const out = raw.map((v) => (integer ? Math.round((v / sum) * total) : (v / sum) * total));
  if (integer) out[n - 1] += total - out.reduce((a, b) => a + b, 0); // exact total, no drift from rounding
  return out;
}

export function buildDemoOverview(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const inDays = (n) => iso(new Date(today.getTime() + n * DAY));
  const N = 30;
  const dates = Array.from({ length: N }, (_, i) => inDays(i - (N - 1)));
  const camp = buildDemoCampaigns(now); const opp = buildDemoOpportunities(now);
  const running = camp.campaigns.filter((c) => c.status === 'running');

  const influenced = series(N, 12540, { trend: 0.5, weekend: 0.35, phase: 1, dates });
  const other = series(N, 27060, { trend: 0.1, weekend: 0.25, phase: 4, dates });
  const storeRevenue = series(N, 14380, { trend: 0.06, weekend: 0.55, phase: 3, dates });

  return {
    demo: true,
    currency: 'EUR',
    generatedAt: now.toISOString(),
    period: { key: 'last_30_days', from: dates[0], to: dates[N - 1] },
    kpis: {
      revenueInfluenced: { value: 12540, deltaPct: 0.28 },
      activeOpportunities: { value: opp.kpis.potentialRevenue.active, highPriority: opp.kpis.priority.high },
      activeCampaigns: { value: running.length, performingWell: running.filter((c) => c.performance >= 1).length },
      roas: { value: camp.kpis.roas.value, deltaPct: Math.round((camp.kpis.roas.value / camp.kpis.roas.previous - 1) * 1000) / 1000 },
      experimentsRunning: { value: null, available: false },
    },
    pulse: {
      dates,
      totalRevenue: influenced.map((v, i) => v + other[i]),
      influencedRevenue: influenced,
      totals: { totalRevenue: 39600, influencedRevenue: 12540 },
      deltas: { totalRevenue: 0.11, influencedRevenue: 0.28 },
    },
    insights: [
      { kind: 'momentum', tone: 'good', title: L('Forte dynamique sur les coques personnalisées', 'Sterke groei bij gepersonaliseerde hoesjes', 'Strong momentum on custom phone cases'), text: L('+34 % de chiffre d’affaires en 30 jours, porté surtout par Google Search.', '+34 % omzet in 30 dagen, vooral gedreven door Google Search.', '+34% revenue in 30 days, driven mostly by Google Search.') },
      { kind: 'campaign', tone: 'good', title: L('La campagne Google Search performe bien', 'De Google Search-campagne presteert goed', 'Google Search campaign performing well'), text: L('ROAS de 4,6x, au-dessus de la moyenne de 3,2x. Le budget est consommé à 82 %.', 'ROAS van 4,6x, boven het gemiddelde van 3,2x. 82 % van het budget is gebruikt.', 'ROAS of 4.6x, above the 3.2x average. 82% of the budget is spent.') },
      { kind: 'stock', tone: 'warn', title: L('Stock élevé sur les mugs personnalisés', 'Hoge voorraad personaliseerbare mokken', 'High stock on custom mugs'), text: L('64 unités, soit 11 semaines de couverture au rythme actuel.', '64 stuks, goed voor 11 weken aan het huidige tempo.', '64 units, 11 weeks of cover at the current pace.') },
    ],
    attention: [
      { kind: 'approval', status: 'pending', date: inDays(1), title: L('Approuver la campagne « Précommandes de Noël »', 'Campagne „Kerstpreorders” goedkeuren', 'Approve campaign “Christmas pre-orders”'), sub: L('Instagram · budget proposé 600 €', 'Instagram · voorgesteld budget € 600', 'Instagram · proposed budget €600'), action: 'approve' },
      { kind: 'opportunity', status: 'new', date: inDays(-1), title: L('Examiner l’opportunité « Stock élevé sur les mugs »', 'Kans „Hoge voorraad mokken” bekijken', 'Review opportunity “High stock on custom mugs”'), sub: L('Impact estimé +1 150 €', 'Geschatte impact + € 1.150', 'Estimated impact +€1,150'), action: 'review' },
    ],
    channels: [
      { id: 'google-search', name: 'Google Search', revenue: 4820, reach: 2140, reachKind: 'visits', conversion: 0.031, roas: 4.4 },
      { id: 'instagram', name: 'Instagram', revenue: 3160, reach: 18400, reachKind: 'reach', conversion: 0.014, roas: 3.0 },
      { id: 'tiktok', name: 'TikTok', revenue: 1240, reach: 22900, reachKind: 'reach', conversion: 0.006, roas: 2.0 },
      { id: 'facebook', name: 'Facebook', revenue: 980, reach: 6300, reachKind: 'reach', conversion: 0.011, roas: 2.4 },
      { id: 'google-business', name: 'Google Business', revenue: 2340, reach: 1120, reachKind: 'actions', conversion: null, roas: null },
    ],
    campaigns: running.slice().sort((a, b) => b.revenue - a.revenue || a.id.localeCompare(b.id)).slice(0, 5).map((c) => ({
      id: c.id, name: c.title, channel: c.channel, spend: c.spend, budget: c.budget,
      status: c.performance >= 1 ? 'performing' : c.performance < 0.9 ? 'watch' : 'active',
      roas: c.spend ? Math.round((c.revenue / c.spend) * 10) / 10 : null, newCustomers: c.newCustomers,
    })),
    // Content items reference a channel by id; its display name comes from `channels` above.
    content: [
      { kind: 'reel', channel: 'instagram', title: L('Making-of d’une coque personnalisée', 'Making-of van een gepersonaliseerd hoesje', 'Making of a custom case'), views: 12400, deltaPct: 0.38, performance: 'best' },
      { kind: 'video', channel: 'tiktok', title: L('Impression UV en 30 secondes', 'UV-print in 30 seconden', 'UV print in 30 seconds'), views: 9800, deltaPct: -0.08, performance: 'below' },
      { kind: 'carousel', channel: 'instagram', title: L('5 idées cadeaux à moins de 30 €', '5 cadeau-ideeën onder € 30', '5 gift ideas under €30'), views: 6100, deltaPct: 0.12, performance: 'good' },
      { kind: 'post', channel: 'google-business', title: L('Nouveautés en boutique', 'Nieuw in de winkel', 'New in store'), views: 1900, deltaPct: 0.04, performance: 'good' },
    ],
    // Store footfall is not connected: only the connection state is carried; the store SALES come from `real.store` (server).
    store: { footfallConnected: false },
    opportunities: opp.pipeline.slice().sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.revenue - a.revenue).slice(0, 3)
      .map((o) => ({ id: o.id, source: o.source, title: o.title, priority: o.priority, estimate: o.revenue, status: o.status })),
    // The Expériences page is not built: no experiment is listed.
    experiments: [],
  };
}
